/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  createFollowupWakeController,
  deliverMailboxAtTurnBoundary,
  enqueueFollowupMessage,
  enqueueMailboxMessage,
  mailboxIdentityFromEnvironment,
  type FollowupWakeController,
  type MailboxDeliveryState,
  type MailboxIdentity,
} from "./mailbox.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const FOLLOWUP_CONTROLLER_KEY = Symbol.for("pi-subagents/followup-wake-controller");
const MAX_SETTLE_RETRIES = 3;
const SETTLE_RETRY_DELAYS_MS = [10, 50, 200] as const;

interface FollowupReloadState {
  runId: string;
  controller: FollowupWakeController;
  cancelPendingLifecycle?: () => void;
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  let mailboxIdentity: MailboxIdentity | null = null;
  const mailboxState: MailboxDeliveryState = { hops: 0, route: [] };

  function getMailboxIdentity(): MailboxIdentity {
    mailboxIdentity ??= mailboxIdentityFromEnvironment();
    return mailboxIdentity;
  }

  let followupController: FollowupWakeController | null = null;
  let followupReloadState: FollowupReloadState | null = null;
  if (process.env.PI_SUBAGENT_TEAM_DIR && process.env.PI_SUBAGENT_RUN_ID) {
    const stored = (globalThis as any)[FOLLOWUP_CONTROLLER_KEY] as
      | FollowupReloadState
      | FollowupWakeController
      | undefined;
    // Accept the pre-reload controller-only shape when this extension replaces
    // an older in-memory copy.
    const previousState = stored && "controller" in stored ? stored : undefined;
    const previous = previousState?.controller ??
      (stored && "runId" in stored && "settle" in stored ? stored : undefined);
    const inheritArmed = previous?.runId === process.env.PI_SUBAGENT_RUN_ID && previous.wakeArmed;
    const inheritActivity = previous?.runId === process.env.PI_SUBAGENT_RUN_ID;
    const inheritedIds = inheritArmed ? [...(previous?.armedMessageIds ?? [])] : [];
    previousState?.cancelPendingLifecycle?.();
    previous?.dispose();
    followupController = createFollowupWakeController(pi, getMailboxIdentity(), {
      initialWakeArmed: inheritArmed,
      initialArmedIds: inheritedIds,
      initialWakeToken: inheritArmed ? previous?.wakeToken ?? undefined : undefined,
      // Same-process extension reloads preserve whether this run was already
      // quiescent. A genuinely new process has no prior controller and starts
      // active until its initial prompt reaches agent_end.
      initialActive: inheritActivity ? previous!.active : true,
      deliveryState: mailboxState,
    });
    followupReloadState = {
      runId: process.env.PI_SUBAGENT_RUN_ID,
      controller: followupController,
    };
    (globalThis as any)[FOLLOWUP_CONTROLLER_KEY] = followupReloadState;
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let lifecycleGeneration = 0;
  let latestAgentEnd: { generation: number; wakeCount: number; event: any; ctx: any } | null = null;
  const settleHandles = new Set<NodeJS.Immediate>();
  const settleRetryHandles = new Map<number, NodeJS.Timeout>();
  const settleRetryAttempts = new Map<number, number>();
  const settlingGenerations = new Set<number>();
  const settledGenerations = new Set<number>();
  let lifecycleCancelled = false;

  function cancelPendingLifecycle(): void {
    lifecycleCancelled = true;
    for (const handle of settleHandles) clearImmediate(handle);
    settleHandles.clear();
    for (const handle of settleRetryHandles.values()) clearTimeout(handle);
    settleRetryHandles.clear();
    settleRetryAttempts.clear();
    settlingGenerations.clear();
    latestAgentEnd = null;
  }

  if (followupReloadState) {
    followupReloadState.cancelPendingLifecycle = cancelPendingLifecycle;
  }

  function markLifecycleActive(): void {
    lifecycleGeneration++;
    for (const handle of settleHandles) clearImmediate(handle);
    settleHandles.clear();
    for (const handle of settleRetryHandles.values()) clearTimeout(handle);
    settleRetryHandles.clear();
    settleRetryAttempts.clear();
    settledGenerations.clear();
    latestAgentEnd = null;
    followupController?.markActive();
  }

  function scheduleSettleRetry(
    generation: number,
    wakeCountAtEnd: number,
    event: any,
    ctx: any,
  ): void {
    if (lifecycleCancelled || generation !== lifecycleGeneration || settledGenerations.has(generation) ||
        settleRetryHandles.has(generation)) return;
    const attempt = (settleRetryAttempts.get(generation) ?? 0) + 1;
    if (attempt > MAX_SETTLE_RETRIES) return;
    settleRetryAttempts.set(generation, attempt);
    const handle = setTimeout(() => {
      settleRetryHandles.delete(generation);
      void settleAgent(generation, wakeCountAtEnd, event, ctx);
    }, SETTLE_RETRY_DELAYS_MS[attempt - 1]);
    handle.unref?.();
    settleRetryHandles.set(generation, handle);
  }

  async function settleAgent(
    generation: number,
    wakeCountAtEnd: number,
    event: any,
    ctx: any,
  ): Promise<void> {
    if (lifecycleCancelled) return;
    if (generation !== lifecycleGeneration) return;
    if (settledGenerations.has(generation)) return;
    if (settlingGenerations.has(generation)) return;
    settlingGenerations.add(generation);
    try {
      await followupController?.settle();
      if (lifecycleCancelled) return;
      // A batch armed by this quiescent drain owns the next Pi turn. Never let
      // synchronous test/session persistence turn that send into same-tick exit.
      if (followupController?.wakeArmed ||
          (followupController?.wakeCount ?? 0) > wakeCountAtEnd) {
        settledGenerations.add(generation);
        settleRetryAttempts.delete(generation);
        return;
      }
      if (generation !== lifecycleGeneration) return;

      const messages = event?.messages as any[] | undefined;
      let shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);
      if (shouldExit && followupController) {
        shouldExit = !(await followupController.prepareAutoExit());
      }
      if (lifecycleCancelled || generation !== lifecycleGeneration) return;

      settledGenerations.add(generation);
      settleRetryAttempts.delete(generation);
      const retryHandle = settleRetryHandles.get(generation);
      if (retryHandle) clearTimeout(retryHandle);
      settleRetryHandles.delete(generation);
      if (!shouldExit) return;

      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }));
        } catch {}
      }
      recorder.agentEndDone();
      ctx.shutdown();
    } catch {
      scheduleSettleRetry(generation, wakeCountAtEnd, event, ctx);
    } finally {
      settlingGenerations.delete(generation);
    }
  }

  function scheduleSettledFallback(event: any, ctx: any): void {
    const generation = lifecycleGeneration;
    const wakeCount = followupController?.wakeCount ?? 0;
    latestAgentEnd = { generation, wakeCount, event, ctx };
    const handle = setImmediate(() => {
      settleHandles.delete(handle);
      void settleAgent(generation, wakeCount, event, ctx).catch(() => {});
    });
    settleHandles.add(handle);
  }

  // Show widget + status bar on session start
  pi.on("session_start", async (_event, ctx) => {
    recorder.sessionStart();
    try {
      await followupController?.setPersistence(ctx.sessionManager);
    } finally {
      // First scan precedes installation; start() installs and scans again.
      followupController?.start();
    }
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    markLifecycleActive();
    recorder.beforeAgentStart();
    if (!process.env.PI_SUBAGENT_TEAM_DIR) return;
    await followupController?.reconcilePersistence();
    // A target-local follow-up already owns its exact inflight batch. A normal
    // prompt must not inject that batch a second time before custom persistence.
    if (followupController?.wakeArmed) return;
    await deliverMailboxAtTurnBoundary(
      pi,
      getMailboxIdentity(),
      mailboxState,
      {},
      ctx.sessionManager,
    );
    await followupController?.scanAndWake();
  });

  pi.on("agent_start", () => {
    markLifecycleActive();
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    recorder.agentEndWaiting();
    if (autoExit) {
      userTookOver = false;
    }
    // Never send or resend from agent_end. Upstream Pi 0.65 lacks an extension
    // settled event, so a guarded macrotask observes true quiescence instead.
    scheduleSettledFallback(event as any, ctx);
  });

  try {
    (pi.on as any)("agent_settled", () => {
      const pending = latestAgentEnd;
      if (!pending) return;
      void settleAgent(
        pending.generation,
        pending.wakeCount,
        pending.event,
        pending.ctx,
      ).catch(() => {});
    });
  } catch {}

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("message_start", (event) => {
    followupController?.observeMessage((event as any).message);
  });

  pi.on("message_end", (event) => {
    followupController?.observeMessage((event as any).message);
    // Pi 0.65 persists custom entries immediately after extension message_end
    // handlers return. The next event-loop phase observes only the durable entry.
    setImmediate(() => { void followupController?.reconcilePersistence().catch(() => {}); });
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    cancelPendingLifecycle();
    settledGenerations.clear();
    recorder.sessionShutdown((event as any).reason);
    followupController?.dispose();
    if ((event as any).reason !== "reload" &&
        (globalThis as any)[FOLLOWUP_CONTROLLER_KEY] === followupReloadState) {
      (globalThis as any)[FOLLOWUP_CONTROLLER_KEY] = null;
    }
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    description:
      "Queue a durable direct message for another active agent in this subagent team. " +
      "The message is delivered at the target's next agent-turn boundary and never wakes or starts an idle target. " +
      "Targets may be an exact run ID, canonical or relative team path, unique display name, or root.",
    parameters: Type.Object({
      target: Type.String({ description: "Recipient run ID, team path, unique name, or root" }),
      message: Type.String({ description: "Message to queue for the recipient" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const queued = await enqueueMailboxMessage(
          getMailboxIdentity(),
          params.target,
          params.message,
          { provenance: mailboxState },
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

  pi.registerTool({
    name: "subagent_followup",
    label: "Follow Up Subagent",
    description:
      "Queue a durable attributed message and safely wake the target in its existing run. " +
      "If the target is active, Pi queues the follow-up without interrupting its turn or tool calls. " +
      "The root coordinator, this agent, terminal agents, and agents outside this team are invalid targets.",
    parameters: Type.Object({
      target: Type.String({ description: "Target run ID, team path, or unique display name" }),
      message: Type.String({ description: "Message to deliver in the target's existing run" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const queued = await enqueueFollowupMessage(
          getMailboxIdentity(),
          params.target,
          params.message,
          { provenance: mailboxState },
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

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
