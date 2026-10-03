import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  acquireTeamMailboxCommitLock,
  listTeamAgents,
  readAgent,
  resolveTeamMessageTarget,
  type TeamAgentRecord,
  type TeamContext,
} from "./team.ts";

export const MAX_MAILBOX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MAILBOX_MESSAGES = 256;
export const MAX_MAILBOX_MESSAGES_PER_SENDER_WINDOW = 60;
export const MAILBOX_RATE_WINDOW_MS = 60_000;
export const MAX_MAILBOX_HOPS = 8;
export const MAILBOX_LOCK_TIMEOUT_MS = 2_000;
export const MAILBOX_STALE_LOCK_MS = 30_000;
export const MAILBOX_LOCK_POLL_MS = 10;
export const MAX_MAILBOX_READ_BATCH = 50;

const TERMINAL = new Set(["completed", "errored"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MailboxIdentity {
  context: TeamContext;
  agent: TeamAgentRecord;
}

export interface MailboxProvenance {
  hops: number;
  route: string[];
}

export interface MailboxEnvelope {
  version: 1;
  delivery?: "queue" | "followUp";
  id: string;
  sequence: number;
  teamId: string;
  senderRunId: string;
  senderPath: string;
  senderName: string;
  recipientRunId: string;
  recipientPath: string;
  recipientName: string;
  message: string;
  bytes: number;
  hops: number;
  route: string[];
  createdAt: string;
}

export interface MailboxOptions {
  maxMessageBytes?: number;
  maxMailboxMessages?: number;
  maxMessagesPerSenderWindow?: number;
  rateWindowMs?: number;
  maxHops?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockPollMs?: number;
  maxReadBatch?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Internal idempotency key. The child-facing tool never accepts this. */
  id?: string;
  provenance?: MailboxProvenance;
  /** Internal delivery policy. The child-facing queue-only tool never accepts this. */
  delivery?: "queue" | "followUp";
}

export interface MailboxDeliveryState extends MailboxProvenance {}

export interface MailboxDeliveryApi {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ): void;
}

export interface MailboxPersistence {
  getEntries(): readonly unknown[];
}

export interface FollowupWakeApi {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: true; deliverAs: "followUp" },
  ): void;
}

export interface FollowupWatchOptions {
  watcherFactory?: (path: string, listener: () => void) => Pick<FSWatcher, "close"> &
    Partial<Pick<FSWatcher, "unref">>;
  initialWakeArmed?: boolean;
  initialArmedIds?: string[];
  initialWakeToken?: string;
  initialActive?: boolean;
  deliveryState?: MailboxDeliveryState;
}

