import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import {
  claimMailboxBatch,
  createFollowupWakeController,
  enqueueFollowupMessage,
  enqueueMailboxMessage,
  mailboxIdentityForContext,
  type MailboxIdentity,
} from "../pi-extension/subagents/mailbox.ts";
import {
  acquireTeamMailboxCommitLock,
  initializeTeam,
  releaseAgentSlot,
  reserveAgentSlot,
  teamEnvironment,
  updateAgent,
  type TeamContext,
} from "../pi-extension/subagents/team.ts";

interface Fixture {
  root: string;
  context: TeamContext;
  rootIdentity: MailboxIdentity;
  scout: MailboxIdentity;
  worker: MailboxIdentity;
  reviewer: MailboxIdentity;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-followup-test-"));
  const context = initializeTeam({
    artifactDir: join(root, "artifacts"),
    sessionPath: join(root, "root.jsonl"),
    threadCap: 8,
    env: {},
  });
  const make = (name: string) => {
    const agent = reserveAgentSlot(context, {
      displayName: name,
      sessionPath: join(root, `${name}.jsonl`),
    });
    updateAgent(context, agent.runId, { status: "running", surface: `surface:${name}` });
    return mailboxIdentityForContext({ ...context, agentPath: agent.path }, agent.runId);
  };
  return {
    root,
    context,
    rootIdentity: mailboxIdentityForContext(context),
    scout: make("Scout"),
    worker: make("Worker"),
    reviewer: make("Reviewer"),
  };
}

