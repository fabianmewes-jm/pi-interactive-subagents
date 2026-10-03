/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect available mux backends (cmux, tmux, zellij)
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in mux surfaces
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  getMuxBackend,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendEscape,
  shellEscape,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxPaneRefForSurfaceFromJson,
  type MuxBackend,
} from "../../pi-extension/subagents/cmux.ts";

// Re-export mux primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendEscape,
  shellEscape,
};
export type { MuxBackend };

export interface CmuxSurfaceSnapshot {
  ref: string;
  title: string;
}

const STABLE_CMUX_ID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

export function isStableCmuxSurfaceId(value: unknown): value is string {
  return typeof value === "string" && STABLE_CMUX_ID.test(value);
}

/** Parse stable surface refs and titles from `cmux tree --all`. */
export function parseCmuxSurfaceSnapshot(tree: string): CmuxSurfaceSnapshot[] {
  const surfaces: CmuxSurfaceSnapshot[] = [];
  for (const line of tree.split("\n")) {
    const match = line.match(/\bsurface\s+(surface:\d+)\b[^\n]*?"([^"]*)"/);
    if (match) surfaces.push({ ref: match[1], title: match[2] });
  }
  return surfaces;
}

function parseCmuxJsonSurfaceSnapshot(tree: string): CmuxSurfaceSnapshot[] {
  const parsed = JSON.parse(tree) as any;
  const surfaces: CmuxSurfaceSnapshot[] = [];
  for (const window of parsed.windows ?? []) {
    for (const workspace of window.workspaces ?? []) {
      for (const pane of workspace.panes ?? []) {
        for (const surface of pane.surfaces ?? []) {
          if (surface.id) surfaces.push({ ref: surface.id, title: surface.title ?? "" });
        }
      }
    }
  }
  return surfaces;
}

export function snapshotCmuxSurfaces(): CmuxSurfaceSnapshot[] | null {
  try {
    return parseCmuxJsonSurfaceSnapshot(
      execFileSync("cmux", ["--json", "--id-format", "both", "tree", "--all"], {
        encoding: "utf8",
      }),
    );
  } catch {
    return null;
  }
}

/** Select only newly-created surfaces whose title belongs to one scenario. */
export function selectNewCmuxScenarioSurfaces(
  before: readonly CmuxSurfaceSnapshot[],
  after: readonly CmuxSurfaceSnapshot[],
  titleFragment: string,
): string[] {
  const preexisting = new Set(before.map((surface) => surface.ref));
  return after
    .filter((surface) => !preexisting.has(surface.ref) && surface.title.includes(titleFragment))
    .map((surface) => surface.ref);
}

/** Best-effort cleanup guarded against closing any surface that predated the scenario. */
export interface CmuxCleanupOperations {
  snapshot?: () => CmuxSurfaceSnapshot[] | null;
  close?: (ref: string) => void;
}

export function cleanupCmuxScenarioSurfaces(
  before: readonly CmuxSurfaceSnapshot[] | null,
  titleFragment: string,
  explicitRefs: readonly string[] = [],
  operations: CmuxCleanupOperations = {},
): string[] {
  if (!before) return [];
  const takeSnapshot = operations.snapshot ?? snapshotCmuxSurfaces;
  const close = operations.close ?? closeSurface;
  const preexisting = new Set(before.map((surface) => surface.ref));
  const current = takeSnapshot();
  if (!current) return [];
  const currentByRef = new Map<string, CmuxSurfaceSnapshot[]>();
  for (const surface of current) {
    currentByRef.set(surface.ref, [...(currentByRef.get(surface.ref) ?? []), surface]);
  }
  const ownsCurrentRef = (ref: string) => {
    const matches = currentByRef.get(ref) ?? [];
    return isStableCmuxSurfaceId(ref) &&
      matches.length === 1 && matches[0].title.includes(titleFragment);
  };
  const candidates = new Set<string>();
  const alreadyAbsent = new Set<string>();
  for (const ref of explicitRefs) {
    if (!isStableCmuxSurfaceId(ref) || preexisting.has(ref)) continue;
    const matches = currentByRef.get(ref) ?? [];
    if (matches.length === 0) alreadyAbsent.add(ref);
    else if (ownsCurrentRef(ref)) candidates.add(ref);
  }
  const closeSucceeded = new Set<string>();
  for (const ref of candidates) {
    try {
      close(ref);
      closeSucceeded.add(ref);
    } catch {}
  }
  const final = takeSnapshot();
  if (!final) return [];
  const remaining = new Set(final.map((surface) => surface.ref));
  return [...new Set([...alreadyAbsent, ...closeSucceeded])]
    .filter((ref) => !remaining.has(ref));
}