function directories(teamDir: string, recipientRunId?: string) {
  const root = join(teamDir, "mailboxes");
  const recipient = recipientRunId ? join(root, recipientRunId) : null;
  return {
    root,
    sequence: join(root, "sequence.json"),
    audit: join(root, "audit"),
    rates: join(root, "rates"),
    recipient,
    pending: recipient ? join(recipient, "pending") : null,
    inflight: recipient ? join(recipient, "inflight") : null,
    delivered: recipient ? join(recipient, "delivered") : null,
    claimLock: recipient ? join(recipient, ".claim.lock") : null,
    exitIntent: recipient ? join(recipient, ".followup-exit-intent.json") : null,
    wakeState: recipient ? join(recipient, ".followup-wake.json") : null,
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // A later file operation will report a useful error if the directory is unusable.
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeNames(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function now(options: MailboxOptions): number {
  return (options.now ?? Date.now)();
}

function sleep(options: MailboxOptions, ms: number): Promise<void> {
  return (options.sleep ?? ((delay) => new Promise<void>((done) => setTimeout(done, delay))))(ms);
}

async function acquireLock(path: string, options: MailboxOptions): Promise<() => void> {
  ensurePrivateDir(dirname(path));
  const started = now(options);
  const timeout = options.lockTimeoutMs ?? MAILBOX_LOCK_TIMEOUT_MS;
  const staleAfter = options.staleLockMs ?? MAILBOX_STALE_LOCK_MS;
  const poll = options.lockPollMs ?? MAILBOX_LOCK_POLL_MS;
  const ownerFile = join(path, "owner.json");

  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const token = randomUUID();
      atomicWriteJson(ownerFile, { token, pid: process.pid, acquiredAt: now(options) });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // A stale owner must never remove a replacement lock after recovery.
        if (readJson<{ token?: string }>(ownerFile)?.token !== token) return;
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const age = now(options) - statSync(path).mtimeMs;
      if (age >= staleAfter) {
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

    if (now(options) - started >= timeout) {
      throw new Error(`Mailbox lock timed out after ${timeout}ms: ${basename(path)}`);
    }
    await sleep(options, Math.max(0, poll));
  }
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid mailbox ${label} ${JSON.stringify(value)}.`);
  }
}

function assertIdentity(identity: MailboxIdentity): void {
  const { context, agent } = identity;
  assertSafeId(agent.runId, "run ID");
  const registered = readAgent(context, agent.runId);
  if (!registered || registered.teamId !== context.teamId || registered.path !== agent.path) {
    throw new Error("Mailbox identity does not match the current team registry.");
  }
  if (resolve(context.teamDir) !== resolve(identity.context.teamDir)) {
    throw new Error("Mailbox team directory mismatch.");
  }
  if (TERMINAL.has(registered.status)) {
    throw new Error(`Mailbox sender ${registered.path} is terminal (${registered.status}).`);
  }
}

export function mailboxIdentityForContext(context: TeamContext, runId?: string): MailboxIdentity {
  const candidates = listTeamAgents(context).filter((agent) =>
    runId ? agent.runId === runId : agent.path === context.agentPath
  );
  if (candidates.length !== 1) {
    throw new Error(`Unable to identify mailbox agent for ${runId ?? context.agentPath}.`);
  }
  const identity = { context, agent: candidates[0] };
  assertIdentity(identity);
  return identity;
}

/** Build and verify sender identity exclusively from parent-provided team metadata. */
export function mailboxIdentityFromEnvironment(env: NodeJS.ProcessEnv = process.env): MailboxIdentity {
  const teamDirValue = env.PI_SUBAGENT_TEAM_DIR?.trim();
  const agentPath = env.PI_SUBAGENT_AGENT_PATH?.trim();
  const runId = env.PI_SUBAGENT_RUN_ID?.trim();
  if (!teamDirValue || !agentPath || !runId) {
    throw new Error(
      "subagent_message is only available in a team subagent context; PI_SUBAGENT_TEAM_DIR, PI_SUBAGENT_AGENT_PATH, and PI_SUBAGENT_RUN_ID are required.",
    );
  }
  const teamDir = resolve(teamDirValue);
  const team = readJson<{ teamId?: string; threadCap?: number }>(join(teamDir, "team.json"));
  if (!team?.teamId) throw new Error(`Invalid or missing team identity at ${join(teamDir, "team.json")}.`);
  const record = readJson<TeamAgentRecord>(join(teamDir, "agents", `${basename(runId)}.json`));
  if (
    !record || record.teamId !== team.teamId || record.runId !== runId || record.path !== agentPath
  ) {
    throw new Error("Subagent mailbox environment does not match an agent in this team registry.");
  }
  const context: TeamContext = {
    teamId: team.teamId,
    teamDir,
    agentPath,
    parentPath: record.parentPath,
    threadCap: team.threadCap ?? (Number(env.PI_SUBAGENT_THREAD_CAP) || 4),
  };
  const identity = { context, agent: record };
  assertIdentity(identity);
  return identity;
}

function mailboxFileName(id: string): string {
  return `${id}.json`;
}

function auditFileName(envelope: Pick<MailboxEnvelope, "sequence" | "id">): string {
  return `${String(envelope.sequence).padStart(20, "0")}-${envelope.id}.json`;
}

function findById(dir: string, id: string): MailboxEnvelope | null {
  const envelope = readJson<MailboxEnvelope>(join(dir, mailboxFileName(id)));
  return envelope?.id === id ? envelope : null;
}

function senderRatePath(teamDir: string, senderRunId: string): string {
  return join(directories(teamDir).rates, `${senderRunId}.json`);
}

function readSequence(path: string): number {
  const value = readJson<{ value?: number }>(path)?.value ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Mailbox sequence state is invalid.");
  return value;
}

export async function enqueueMailboxMessage(
  sender: MailboxIdentity,
  target: string,
  message: string,
  options: MailboxOptions = {},
): Promise<MailboxEnvelope> {
  assertIdentity(sender);
  const text = message.trim();
  if (!text) throw new Error("Mailbox message must not be empty.");
  const bytes = Buffer.byteLength(message, "utf8");
  const maxBytes = options.maxMessageBytes ?? MAX_MAILBOX_MESSAGE_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`Mailbox message is ${bytes} UTF-8 bytes; maximum is ${maxBytes}.`);
  }

  const recipient = resolveTeamMessageTarget(sender.context, target, sender.agent.runId);
  assertSafeId(recipient.runId, "recipient run ID");
  const provenance = options.provenance ?? { hops: 0, route: [] };
  if (!Number.isSafeInteger(provenance.hops) || provenance.hops < 0) {
    throw new Error("Mailbox hop metadata is invalid.");
  }
  const hops = provenance.hops + 1;
  const maxHops = options.maxHops ?? MAX_MAILBOX_HOPS;
  if (hops > maxHops) throw new Error(`Mailbox hop limit exceeded (maximum ${maxHops}).`);
  if (provenance.route.includes(recipient.runId) || provenance.route.includes(sender.agent.runId)) {
    throw new Error("Mailbox routing loop detected; choose an agent not already in this message route.");
  }
  const route = [...provenance.route, sender.agent.runId];
  const id = options.id ?? randomUUID();
  assertSafeId(id, "message ID");
  const paths = directories(sender.context.teamDir, recipient.runId);
  ensurePrivateDir(paths.root);
  ensurePrivateDir(paths.audit);
  ensurePrivateDir(paths.rates);
  ensurePrivateDir(paths.recipient!);
  ensurePrivateDir(paths.pending!);
  ensurePrivateDir(paths.inflight!);
  ensurePrivateDir(paths.delivered!);

  const release = await acquireTeamMailboxCommitLock(sender.context.teamDir, options);
  try {
    // Terminal transitions use this same commit lock. These fresh reads are the
    // enqueue linearization point: either mail commits first, or terminal wins.
    const currentSender = readAgent(sender.context, sender.agent.runId);
    const currentRecipient = readAgent(sender.context, recipient.runId);
    if (!currentSender || TERMINAL.has(currentSender.status)) {
      throw new Error(`Mailbox sender ${sender.agent.path} is terminal or no longer registered.`);
    }
    if (!currentRecipient || TERMINAL.has(currentRecipient.status)) {
      throw new Error(`Cannot send a mailbox message to terminal agent ${recipient.path}.`);
    }
    if (options.delivery === "followUp" && readJson(paths.exitIntent!)) {
      throw new Error(`Cannot send a follow-up to agent ${recipient.path}; it is shutting down.`);
    }
    const duplicate = findById(paths.pending!, id) ?? findById(paths.inflight!, id) ??
      findById(paths.delivered!, id);
    if (duplicate) return duplicate;

    const queuedCount = safeNames(paths.pending!).length + safeNames(paths.inflight!).length;
    const maxCount = options.maxMailboxMessages ?? MAX_MAILBOX_MESSAGES;
    if (queuedCount >= maxCount) {
      throw new Error(`Mailbox for ${recipient.path} is full (${maxCount} queued messages).`);
    }

    const timestamp = now(options);
    const ratePath = senderRatePath(sender.context.teamDir, sender.agent.runId);
    const windowMs = options.rateWindowMs ?? MAILBOX_RATE_WINDOW_MS;
    const recent = (readJson<{ timestamps?: number[] }>(ratePath)?.timestamps ?? [])
      .filter((value) => Number.isFinite(value) && timestamp - value < windowMs);
    const maxRate = options.maxMessagesPerSenderWindow ?? MAX_MAILBOX_MESSAGES_PER_SENDER_WINDOW;
    if (recent.length >= maxRate) {
      throw new Error(
        `Mailbox sender rate limit exceeded (${maxRate} messages per ${windowMs}ms window).`,
      );
    }

    const sequence = readSequence(paths.sequence) + 1;
    const envelope: MailboxEnvelope = {
      version: 1,
      delivery: options.delivery ?? "queue",
      id,
      sequence,
      teamId: sender.context.teamId,
      senderRunId: sender.agent.runId,
      senderPath: currentSender.path,
      senderName: currentSender.displayName,
      recipientRunId: currentRecipient.runId,
      recipientPath: currentRecipient.path,
      recipientName: currentRecipient.displayName,
      message,
      bytes,
      hops,
      route,
      createdAt: new Date(timestamp).toISOString(),
    };
    atomicWriteJson(paths.sequence, { value: sequence, updatedAt: envelope.createdAt });
    atomicWriteJson(join(paths.pending!, mailboxFileName(envelope.id)), envelope);
    atomicWriteJson(ratePath, { timestamps: [...recent, timestamp] });
    atomicWriteJson(join(paths.audit, auditFileName(envelope)), envelope);
    return envelope;
  } finally {
    release();
  }
}

export async function enqueueFollowupMessage(
  sender: MailboxIdentity,
  target: string,
  message: string,
  options: MailboxOptions = {},
): Promise<MailboxEnvelope> {
  assertIdentity(sender);
  const recipient = resolveTeamMessageTarget(sender.context, target, sender.agent.runId);
  if (recipient.path === "/root") {
    throw new Error("The root coordinator cannot be a follow-up target.");
  }
  return enqueueMailboxMessage(sender, target, message, { ...options, delivery: "followUp" });
}

function isFollowupEnvelope(envelope: MailboxEnvelope | null): envelope is MailboxEnvelope {
  return envelope?.version === 1 && envelope.delivery === "followUp";
}

function hasFollowupFiles(paths: ReturnType<typeof directories>): boolean {
  return [...readEnvelopeFiles(paths.pending!), ...readEnvelopeFiles(paths.inflight!)]
    .some((item) => isFollowupEnvelope(item.envelope));
}

interface PersistedFollowupWake {
  version: 1;
  token: string;
  messageIds: string[];
  createdAt: string;
}

function readPersistedFollowupWake(path: string): PersistedFollowupWake | null {
  const value = readJson<PersistedFollowupWake>(path);
  if (value?.version !== 1 || !SAFE_ID.test(value.token) ||
      !Array.isArray(value.messageIds) || value.messageIds.length === 0 ||
      value.messageIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
      new Set(value.messageIds).size !== value.messageIds.length) return null;
  return value;
}

export interface FollowupWakeController {
  readonly runId: string;
  readonly wakeArmed: boolean;
  readonly armedMessageIds: readonly string[];
  readonly wakeToken: string | null;
  readonly wakeCount: number;
  readonly active: boolean;
  start(): void;
  markActive(): void;
  settle(): Promise<void>;
  setPersistence(persistence: MailboxPersistence): Promise<void>;
  scanAndWake(): Promise<boolean>;
  reconcilePersistence(): Promise<boolean>;
  observeMessage(message: unknown): void;
  prepareAutoExit(): Promise<boolean>;
  dispose(): void;
}

/** Install target-local wake delivery; fs.watch is a hint backed by scans. */
export function createFollowupWakeController(
  pi: FollowupWakeApi,
  recipient: MailboxIdentity,
  options: FollowupWatchOptions = {},
): FollowupWakeController {
  assertIdentity(recipient);
  const paths = directories(recipient.context.teamDir, recipient.agent.runId);
  ensurePrivateDir(paths.recipient!);
  ensurePrivateDir(paths.pending!);
  ensurePrivateDir(paths.inflight!);
  // A new child process (including resume) re-opens this run identity.
  rmSync(paths.exitIntent!, { force: true });

  const recoveredWake = readPersistedFollowupWake(paths.wakeState!);
  let armedIds = [...(options.initialArmedIds ?? recoveredWake?.messageIds ?? [])];
  let wakeToken = options.initialWakeToken ?? recoveredWake?.token ?? null;
  let armed = options.initialWakeArmed === true && armedIds.length > 0 && wakeToken != null;
  let recovering = recoveredWake != null && !armed;
  let active = options.initialActive === true;
  let generation = armed ? 1 : 0;
  let successfulWakeCount = armed ? 1 : 0;
  let armingPromise: Promise<boolean> | null = null;
  let disposed = false;
  let persistence: MailboxPersistence | null = null;
  let watcher: (Pick<FSWatcher, "close"> & Partial<Pick<FSWatcher, "unref">>) | null = null;

  const controller: FollowupWakeController = {
    runId: recipient.agent.runId,
    get wakeArmed() { return armed; },
    get armedMessageIds() { return [...armedIds]; },
    get wakeToken() { return wakeToken; },
    get wakeCount() { return successfulWakeCount; },
    get active() { return active; },
    start() {
      if (disposed || watcher) return;
      void controller.scanAndWake().catch(() => {});
      const factory = options.watcherFactory ?? ((path, listener) => watch(path, listener));
      watcher = factory(paths.pending!, () => {
        void controller.scanAndWake().catch(() => {});
      });
      watcher.unref?.();
      void controller.scanAndWake().catch(() => {});
    },
    markActive() {
      active = true;
    },
    async settle() {
      active = false;
      await controller.reconcilePersistence();
      await controller.scanAndWake();
    },
    async setPersistence(value) {
      persistence = value;
      await controller.reconcilePersistence();
      if (recovering) {
        // A new process cannot retain Pi's in-memory queue. Persistence was
        // checked first; an unpersisted prepared batch is safe to resend.
        recovering = false;
        armed = false;
        armedIds = [];
        wakeToken = null;
        rmSync(paths.wakeState!, { force: true });
      }
      if (!active) await controller.scanAndWake();
    },
    async scanAndWake() {
      if (disposed) return false;
      // Concurrent lifecycle and fs.watch scans share the same attempt. In
      // particular, a quiescent lifecycle drain must observe a synchronous
      // send/claim failure even when a watch hint reached the attempt first.
      if (armingPromise) return await armingPromise;
      const hasFollowup = hasFollowupFiles(paths);
      if (active || !persistence || armed || !hasFollowup) {
        return false;
      }
      const attempt = (async () => {
        if (active || armed || !hasFollowupFiles(paths)) return false;
        const messages = await claimMailboxBatch(recipient);
        if (messages.length === 0) return false;
        const token = randomUUID();
        generation++;
        armed = true;
        armedIds = messages.map((message) => message.id);
        wakeToken = token;
        atomicWriteJson(paths.wakeState!, {
          version: 1,
          token,
          messageIds: armedIds,
          createdAt: new Date().toISOString(),
        } satisfies PersistedFollowupWake);
        pi.sendMessage(
          mailboxCustomMessage(messages, recipient.agent.runId, {
            wakeGeneration: generation,
            wakeToken: token,
          }),
          { triggerTurn: true, deliverAs: "followUp" },
        );
        successfulWakeCount++;
        return true;
      })();
      armingPromise = attempt;
      try {
        return await attempt;
      } catch (error) {
        armed = false;
        armedIds = [];
        wakeToken = null;
        rmSync(paths.wakeState!, { force: true });
        throw error;
      } finally {
        if (armingPromise === attempt) armingPromise = null;
      }
    },
    async reconcilePersistence() {
      if (!persistence || !wakeToken || armedIds.length === 0) return false;
      const persisted = await acknowledgePersistedFollowupWake(
        recipient,
        persistence,
        wakeToken,
        armedIds,
      );
      if (!persisted) {
        return false;
      }
      armed = false;
      armedIds = [];
      wakeToken = null;
      recovering = false;
      if (!disposed && !active) await controller.scanAndWake();
      return true;
    },
    observeMessage(value) {
      const message = value as {
        role?: string;
        customType?: string;
        details?: { mailboxId?: unknown; wakeToken?: unknown; messageIds?: unknown };
      };
      if (message?.role !== "custom" || message.customType !== "subagent_mailbox" ||
          message.details?.mailboxId !== recipient.agent.runId ||
          message.details?.wakeToken !== wakeToken ||
          !Array.isArray(message.details?.messageIds) || !armed) return;
      const ids = message.details.messageIds.filter((id): id is string => typeof id === "string");
      if (armedIds.length !== ids.length || !armedIds.every((id, index) => ids[index] === id)) return;
      const messages = readEnvelopeFiles(paths.inflight!)
        .map((item) => item.envelope)
        .filter((item): item is MailboxEnvelope => item != null && ids.includes(item.id))
        .sort((a, b) => a.sequence - b.sequence);
      if (messages.length > 0 && options.deliveryState) {
        const furthest = messages.reduce(
          (best, item) => item.hops >= best.hops ? item : best,
          messages[0],
        );
        options.deliveryState.hops = furthest.hops;
        options.deliveryState.route = [...furthest.route];
      }
    },
    async prepareAutoExit() {
      await controller.reconcilePersistence();
      if (armed) return true;
      let suppressExit = false;
      const release = await acquireTeamMailboxCommitLock(recipient.context.teamDir);
      try {
        suppressExit = armed || hasFollowupFiles(paths);
        if (!suppressExit) {
          atomicWriteJson(paths.exitIntent!, {
            version: 1,
            runId: recipient.agent.runId,
            createdAt: new Date().toISOString(),
          });
        }
      } finally {
        release();
      }
      // The decision is committed under the mailbox lock, but Pi delivery is
      // target-local and must happen after releasing it. Propagate this drain's
      // failure so lifecycle retry can recover rather than strand durable work.
      if (suppressExit && !disposed && !armed) await controller.scanAndWake();
      return suppressExit;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      watcher?.close();
      watcher = null;
    },
  };
  return controller;
}

function readEnvelopeFiles(dir: string): Array<{ name: string; envelope: MailboxEnvelope | null }> {
  return safeNames(dir).map((name) => ({
    name,
    envelope: readJson<MailboxEnvelope>(join(dir, name)),
  }));
}

function validateClaimBatch(
  batch: Array<{ name: string; envelope: MailboxEnvelope | null; source: "pending" | "inflight" }>,
  recipient: MailboxIdentity,
): asserts batch is Array<{ name: string; envelope: MailboxEnvelope; source: "pending" | "inflight" }> {
  const ids = new Set<string>();
  for (const item of batch) {
    const envelope = item.envelope;
    if (!envelope || envelope.version !== 1 || envelope.teamId !== recipient.context.teamId ||
        envelope.recipientRunId !== recipient.agent.runId ||
        item.name !== mailboxFileName(envelope.id) || ids.has(envelope.id)) {
      throw new Error(`Invalid mailbox envelope ${item.name}; no claim state was changed.`);
    }
    ids.add(envelope.id);
  }
}

function reconcilePersistedClaims(
  paths: ReturnType<typeof directories>,
  persistedIds: ReadonlySet<string>,
): void {
  for (const { name, envelope } of readEnvelopeFiles(paths.inflight!)) {
    if (!envelope || !persistedIds.has(envelope.id)) continue;
    try {
      renameSync(join(paths.inflight!, name), join(paths.delivered!, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function prepareClaimLocked(
  recipient: MailboxIdentity,
  paths: ReturnType<typeof directories>,
  persistedIds: ReadonlySet<string>,
  options: MailboxOptions,
): MailboxEnvelope[] {
  const inflightBeforeReconcile = readEnvelopeFiles(paths.inflight!)
    .map((item) => ({ ...item, source: "inflight" as const }));
  validateClaimBatch(inflightBeforeReconcile, recipient);
  reconcilePersistedClaims(paths, persistedIds);
  const captured = [
    ...readEnvelopeFiles(paths.inflight!).map((item) => ({ ...item, source: "inflight" as const })),
    ...readEnvelopeFiles(paths.pending!).map((item) => ({ ...item, source: "pending" as const })),
  ]
    .sort((a, b) => (a.envelope?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (b.envelope?.sequence ?? Number.MAX_SAFE_INTEGER))
    .slice(0, options.maxReadBatch ?? MAX_MAILBOX_READ_BATCH);

  // Validate the complete captured batch before the first pending file moves.
  validateClaimBatch(captured, recipient);
  for (const item of captured) {
    if (item.source !== "pending") continue;
    try {
      renameSync(join(paths.pending!, item.name), join(paths.inflight!, item.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return captured.map((item) => item.envelope).sort((a, b) => a.sequence - b.sequence);
}

export async function claimMailboxBatch(
  recipient: MailboxIdentity,
  options: MailboxOptions = {},
  persistedIds: ReadonlySet<string> = new Set(),
): Promise<MailboxEnvelope[]> {
  assertIdentity(recipient);
  const paths = directories(recipient.context.teamDir, recipient.agent.runId);
  ensurePrivateDir(paths.recipient!);
  ensurePrivateDir(paths.pending!);
  ensurePrivateDir(paths.inflight!);
  ensurePrivateDir(paths.delivered!);
  const release = await acquireLock(paths.claimLock!, options);
  try {
    return prepareClaimLocked(recipient, paths, persistedIds, options);
  } finally {
    release();
  }
}

export function persistedMailboxMessageIds(
  entries: readonly unknown[],
  mailboxId?: string,
): Set<string> {
  const ids = new Set<string>();
  for (const value of entries) {
    const entry = value as {
      type?: string;
      customType?: string;
      details?: { mailboxId?: unknown; messageIds?: unknown };
    };
    if (entry?.type !== "custom_message" || entry.customType !== "subagent_mailbox" ||
        (mailboxId != null && entry.details?.mailboxId !== mailboxId) ||
        !Array.isArray(entry.details?.messageIds)) continue;
    for (const id of entry.details.messageIds) {
      if (typeof id === "string" && SAFE_ID.test(id)) ids.add(id);
    }
  }
  return ids;
}

async function acknowledgePersistedFollowupWake(
  recipient: MailboxIdentity,
  persistence: MailboxPersistence,
  token: string,
  messageIds: readonly string[],
  options: MailboxOptions = {},
): Promise<boolean> {
  assertIdentity(recipient);
  const matching = persistence.getEntries().filter((value) => {
    const entry = value as {
      type?: string;
      customType?: string;
      details?: { mailboxId?: unknown; wakeToken?: unknown; messageIds?: unknown };
    };
    return entry?.type === "custom_message" && entry.customType === "subagent_mailbox" &&
      entry.details?.mailboxId === recipient.agent.runId && entry.details?.wakeToken === token &&
      Array.isArray(entry.details?.messageIds) &&
      entry.details.messageIds.length === messageIds.length &&
      entry.details.messageIds.every((id, index) => id === messageIds[index]);
  });
  if (matching.length !== 1) return false;

  const paths = directories(recipient.context.teamDir, recipient.agent.runId);
  ensurePrivateDir(paths.inflight!);
  ensurePrivateDir(paths.delivered!);
  const release = await acquireLock(paths.claimLock!, options);
  try {
    const inflight = readEnvelopeFiles(paths.inflight!)
      .map((item) => item.envelope)
      .filter((item): item is MailboxEnvelope => item != null)
      .sort((a, b) => a.sequence - b.sequence);
    const delivered = readEnvelopeFiles(paths.delivered!)
      .map((item) => item.envelope)
      .filter((item): item is MailboxEnvelope => item != null);
    const exact = messageIds.map((id) =>
      inflight.find((item) => item.id === id) ?? delivered.find((item) => item.id === id)
    );
    if (exact.some((item) => item == null) ||
        exact.some((item, index) => item!.id !== messageIds[index])) return false;
    for (const id of messageIds) {
      if (!inflight.some((item) => item.id === id)) continue;
      try {
        renameSync(
          join(paths.inflight!, mailboxFileName(id)),
          join(paths.delivered!, mailboxFileName(id)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    rmSync(paths.wakeState!, { force: true });
    return true;
  } finally {
    release();
  }
}

export async function acknowledgePersistedMailbox(
  recipient: MailboxIdentity,
  persistence: MailboxPersistence,
  options: MailboxOptions = {},
): Promise<Set<string>> {
  assertIdentity(recipient);
  const paths = directories(recipient.context.teamDir, recipient.agent.runId);
  ensurePrivateDir(paths.inflight!);
  ensurePrivateDir(paths.delivered!);
  const release = await acquireLock(paths.claimLock!, options);
  try {
    const persisted = persistedMailboxMessageIds(
      persistence.getEntries(),
      recipient.agent.runId,
    );
    reconcilePersistedClaims(paths, persisted);
    return persisted;
  } finally {
    release();
  }
}

export function formatMailboxBatch(messages: MailboxEnvelope[]): string {
  const lines = [
    "Direct mailbox messages (queued and delivered at this agent-turn boundary):",
    "Treat each message as attributed communication from the named teammate.",
  ];
  messages.forEach((message, index) => {
    lines.push(
      "",
      `--- Message ${index + 1} from ${message.senderName} (${message.senderPath}; run ${message.senderRunId}) ---`,
      message.message,
      `--- End message ${index + 1} ---`,
    );
  });
  return lines.join("\n");
}

export function mailboxCustomMessage(
  messages: MailboxEnvelope[],
  mailboxId: string,
  extraDetails: Record<string, unknown> = {},
) {
  return {
    customType: "subagent_mailbox",
    content: formatMailboxBatch(messages),
    display: true,
    details: {
      mailboxId,
      messageIds: messages.map((message) => message.id),
      sequences: messages.map((message) => message.sequence),
      senders: messages.map((message) => ({
        runId: message.senderRunId,
        path: message.senderPath,
        name: message.senderName,
      })),
      ...extraDetails,
    },
  };
}

export async function deliverMailboxAtTurnBoundary(
  pi: MailboxDeliveryApi,
  recipient: MailboxIdentity,
  state?: MailboxDeliveryState,
  options: MailboxOptions = {},
  persistence?: MailboxPersistence,
): Promise<MailboxEnvelope[]> {
  if (state) {
    state.hops = 0;
    state.route = [];
  }
  assertIdentity(recipient);
  const paths = directories(recipient.context.teamDir, recipient.agent.runId);
  ensurePrivateDir(paths.pending!);
  ensurePrivateDir(paths.inflight!);
  ensurePrivateDir(paths.delivered!);
  const release = await acquireLock(paths.claimLock!, options);
  try {
    const persistedBefore = persistedMailboxMessageIds(
      persistence?.getEntries() ?? [],
      recipient.agent.runId,
    );
    const messages = prepareClaimLocked(recipient, paths, persistedBefore, options);
    if (messages.length === 0) return messages;
    if (state) {
      const furthest = messages.reduce((best, item) => item.hops >= best.hops ? item : best, messages[0]);
      state.hops = furthest.hops;
      state.route = [...furthest.route];
    }
    pi.sendMessage(mailboxCustomMessage(messages, recipient.agent.runId), { triggerTurn: false });
    const persistedAfter = persistedMailboxMessageIds(
      persistence?.getEntries() ?? [],
      recipient.agent.runId,
    );
    const missing = messages.filter((message) => !persistedAfter.has(message.id));
    reconcilePersistedClaims(paths, persistedAfter);
    if (missing.length > 0) {
      throw new Error(
        `Mailbox delivery was not durably persisted (${missing.length} message${missing.length === 1 ? "" : "s"}); the inflight claim will be retried.`,
      );
    }
    return messages;
  } finally {
    release();
  }
}

/** Convenience wiring for child extensions. Returns mutable provenance for replies. */
export function registerMailboxDelivery(
  pi: ExtensionAPI,
  identity: () => MailboxIdentity,
  options: MailboxOptions = {},
): MailboxDeliveryState {
  const state: MailboxDeliveryState = { hops: 0, route: [] };
  pi.on("before_agent_start", async (_event, ctx) => {
    await deliverMailboxAtTurnBoundary(pi, identity(), state, options, ctx.sessionManager);
  });
  return state;
}