async function withFixture(run: (value: Fixture) => Promise<void> | void): Promise<void> {
  const value = fixture();
  try {
    await run(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

function pending(identity: MailboxIdentity): string[] {
  const dir = join(identity.context.teamDir, "mailboxes", identity.agent.runId, "pending");
  try { return readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
}

function wakeRecorder() {
  const sent: Array<{ message: any; options: any }> = [];
  return {
    sent,
    api: {
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
    },
  };
}

function extensionRecorder(options: { failSendCount?: number } = {}) {
  const tools: any[] = [];
  const handlers = new Map<string, Function[]>();
  const entries: any[] = [];
  const sent: any[] = [];
  let sendAttempts = 0;
  const api: any = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    getAllTools() { return tools; },
    sendMessage(message: any, sendOptions: any) {
      sendAttempts++;
      if (sendAttempts <= (options.failSendCount ?? 0)) throw new Error("injected send failure");
      sent.push({ message, options: sendOptions });
      entries.push({ type: "custom_message", ...message });
    },
  };
  return { api, tools, handlers, entries, sent, get sendAttempts() { return sendAttempts; } };
}

async function withChildEnv(
  value: Fixture,
  identity: MailboxIdentity,
  run: () => Promise<void> | void,
): Promise<void> {
  const keys = [
    "PI_SUBAGENT_TEAM_DIR",
    "PI_SUBAGENT_AGENT_PATH",
    "PI_SUBAGENT_PARENT_PATH",
    "PI_SUBAGENT_THREAD_CAP",
    "PI_SUBAGENT_RUN_ID",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_ACTIVITY_FILE",
    "PI_DENY_TOOLS",
  ];
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, teamEnvironment(value.context, identity.agent), {
    PI_DENY_TOOLS: "",
  });
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  try {
    await run();
  } finally {
    for (const [key, previous] of old) {
      if (previous == null) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

describe("durable safe subagent follow-up", () => {
  it("wakes an idle target exactly once and injects the attributed batch at the boundary", async () => {
    await withFixture(async ({ scout, worker }) => {
      const wake = wakeRecorder();
      const provenance = { hops: 0, route: [] as string[] };
      const controller = createFollowupWakeController(wake.api, worker, {
        deliveryState: provenance,
      });
      controller.start();
      await enqueueFollowupMessage(scout, "Worker", "continue safely");
      const entries: any[] = [];
      await controller.setPersistence({ getEntries: () => entries });
      assert.equal(wake.sent.length, 1);
      assert.equal(await controller.scanAndWake(), false);
      assert.equal(wake.sent.length, 1);
      assert.deepEqual(wake.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
      assert.equal(wake.sent[0].message.customType, "subagent_mailbox");
      controller.observeMessage({ role: "custom", ...wake.sent[0].message });
      assert.equal(provenance.hops, 1);
      assert.deepEqual(provenance.route, [scout.agent.runId]);
      entries.push({ type: "custom_message", ...wake.sent[0].message });
      await controller.reconcilePersistence();
      assert.equal(wake.sent.length, 1, "a consumed batch must not create a duplicate wake loop");
      assert.match(wake.sent[0].message.content, /from Scout/);
      assert.match(wake.sent[0].message.content, /continue safely/);
      assert.equal(pending(worker).length, 0);
      controller.dispose();
    });
  });

  it("uses Pi followUp while active, coalesces mail, and never invokes interruption transport", async () => {
    await withFixture(async ({ scout, reviewer, worker }) => {
      const wake = wakeRecorder();
      const controller = createFollowupWakeController(wake.api, worker);
      controller.start();
      controller.markActive();
      await Promise.all([
        enqueueFollowupMessage(scout, "Worker", "one"),
        enqueueFollowupMessage(reviewer, "Worker", "two"),
      ]);
      await controller.setPersistence({ getEntries: () => [] });
      await controller.scanAndWake();
      assert.equal(wake.sent.length, 0, "active turns and tool calls must never be interrupted");
      await controller.settle();
      assert.equal(wake.sent.length, 1);
      assert.equal(wake.sent[0].message.customType, "subagent_mailbox");
      assert.deepEqual(wake.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
      controller.dispose();
    });
  });

  it("requires one exact persisted wake token and ordered batch instead of unioning split entries", async () => {
    await withFixture(async ({ scout, reviewer, worker }) => {
      const wake = wakeRecorder();
      const entries: any[] = [];
      const controller = createFollowupWakeController(wake.api, worker);
      await Promise.all([
        enqueueFollowupMessage(scout, "Worker", "batch one"),
        enqueueFollowupMessage(reviewer, "Worker", "batch two"),
      ]);
      await controller.setPersistence({ getEntries: () => entries });
      const exact = wake.sent[0].message;
      const [firstId, secondId] = exact.details.messageIds;
      entries.push(
        { type: "custom_message", ...exact, details: { ...exact.details, messageIds: [firstId] } },
        { type: "custom_message", ...exact, details: { ...exact.details, messageIds: [secondId] } },
      );
      assert.equal(await controller.reconcilePersistence(), false);
      assert.equal(controller.wakeArmed, true);

      const mailboxDir = join(worker.context.teamDir, "mailboxes", worker.agent.runId);
      const partiallyAcknowledged = readdirSync(join(mailboxDir, "inflight"))
        .find((name) => name === `${firstId}.json`);
      assert.ok(partiallyAcknowledged);
      renameSync(
        join(mailboxDir, "inflight", partiallyAcknowledged),
        join(mailboxDir, "delivered", partiallyAcknowledged),
      );

      entries.length = 0;
      entries.push({ type: "custom_message", ...exact });
      assert.equal(await controller.reconcilePersistence(), true);
      assert.equal(controller.wakeArmed, false);
      controller.dispose();
    });
  });

  it("delivers new mail behind an armed batch only after exact persistence acknowledgement", async () => {
    await withFixture(async ({ scout, worker }) => {
      const wake = wakeRecorder();
      const entries: any[] = [];
      const controller = createFollowupWakeController(wake.api, worker);
      await controller.setPersistence({ getEntries: () => entries });
      controller.start();

      await enqueueFollowupMessage(scout, "Worker", "first batch");
      await controller.scanAndWake();
      await enqueueFollowupMessage(scout, "Worker", "behind armed batch");
      assert.equal(await controller.scanAndWake(), false);
      assert.equal(wake.sent.length, 1);

      entries.push({ type: "custom_message", ...wake.sent[0].message });
      await controller.reconcilePersistence();
      assert.equal(wake.sent.length, 2);
      assert.match(wake.sent[1].message.content, /behind armed batch/);
      entries.push({ type: "custom_message", ...wake.sent[1].message });
      await controller.reconcilePersistence();
      assert.equal(wake.sent.length, 2);
      controller.dispose();
    });
  });

  it("closes the scan/watch installation race and keeps queue-only subagent_message asleep", async () => {
    await withFixture(async ({ scout, worker }) => {
      const queued = await enqueueFollowupMessage(scout, "Worker", "racing");
      const dir = join(worker.context.teamDir, "mailboxes", worker.agent.runId, "pending");
      const staged = join(worker.context.teamDir, `${queued.id}.staged`);
      renameSync(join(dir, `${queued.id}.json`), staged);
      const wake = wakeRecorder();
      let closed = false;
      const controller = createFollowupWakeController(wake.api, worker, {
        watcherFactory(_path, _listener) {
          renameSync(staged, join(dir, `${queued.id}.json`));
          return { close() { closed = true; } };
        },
      });
      controller.start();
      await controller.setPersistence({ getEntries: () => [] });
      assert.equal(wake.sent.length, 1, "post-install scan must observe the raced enqueue");
      controller.dispose();
      assert.equal(closed, true);

      const queueWake = wakeRecorder();
      const queueController = createFollowupWakeController(queueWake.api, worker);
      await claimMailboxBatch(worker); // remove the prior follow-up from pending
      rmSync(join(worker.context.teamDir, "mailboxes", worker.agent.runId, "inflight"), {
        recursive: true,
        force: true,
      });
      await enqueueMailboxMessage(scout, "Worker", "queue only");
      queueController.start();
      await queueController.setPersistence({ getEntries: () => [] });
      assert.equal(queueWake.sent.length, 0, "subagent_message remains queue-only");
      queueController.dispose();
    });
  });

  it("recovers send failure and reload without loss or duplicate persisted delivery", async () => {
    await withFixture(async ({ scout, worker }) => {
      await enqueueFollowupMessage(scout, "Worker", "survive send failure");
      const failed = createFollowupWakeController(
        { sendMessage() { throw new Error("send failed"); } },
        worker,
      );
      failed.start();
      await assert.rejects(
        failed.setPersistence({ getEntries: () => [] }),
        /send failed/,
      );
      failed.dispose();

      const retry = wakeRecorder();
      const entries: any[] = [];
      const recovered = createFollowupWakeController(retry.api, worker);
      recovered.start();
      await recovered.setPersistence({ getEntries: () => entries });
      assert.equal(retry.sent.length, 1, "recoverable inflight must be resent after failed API delivery");
      entries.push({ type: "custom_message", ...retry.sent[0].message });
      recovered.dispose(); // simulate reload after Pi persisted but before local acknowledgement

      const afterReload = wakeRecorder();
      const reloaded = createFollowupWakeController(afterReload.api, worker);
      reloaded.start();
      await reloaded.setPersistence({ getEntries: () => entries });
      assert.equal(afterReload.sent.length, 0, "persisted exact batch must not be delivered twice");
      assert.equal(pending(worker).length, 0);
      reloaded.dispose();
    });
  });

  it("rejects root, self, terminal, unknown, ambiguous, and escaping targets without enqueue", async () => {
    await withFixture(async ({ context, rootIdentity, scout, worker }) => {
      await assert.rejects(enqueueFollowupMessage(scout, "root", "x"), /root.*cannot.*target/i);
      await assert.rejects(enqueueFollowupMessage(scout, "Scout", "x"), /self/i);
      await assert.rejects(enqueueFollowupMessage(scout, "missing", "x"), /unknown/i);
      await assert.rejects(enqueueFollowupMessage(scout, "../../outside", "x"), /cross-team/i);
      await assert.rejects(enqueueFollowupMessage(rootIdentity, "root", "x"), /self|root/i);

      const sameA = reserveAgentSlot(context, { displayName: "Same", sessionPath: join(context.teamDir, "a.jsonl") });
      const sameB = reserveAgentSlot(context, { displayName: "Same", sessionPath: join(context.teamDir, "b.jsonl") });
      await assert.rejects(enqueueFollowupMessage(scout, "Same", "x"), /ambiguous/i);
      await releaseAgentSlot(context, sameA.runId, "completed");
      await releaseAgentSlot(context, sameB.runId, "completed");
      await releaseAgentSlot(context, worker.agent.runId, "completed");
      await assert.rejects(enqueueFollowupMessage(scout, worker.agent.runId, "x"), /terminal/i);
      assert.equal(pending(worker).length, 0);
    });
  });

  it("linearizes terminal and auto-exit races, suppresses once, then permits eventual exit", async () => {
    await withFixture(async ({ context, scout, worker }) => {
      const release = await acquireTeamMailboxCommitLock(context.teamDir);
      const terminal = releaseAgentSlot(context, worker.agent.runId, "completed");
      const enqueue = enqueueFollowupMessage(scout, "Worker", "too late", {
        lockPollMs: 20,
        lockTimeoutMs: 1_000,
      });
      release();
      await terminal;
      await assert.rejects(enqueue, /terminal/i);
      assert.equal(pending(worker).length, 0);
    });

    await withFixture(async ({ scout, worker }) => {
      const wake = wakeRecorder();
      const controller = createFollowupWakeController(wake.api, worker);
      controller.start();
      const entries: any[] = [];
      await controller.setPersistence({ getEntries: () => entries });
      await enqueueFollowupMessage(scout, "Worker", "before exit");
      await controller.scanAndWake();
      assert.equal(await controller.prepareAutoExit(), true);
      entries.push({ type: "custom_message", ...wake.sent[0].message });
      await controller.reconcilePersistence();
      assert.equal(await controller.prepareAutoExit(), false, "consumed follow-up allows eventual exit");
      await assert.rejects(enqueueFollowupMessage(scout, "Worker", "after exit intent"), /shutting down/i);
      controller.dispose();
    });
  });

  it("registers one follow-up tool in root and child contexts with trusted child provenance", async () => {
    const previousRunId = process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_RUN_ID;
    try {
      const rootApi = extensionRecorder();
      subagentsExtension(rootApi.api);
      assert.equal(rootApi.tools.filter((tool) => tool.name === "subagent_followup").length, 1);
    } finally {
      if (previousRunId == null) delete process.env.PI_SUBAGENT_RUN_ID;
      else process.env.PI_SUBAGENT_RUN_ID = previousRunId;
    }

    await withFixture(async (value) => {
      await withChildEnv(value, value.worker, async () => {
        const childApi = extensionRecorder();
        subagentsExtension(childApi.api);
        subagentDoneExtension(childApi.api);
        const tools = childApi.tools.filter((tool) => tool.name === "subagent_followup");
        assert.equal(tools.length, 1);
        const result = await tools[0].execute("call", {
          target: "Scout",
          message: "trusted sender",
        });
        assert.equal(result.details.status, "followup_queued");
        const [envelope] = await claimMailboxBatch(value.scout);
        assert.equal(envelope.senderRunId, value.worker.agent.runId);
        assert.equal(envelope.senderPath, value.worker.agent.path);
        for (const handler of childApi.handlers.get("session_shutdown") ?? []) {
          handler({ reason: "quit" }, {});
        }
      });
    });
  });

  it("preserves idle versus active state across extension reload without stranding follow-ups", async () => {
    await withFixture(async (value) => {
      await withChildEnv(value, value.worker, async () => {
        const ctxFor = (child: ReturnType<typeof extensionRecorder>) => ({
          sessionManager: { getEntries: () => child.entries },
          ui: { setWidget() {} },
          shutdown() {},
        });
        const endEvent = { messages: [{ role: "assistant", stopReason: "stop" }] };

        const idleBeforeReload = extensionRecorder();
        subagentDoneExtension(idleBeforeReload.api);
        const firstCtx = ctxFor(idleBeforeReload);
        await idleBeforeReload.handlers.get("session_start")![0]({}, firstCtx);
        idleBeforeReload.handlers.get("agent_end")![0](endEvent, firstCtx);
        await new Promise<void>((done) => setImmediate(done));
        idleBeforeReload.handlers.get("session_shutdown")![0]({ reason: "reload" }, firstCtx);

        const idleAfterReload = extensionRecorder();
        subagentDoneExtension(idleAfterReload.api);
        await enqueueFollowupMessage(value.scout, "Worker", "arrived after idle reload");
        const secondCtx = ctxFor(idleAfterReload);
        await idleAfterReload.handlers.get("session_start")![0]({}, secondCtx);
        assert.equal(idleAfterReload.sent.length, 1, "idle reload must deliver without manual input");
        idleAfterReload.handlers.get("message_end")![0]({
          message: { role: "custom", ...idleAfterReload.sent[0].message },
        });
        await new Promise<void>((done) => setImmediate(done));
        const mailboxDir = join(value.context.teamDir, "mailboxes", value.worker.agent.runId);
        assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 0);
        assert.equal(readdirSync(join(mailboxDir, "delivered")).length, 1);
        idleAfterReload.handlers.get("session_shutdown")![0]({ reason: "quit" }, secondCtx);
      });
    });

    await withFixture(async (value) => {
      await withChildEnv(value, value.worker, async () => {
        const activeBeforeReload = extensionRecorder();
        subagentDoneExtension(activeBeforeReload.api);
        const firstCtx: any = {
          sessionManager: { getEntries: () => activeBeforeReload.entries },
          ui: { setWidget() {} },
          shutdown() {},
        };
        await activeBeforeReload.handlers.get("session_start")![0]({}, firstCtx);
        activeBeforeReload.handlers.get("session_shutdown")![0]({ reason: "reload" }, firstCtx);

        const activeAfterReload = extensionRecorder();
        subagentDoneExtension(activeAfterReload.api);
        await enqueueFollowupMessage(value.scout, "Worker", "defer across active reload");
        const secondCtx: any = {
          sessionManager: { getEntries: () => activeAfterReload.entries },
          ui: { setWidget() {} },
          shutdown() {},
        };
        await activeAfterReload.handlers.get("session_start")![0]({}, secondCtx);
        assert.equal(activeAfterReload.sent.length, 0, "active reload must remain deferred");
        activeAfterReload.handlers.get("agent_end")![0](
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          secondCtx,
        );
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(activeAfterReload.sent.length, 1);
        activeAfterReload.handlers.get("session_shutdown")![0]({ reason: "quit" }, secondCtx);
      });
    });
  });

  it("retries one failed quiescent drain and coalesces settled with fallback before eventual exit", async () => {
    await withFixture(async (value) => {
      await enqueueFollowupMessage(value.scout, "Worker", "survive first quiescent failure");
      await withChildEnv(value, value.worker, async () => {
        process.env.PI_SUBAGENT_AUTO_EXIT = "1";
        const child = extensionRecorder({ failSendCount: 1 });
        subagentDoneExtension(child.api);
        let shutdowns = 0;
        const ctx: any = {
          sessionManager: { getEntries: () => child.entries },
          ui: { setWidget() {} },
          shutdown() { shutdowns++; },
        };
        const endEvent = { messages: [{ role: "assistant", stopReason: "stop" }] };
        await child.handlers.get("session_start")![0]({}, ctx);
        child.handlers.get("agent_end")![0](endEvent, ctx);
        await new Promise<void>((done) => setTimeout(done, 80));
        assert.equal(child.sendAttempts, 2, "one bounded retry must follow the injected failure");
        assert.equal(child.sent.length, 1, "only the successful attributed delivery is emitted");
        assert.equal(shutdowns, 0, "failed or armed drains must never auto-exit");

        child.handlers.get("message_end")![0]({
          message: { role: "custom", ...child.sent[0].message },
        });
        await new Promise<void>((done) => setImmediate(done));
        const mailboxDir = join(value.context.teamDir, "mailboxes", value.worker.agent.runId);
        assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 0);
        assert.equal(readdirSync(join(mailboxDir, "delivered")).length, 1);

        child.handlers.get("agent_start")![0]({}, ctx);
        child.handlers.get("agent_end")![0](endEvent, ctx);
        child.handlers.get("agent_settled")![0]({}, ctx);
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(shutdowns, 1, "settled and fallback must coalesce into one eventual exit");
        assert.equal(child.sent.length, 1, "successful coalescing must not resend the batch");
        child.handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
      });
    });
  });

  it("suppresses autonomous shutdown for armed work and shuts down after it is consumed", async () => {
    await withFixture(async (value) => {
      await enqueueFollowupMessage(value.scout, "Worker", "wake autonomous worker");
      await withChildEnv(value, value.worker, async () => {
        process.env.PI_SUBAGENT_AUTO_EXIT = "1";
        const child = extensionRecorder();
        subagentDoneExtension(child.api);
        let shutdowns = 0;
        const ctx: any = {
          sessionManager: { getEntries: () => child.entries },
          ui: { setWidget() {} },
          shutdown() { shutdowns++; },
        };
        const endEvent = { messages: [{ role: "assistant", stopReason: "stop" }] };
        await child.handlers.get("session_start")![0]({}, ctx);
        child.handlers.get("agent_end")![0](endEvent, ctx);
        assert.equal(child.sent.length, 0, "agent_end itself must not send or resend");
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(child.sent.length, 1, "quiescent macrotask drains exactly one attributed batch");
        assert.equal(shutdowns, 0, "armed follow-up keeps the autonomous child alive");

        child.handlers.get("agent_start")![0]({}, ctx);
        child.handlers.get("agent_end")![0](endEvent, ctx);
        await new Promise<void>((done) => setImmediate(done));
        assert.equal(shutdowns, 1, "the follow-up turn exits normally after consumption");
        for (const handler of child.handlers.get("session_shutdown") ?? []) {
          handler({ reason: "quit" }, ctx);
        }
      });
    });
  });
});