export interface RegistryOwnedCmuxSurface {
  ref: string;
  titleFragment: string;
  ambiguous?: boolean;
  ownershipClaims: string[];
}

export function collectRegistryOwnedCmuxSurfaces(teamDir: string): RegistryOwnedCmuxSurface[] {
  const agentsDir = join(teamDir, "agents");
  if (!teamDir || !existsSync(agentsDir)) return [];
  const ownership = new Map<string, Map<string, string>>();
  for (const name of readdirSync(agentsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(agentsDir, name), "utf8"));
      const titleFragment = typeof record.displayName === "string" ? record.displayName : "";
      if (!titleFragment) continue;
      const refs = [
        record.surface,
        ...(Array.isArray(record.surfaces) ? record.surfaces.map((surface: any) => surface?.id) : []),
      ];
      for (const ref of new Set(refs)) {
        if (!isStableCmuxSurfaceId(ref)) continue;
        const claims = ownership.get(ref) ?? new Map<string, string>();
        claims.set(name, titleFragment);
        ownership.set(ref, claims);
      }
    } catch {}
  }
  return [...ownership].map(([ref, claims]) => {
    const titles = [...new Set(claims.values())].sort();
    const ownershipClaims = [...claims]
      .map(([record, title]) => `${record}:${title}`)
      .sort();
    return {
      ref,
      titleFragment: titles.join(" | "),
      ambiguous: claims.size > 1 || undefined,
      ownershipClaims,
    };
  });
}

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "openai-codex/gpt-5.6-sol";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/**
 * Detect which mux backends are actually available in the current environment.
 * Temporarily sets PI_SUBAGENT_MUX to probe each backend.
 */
