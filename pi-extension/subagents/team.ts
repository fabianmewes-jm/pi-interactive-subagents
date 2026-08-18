import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_TEAM_THREAD_CAP = 4;
export const ROOT_AGENT_PATH = "/root";

export type TeamAgentStatus =
  | "starting"
  | "running"
  | "waiting"
  | "interrupted"
  | "completed"
  | "errored";

export interface LaunchPolicy {
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  cwd?: string;
  agent?: string;
  interactive?: boolean;
  autoExit?: boolean;
  cli?: string;
  [key: string]: unknown;
}

export interface TeamAgentRecord {
  version: 1;
  teamId: string;
  runId: string;
  path: string;
  parentPath: string | null;
  displayName: string;
  role?: string;
  sessionPath: string;
  surface?: string;
  status: TeamAgentStatus;
  slot: number;
  ownerPid: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  launchPolicy: LaunchPolicy;
}

export interface TeamContext {
  teamId: string;
  teamDir: string;
  agentPath: string;
  parentPath: string | null;
  threadCap: number;
}

export interface ReserveAgentInput {
  displayName: string;
  /** Optional stable path segment, separate from the user-facing display name. */
  taskName?: string;
  /** Reuse an existing canonical path when restoring a previous run. */
  path?: string;
  role?: string;
  sessionPath: string;
  launchPolicy?: LaunchPolicy;
  runId?: string;
  parentPath?: string;
  ownerPid?: number;
  now?: Date;
}

const TERMINAL = new Set<TeamAgentStatus>(["completed", "errored"]);
const MAILBOX_COMMIT_LOCK_TIMEOUT_MS = 2_000;
const MAILBOX_COMMIT_STALE_MS = 30_000;
const LIFECYCLE_COMMIT_LOCK_TIMEOUT_MS = 65_000;

export interface TeamMailboxCommitLockOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function mailboxCommitLockPath(teamDir: string): string {
  return join(teamDir, "mailboxes", ".commit.lock");
}

