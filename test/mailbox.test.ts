import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import {
  claimMailboxBatch,
  deliverMailboxAtTurnBoundary,
  enqueueMailboxMessage,
  mailboxIdentityForContext,
  mailboxIdentityFromEnvironment,
  type MailboxIdentity,
} from "../pi-extension/subagents/mailbox.ts";
import {
  acquireTeamMailboxCommitLock,
  initializeTeam,
  readAgent,
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
  const root = mkdtempSync(join(tmpdir(), "pi-mailbox-test-"));
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

function pendingFiles(identity: MailboxIdentity): string[] {
  const path = join(identity.context.teamDir, "mailboxes", identity.agent.runId, "pending");
  try {
    return readdirSync(path).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function deliveryRecorder() {
  const sent: any[] = [];
  const entries: any[] = [];
  return {
    sent,
    entries,
    api: {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
        entries.push({ type: "custom_message", ...message });
      },
    },
    persistence: { getEntries: () => entries },
  };
}

describe("durable direct mailbox", () => {
  it("queues without waking an idle target, then delivers an attributed FIFO batch once", async () => {
    await withFixture(async ({ scout, worker }) => {
      updateAgent(worker.context, worker.agent.runId, { status: "waiting" });
      const first = await enqueueMailboxMessage(scout, "Worker", "first");
      const second = await enqueueMailboxMessage(scout, worker.agent.runId, "second");
      assert.ok(first.sequence < second.sequence);
      assert.equal(pendingFiles(worker).length, 2);

      const delivery = deliveryRecorder();
      const delivered = await deliverMailboxAtTurnBoundary(
        delivery.api, worker, undefined, {}, delivery.persistence,
      );
      assert.deepEqual(delivered.map((item) => item.message), ["first", "second"]);
      assert.equal(delivery.sent.length, 1);
      assert.deepEqual(delivery.sent[0].options, { triggerTurn: false });
      assert.match(delivery.sent[0].message.content, /from Scout \(\/root\/scout; run/);
      assert.ok(delivery.sent[0].message.content.indexOf("first") <
        delivery.sent[0].message.content.indexOf("second"));
      assert.equal(pendingFiles(worker).length, 0);

      await deliverMailboxAtTurnBoundary(
        delivery.api, worker, undefined, {}, delivery.persistence,
      );
      assert.equal(delivery.sent.length, 1, "delivered files must not be injected again after reload/boundary");
    });
  });

  it("captures bounded batches so mail outside the capture waits for the next boundary", async () => {
    await withFixture(async ({ scout, worker }) => {
      await enqueueMailboxMessage(scout, "Worker", "one");
      await enqueueMailboxMessage(scout, "Worker", "two");
      const delivery = deliveryRecorder();

      assert.deepEqual(
        (await deliverMailboxAtTurnBoundary(
          delivery.api, worker, undefined, { maxReadBatch: 1 }, delivery.persistence,
        )).map((item) => item.message),
        ["one"],
      );
      assert.equal(pendingFiles(worker).length, 1);
      assert.deepEqual(
        (await deliverMailboxAtTurnBoundary(
          delivery.api, worker, undefined, { maxReadBatch: 1 }, delivery.persistence,
        )).map((item) => item.message),
        ["two"],
      );
      assert.equal(delivery.sent.length, 2);
    });
  });

  it("deduplicates concurrent enqueue retries and concurrent claims", async () => {
    await withFixture(async ({ scout, worker }) => {
      const writes = await Promise.all(
        Array.from({ length: 12 }, () =>
          enqueueMailboxMessage(scout, "Worker", "idempotent", { id: "stable-message-id" })
        ),
      );
      assert.equal(new Set(writes.map((item) => item.sequence)).size, 1);
      assert.equal(pendingFiles(worker).length, 1);

      const delivery = deliveryRecorder();
      const claims = await Promise.all([
        deliverMailboxAtTurnBoundary(delivery.api, worker, undefined, {}, delivery.persistence),
        deliverMailboxAtTurnBoundary(delivery.api, worker, undefined, {}, delivery.persistence),
        deliverMailboxAtTurnBoundary(delivery.api, worker, undefined, {}, delivery.persistence),
      ]);
      assert.equal(claims.flat().length, 1);
      assert.equal(claims.flat()[0].id, "stable-message-id");
      assert.equal(delivery.sent.length, 1);
    });
  });

  it("serializes concurrent writers into one global FIFO sequence", async () => {
    await withFixture(async ({ scout, reviewer, worker }) => {
      const messages = Array.from({ length: 30 }, (_, index) => ({
        sender: index % 2 ? scout : reviewer,
        text: `message-${index}`,
      }));
      const written = await Promise.all(messages.map(({ sender, text }) =>
        enqueueMailboxMessage(sender, "Worker", text, {
          maxMessagesPerSenderWindow: 100,
        })
      ));
      assert.equal(new Set(written.map((item) => item.sequence)).size, messages.length);
      const claimed = await claimMailboxBatch(worker, { maxReadBatch: 100 });
      assert.deepEqual(
        claimed.map((item) => item.sequence),
        [...claimed.map((item) => item.sequence)].sort((a, b) => a - b),
      );
    });
  });

  it("enforces UTF-8 size, count, sender-rate, hop, loop, and lock bounds", async () => {
    await withFixture(async ({ scout, worker, reviewer }) => {
      await assert.rejects(
        enqueueMailboxMessage(scout, "Worker", "éé", { maxMessageBytes: 3 }),
        /UTF-8 bytes.*maximum is 3/,
      );
      await enqueueMailboxMessage(scout, "Worker", "fills mailbox", { maxMailboxMessages: 1 });
      await assert.rejects(
        enqueueMailboxMessage(reviewer, "Worker", "overflow", { maxMailboxMessages: 1 }),
        /mailbox.*full/i,
      );
      await claimMailboxBatch(worker);

      await enqueueMailboxMessage(reviewer, "Scout", "rate one", {
        maxMessagesPerSenderWindow: 1,
        rateWindowMs: 10_000,
      });
      await assert.rejects(
        enqueueMailboxMessage(reviewer, "Worker", "rate two", {
          maxMessagesPerSenderWindow: 1,
          rateWindowMs: 10_000,
        }),
        /rate limit/i,
      );
      await assert.rejects(
        enqueueMailboxMessage(reviewer, "Worker", "too far", {
          maxHops: 2,
          provenance: { hops: 2, route: [] },
        }),
        /hop limit/i,
      );
      await assert.rejects(
        enqueueMailboxMessage(reviewer, "Worker", "loop", {
          provenance: { hops: 1, route: [worker.agent.runId] },
        }),
        /loop/i,
      );

      const lock = join(scout.context.teamDir, "mailboxes", ".commit.lock");
      mkdirSync(lock, { recursive: true });
      let clock = 0;
      await assert.rejects(
        enqueueMailboxMessage(reviewer, "Worker", "locked", {
          now: () => clock,
          sleep: async (ms) => { clock += Math.max(ms, 1); },
          lockTimeoutMs: 3,
          staleLockMs: 100_000,
          lockPollMs: 1,
        }),
        /lock timed out/i,
      );
      rmSync(lock, { recursive: true, force: true });

      mkdirSync(lock, { recursive: true });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const recovered = await enqueueMailboxMessage(reviewer, "Worker", "stale", {
        staleLockMs: 1,
      });
      assert.equal(recovered.message, "stale");
    });
  });

  it("resolves root, sibling ID/path/name targets and rejects unsafe targets actionably", async () => {
    await withFixture(async ({ context, rootIdentity, scout, worker, reviewer }) => {
      const childContext = { ...context, agentPath: scout.agent.path, parentPath: scout.agent.parentPath };
      const childScout = { ...scout, context: childContext };
      assert.equal((await enqueueMailboxMessage(childScout, "root", "to root")).recipientRunId, rootIdentity.agent.runId);
      assert.equal(
        (await enqueueMailboxMessage(rootIdentity, "Worker", "root to worker")).recipientRunId,
        worker.agent.runId,
      );
      assert.equal((await enqueueMailboxMessage(childScout, worker.agent.runId, "by id")).recipientRunId, worker.agent.runId);
      assert.equal((await enqueueMailboxMessage(childScout, "../worker", "by relative path")).recipientRunId, worker.agent.runId);
      assert.equal((await enqueueMailboxMessage(childScout, worker.agent.path, "by canonical path")).recipientRunId, worker.agent.runId);
      assert.equal((await enqueueMailboxMessage(childScout, "Reviewer", "by name")).recipientRunId, reviewer.agent.runId);

      await assert.rejects(enqueueMailboxMessage(childScout, "", "x"), /target must not be empty/i);
      await assert.rejects(enqueueMailboxMessage(childScout, "missing", "x"), /unknown/i);
      await assert.rejects(enqueueMailboxMessage(childScout, "../../outside/agent", "x"), /cross-team/i);
      await assert.rejects(enqueueMailboxMessage(childScout, "Scout", "x"), /self/i);

      const sameA = reserveAgentSlot(context, { displayName: "Same", sessionPath: join(context.teamDir, "a.jsonl") });
      const sameB = reserveAgentSlot(context, { displayName: "Same", sessionPath: join(context.teamDir, "b.jsonl") });
      await assert.rejects(enqueueMailboxMessage(childScout, "Same", "x"), /ambiguous/i);
      await releaseAgentSlot(context, sameA.runId, "completed");
      await releaseAgentSlot(context, sameB.runId, "completed");
      await releaseAgentSlot(context, reviewer.agent.runId, "completed");
      await assert.rejects(enqueueMailboxMessage(childScout, reviewer.agent.runId, "x"), /terminal/i);
    });
  });

  it("verifies trusted environment identity and keeps all durable leaves private", async () => {
    await withFixture(async ({ context, scout, worker }) => {
      const env = {
        ...teamEnvironment(context, scout.agent),
      };
      const loaded = mailboxIdentityFromEnvironment(env);
      assert.equal(loaded.agent.runId, scout.agent.runId);
      assert.throws(
        () => mailboxIdentityFromEnvironment({ ...env, PI_SUBAGENT_AGENT_PATH: worker.agent.path }),
        /does not match/i,
      );

      await enqueueMailboxMessage(scout, "Worker", "private");
      const mailRoot = join(context.teamDir, "mailboxes");
      const leaves = [
        join(mailRoot, "sequence.json"),
        ...readdirSync(join(mailRoot, "audit")).map((name) => join(mailRoot, "audit", name)),
        ...readdirSync(join(mailRoot, worker.agent.runId, "pending")).map((name) =>
          join(mailRoot, worker.agent.runId, "pending", name)
        ),
      ];
      for (const path of leaves) assert.equal(statSync(path).mode & 0o777, 0o600, path);
      assert.doesNotMatch(readFileSync(join(mailRoot, "audit", readdirSync(join(mailRoot, "audit"))[0]), "utf8"), /surface:/);
    });
  });

  it("recovers failed and crashed inflight claims without loss or duplicate model delivery", async () => {
    await withFixture(async ({ scout, worker }) => {
      const queued = await enqueueMailboxMessage(scout, "Worker", "recover me");
      await assert.rejects(
        deliverMailboxAtTurnBoundary(
          { sendMessage() { throw new Error("simulated send failure"); } },
          worker,
          undefined,
          {},
          { getEntries: () => [] },
        ),
        /simulated send failure/,
      );
      const mailboxDir = join(worker.context.teamDir, "mailboxes", worker.agent.runId);
      assert.equal(readdirSync(join(mailboxDir, "pending")).length, 0);
      assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 1);
      assert.equal(readdirSync(join(mailboxDir, "delivered")).length, 0);

      const retry = deliveryRecorder();
      await deliverMailboxAtTurnBoundary(retry.api, worker, undefined, {}, retry.persistence);
      assert.equal(retry.sent.length, 1);
      assert.deepEqual(retry.sent[0].message.details.messageIds, [queued.id]);
      assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 0);
      assert.equal(readdirSync(join(mailboxDir, "delivered")).length, 1);

      const crashQueued = await enqueueMailboxMessage(scout, "Worker", "persisted before crash");
      await claimMailboxBatch(worker);
      const persisted = [{
        type: "custom_message",
        customType: "subagent_mailbox",
        details: { mailboxId: worker.agent.runId, messageIds: [crashQueued.id] },
      }];
      const afterReload = deliveryRecorder();
      afterReload.entries.push(...persisted);
      const recovered = await deliverMailboxAtTurnBoundary(
        afterReload.api, worker, undefined, {}, afterReload.persistence,
      );
      assert.deepEqual(recovered, []);
      assert.equal(afterReload.sent.length, 0, "persisted message IDs must not be injected twice");
      assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 0);
      assert.equal(readdirSync(join(mailboxDir, "delivered")).length, 2);
    });
  });

  it("validates the entire captured batch before moving any message to inflight", async () => {
    await withFixture(async ({ scout, worker }) => {
      const first = await enqueueMailboxMessage(scout, "Worker", "valid");
      const second = await enqueueMailboxMessage(scout, "Worker", "will be corrupt");
      const mailboxDir = join(worker.context.teamDir, "mailboxes", worker.agent.runId);
      writeFileSync(join(mailboxDir, "pending", `${second.id}.json`), "{ invalid", { mode: 0o600 });
      await assert.rejects(claimMailboxBatch(worker), /no claim state was changed/i);
      assert.equal(readdirSync(join(mailboxDir, "pending")).length, 2);
      assert.equal(readdirSync(join(mailboxDir, "inflight")).length, 0);
      assert.ok(readFileSync(join(mailboxDir, "pending", `${first.id}.json`), "utf8"));
    });
  });

  it("linearizes terminal transition before a waiting enqueue commit", async () => {
    await withFixture(async ({ context, scout, worker }) => {
      const releaseBlocker = await acquireTeamMailboxCommitLock(context.teamDir);
      const terminal = releaseAgentSlot(context, worker.agent.runId, "completed");
      const enqueue = enqueueMailboxMessage(scout, "Worker", "too late", {
        lockPollMs: 30,
        lockTimeoutMs: 1_000,
      });
      releaseBlocker();
      await terminal;
      await assert.rejects(enqueue, /terminal/i);
      assert.equal(pendingFiles(worker).length, 0);
      assert.equal(readAgent(context, worker.agent.runId)?.status, "completed");
    });
  });

  it("recovers a dead commit-lock owner for terminal status and lease release", async () => {
    await withFixture(async ({ context, worker }) => {
      const lock = join(context.teamDir, "mailboxes", ".commit.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, "owner.json"),
        `${JSON.stringify({ token: "dead-owner", pid: 2_000_000_000, acquiredAt: Date.now() })}\n`,
        { mode: 0o600 },
      );

      await releaseAgentSlot(context, worker.agent.runId, "completed");

      assert.equal(readAgent(context, worker.agent.runId)?.status, "completed");
      assert.equal(existsSync(join(context.teamDir, "leases", String(worker.agent.slot))), false);
      assert.equal(existsSync(lock), false);
    });
  });

  it("protects a live commit-lock owner until lifecycle transition can commit", async () => {
    await withFixture(async ({ context, worker }) => {
      const releaseOwner = await acquireTeamMailboxCommitLock(context.teamDir);
      const liveLock = join(context.teamDir, "mailboxes", ".commit.lock");
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(liveLock, staleTime, staleTime);
      const terminal = releaseAgentSlot(context, worker.agent.runId, "completed");
      await new Promise<void>((done) => setTimeout(done, 30));

      assert.equal(readAgent(context, worker.agent.runId)?.status, "running");
      assert.equal(existsSync(join(context.teamDir, "leases", String(worker.agent.slot))), true);

      releaseOwner();
      await terminal;
      assert.equal(readAgent(context, worker.agent.runId)?.status, "completed");
      assert.equal(existsSync(join(context.teamDir, "leases", String(worker.agent.slot))), false);
    });
  });

  it("combined child extensions register one mailbox tool and preserve inbound provenance", async () => {
    await withFixture(async ({ context, rootIdentity, scout, worker, reviewer }) => {
      await enqueueMailboxMessage(scout, "Worker", "inbound", {
        provenance: { hops: 1, route: [reviewer.agent.runId] },
      });
      const envKeys = [
        "PI_SUBAGENT_TEAM_DIR",
        "PI_SUBAGENT_AGENT_PATH",
        "PI_SUBAGENT_PARENT_PATH",
        "PI_SUBAGENT_THREAD_CAP",
        "PI_SUBAGENT_RUN_ID",
        "PI_SUBAGENT_ACTIVITY_FILE",
        "PI_DENY_TOOLS",
      ];
      const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
      Object.assign(process.env, teamEnvironment(context, worker.agent), { PI_DENY_TOOLS: "" });
      delete process.env.PI_SUBAGENT_ACTIVITY_FILE;

      const tools: any[] = [];
      const handlers = new Map<string, Function[]>();
      const entries: any[] = [];
      const api: any = {
        on(name: string, handler: Function) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        registerTool(tool: any) { tools.push(tool); },
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer() {},
        getAllTools() { return tools; },
        sendMessage(message: any) {
          entries.push({ type: "custom_message", ...message });
        },
      };
      const ctx: any = {
        sessionManager: { getEntries: () => entries },
      };

      try {
        subagentsExtension(api);
        subagentDoneExtension(api);
        const mailboxTools = tools.filter((tool) => tool.name === "subagent_message");
        assert.equal(mailboxTools.length, 1, "child must use only subagent-done mailbox registration");

        for (const handler of handlers.get("before_agent_start") ?? []) {
          await handler({ type: "before_agent_start" }, ctx);
        }
        const result = await mailboxTools[0].execute(
          "call-1",
          { target: "root", message: "reply with provenance" },
        );
        assert.equal(result.details.status, "queued");
        const [reply] = await claimMailboxBatch(rootIdentity);
        assert.equal(reply.hops, 3);
        assert.deepEqual(reply.route, [
          reviewer.agent.runId,
          scout.agent.runId,
          worker.agent.runId,
        ]);
      } finally {
        for (const [key, value] of previous) {
          if (value == null) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  it("does not corrupt team status while result/status metadata and mail are written together", async () => {
    await withFixture(async ({ context, scout, worker }) => {
      await Promise.all([
        enqueueMailboxMessage(scout, "Worker", "simultaneous"),
        Promise.resolve().then(() => updateAgent(context, worker.agent.runId, { status: "waiting" })),
        Promise.resolve().then(() => updateAgent(context, scout.agent.runId, { status: "interrupted" })),
      ]);
      assert.equal(readAgent(context, worker.agent.runId)?.status, "waiting");
      assert.equal(readAgent(context, scout.agent.runId)?.status, "interrupted");
      assert.deepEqual((await claimMailboxBatch(worker)).map((item) => item.message), ["simultaneous"]);
    });
  });
});