export function getAvailableBackends(): MuxBackend[] {
  const backends: MuxBackend[] = [];
  const orig = process.env.PI_SUBAGENT_MUX;

  for (const backend of ["cmux", "tmux", "zellij"] as MuxBackend[]) {
    process.env.PI_SUBAGENT_MUX = backend;
    try {
      if (getMuxBackend() === backend) backends.push(backend);
    } catch {}
  }

  if (orig === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = orig;

  return backends;
}

export function setBackend(backend: MuxBackend): string | undefined {
  const prev = process.env.PI_SUBAGENT_MUX;
  process.env.PI_SUBAGENT_MUX = backend;
  return prev;
}

export function restoreBackend(prev: string | undefined): void {
  if (prev === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = prev;
}

export function focusSurface(backend: MuxBackend, surface: string): void {
  if (backend === "cmux") {
    const pane = getSurfacePane(backend, surface);
    if (pane) execFileSync("cmux", ["focus-pane", "--pane", pane], { encoding: "utf8" });
    execFileSync("cmux", ["focus-panel", "--panel", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["select-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  throw new Error(`Focus helpers are not implemented for ${backend}`);
}

export function getFocusedSurface(backend: MuxBackend): string | null {
  if (backend === "cmux") {
    const info = execFileSync(
      "cmux",
      ["--json", "--id-format", "both", "identify"],
      { encoding: "utf8" },
    );
    const focused = parseCmuxFocusedSnapshotFromJson(info);
    return focused?.surfaceId ?? focused?.surfaceRef ?? null;
  }

  if (backend === "tmux") {
    try {
      const panes = execFileSync("tmux", ["list-panes", "-F", "#{pane_id} #{pane_active}"], {
        encoding: "utf8",
      });
      const activeLine = panes.split("\n").find((line) => line.endsWith(" 1"));
      return activeLine?.split(" ")[0] ?? null;
    } catch {
      return null;
    }
  }

  throw new Error(`Focus helpers are not implemented for ${backend}`);
}

export function getSurfacePane(backend: MuxBackend, surface: string): string | null {
  if (backend === "cmux") {
    const info = execFileSync(
      "cmux",
      ["--json", "--id-format", "both", "identify", "--surface", surface],
      { encoding: "utf8" },
    );
    return parseCmuxPaneRefForSurfaceFromJson(info, surface);
  }

  if (backend === "tmux") return surface;

  throw new Error(`Pane lookup is not implemented for ${backend}`);
}

export async function waitForFocusedSurface(
  backend: MuxBackend,
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface(backend) === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
      `current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TrackedSurface {
  ref: string;
  cmuxOwnership?: {
    baseline: readonly CmuxSurfaceSnapshot[] | null;
    titleFragment: string;
    ambiguous?: boolean;
    ownershipClaims?: readonly string[];
  };
}

export interface TrackedTeam {
  dir: string;
  /** Harness-created root surface that owns this team's watcher process. */
  rootRef: string;
}

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Active mux backend for this test run */
  backend: MuxBackend;
  /** Surfaces created during the test (cleaned up automatically) */
  surfaces: TrackedSurface[];
  /** Temp files to clean up */
  tempFiles: string[];
  /** Stable UUID baseline captured before this scenario creates any surface. */
  cmuxBaseline: readonly CmuxSurfaceSnapshot[] | null;
  /** Team registries explicitly associated with their harness root surface. */
  teams: TrackedTeam[];
  /** Exact stable IDs ever proven owned by this scenario, including closed IDs. */
  surfaceHistory: TrackedSurface[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(backend: MuxBackend): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  return {
    dir,
    backend,
    surfaces: [],
    tempFiles: [],
    cmuxBaseline: backend === "cmux" ? snapshotCmuxSurfaces() : null,
    teams: [],
    surfaceHistory: [],
  };
}

export function trackTeamDir(env: TestEnv, teamDir: string, rootRef: string): void {
  if (!teamDir || !rootRef) throw new Error("team cleanup requires an explicit harness root surface");
  if (env.backend === "cmux" && !isStableCmuxSurfaceId(rootRef)) {
    throw new Error(`team cleanup requires a stable cmux root UUID: ${rootRef}`);
  }
  const existing = env.teams.find((team) => team.dir === teamDir);
  if (existing && existing.rootRef !== rootRef) {
    throw new Error(`team ${teamDir} has conflicting harness roots: ${existing.rootRef}, ${rootRef}`);
  }
  if (!existing) env.teams.push({ dir: teamDir, rootRef });
}

export function trackRegistryOwnedSurfaces(env: TestEnv): RegistryOwnedCmuxSurface[] {
  if (env.backend !== "cmux") return [];
  const claims = env.teams.flatMap((team) =>
    collectRegistryOwnedCmuxSurfaces(team.dir).map((owned) => ({ teamDir: team.dir, owned })),
  );
  const collected = [...new Set(claims.map(({ owned }) => owned.ref))].map((ref) => {
    const matching = claims.filter(({ owned }) => owned.ref === ref);
    const titles = [...new Set(matching.flatMap(({ owned }) => owned.titleFragment.split(" | ")))].sort();
    const ownershipClaims = matching.flatMap(({ teamDir, owned }) =>
      owned.ownershipClaims.map((claim) => `${teamDir}/${claim}`)
    ).sort();
    return {
      ref,
      titleFragment: titles.join(" | "),
      ambiguous: matching.length > 1 || matching.some(({ owned }) => owned.ambiguous) || undefined,
      ownershipClaims,
    };
  });
  for (const owned of collected) {
    const existing = env.surfaces.find((surface) => surface.ref === owned.ref);
    if (existing) {
      if (owned.ambiguous && existing.cmuxOwnership) {
        existing.cmuxOwnership.ambiguous = true;
        existing.cmuxOwnership.titleFragment = owned.titleFragment;
        existing.cmuxOwnership.ownershipClaims = owned.ownershipClaims;
      }
      continue;
    }
    const tracked = {
      ref: owned.ref,
      cmuxOwnership: {
        baseline: env.cmuxBaseline,
        titleFragment: owned.titleFragment,
        ambiguous: owned.ambiguous,
        ownershipClaims: owned.ownershipClaims,
      },
    };
    env.surfaces.push(tracked);
    env.surfaceHistory.push(tracked);
  }
  return collected;
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTrackedSurfaces(
  env: TestEnv,
  operations: CmuxCleanupOperations = {},
): string[] {
  const confirmedClosed: string[] = [];
  const remaining: TrackedSurface[] = [];
  const close = operations.close ?? closeSurface;
  // Descendants are registered after their root. Close in reverse ownership
  // order so a root watcher remains alive until child surfaces are gone.
  for (const tracked of [...env.surfaces].reverse()) {
    if (env.backend === "cmux" && tracked.cmuxOwnership) {
      if (tracked.cmuxOwnership.ambiguous) {
        const current = (operations.snapshot ?? snapshotCmuxSurfaces)();
        const preexisting = tracked.cmuxOwnership.baseline?.some((surface) => surface.ref === tracked.ref);
        if (current && !preexisting && !current.some((surface) => surface.ref === tracked.ref)) {
          confirmedClosed.push(tracked.ref);
        } else {
          remaining.push(tracked);
        }
        continue;
      }
      const closed = cleanupCmuxScenarioSurfaces(
        tracked.cmuxOwnership.baseline,
        tracked.cmuxOwnership.titleFragment,
        [tracked.ref],
        operations,
      );
      if (closed.includes(tracked.ref)) confirmedClosed.push(tracked.ref);
      else remaining.push(tracked);
      continue;
    }
    try {
      close(tracked.ref);
      confirmedClosed.push(tracked.ref);
    } catch {
      remaining.push(tracked);
    }
  }
  env.surfaces = remaining.reverse();
  return confirmedClosed;
}

export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  await cleanupTestEnvVerified(env);
}

export async function cleanupTestEnvVerified(
  env: TestEnv,
  timeout = 10_000,
  operations: CmuxCleanupOperations = {},
): Promise<void> {
  trackRegistryOwnedSurfaces(env);
  const ownedRefs = [...new Set(env.surfaces.map((surface) => surface.ref))];
  const rootRefs = new Set(env.teams.map((team) => team.rootRef));
  const descendants: Array<{ path: string; teamDir: string; runId: string }> = [];
  for (const team of env.teams) {
    const agentsDir = join(team.dir, "agents");
    if (!existsSync(agentsDir)) continue;
    for (const name of readdirSync(agentsDir).filter((entry) => entry.endsWith(".json"))) {
      try {
        const path = join(agentsDir, name);
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (record.parentPath !== null && typeof record.runId === "string") {
          descendants.push({ path, teamDir: team.dir, runId: record.runId });
        }
      } catch {}
    }
  }

  // Keep explicitly associated roots alive while descendants disappear and
  // their root-owned watchers persist terminal metadata and release leases.
  const deferredRoots = env.surfaces.filter((surface) => rootRefs.has(surface.ref));
  env.surfaces = env.surfaces.filter((surface) => !rootRefs.has(surface.ref));
  const descendantCleanupStart = Date.now();
  do {
    cleanupTrackedSurfaces(env, operations);
    if (env.surfaces.length === 0) break;
    await sleep(200);
  } while (Date.now() - descendantCleanupStart < timeout);
  let watcherFailure: unknown;
  if (env.surfaces.length === 0 && descendants.length > 0) {
    try {
      await waitForCondition("descendant watcher finalization before root cleanup", () => {
        const current = env.backend === "cmux"
          ? (operations.snapshot ?? snapshotCmuxSurfaces)()
          : [];
        if (!current) return false;
        const recordsFinal = descendants.every((descendant) => {
          const record = JSON.parse(readFileSync(descendant.path, "utf8"));
          return ["completed", "errored"].includes(record.status) &&
            (!Array.isArray(record.surfaces) || record.surfaces.every((surface: any) =>
              surface.state !== "active" && !current.some((visible) => visible.ref === surface.id)
            ));
        });
        if (!recordsFinal) return false;
        return descendants.every((descendant) => {
          const leasesDir = join(descendant.teamDir, "leases");
          if (!existsSync(leasesDir)) return true;
          return readdirSync(leasesDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
            .every((entry) => {
              try {
                const owner = JSON.parse(readFileSync(join(leasesDir, entry.name, "owner.json"), "utf8"));
                return owner.runId !== descendant.runId;
              } catch {
                return false;
              }
            });
        });
      }, timeout, 200);
    } catch (error) {
      watcherFailure = error;
    }
  }

  env.surfaces.push(...deferredRoots);
  if (env.surfaces.some((surface) => !rootRefs.has(surface.ref)) || watcherFailure) {
    const unresolvedDescendants = env.surfaces
      .filter((surface) => !rootRefs.has(surface.ref))
      .map((surface) => {
        const claims = surface.cmuxOwnership?.ownershipClaims;
        return `${surface.ref}${surface.cmuxOwnership?.ambiguous
          ? ` (ambiguous registry claims: ${claims?.join(", ") || "unavailable"})`
          : ""}`;
      });
    throw new Error(
      `Scenario cleanup retained roots while descendants were unresolved: ` +
      `${env.surfaces.map((surface) => surface.ref).join(", ")}; ` +
      `unresolved descendants: ${unresolvedDescendants.join(", ") || "watcher finalization"}; ` +
      `all registered ownership: ${ownedRefs.join(", ")}` +
      (watcherFailure instanceof Error ? `; watcher finalization: ${watcherFailure.message}` : ""),
    );
  }

  const start = Date.now();
  do {
    cleanupTrackedSurfaces(env, operations);
    if (env.surfaces.length === 0) break;
    await sleep(200);
  } while (Date.now() - start < timeout);

  if (env.surfaces.length > 0) {
    throw new Error(
      `Scenario cleanup left owned cmux surfaces: ${env.surfaces.map((surface) => surface.ref).join(", ")}; ` +
      `all registered ownership: ${ownedRefs.join(", ")}`,
    );
  }

  for (const file of env.tempFiles) {
    try { unlinkSync(file); } catch {}
  }
  try { rmSync(env.dir, { recursive: true, force: true }); } catch {}
}


/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(
  env: TestEnv,
  name: string,
  options: { cmuxOwnership?: TrackedSurface["cmuxOwnership"] } = {},
): string {
  const automaticOwnership = env.backend === "cmux" && !options.cmuxOwnership
    ? { baseline: env.cmuxBaseline, titleFragment: name }
    : undefined;
  const surface = createSurface(name);
  const tracked = {
    ref: surface,
    cmuxOwnership: options.cmuxOwnership ?? automaticOwnership,
  };
  env.surfaces.push(tracked);
  env.surfaceHistory.push(tracked);
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const surface = createSurfaceSplit(name, direction, fromSurface);
  const tracked = { ref: surface };
  env.surfaces.push(tracked);
  env.surfaceHistory.push(tracked);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((tracked) => tracked.ref !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `PI_SUBAGENT_EXTENSION_SOURCE=${shellEscape(EXTENSION_SOURCE)}`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

export async function assertConditionFor(
  description: string,
  predicate: () => boolean,
  duration: number,
  interval = 200,
): Promise<void> {
  const start = Date.now();
  do {
    if (!predicate()) throw new Error(`Condition failed during bounded observation: ${description}`);
    await sleep(interval);
  } while (Date.now() - start < duration);
  if (!predicate()) throw new Error(`Condition failed at end of bounded observation: ${description}`);
}

export async function waitForCondition(
  description: string,
  predicate: () => boolean,
  timeout: number = PI_TIMEOUT,
  interval = 200,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for ${description}` +
      (lastError instanceof Error ? `; last error: ${lastError.message}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
