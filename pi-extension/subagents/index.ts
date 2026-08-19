import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeOwnedMuxTarget,
  getMuxBackend,
  sendEscape,
  shellEscape,
  renameCurrentTab,
  renameWorkspace,
  readScreen,
  isStableCmuxId,
  muxInstanceIdentity,
  ownedMuxTargetExists,
  ownedMuxTargetIsTrusted,
} from "./cmux.ts";

import {
  appendImagePathInstructions,
  findLastAssistantMessage,
  getNewEntries,
  materializeLatestUserImages,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  abandonAgentReservation,
  agentIncarnation,
  agentIncarnationMatches,
  activateAgentSurface,
  activeOwnedSurface,
  initializeTeam,
  listTeamAgents,
  markAgentSurface,
  readAgent,
  releaseAgentSlot,
  reserveAgentSlot,
  reserveAgentSlotForResume,
  restoreAgentAfterFailedResume,
  teamEnvironment,
  updateAgent,
  type LaunchPolicy,
  type ExpectedAgentIncarnation,
  type OwnedSurfaceRecord,
  type TeamAgentRecord,
  type TeamContext,
} from "./team.ts";
import { loadTeamConfig } from "./config.ts";
import {
  deliverMailboxAtTurnBoundary,
  enqueueFollowupMessage,
  enqueueMailboxMessage,
  mailboxIdentityForContext,
  type MailboxDeliveryState,
} from "./mailbox.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const teamConfig = loadTeamConfig();

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  thinking: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Reasoning effort override (overrides agent frontmatter).",
    }),
  ),
  taskName: Type.Optional(
    Type.String({
      description: "Stable task name used for the hierarchical team path. The display name is unchanged.",
    }),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  forkTurns: Type.Optional(
    Type.String({
      description:
        'Context to inherit: "none", "all", or a positive integer string for the latest N proven user turns.',
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

type ThinkingLevel = "low" | "medium" | "high";
type ForkTurns = "none" | "all" | number;

interface EffectiveLaunchOptions {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string;
}

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  taskName?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function serializeDenyTools(denied: Set<string>): string {
  return [...denied].sort().join(",");
}

function persistedDenyTools(policy: LaunchPolicy): string {
  if (typeof policy.effectiveDenyTools === "string") return policy.effectiveDenyTools;
  return serializeDenyTools(resolveDenyTools({
    denyTools: typeof policy.denyTools === "string" ? policy.denyTools : undefined,
    spawning: policy.spawning === false ? false : undefined,
  }));
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    taskName: getFrontmatterValue(frontmatter, "task-name"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function parseThinking(value: string | undefined, source: string): ThinkingLevel | undefined {
  if (value == null) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Invalid ${source} thinking ${JSON.stringify(value)}; expected low, medium, or high.`);
}

function parseForkTurns(value: string): ForkTurns {
  if (value === "none" || value === "all") return value;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `Invalid forkTurns ${JSON.stringify(value)}; expected "none", "all", or a positive integer string.`,
    );
  }
  const turns = Number(value);
  if (!Number.isSafeInteger(turns)) {
    throw new Error(`Invalid forkTurns ${JSON.stringify(value)}; the positive integer is too large.`);
  }
  return turns;
}

function resolveForkTurns(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): ForkTurns | null {
  const explicit = params.forkTurns != null ? parseForkTurns(params.forkTurns) : null;
  if (params.fork === true && explicit != null && explicit !== "all") {
    throw new Error(
      `Conflicting context options: fork:true is an alias for forkTurns:"all", not ${JSON.stringify(params.forkTurns)}.`,
    );
  }
  if (explicit != null) return explicit;
  if (params.fork === true) return "all";
  if (agentDefs?.sessionMode === "fork") return "all";
  if (agentDefs?.sessionMode === "lineage-only") return "none";
  return null;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  const forkTurns = resolveForkTurns(params, agentDefs);
  if (forkTurns === "none") return "lineage-only";
  if (forkTurns === "all" || typeof forkTurns === "number") return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  forkTurns: "all" | number | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const resolvedForkTurns = resolveForkTurns(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    forkTurns:
      resolvedForkTurns === "all" || typeof resolvedForkTurns === "number"
        ? resolvedForkTurns
        : null,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

function modelFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const model = env.PI_MODEL?.trim();
  if (!model) return undefined;
  if (model.includes("/")) return model;
  const provider = env.PI_PROVIDER?.trim();
  return provider ? `${provider}/${model}` : undefined;
}

function thinkingFromEnvironment(env: NodeJS.ProcessEnv = process.env): ThinkingLevel | undefined {
  const value = env.PI_REASONING_LEVEL?.trim();
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function resolveEffectiveLaunchOptions(
  params: Pick<Static<typeof SubagentParams>, "model" | "thinking" | "tools" | "skills">,
  agentDefs: AgentDefaults | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveLaunchOptions {
  if (params.model != null && !params.model.trim()) {
    throw new Error("Invalid tool model; expected a non-empty model name.");
  }
  const model = params.model?.trim() ?? agentDefs?.model ?? modelFromEnvironment(env);
  const configuredThinking = params.thinking ?? agentDefs?.thinking;
  const thinking = configuredThinking != null
    ? parseThinking(configuredThinking, params.thinking != null ? "tool" : "agent frontmatter")
    : model
      ? thinkingFromEnvironment(env)
      : undefined;
  if (thinking && !model) {
    throw new Error(
      "A thinking override requires an effective model. Set model, agent frontmatter model, or PI_PROVIDER and PI_MODEL.",
    );
  }
  const tools = params.tools ?? agentDefs?.tools;
  const skills = params.skills ?? agentDefs?.skills;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools != null ? { tools } : {}),
    ...(skills != null ? { skills } : {}),
  };
}

function resolveTaskName(
  params: Pick<Static<typeof SubagentParams>, "taskName">,
  agentDefs: AgentDefaults | null,
): string | undefined {
  const value = params.taskName ?? agentDefs?.taskName;
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Invalid taskName; expected a non-empty task path name.");
  return trimmed;
}

const REASONING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh)$/;

function buildPiModelSpec(model: string | undefined, thinking: ThinkingLevel | undefined): string | undefined {
  if (!model) return undefined;
  if (!thinking) return model;
  return `${model.replace(REASONING_SUFFIX, "")}:${thinking}`;
}

function modelEnvironment(model: string | undefined, thinking: ThinkingLevel | undefined): Record<string, string> {
  const environment = {
    PI_PROVIDER: "",
    PI_MODEL: "",
    PI_REASONING_LEVEL: thinking ?? "",
  };
  if (!model) return environment;
  const normalizedModel = model.replace(REASONING_SUFFIX, "");
  const slash = normalizedModel.indexOf("/");
  if (slash <= 0 || slash === normalizedModel.length - 1) return environment;
  return {
    PI_PROVIDER: normalizedModel.slice(0, slash),
    PI_MODEL: normalizedModel.slice(slash + 1),
    PI_REASONING_LEVEL: thinking ?? "",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string, cwd = process.cwd()): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(cwd, ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

function getTeamContext(ctx: {
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
    getSessionDir(): string;
  };
}): TeamContext {
  const sessionPath = ctx.sessionManager.getSessionFile();
  if (!sessionPath) throw new Error("No session file");
  return initializeTeam({
    artifactDir: getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
    sessionPath,
    ...(process.env.PI_SUBAGENT_THREAD_CAP ? {} : { threadCap: teamConfig.maxThreads }),
  });
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
  /** Watcher detached on extension/session shutdown; the child remains team-owned. */
  detached?: boolean;
  /** Another watcher already committed this run's durable terminal transition. */
  duplicate?: boolean;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  runId: string;
  incarnation: ExpectedAgentIncarnation;
  agentPath: string;
  team: TeamContext;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  ownedSurface?: OwnedSurfaceRecord;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  watcherPromise?: Promise<SubagentResult>;
  finalizationPromise?: Promise<SubagentResult>;
  finalizedResult?: SubagentResult;
  surfaceFinalizationState?: "closed" | "orphaned" | "close_failed";
  surfaceExistsCheck?: (surface: string) => boolean | null;
  completionFilesOnly?: boolean;
}

const MUX_RUNTIME_INSTANCE_ID = randomUUID();

function ownedSurfaceIsTrusted(owned: OwnedSurfaceRecord): boolean {
  return ownedMuxTargetIsTrusted(owned, process.env, MUX_RUNTIME_INSTANCE_ID);
}

function closeOwnedSurface(owned: OwnedSurfaceRecord): void {
  closeOwnedMuxTarget(owned, MUX_RUNTIME_INSTANCE_ID);
}

function ownedSurfaceExists(owned: OwnedSurfaceRecord): boolean | null {
  return ownedMuxTargetExists(owned, MUX_RUNTIME_INSTANCE_ID);
}

function ownedSurfaceForTarget(surface: string): OwnedSurfaceRecord | undefined {
  const backend = getMuxBackend();
  if (!backend) return undefined;
  if (backend === "cmux" && !isStableCmuxId(surface)) return undefined;
  const instanceId = muxInstanceIdentity(backend);
  if (!instanceId) return undefined;
  const now = new Date().toISOString();
  return {
    backend,
    id: surface,
    instanceId,
    ...(backend === "cmux" ? {} : { runtimeInstanceId: MUX_RUNTIME_INSTANCE_ID }),
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

const FINALIZATION_REGISTRY_KEY = Symbol.for("pi.subagents.finalization-registry");

interface SharedFinalizationEntry {
  promise: Promise<SubagentResult>;
}

function finalizationRegistry(): Map<string, SharedFinalizationEntry> {
  const global = globalThis as any;
  return global[FINALIZATION_REGISTRY_KEY] ??=
    new Map<string, SharedFinalizationEntry>();
}

function finalizationKey(running: RunningSubagent): string {
  return `${running.team.teamId}:${running.runId}:${running.incarnation ?? "legacy"}`;
}

function clearRunningIncarnation(running: RunningSubagent): void {
  const current = runningSubagents.get(running.id);
  if (current?.runId === running.runId && current.incarnation === running.incarnation) {
    runningSubagents.delete(running.id);
  }
  updateWidget();
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = [
  "caller_ping",
  "subagent_message",
  "subagent_followup",
  "subagent_done",
] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string, requireRead = false): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  if (requireRead) allow.add("read");
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg?: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator =
    params.taskArg != null && params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    ...(params.taskArg != null ? [params.taskArg] : []),
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId) ??
      Array.from(runningSubagents.values()).find((candidate) =>
        candidate.runId === requestedId || candidate.agentPath === requestedId
      );
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      }],
      details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  if (running.team && running.runId) {
    updateAgent(running.team, running.runId, { status: "interrupted" }, running.incarnation);
  }
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;
      const teamStatus = snapshot.kind === "waiting" || snapshot.kind === "stalled"
        ? "waiting"
        : "running";
      try {
        updateAgent(running.team, running.runId, { status: teamStatus }, running.incarnation);
      } catch {
        // UI refresh must survive externally removed registry metadata.
      }

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function cleanupOwnedSurfaces(
  team: TeamContext,
  record: TeamAgentRecord,
  operations: {
    close?: (owned: OwnedSurfaceRecord) => void;
    exists?: (owned: OwnedSurfaceRecord) => boolean | null;
    trusted?: (owned: OwnedSurfaceRecord) => boolean;
  } = {},
): TeamAgentRecord {
  const expected = agentIncarnation(record);
  for (const owned of record.surfaces ?? []) {
    if (owned.state !== "active" && owned.state !== "close_failed") continue;
    if (owned.backend === "cmux" && !isStableCmuxId(owned.id)) continue;
    if (!(operations.trusted ?? ownedSurfaceIsTrusted)(owned)) {
      markAgentSurface(team, record.runId, owned.id, "close_failed", expected);
      throw new Error(`Cannot prove ownership of ${owned.backend} instance for ${owned.id}.`);
    }
    if ((operations.exists ?? ownedSurfaceExists)(owned) === false) {
      markAgentSurface(team, record.runId, owned.id, "orphaned", expected);
      continue;
    }
    try {
      (operations.close ?? closeOwnedSurface)(owned);
      markAgentSurface(team, record.runId, owned.id, "closed", expected);
    } catch (error) {
      markAgentSurface(team, record.runId, owned.id, "close_failed", expected);
      throw new Error(
        `Could not close previously owned surface ${owned.id}: ${(error as Error).message}`,
      );
    }
  }
  return readAgent(team, record.runId) ?? record;
}

interface ResumeOverrides {
  name?: string;
  autoExit?: boolean;
  interactive?: boolean;
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  cwd?: string;
}

function findResumeSource(team: TeamContext, sessionPath: string): TeamAgentRecord | null {
  return listTeamAgents(team)
    .filter((agent) => agent.sessionPath === sessionPath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

function stringPolicy(policy: LaunchPolicy, key: string): string | undefined {
  const value = policy[key];
  return typeof value === "string" && value ? value : undefined;
}

function resolveResumeLaunchBehavior(
  params: ResumeOverrides,
  source: TeamAgentRecord | null = null,
  env: NodeJS.ProcessEnv = process.env,
): {
  name: string;
  role?: string;
  autoExit: boolean;
  interactive: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string;
  cwd?: string;
  launchPolicy: LaunchPolicy;
} {
  const previous = source?.launchPolicy ?? {};
  if (params.model != null && !params.model.trim()) {
    throw new Error("Invalid resume model override; expected a non-empty model name.");
  }
  if (params.cwd != null && !params.cwd.trim()) {
    throw new Error("Invalid resume cwd override; expected a non-empty path.");
  }
  if (params.name != null && !params.name.trim()) {
    throw new Error("Invalid resume name override; expected a non-empty display name.");
  }
  const model = params.model?.trim() ?? stringPolicy(previous, "model") ?? modelFromEnvironment(env);
  const configuredThinking = params.thinking ?? stringPolicy(previous, "thinking");
  const thinking = configuredThinking != null
    ? parseThinking(
      configuredThinking,
      params.thinking != null ? "resume override" : "stored launch policy",
    )
    : model
      ? thinkingFromEnvironment(env)
      : undefined;
  if (thinking && !model) {
    throw new Error(
      "A resume thinking override requires an effective model. Set model or PI_PROVIDER and PI_MODEL.",
    );
  }
  const storedAutoExit = typeof previous.autoExit === "boolean" ? previous.autoExit : undefined;
  const autoExit = params.autoExit ?? storedAutoExit ?? true;
  const storedInteractive = typeof previous.interactive === "boolean" ? previous.interactive : undefined;
  const interactive = params.interactive ??
    (params.autoExit != null ? !autoExit : storedInteractive ?? !autoExit);
  const name = params.name?.trim() ?? source?.displayName ?? "Resume";
  const role = source?.role ?? stringPolicy(previous, "agent");
  const previousTools = typeof previous.tools === "string" ? previous.tools : undefined;
  const previousSkills = typeof previous.skills === "string" ? previous.skills : undefined;
  const tools = params.tools ?? previousTools;
  const skills = params.skills ?? previousSkills;
  const cwd = params.cwd?.trim() ?? stringPolicy(previous, "cwd");
  const launchPolicy: LaunchPolicy = {
    ...previous,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools != null ? { tools } : {}),
    ...(skills != null ? { skills } : {}),
    ...(cwd ? { cwd } : {}),
    autoExit,
    interactive,
    effectiveDenyTools: persistedDenyTools(previous),
  };
  return { name, role, autoExit, interactive, model, thinking, tools, skills, cwd, launchPolicy };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  parseForkTurns,
  resolveForkTurns,
  resolveLaunchBehavior,
  resolveEffectiveLaunchOptions,
  resolveTaskName,
  buildPiModelSpec,
  modelEnvironment,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  serializeDenyTools,
  persistedDenyTools,
  thinkingFromEnvironment,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  findResumeSource,
  finalizeSubagent,
  watchSubagent,
  cleanupOwnedSurfaces,
  resolveReconciledSurface,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: {
      getSessionFile(): string | null | undefined;
      getSessionId(): string;
      getSessionDir(): string;
      getBranch(): Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
    };
    cwd: string;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const runId = randomUUID();
  const id = runId.slice(0, 8);

  const definitionCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
  const agentDefs = params.agent ? loadAgentDefaults(params.agent, definitionCwd) : null;
  const effective = resolveEffectiveLaunchOptions(params, agentDefs);
  const effectiveModel = effective.model;
  const effectiveTools = effective.tools;
  const effectiveSkills = effective.skills;
  const effectiveThinking = effective.thinking;
  const effectiveTaskName = resolveTaskName(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const effectiveDenyTools = resolveDenyTools(agentDefs);
  const serializedDenyTools = serializeDenyTools(effectiveDenyTools);
  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
  const imagePaths = materializeLatestUserImages(
    ctx.sessionManager.getBranch(),
    join(artifactDir, "images", id),
  );
  const taskWithImages = appendImagePathInstructions(params.task, imagePaths);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
  const team = getTeamContext(ctx);
  const teamAgent = reserveAgentSlot(team, {
    runId,
    displayName: params.name,
    taskName: effectiveTaskName,
    role: params.agent,
    sessionPath: subagentSessionFile,
    launchPolicy: {
      task: params.task,
      taskName: effectiveTaskName,
      sessionMode: launchBehavior.sessionMode,
      forkTurns: launchBehavior.forkTurns,
      agent: params.agent,
      model: effectiveModel,
      thinking: effectiveThinking,
      tools: effectiveTools,
      skills: effectiveSkills,
      cwd: targetCwdForSession,
      interactive: effectiveInteractive,
      autoExit: agentDefs?.autoExit,
      cli: agentDefs?.cli,
      systemPrompt: params.systemPrompt,
      identity: agentDefs?.body,
      systemPromptMode: agentDefs?.systemPromptMode,
      denyTools: agentDefs?.denyTools,
      spawning: agentDefs?.spawning,
      effectiveDenyTools: serializedDenyTools,
    },
  });
  let surface: string | undefined;
  let launchedOwnership: OwnedSurfaceRecord | undefined;

  try {
  // Use pre-created surface (parallel mode) or create a new one. Capacity has
  // already been reserved atomically across the whole team.
  const surfacePreCreated = !!options?.surface;
  const launchBackend = getMuxBackend();
  if (!launchBackend || !muxInstanceIdentity(launchBackend)) {
    throw new Error("Mux instance identity is unavailable; refusing an unowned launch");
  }
  surface = options?.surface ?? createSurface(params.name);
  launchedOwnership = ownedSurfaceForTarget(surface);
  if (!launchedOwnership) throw new Error("Mux did not return a safely owned surface identity");
  activateAgentSurface(team, runId, launchedOwnership, agentIncarnation(teamAgent));
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      ...(launchBehavior.forkTurns != null ? { forkTurns: launchBehavior.forkTurns } : {}),
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? taskWithImages
    : `${roleBlock}\n\n${modeHint}\n\n${taskWithImages}\n\n${summaryInstruction}`;
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = params.systemPrompt ?? agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--resume", shellEscape(params.resumeSessionId));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(taskWithImages));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const teamEnvPrefix = Object.entries(teamEnvironment(team, teamAgent))
      .map(([key, value]) => `${key}=${shellEscape(value)}`)
      .join(" ");
    const command = `${cdPrefix}${teamEnvPrefix} ${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      runId,
      incarnation: agentIncarnation(teamAgent),
      agentPath: teamAgent.path,
      team,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      ownedSurface: launchedOwnership,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  const forcedExtension = process.env.PI_SUBAGENT_EXTENSION_SOURCE?.trim();
  if (forcedExtension) parts.push("-ne", "-e", shellEscape(forcedExtension));
  parts.push("-e", shellEscape(subagentDonePath));

  const piModelSpec = buildPiModelSpec(effectiveModel, effectiveThinking);
  if (piModelSpec) {
    parts.push("--model", shellEscape(piModelSpec));
  }

  // Pass agent body as system prompt via file to avoid shell escaping issues
  // with multiline content. Pi's --append-system-prompt and --system-prompt
  // auto-detect file paths and read their contents.
  if (identityInSystemPrompt && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, imagePaths.length > 0);
  if (toolAllowlist) {
    parts.push("--tools", shellEscape(toolAllowlist));
  }

  // Build env prefix: denied tools + subagent identity + config dir propagation
  const envParts: string[] = [];

  for (const [key, value] of Object.entries(modelEnvironment(effectiveModel, effectiveThinking))) {
    envParts.push(`${key}=${shellEscape(value)}`);
  }

  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }

  envParts.push(`PI_DENY_TOOLS=${shellEscape(serializedDenyTools)}`);
  for (const [key, value] of Object.entries(teamEnvironment(team, teamAgent))) {
    envParts.push(`${key}=${shellEscape(value)}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  updateAgent(team, runId, {
    launchPolicy: {
      ...teamAgent.launchPolicy,
      activityFile,
      launchScriptFile,
    },
  }, agentIncarnation(teamAgent));
  const running: RunningSubagent = {
    id,
    runId,
    incarnation: agentIncarnation(teamAgent),
    agentPath: teamAgent.path,
    team,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    ownedSurface: launchedOwnership,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  return running;
  } catch (error) {
    if (launchedOwnership) {
      try {
        closeOwnedSurface(launchedOwnership);
        markAgentSurface(team, runId, launchedOwnership.id, "closed", agentIncarnation(teamAgent));
      } catch {
        markAgentSurface(team, runId, launchedOwnership.id, "close_failed", agentIncarnation(teamAgent));
      }
      await releaseAgentSlot(team, runId, "errored", { expectedIncarnation: agentIncarnation(teamAgent) });
    } else {
      await abandonAgentReservation(team, runId, agentIncarnation(teamAgent));
    }
    throw error;
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

async function finalizeSubagentOnce(
  running: RunningSubagent,
  result: SubagentResult,
  surfaceState: "closed" | "orphaned",
  operations: {
    close?: (owned: OwnedSurfaceRecord) => void;
    exists?: (owned: OwnedSurfaceRecord) => boolean | null;
    trusted?: (owned: OwnedSurfaceRecord) => boolean;
    release?: typeof releaseAgentSlot;
  },
): Promise<SubagentResult> {
  if (!agentIncarnationMatches(readAgent(running.team, running.runId), running.incarnation)) {
    clearRunningIncarnation(running);
    return { ...result, duplicate: true };
  }

  const candidate = running.ownedSurface;
  const owned = candidate?.backend === "cmux" && !isStableCmuxId(candidate.id)
    ? undefined
    : candidate;
  let state = running.surfaceFinalizationState ?? surfaceState;

  if (!running.surfaceFinalizationState && surfaceState === "closed" && owned) {
    if (!(operations.trusted ?? ownedSurfaceIsTrusted)(owned)) {
      state = "close_failed";
    } else if ((operations.exists ?? ownedSurfaceExists)(owned) === false) {
      state = "orphaned";
    } else {
      try {
        (operations.close ?? closeOwnedSurface)(owned);
      } catch {
        state = "close_failed";
      }
    }
    running.surfaceFinalizationState = state;
  }

  const transitioned = await (operations.release ?? releaseAgentSlot)(
    running.team,
    running.runId,
    result.exitCode === 0 && !result.errorMessage && !result.error ? "completed" : "errored",
    {
      expectedIncarnation: running.incarnation,
      ...(owned ? { surface: { id: owned.id, state } } : {}),
    },
  );
  clearRunningIncarnation(running);
  return transitioned ? result : { ...result, duplicate: true };
}

function finalizeSubagent(
  running: RunningSubagent,
  result: SubagentResult,
  surfaceState: "closed" | "orphaned" = "closed",
  operations: {
    close?: (owned: OwnedSurfaceRecord) => void;
    exists?: (owned: OwnedSurfaceRecord) => boolean | null;
    trusted?: (owned: OwnedSurfaceRecord) => boolean;
    release?: typeof releaseAgentSlot;
  } = {},
): Promise<SubagentResult> {
  if (running.finalizedResult) return Promise.resolve(running.finalizedResult);
  if (running.finalizationPromise) return running.finalizationPromise;

  const registry = finalizationRegistry();
  const key = finalizationKey(running);
  const existing = registry.get(key);
  const isOwner = !existing;
  const pending = existing?.promise ?? finalizeSubagentOnce(running, result, surfaceState, operations);
  const entry = existing ?? { promise: pending };
  if (isOwner) registry.set(key, entry);

  const tracked = pending.then(
    (sharedResult) => {
      const finalized = isOwner ? sharedResult : { ...sharedResult, duplicate: true };
      if (!isOwner) clearRunningIncarnation(running);
      running.finalizedResult = finalized;
      return finalized;
    },
    (error) => {
      running.finalizationPromise = undefined;
      throw error;
    },
  );
  running.finalizationPromise = tracked;
  tracked.then(
    () => { if (registry.get(key) === entry) registry.delete(key); },
    () => { if (registry.get(key) === entry) registry.delete(key); },
  );
  return tracked;
}

async function watchSubagentOnce(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;
  const moduleSignal = getModuleAbortSignal();

  try {
    const polled = await pollForExit(surface, AbortSignal.any([signal, moduleSignal]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      surfaceExists: running.surfaceExistsCheck,
      completionFilesOnly: running.completionFilesOnly,
      onTick() { observeRunningSubagent(running); },
    });
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      let summary = "";
      if (running.sentinelFile) {
        try { summary = readFileSync(running.sentinelFile, "utf-8").trim(); } catch {}
      }
      if (!summary && polled.reason !== "disappeared") {
        try {
          summary = readScreen(surface, 200).replace(/__SUBAGENT_DONE_\d+__/, "").trimEnd();
        } catch {}
      }
      if (!summary) summary = polled.errorMessage ??
        (polled.exitCode !== 0 ? `Claude Code exited with code ${polled.exitCode}` : "Claude Code exited without output");
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }
      return finalizeSubagent(running, {
        name, task, summary, exitCode: polled.exitCode, elapsed,
        ...(polled.errorMessage ? { errorMessage: polled.errorMessage } : {}),
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      }, polled.reason === "disappeared" ? "orphaned" : "closed");
    }

    const fallback = polled.errorMessage
      ? `Subagent error: ${polled.errorMessage}`
      : polled.exitCode !== 0
        ? `Sub-agent exited with code ${polled.exitCode}`
        : "Sub-agent exited without output";
    let summary = fallback;
    if (existsSync(sessionFile)) {
      try { summary = findLastAssistantMessage(getNewEntries(sessionFile, 0)) ?? fallback; } catch {}
    }
    return finalizeSubagent(running, {
      name, task, summary, sessionFile, exitCode: polled.exitCode, elapsed,
      ping: polled.ping,
      ...(polled.errorMessage ? { errorMessage: polled.errorMessage } : {}),
    }, polled.reason === "disappeared" ? "orphaned" : "closed");
  } catch (err: any) {
    // Reload/shutdown only detaches this watcher. Durable ownership and the
    // lease stay active for the next extension instance to reconcile.
    if (signal.aborted || moduleSignal.aborted) {
      if (runningSubagents.get(running.id) === running) runningSubagents.delete(running.id);
      return {
        name, task, summary: "Subagent watcher detached; child remains active.",
        exitCode: 0, elapsed: Math.floor((Date.now() - startTime) / 1000),
        detached: true, sessionFile,
      };
    }
    const message = err?.message ?? String(err);
    return finalizeSubagent(running, {
      name, task, summary: `Subagent error: ${message}`, exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000), error: message,
    });
  }
}

function watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult> {
  if (!running.watcherPromise) {
    running.watcherPromise = watchSubagentOnce(running, signal);
  }
  return running.watcherPromise;
}


function resolveReconciledSurface(record: TeamAgentRecord): {
  ownedSurface?: OwnedSurfaceRecord;
  completionFilesOnly: boolean;
  knownMissing: boolean;
} {
  const candidate = activeOwnedSurface(record) ?? undefined;
  const ownedSurface = candidate?.backend === "cmux" && !isStableCmuxId(candidate.id)
    ? undefined
    : candidate;
  const targetIsAccessible = ownedSurface?.backend === "cmux" &&
    ownedSurface.backend === getMuxBackend() &&
    ownedSurfaceIsTrusted(ownedSurface);
  return {
    ownedSurface,
    completionFilesOnly: !targetIsAccessible,
    knownMissing: !!targetIsAccessible && ownedSurface?.backend === "cmux" &&
      ownedSurfaceExists(ownedSurface) === false,
  };
}

function reconcileTeamWatchers(pi: ExtensionAPI, ctx: ExtensionContext): void {
  let team: TeamContext;
  try {
    team = getTeamContext(ctx);
  } catch {
    return;
  }
  const terminal = new Set(["completed", "errored"]);
  for (const record of listTeamAgents(team)) {
    if (record.parentPath !== team.agentPath || terminal.has(record.status) || !record.surface) continue;
    const id = record.runId.slice(0, 8);
    if (runningSubagents.has(id)) continue;
    const policy = record.launchPolicy;
    const reconciliation = resolveReconciledSurface(record);
    const { ownedSurface } = reconciliation;
    const startTime = Date.parse(record.createdAt) || Date.now();
    const running: RunningSubagent = {
      id,
      runId: record.runId,
      incarnation: agentIncarnation(record),
      agentPath: record.path,
      team,
      name: record.displayName,
      task: typeof policy.task === "string" ? policy.task : "reconciled subagent",
      agent: record.role,
      surface: record.surface,
      ownedSurface,
      startTime,
      sessionFile: record.sessionPath,
      launchScriptFile: typeof policy.launchScriptFile === "string" ? policy.launchScriptFile : undefined,
      activityFile: typeof policy.activityFile === "string" ? policy.activityFile : undefined,
      cli: policy.cli === "claude" ? "claude" : undefined,
      interactive: policy.interactive === true,
      statusState: createStatusState({ source: policy.cli === "claude" ? "claude" : "pi", startTimeMs: startTime }),
    };
    runningSubagents.set(id, running);
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    if (reconciliation.knownMissing) running.surfaceExistsCheck = () => false;
    if (reconciliation.completionFilesOnly) running.completionFilesOnly = true;
    const completion = watchSubagent(running, watcherAbort.signal);
    completion.then((result) => {
      updateWidget();
      if (result.detached || result.duplicate) return;
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name),
          display: true,
          details: {
            id: running.runId,
            path: running.agentPath,
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }).catch(() => {});
  }
  if (runningSubagents.size > 0) {
    startWidgetRefresh();
    startStatusRefresh(pi);
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const rootMailboxState: MailboxDeliveryState = { hops: 0, route: [] };
  // Child delivery is owned by subagent-done.ts so it can carry hop provenance
  // into subagent_message calls. The coordinator receives queued child mail here.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_RUN_ID || !ctx.sessionManager.getSessionFile()) return;
    const team = getTeamContext(ctx);
    await deliverMailboxAtTurnBoundary(
      pi,
      mailboxIdentityForContext(team),
      rootMailboxState,
      {},
      ctx.sessionManager,
    );
  });

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    reconcileTeamWatchers(pi, ctx);
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── durable direct mailbox tool (root; children register it in subagent-done.ts) ──
  if (!process.env.PI_SUBAGENT_RUN_ID && shouldRegister("subagent_message"))
    pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Queue a durable direct message for another active agent in this subagent team. " +
        "The message is delivered at the target's next agent-turn boundary and never wakes or starts an idle target.",
      parameters: Type.Object({
        target: Type.String({ description: "Recipient run ID, team path, or unique display name" }),
        message: Type.String({ description: "Message to queue for the recipient" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const team = getTeamContext(ctx);
          const queued = await enqueueMailboxMessage(
            mailboxIdentityForContext(team),
            params.target,
            params.message,
            { provenance: rootMailboxState },
          );
          return {
            content: [{
              type: "text" as const,
              text:
                `Message queued for ${queued.recipientName} (${queued.recipientPath}). ` +
                "It will be delivered at that agent's next turn boundary without waking it.",
            }],
            details: {
              id: queued.id,
              sequence: queued.sequence,
              targetRunId: queued.recipientRunId,
              targetPath: queued.recipientPath,
              status: "queued",
            },
          };
        } catch (error) {
          const message = (error as Error).message;
          return {
            content: [{ type: "text" as const, text: `Message was not queued: ${message}` }],
            details: { error: message },
          };
        }
      },
    });

  // ── durable safe follow-up tool (root; children register it in subagent-done.ts) ──
  if (!process.env.PI_SUBAGENT_RUN_ID && shouldRegister("subagent_followup"))
    pi.registerTool({
      name: "subagent_followup",
      label: "Follow Up Subagent",
      description:
        "Queue a durable attributed message and safely wake an active team agent in its existing run. " +
        "If the target is busy, Pi queues the follow-up without interrupting its turn or tool calls. " +
        "The root coordinator is never a valid target.",
      parameters: Type.Object({
        target: Type.String({ description: "Target run ID, team path, or unique display name" }),
        message: Type.String({ description: "Message to deliver in the target's existing run" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const team = getTeamContext(ctx);
          const queued = await enqueueFollowupMessage(
            mailboxIdentityForContext(team),
            params.target,
            params.message,
            { provenance: rootMailboxState },
          );
          return {
            content: [{
              type: "text" as const,
              text:
                `Follow-up queued for ${queued.recipientName} (${queued.recipientPath}). ` +
                "Its target process will safely start or queue the next turn.",
            }],
            details: {
              id: queued.id,
              sequence: queued.sequence,
              targetRunId: queued.recipientRunId,
              targetPath: queued.recipientPath,
              status: "followup_queued",
            },
          };
        } catch (error) {
          const message = (error as Error).message;
          return {
            content: [{ type: "text" as const, text: `Follow-up was not queued: ${message}` }],
            details: { error: message },
          };
        }
      },
    });

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "Images attached to the current user message are saved as files and their absolute paths are added to the sub-agent task. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "Images attached to the current user message are saved as files and their absolute paths are added to the sub-agent task. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (reserves team capacity before creating a pane).
        let running: RunningSubagent;
        try {
          running = await launchSubagent(params, ctx);
        } catch (error: any) {
          const message = error?.message ?? String(error);
          return {
            content: [{ type: "text" as const, text: `Subagent launch failed: ${message}` }],
            details: { error: message },
          };
        }

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately
            if (result.detached || result.duplicate) return;

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    agent: running.agent,
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const presentation = resolveResultPresentation(result, running.name);

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            runId: running.runId,
            path: running.agentPath,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagents_team tool (runtime hierarchy; distinct from definition discovery) ──
  if (shouldRegister("subagents_team"))
    pi.registerTool({
      name: "subagents_team",
      label: "Subagent Team",
      description:
        "List this orchestration team's runtime hierarchy and normalized lifecycle status. " +
        "This is an activity snapshot, not a polling/wait tool.",
      promptSnippet:
        "List this orchestration team's runtime hierarchy. Do not repeatedly call it to wait for completion; terminal results arrive automatically.",
      parameters: Type.Object({
        pathPrefix: Type.Optional(Type.String({ description: "Optional canonical path prefix" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const team = getTeamContext(ctx);
        const agents = listTeamAgents(team, params.pathPrefix);
        const lines = agents.map((agent) =>
          `${agent.path} [${agent.status}] — ${agent.displayName}` +
          `${agent.role ? ` (${agent.role})` : ""} · ${agent.runId}` +
          `${agent.parentPath ? ` · parent ${agent.parentPath}` : ""}`,
        );
        return {
          content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No team agents found." }],
          details: { teamId: team.teamId, teamDir: team.teamDir, agents },
        };
      },
    });

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name override. Defaults to the original subagent name, otherwise 'Resume'." }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Restores the original launch policy. Defaults to true when no stored policy exists.",
          }),
        ),
        interactive: Type.Optional(
          Type.Boolean({ description: "Override interactive tracking for this resumed run." }),
        ),
        model: Type.Optional(Type.String({ description: "Override the stored launch model." })),
        thinking: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
            description: "Override the stored reasoning effort.",
          }),
        ),
        tools: Type.Optional(Type.String({ description: "Override the stored tool allowlist." })),
        skills: Type.Optional(Type.String({ description: "Override the stored skills policy." })),
        cwd: Type.Optional(Type.String({ description: "Override the stored working directory." })),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const startTime = Date.now();

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages.
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;
        const team = getTeamContext(ctx);
        let source = findResumeSource(team, params.sessionPath);
        if (source && source.status !== "completed" && source.status !== "errored") {
          return {
            content: [{ type: "text" as const, text: `Subagent resume failed: ${source.path} is still ${source.status}.` }],
            details: { error: "session is still active", runId: source.runId, path: source.path },
          };
        }
        if (source) {
          try {
            source = cleanupOwnedSurfaces(team, source);
          } catch (error) {
            const message = (error as Error).message;
            return {
              content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
              details: { error: message },
            };
          }
        }
        let restored: ReturnType<typeof resolveResumeLaunchBehavior>;
        try {
          restored = resolveResumeLaunchBehavior(params, source);
        } catch (error) {
          const message = (error as Error).message;
          return {
            content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
            details: { error: message },
          };
        }
        const { name, role, autoExit, interactive, model, thinking, tools, skills, cwd } = restored;
        const runId = source?.runId ?? randomUUID();
        const id = runId.slice(0, 8);
        let teamAgent: TeamAgentRecord;
        try {
          const reservation = {
            runId,
            displayName: name,
            ...(source ? { path: source.path, parentPath: source.parentPath ?? team.agentPath } : {}),
            ...(role ? { role } : {}),
            sessionPath: params.sessionPath,
            launchPolicy: {
              ...restored.launchPolicy,
              task: params.message ?? "resumed session",
              resumedAt: new Date().toISOString(),
            },
          };
          teamAgent = source
            ? await reserveAgentSlotForResume(team, {
              ...reservation,
              expectedPriorIncarnation: agentIncarnation(source),
            })
            : reserveAgentSlot(team, reservation);
        } catch (error) {
          const message = (error as Error).message;
          return {
            content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
            details: { error: message },
          };
        }
        let surface: string | undefined;
        let launchedOwnership: OwnedSurfaceRecord | undefined;
        try {
        const resumeBackend = getMuxBackend();
        if (!resumeBackend || !muxInstanceIdentity(resumeBackend)) {
          throw new Error("Mux instance identity is unavailable; refusing an unowned resume");
        }
        surface = createSurface(name);
        launchedOwnership = ownedSurfaceForTarget(surface);
        if (!launchedOwnership) throw new Error("Mux did not return a safely owned surface identity");
        activateAgentSurface(team, runId, launchedOwnership, agentIncarnation(teamAgent));
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        const forcedExtension = process.env.PI_SUBAGENT_EXTENSION_SOURCE?.trim();
        if (forcedExtension) parts.push("-ne", "-e", shellEscape(forcedExtension));
        parts.push("-e", shellEscape(subagentDonePath));

        const resumeModelSpec = buildPiModelSpec(model, thinking);
        if (resumeModelSpec) parts.push("--model", shellEscape(resumeModelSpec));
        const resumeToolAllowlist = buildSubagentToolAllowlist(tools);
        if (resumeToolAllowlist) parts.push("--tools", shellEscape(resumeToolAllowlist));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        const identity = stringPolicy(restored.launchPolicy, "identity") ??
          stringPolicy(restored.launchPolicy, "systemPrompt");
        const systemPromptMode = stringPolicy(restored.launchPolicy, "systemPromptMode");
        if (identity && (systemPromptMode === "append" || systemPromptMode === "replace")) {
          const syspromptPath = join(artifactDir, "subagent-resume", `${id}-sysprompt.md`);
          mkdirSync(dirname(syspromptPath), { recursive: true });
          writeFileSync(syspromptPath, identity, "utf8");
          parts.push(
            systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
            shellEscape(syspromptPath),
          );
        }

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
        }

        for (const promptArg of buildPiPromptArgs({
          effectiveSkills: skills,
          taskDelivery: "artifact",
          ...(resumeMsgFile ? { taskArg: `@${resumeMsgFile}` } : {}),
        })) {
          parts.push(shellEscape(promptArg));
        }

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        for (const [key, value] of Object.entries(modelEnvironment(model, thinking))) {
          resumeEnvParts.push(`${key}=${shellEscape(value)}`);
        }
        for (const [key, value] of Object.entries(teamEnvironment(team, teamAgent))) {
          resumeEnvParts.push(`${key}=${shellEscape(value)}`);
        }
        const resumedLocalAgentDir = cwd ? join(cwd, ".pi", "agent") : null;
        if (resumedLocalAgentDir && existsSync(resumedLocalAgentDir)) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumedLocalAgentDir)}`);
        } else if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
        }
        resumeEnvParts.push(
          `PI_DENY_TOOLS=${shellEscape(persistedDenyTools(restored.launchPolicy))}`,
        );
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        if (role) resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(role)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        const resumeCdPrefix = cwd ? `cd ${shellEscape(cwd)} && ` : "";
        const command = `${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        updateAgent(team, runId, {
          launchPolicy: {
            ...teamAgent.launchPolicy,
            activityFile,
            launchScriptFile,
          },
        }, agentIncarnation(teamAgent));
        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          runId,
          incarnation: agentIncarnation(teamAgent),
          agentPath: teamAgent.path,
          team,
          name,
          task: params.message ?? "resumed session",
          agent: role,
          surface,
          ownedSurface: launchedOwnership,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();
            if (result.detached || result.duplicate) return;

            if (result.ping) {
              const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: params.sessionPath,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: params.sessionPath },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            runId,
            path: teamAgent.path,
            launchScriptFile,
            status: "started",
          },
        };
        } catch (error) {
          if (launchedOwnership) {
            let failedSurfaceState: "closed" | "close_failed" = "closed";
            try {
              closeOwnedSurface(launchedOwnership);
            } catch {
              failedSurfaceState = "close_failed";
            }
            try {
              markAgentSurface(
                team,
                runId,
                launchedOwnership.id,
                failedSurfaceState,
                agentIncarnation(teamAgent),
              );
            } catch {
              // A newer incarnation owns metadata; rollback below still removes only our lease.
            }
          }
          if (source) {
            await restoreAgentAfterFailedResume(team, source, agentIncarnation(teamAgent));
          } else {
            await abandonAgentReservation(team, runId, agentIncarnation(teamAgent));
          }
          const message = (error as any)?.message ?? String(error);
          return {
            content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
            details: { error: message },
          };
        }
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
// test