function tryAcquireMailboxCommitLock(
  teamDir: string,
  options: TeamMailboxCommitLockOptions = {},
): (() => void) | null {
  const path = mailboxCommitLockPath(teamDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const token = randomUUID();
  atomicWriteJson(join(path, "owner.json"), {
    token,
    pid: process.pid,
    acquiredAt: (options.now ?? Date.now)(),
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readJson<{ token?: string }>(join(path, "owner.json"))?.token !== token) return;
    rmSync(path, { recursive: true, force: true });
  };
}

export async function acquireTeamMailboxCommitLock(
  teamDir: string,
  options: TeamMailboxCommitLockOptions = {},
): Promise<() => void> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const timeout = options.lockTimeoutMs ?? MAILBOX_COMMIT_LOCK_TIMEOUT_MS;
  const staleAfter = options.staleLockMs ?? MAILBOX_COMMIT_STALE_MS;
  const poll = options.lockPollMs ?? 10;
  const path = mailboxCommitLockPath(teamDir);
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (;;) {
    const release = tryAcquireMailboxCommitLock(teamDir, options);
    if (release) return release;
    try {
      const age = clock() - statSync(path).mtimeMs;
      const owner = readJson<{ pid?: number }>(join(path, "owner.json"));
      const ownerIsDead = owner?.pid != null && !processAlive(owner.pid);
      const invalidOwnerIsStale = owner?.pid == null && age >= staleAfter;
      if (ownerIsDead || invalidOwnerIsStale) {
        const stale = `${path}.stale.${process.pid}.${randomUUID()}`;
        try {
          renameSync(path, stale);
          rmSync(stale, { recursive: true, force: true });
          continue;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (clock() - started >= timeout) {
      throw new Error(`Mailbox commit lock timed out after ${timeout}ms.`);
    }
    await wait(Math.max(0, poll));
  }
}

function acquireLifecycleMailboxCommitLock(teamDir: string): Promise<() => void> {
  return acquireTeamMailboxCommitLock(teamDir, {
    lockTimeoutMs: LIFECYCLE_COMMIT_LOCK_TIMEOUT_MS,
    staleLockMs: MAILBOX_COMMIT_STALE_MS,
  });
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function metadataPath(teamDir: string, runId: string): string {
  return join(teamDir, "agents", `${runId}.json`);
}

function leaseDir(teamDir: string, slot: number): string {
  return join(teamDir, "leases", String(slot));
}

function leaseRecordPath(teamDir: string, slot: number): string {
  return join(leaseDir(teamDir, slot), "owner.json");
}

function acquireLease(
  teamDir: string,
  slot: number,
  owner: { runId: string; ownerPid: number; phase: "reserved" | "active"; updatedAt: string },
): boolean {
  const leasesDir = join(teamDir, "leases");
  mkdirSync(leasesDir, { recursive: true });
  const pendingDir = join(leasesDir, `.${slot}.${process.pid}.${randomUUID()}`);
  if (existsSync(join(leasesDir, `${slot}.recovery`))) return false;
  mkdirSync(pendingDir);
  try {
    atomicWriteJson(join(pendingDir, "owner.json"), owner);
    try {
      if (existsSync(join(leasesDir, `${slot}.recovery`))) return false;
      renameSync(pendingDir, leaseDir(teamDir, slot));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
  } finally {
    rmSync(pendingDir, { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseThreadCap(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_TEAM_THREAD_CAP;
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new Error(`Invalid PI_SUBAGENT_THREAD_CAP ${JSON.stringify(raw)}; expected a positive integer.`);
  }
  return cap;
}

function assertInsideTeam(teamDir: string): string {
  const absolute = resolve(teamDir);
  if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
  return absolute;
}

function teamIdentityPath(teamDir: string): string {
  return join(teamDir, "team.json");
}

function createOrReadTeamIdentity(teamDir: string, threadCap: number): { teamId: string; threadCap: number } {
  const path = teamIdentityPath(teamDir);
  const existing = readJson<{ teamId?: string; threadCap?: number }>(path);
  if (existing?.teamId) {
    return { teamId: existing.teamId, threadCap: existing.threadCap ?? threadCap };
  }

  mkdirSync(teamDir, { recursive: true });
  const candidate = { teamId: randomUUID(), threadCap, createdAt: new Date().toISOString() };
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readJson<{ teamId: string; threadCap?: number }>(path);
    if (!raced?.teamId) throw new Error(`Team identity at ${path} is invalid.`);
    return { teamId: raced.teamId, threadCap: raced.threadCap ?? threadCap };
  }
}

export function initializeTeam(options: {
  artifactDir: string;
  sessionPath: string;
  threadCap?: number;
  env?: NodeJS.ProcessEnv;
}): TeamContext {
  const env = options.env ?? process.env;
  const inheritedDir = env.PI_SUBAGENT_TEAM_DIR;
  const requestedCap = options.threadCap ?? parseThreadCap(env.PI_SUBAGENT_THREAD_CAP);
  const teamDir = assertInsideTeam(inheritedDir ?? join(options.artifactDir, "team"));
  const identity = createOrReadTeamIdentity(teamDir, requestedCap);
  const agentPath = env.PI_SUBAGENT_AGENT_PATH || ROOT_AGENT_PATH;
  const parentPath = env.PI_SUBAGENT_PARENT_PATH || (agentPath === ROOT_AGENT_PATH ? null : dirname(agentPath));
  const context = { teamId: identity.teamId, teamDir, agentPath, parentPath, threadCap: identity.threadCap };

  if (agentPath === ROOT_AGENT_PATH) ensureRootAgent(context, options.sessionPath);
  return context;
}

function ensureRootAgent(context: TeamContext, sessionPath: string): void {
  const existing = listTeamAgents(context).find((agent) => agent.path === ROOT_AGENT_PATH);
  if (existing) return;
  const now = new Date().toISOString();
  const runId = `root-${context.teamId}`;
  const root: TeamAgentRecord = {
    version: 1,
    teamId: context.teamId,
    runId,
    path: ROOT_AGENT_PATH,
    parentPath: null,
    displayName: "root",
    role: "coordinator",
    sessionPath,
    status: "running",
    slot: 0,
    ownerPid: process.pid,
    createdAt: now,
    updatedAt: now,
    launchPolicy: {},
  };
  atomicWriteJson(metadataPath(context.teamDir, runId), root);
  acquireLease(context.teamDir, 0, { runId, ownerPid: process.pid, phase: "active", updatedAt: now });
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "subagent";
}

function canonicalChildPath(context: TeamContext, parentPath: string, name: string, runId: string): string {
  const base = `${parentPath === "/" ? "" : parentPath}/${slug(name)}`;
  const occupied = new Set(
    listTeamAgents(context)
      .filter((agent) => !TERMINAL.has(agent.status))
      .map((agent) => agent.path),
  );
  return occupied.has(base) ? `${base}-${runId.slice(0, 8)}` : base;
}

function assertReusablePath(
  context: TeamContext,
  requestedPath: string,
  runId: string,
  parentPath: string,
): string {
  const path = normalize(requestedPath).replaceAll(sep, "/");
  if (!path.startsWith(`${ROOT_AGENT_PATH}/`) || dirname(path) !== parentPath) {
    throw new Error(`Invalid restored agent path ${JSON.stringify(requestedPath)} for parent ${parentPath}.`);
  }
  const occupied = listTeamAgents(context).find(
    (agent) => agent.path === path && agent.runId !== runId && !TERMINAL.has(agent.status),
  );
  if (occupied) {
    throw new Error(`Cannot restore agent path ${path}; it is currently used by ${occupied.runId}.`);
  }
  return path;
}

function recoverLeaseIfSafe(context: TeamContext, slot: number): boolean {
  const recoveryLock = join(context.teamDir, "leases", `${slot}.recovery`);
  try {
    mkdirSync(recoveryLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const lease = readJson<{ runId?: string; ownerPid?: number; phase?: string }>(leaseRecordPath(context.teamDir, slot));
    if (!lease?.runId) {
      rmSync(leaseDir(context.teamDir, slot), { recursive: true, force: true });
      return true;
    }
    const agent = readAgent(context, lease.runId);
    if (agent && TERMINAL.has(agent.status)) {
      rmSync(leaseDir(context.teamDir, slot), { recursive: true, force: true });
      return true;
    }
    // Only an unfinished reservation can be reclaimed from a dead reserving process.
    // Once marked active, pane/process liveness must be reconciled by the surface owner.
    if ((!agent || agent.status === "starting") && lease.phase !== "active" && !processAlive(lease.ownerPid ?? -1)) {
      const commit = tryAcquireMailboxCommitLock(context.teamDir);
      if (!commit) return false;
      try {
        const fresh = lease.runId ? readAgent(context, lease.runId) : null;
        if (fresh && fresh.status !== "starting" && !TERMINAL.has(fresh.status)) return false;
        if (fresh) {
          atomicWriteJson(metadataPath(context.teamDir, fresh.runId), {
            ...fresh,
            status: "errored",
            terminalAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        rmSync(leaseDir(context.teamDir, slot), { recursive: true, force: true });
        return true;
      } finally {
        commit();
      }
    }
    return false;
  } finally {
    rmSync(recoveryLock, { recursive: true, force: true });
  }
}

export function reserveAgentSlot(context: TeamContext, input: ReserveAgentInput): TeamAgentRecord {
  mkdirSync(join(context.teamDir, "leases"), { recursive: true });
  mkdirSync(join(context.teamDir, "agents"), { recursive: true });
  const runId = input.runId ?? randomUUID();
  const ownerPid = input.ownerPid ?? process.pid;
  const parentPath = input.parentPath ?? context.agentPath;
  const now = (input.now ?? new Date()).toISOString();
  const previousRecord = readAgent(context, runId);
  if (previousRecord && !TERMINAL.has(previousRecord.status)) {
    throw new Error(`Cannot reuse active agent identity ${runId} (${previousRecord.status}).`);
  }

  for (let slot = 1; slot < context.threadCap; slot += 1) {
    const leaseOwner = { runId, ownerPid, phase: "reserved" as const, updatedAt: now };
    if (!acquireLease(context.teamDir, slot, leaseOwner)) {
      if (!recoverLeaseIfSafe(context, slot) || !acquireLease(context.teamDir, slot, leaseOwner)) continue;
    }

    try {
      const record: TeamAgentRecord = {
        version: 1,
        teamId: context.teamId,
        runId,
        path: input.path
          ? assertReusablePath(context, input.path, runId, parentPath)
          : canonicalChildPath(context, parentPath, input.taskName ?? input.displayName, runId),
        parentPath,
        displayName: input.displayName,
        ...(input.role ? { role: input.role } : {}),
        sessionPath: input.sessionPath,
        status: "starting",
        slot,
        ownerPid,
        createdAt: previousRecord?.createdAt ?? now,
        updatedAt: now,
        launchPolicy: input.launchPolicy ?? {},
      };
      atomicWriteJson(metadataPath(context.teamDir, runId), record);
      return record;
    } catch (error) {
      rmSync(leaseDir(context.teamDir, slot), { recursive: true, force: true });
      if (previousRecord) {
        atomicWriteJson(metadataPath(context.teamDir, runId), previousRecord);
      } else {
        rmSync(metadataPath(context.teamDir, runId), { force: true });
      }
      throw error;
    }
  }

  throw new Error(
    `Subagent team capacity reached: ${context.threadCap} concurrent threads including root (maximum ${context.threadCap - 1} descendants). Wait for an active subagent to finish before spawning another.`,
  );
}

export function readAgent(context: TeamContext, runId: string): TeamAgentRecord | null {
  const record = readJson<TeamAgentRecord>(metadataPath(context.teamDir, basename(runId)));
  return record?.teamId === context.teamId ? record : null;
}

function updateAgentRecord(
  context: TeamContext,
  runId: string,
  patch: Partial<Omit<TeamAgentRecord, "teamId" | "runId" | "version" | "createdAt">>,
): TeamAgentRecord {
  const current = readAgent(context, runId);
  if (!current) throw new Error(`Unknown team agent ${runId}.`);
  const updated: TeamAgentRecord = {
    ...current,
    ...patch,
    teamId: current.teamId,
    runId: current.runId,
    version: 1,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(metadataPath(context.teamDir, runId), updated);
  if (patch.surface || (patch.status && patch.status !== "starting")) {
    atomicWriteJson(leaseRecordPath(context.teamDir, current.slot), {
      runId,
      ownerPid: current.ownerPid,
      phase: "active",
      updatedAt: updated.updatedAt,
    });
  }
  return updated;
}

export function updateAgent(
  context: TeamContext,
  runId: string,
  patch: Partial<Omit<TeamAgentRecord, "teamId" | "runId" | "version" | "createdAt">>,
): TeamAgentRecord {
  if (patch.status && TERMINAL.has(patch.status)) {
    throw new Error("Terminal agent transitions must use releaseAgentSlot().");
  }
  return updateAgentRecord(context, runId, patch);
}

export function releaseAgentSlot(
  context: TeamContext,
  runId: string,
  status: "completed" | "errored" = "completed",
): Promise<void> {
  const transition = () => {
    const current = readAgent(context, runId);
    if (!current || current.path === ROOT_AGENT_PATH) return;
    const updated = updateAgentRecord(context, runId, { status, terminalAt: new Date().toISOString() });
    const lease = readJson<{ runId?: string }>(leaseRecordPath(context.teamDir, updated.slot));
    if (lease?.runId === runId) {
      rmSync(leaseDir(context.teamDir, updated.slot), { recursive: true, force: true });
    }
  };
  const immediate = tryAcquireMailboxCommitLock(context.teamDir);
  if (immediate) {
    try {
      transition();
    } finally {
      immediate();
    }
    return Promise.resolve();
  }
  return acquireLifecycleMailboxCommitLock(context.teamDir).then((release) => {
    try {
      transition();
    } finally {
      release();
    }
  });
}

export function abandonAgentReservation(context: TeamContext, runId: string): Promise<void> {
  const abandon = () => {
    const current = readAgent(context, runId);
    if (!current || current.path === ROOT_AGENT_PATH) return;
    const lease = readJson<{ runId?: string }>(leaseRecordPath(context.teamDir, current.slot));
    if (lease?.runId === runId) {
      rmSync(leaseDir(context.teamDir, current.slot), { recursive: true, force: true });
    }
    rmSync(metadataPath(context.teamDir, runId), { force: true });
  };
  const immediate = tryAcquireMailboxCommitLock(context.teamDir);
  if (immediate) {
    try {
      abandon();
    } finally {
      immediate();
    }
    return Promise.resolve();
  }
  return acquireLifecycleMailboxCommitLock(context.teamDir).then((release) => {
    try {
      abandon();
    } finally {
      release();
    }
  });
}

/** Restore terminal metadata when a resume launch fails after reusing its run identity. */
export function restoreAgentAfterFailedResume(
  context: TeamContext,
  previous: TeamAgentRecord,
): Promise<void> {
  const restore = () => {
    const current = readAgent(context, previous.runId);
    if (current) {
      const lease = readJson<{ runId?: string }>(leaseRecordPath(context.teamDir, current.slot));
      if (lease?.runId === previous.runId) {
        rmSync(leaseDir(context.teamDir, current.slot), { recursive: true, force: true });
      }
    }
    atomicWriteJson(metadataPath(context.teamDir, previous.runId), previous);
  };
  const immediate = tryAcquireMailboxCommitLock(context.teamDir);
  if (immediate) {
    try {
      restore();
    } finally {
      immediate();
    }
    return Promise.resolve();
  }
  return acquireLifecycleMailboxCommitLock(context.teamDir).then((release) => {
    try {
      restore();
    } finally {
      release();
    }
  });
}

export function listTeamAgents(context: TeamContext, pathPrefix?: string): TeamAgentRecord[] {
  const dir = join(context.teamDir, "agents");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = names
    .map((name) => readJson<TeamAgentRecord>(join(dir, name)))
    .filter((record): record is TeamAgentRecord => record?.teamId === context.teamId);
  const filtered = pathPrefix ? records.filter((record) => record.path.startsWith(pathPrefix)) : records;
  return filtered.sort((a, b) => a.path.localeCompare(b.path) || a.createdAt.localeCompare(b.createdAt));
}

function normalizeTargetPath(currentPath: string, target: string): string {
  if (target.startsWith("/")) return normalize(target).replaceAll(sep, "/");
  const normalized = normalize(join(currentPath, target)).replaceAll(sep, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function resolveTeamTarget(context: TeamContext, target: string): TeamAgentRecord {
  const value = target.trim();
  if (!value) throw new Error("Target must not be empty.");
  const agents = listTeamAgents(context);
  if (value === "root") {
    const root = agents.find((agent) => agent.path === ROOT_AGENT_PATH);
    if (root) return root;
  }
  const byId = agents.find((agent) => agent.runId === value);
  if (byId) return byId;

  if (value.includes("/") || value.startsWith(".")) {
    const path = normalizeTargetPath(context.agentPath, value);
    if (!path.startsWith(`${ROOT_AGENT_PATH}/`) && path !== ROOT_AGENT_PATH) {
      throw new Error(`Cross-team target is not allowed: ${target}`);
    }
    const byPath = agents.find((agent) => agent.path === path);
    if (byPath) return byPath;
    throw new Error(`Unknown team target: ${target}`);
  }

  const byName = agents.filter((agent) => agent.displayName === value);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Ambiguous team target ${JSON.stringify(target)}; use an exact run ID or canonical path.`);
  }
  throw new Error(`Unknown team target: ${target}`);
}

/** Resolve an active, same-team direct-message target with self-send protection. */
export function resolveTeamMessageTarget(
  context: TeamContext,
  target: string,
  senderRunId: string,
): TeamAgentRecord {
  const recipient = resolveTeamTarget(context, target);
  if (recipient.runId === senderRunId) {
    throw new Error(`Cannot send a mailbox message to self (${recipient.path}).`);
  }
  if (TERMINAL.has(recipient.status)) {
    throw new Error(
      `Cannot send a mailbox message to terminal agent ${recipient.path} (${recipient.status}).`,
    );
  }
  return recipient;
}

export function teamEnvironment(context: TeamContext, agent: TeamAgentRecord): Record<string, string> {
  return {
    PI_SUBAGENT_TEAM_DIR: context.teamDir,
    PI_SUBAGENT_AGENT_PATH: agent.path,
    PI_SUBAGENT_PARENT_PATH: agent.parentPath ?? "",
    PI_SUBAGENT_THREAD_CAP: String(context.threadCap),
    PI_SUBAGENT_RUN_ID: agent.runId,
  };
}
