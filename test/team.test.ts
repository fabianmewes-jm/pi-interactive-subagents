import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  abandonAgentReservation,
  acquireTeamMailboxCommitLock,
  activateAgentSurface,
  agentIncarnation,
  activeOwnedSurface,
  initializeTeam,
  listTeamAgents,
  markAgentSurface,
  readAgent,
  releaseAgentSlot,
  reserveAgentSlot,
  reserveAgentSlotForResume,
  resolveTeamTarget,
  teamEnvironment,
  updateAgent,
  restoreAgentAfterFailedResume,
} from "../pi-extension/subagents/team.ts";
import { parseTeamConfig } from "../pi-extension/subagents/config.ts";

describe("team configuration", () => {
  it("defaults to four threads and validates explicit caps strictly", () => {
    assert.equal(parseTeamConfig({ status: { enabled: true } }).maxThreads, 4);
    assert.equal(parseTeamConfig({ team: { maxThreads: 7 } }).maxThreads, 7);
    assert.throws(() => parseTeamConfig({ team: { maxThreads: 0 } }), /positive integer/);
    assert.throws(() => parseTeamConfig({ team: { maxThreads: 4, extra: true } }), /unsupported key/);
  });
});

function withTeam(run: (fixture: ReturnType<typeof makeTeam>) => void, cap = 4): void {
  const root = mkdtempSync(join(tmpdir(), "pi-team-test-"));
  try {
    run(makeTeam(root, cap));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeTeam(root: string, cap = 4) {
  const artifactDir = join(root, "artifacts", "root-session");
  const context = initializeTeam({ artifactDir, sessionPath: join(root, "root.jsonl"), threadCap: cap, env: {} });
  return { root, artifactDir, context };
}

function reserve(context: ReturnType<typeof makeTeam>["context"], name: string, options: Record<string, unknown> = {}) {
  return reserveAgentSlot(context, {
    displayName: name,
    sessionPath: `/sessions/${name}.jsonl`,
    ...options,
  });
}

describe("team registry and capacity", () => {
  it("counts root and admits exactly three descendants by default", () => withTeam(({ context }) => {
    const agents = [reserve(context, "one"), reserve(context, "two"), reserve(context, "three")];
    assert.deepEqual(agents.map((agent) => agent.slot).sort(), [1, 2, 3]);
    assert.throws(() => reserve(context, "four"), /capacity reached.*4 concurrent threads/i);
    assert.equal(listTeamAgents(context).length, 4);
  }));

  it("atomically gives the final slot to only one cross-process contender", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-team-race-"));
    try {
      const { context } = makeTeam(root, 2);
      const teamModule = pathToFileURL(join(process.cwd(), "pi-extension/subagents/team.ts")).href;
      const script = `
        import { reserveAgentSlot } from ${JSON.stringify(teamModule)};
        process.on("message", ({ context, name }) => {
          try {
            const agent = reserveAgentSlot(context, { displayName: name, sessionPath: "/" + name + ".jsonl" });
            process.send({ ok: true, runId: agent.runId });
          } catch (error) {
            process.send({ ok: false, error: error.message });
          }
        });
      `;
      const contender = (name: string) => new Promise<{ ok: boolean; error?: string }>((resolveResult, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("message", (message) => {
          resolveResult(message as { ok: boolean; error?: string });
          child.disconnect();
        });
        child.send({ context, name });
        child.once("exit", (code) => {
          if (code && code !== 0) reject(new Error(stderr || `contender exited ${code}`));
        });
      });
      const outcomes = await Promise.all([contender("left"), contender("right")]);
      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
      assert.equal(outcomes.filter((outcome) => !outcome.ok).length, 1);
      assert.match(outcomes.find((outcome) => !outcome.ok)?.error ?? "", /capacity reached/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back abandoned launches and releases terminal agents", () => withTeam(({ context }) => {
    const failed = reserve(context, "failed");
    abandonAgentReservation(context, failed.runId);
    assert.equal(readAgent(context, failed.runId), null);

    const completed = reserve(context, "completed");
    updateAgent(context, completed.runId, { surface: "surface:1", status: "running" });
    releaseAgentSlot(context, completed.runId, "completed");
    assert.equal(readAgent(context, completed.runId)?.status, "completed");

    const replacements = [reserve(context, "replacement-a"), reserve(context, "replacement-b"), reserve(context, "replacement-c")];
    assert.equal(replacements.length, 3);
  }));

  it("recovers dead unfinished reservations but never active ones", () => withTeam(({ context }) => {
    const stale = reserve(context, "stale", { ownerPid: 2_000_000_000 });
    const replacement = reserve(context, "replacement");
    assert.equal(replacement.slot, stale.slot);

    updateAgent(context, replacement.runId, { surface: "surface:live", status: "running" });
    reserve(context, "second");
    reserve(context, "third");
    assert.throws(() => reserve(context, "blocked"), /capacity reached/i);
  }));

  it("keeps one atomic metadata file per agent and stable launch policy", () => withTeam(({ context }) => {
    const agent = reserveAgentSlot(context, {
      displayName: "Worker",
      role: "worker",
      sessionPath: "/sessions/worker.jsonl",
      launchPolicy: { model: "openai-codex/gpt-5.6-sol", cwd: "/repo" },
    });
    const raw = JSON.parse(readFileSync(join(context.teamDir, "agents", `${agent.runId}.json`), "utf8"));
    assert.equal(raw.launchPolicy.cwd, "/repo");
    assert.equal(raw.teamId, context.teamId);
  }));
});

describe("durable surface ownership", () => {
  it("admits only one simultaneous reservation for an exact terminal incarnation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-race-"));
    try {
      const { context } = makeTeam(root);
      const terminal = reserve(context, "worker");
      await releaseAgentSlot(context, terminal.runId, "completed", {
        expectedIncarnation: agentIncarnation(terminal),
      });
      const input = {
        runId: terminal.runId,
        expectedPriorIncarnation: agentIncarnation(terminal),
        path: terminal.path,
        parentPath: terminal.parentPath ?? context.agentPath,
        displayName: terminal.displayName,
        sessionPath: terminal.sessionPath,
      };
      const unlock = await acquireTeamMailboxCommitLock(context.teamDir);
      let surfacesCreated = 0;
      const contend = () => reserveAgentSlotForResume(context, input).then((record) => {
        surfacesCreated += 1;
        activateAgentSurface(context, record.runId, {
          backend: "cmux",
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }, agentIncarnation(record));
        return record;
      });
      const left = contend();
      const right = contend();
      unlock();
      const outcomes = await Promise.allSettled([left, right]);
      const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.match(String((failures[0] as PromiseRejectedResult).reason), /resume conflict.*(?:starting|running) incarnation/i);
      assert.equal(surfacesCreated, 1);
      const winner = (successes[0] as PromiseFulfilledResult<ReturnType<typeof reserve>>).value;
      assert.equal(readAgent(context, terminal.runId)?.incarnation, winner.incarnation);
      assert.equal(
        listTeamAgents(context).filter((agent) => agent.runId === terminal.runId).length,
        1,
      );
      const matchingLeases = Array.from({ length: context.threadCap - 1 }, (_, index) => index + 1)
        .map((slot) => {
          try {
            return JSON.parse(readFileSync(join(context.teamDir, "leases", String(slot), "owner.json"), "utf8"));
          } catch {
            return null;
          }
        })
        .filter((lease) => lease?.runId === terminal.runId);
      assert.deepEqual(matchingLeases.map((lease) => lease.incarnation), [winner.incarnation]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back a failed post-surface resume lease and restores only its prior terminal record", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-resume-rollback-"));
    try {
      const { context } = makeTeam(root, 2);
      const terminal = reserve(context, "worker");
      await releaseAgentSlot(context, terminal.runId, "completed", {
        expectedIncarnation: agentIncarnation(terminal),
      });
      const source = readAgent(context, terminal.runId)!;
      const resumed = await reserveAgentSlotForResume(context, {
        runId: terminal.runId,
        expectedPriorIncarnation: agentIncarnation(source),
        path: terminal.path,
        parentPath: terminal.parentPath ?? context.agentPath,
        displayName: terminal.displayName,
        sessionPath: terminal.sessionPath,
      });
      const surfaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      activateAgentSurface(context, resumed.runId, { backend: "cmux", id: surfaceId }, agentIncarnation(resumed));
      assert.equal(
        await restoreAgentAfterFailedResume(context, source, agentIncarnation(resumed)),
        true,
      );
      const restored = readAgent(context, terminal.runId)!;
      assert.equal(restored.incarnation, terminal.incarnation);
      assert.equal(restored.status, "completed");
      assert.equal(restored.surfaces?.some((surface) => surface.id === surfaceId), true);
      assert.doesNotThrow(() => reserve(context, "replacement"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let an old incarnation terminalize resumed metadata or delete its new lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-incarnation-race-"));
    try {
      const { context } = makeTeam(root);
      const first = reserve(context, "worker");
      const oldIncarnation = agentIncarnation(first);
      await releaseAgentSlot(context, first.runId, "completed", { expectedIncarnation: oldIncarnation });
      let delayedRelease: Promise<boolean> | undefined;
      const resumed = await reserveAgentSlotForResume(context, {
        runId: first.runId,
        expectedPriorIncarnation: oldIncarnation,
        path: first.path,
        parentPath: first.parentPath ?? context.agentPath,
        displayName: "worker",
        sessionPath: first.sessionPath,
        afterLeaseAcquired(reservation) {
          const lease = JSON.parse(readFileSync(
            join(context.teamDir, "leases", String(reservation.slot), "owner.json"),
            "utf8",
          ));
          assert.equal(lease.incarnation, reservation.incarnation);
          assert.equal(readAgent(context, first.runId)?.incarnation, first.incarnation);
          delayedRelease = releaseAgentSlot(context, first.runId, "errored", {
            expectedIncarnation: oldIncarnation,
          });
        },
      });
      assert.equal(await delayedRelease, false);
      assert.notEqual(resumed.incarnation, first.incarnation);
      assert.equal(readAgent(context, first.runId)?.incarnation, resumed.incarnation);
      assert.equal(readAgent(context, first.runId)?.status, "starting");
      const lease = JSON.parse(readFileSync(
        join(context.teamDir, "leases", String(resumed.slot), "owner.json"),
        "utf8",
      ));
      assert.equal(lease.incarnation, resumed.incarnation);
      assert.equal(
        await releaseAgentSlot(context, first.runId, "errored", { expectedIncarnation: oldIncarnation }),
        false,
      );
      assert.equal(readAgent(context, first.runId)?.status, "starting");
      await releaseAgentSlot(context, resumed.runId, "completed", {
        expectedIncarnation: agentIncarnation(resumed),
      });
      const newer = await reserveAgentSlotForResume(context, {
        runId: first.runId,
        expectedPriorIncarnation: agentIncarnation(resumed),
        path: first.path,
        parentPath: first.parentPath ?? context.agentPath,
        displayName: "worker",
        sessionPath: first.sessionPath,
      });
      const staleSlot = newer.slot === 2 ? 3 : 2;
      const staleLeaseDir = join(context.teamDir, "leases", String(staleSlot));
      mkdirSync(staleLeaseDir, { recursive: true });
      writeFileSync(join(staleLeaseDir, "owner.json"), JSON.stringify({
        runId: first.runId,
        incarnation: resumed.incarnation,
        ownerPid: process.pid,
        phase: "active",
        updatedAt: new Date().toISOString(),
      }));
      assert.equal(
        await restoreAgentAfterFailedResume(context, first, agentIncarnation(resumed)),
        false,
      );
      assert.equal(existsSync(staleLeaseDir), false);
      assert.equal(readAgent(context, first.runId)?.incarnation, newer.incarnation);
      const newerLease = JSON.parse(readFileSync(
        join(context.teamDir, "leases", String(newer.slot), "owner.json"),
        "utf8",
      ));
      assert.equal(newerLease.incarnation, newer.incarnation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains exact ownership history across terminal resume cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-surface-history-"));
    try {
      const { context } = makeTeam(root);
      const first = reserve(context, "worker");
      const uuidA = "11111111-1111-4111-8111-111111111111";
      const uuidB = "22222222-2222-4222-8222-222222222222";
      activateAgentSurface(context, first.runId, { backend: "cmux", id: uuidA, ref: "surface:7" });
      assert.equal(activeOwnedSurface(readAgent(context, first.runId)!)?.id, uuidA);
      markAgentSurface(context, first.runId, uuidA, "closed");
      await releaseAgentSlot(context, first.runId, "completed");

      const resumed = reserve(context, "worker", {
        runId: first.runId,
        path: first.path,
        parentPath: first.parentPath ?? context.agentPath,
      });
      activateAgentSurface(context, resumed.runId, { backend: "cmux", id: uuidB, ref: "surface:7" });
      const record = readAgent(context, first.runId)!;
      assert.deepEqual(record.surfaces?.map((surface) => [surface.id, surface.state]), [
        [uuidA, "closed"],
        [uuidB, "active"],
      ]);
      assert.equal(record.surface, uuidB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps failed-resume ownership while restoring terminal metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-failed-resume-history-"));
    try {
      const { context } = makeTeam(root);
      const first = reserve(context, "worker");
      const uuidA = "33333333-3333-4333-8333-333333333333";
      const uuidB = "44444444-4444-4444-8444-444444444444";
      activateAgentSurface(context, first.runId, { backend: "cmux", id: uuidA });
      markAgentSurface(context, first.runId, uuidA, "closed");
      await releaseAgentSlot(context, first.runId, "completed");
      const terminal = readAgent(context, first.runId)!;
      reserve(context, "worker", { runId: first.runId, path: first.path });
      activateAgentSurface(context, first.runId, { backend: "cmux", id: uuidB });
      markAgentSurface(context, first.runId, uuidB, "close_failed");
      await restoreAgentAfterFailedResume(context, terminal);
      const restored = readAgent(context, first.runId)!;
      assert.equal(restored.status, "completed");
      assert.deepEqual(restored.surfaces?.map((surface) => surface.id), [uuidA, uuidB]);
      assert.equal(restored.surfaces?.[1].state, "close_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("team paths, resolution, and listing", () => {
  it("creates hierarchical paths and propagates team environment", () => withTeam(({ context }) => {
    const parent = reserve(context, "Parent");
    const childContext = { ...context, agentPath: parent.path, parentPath: parent.parentPath };
    const child = reserve(childContext, "Child", { parentPath: parent.path });
    assert.equal(parent.path, "/root/parent");
    assert.equal(child.path, "/root/parent/child");
    assert.deepEqual(teamEnvironment(context, child), {
      PI_SUBAGENT_TEAM_DIR: context.teamDir,
      PI_SUBAGENT_AGENT_PATH: child.path,
      PI_SUBAGENT_PARENT_PATH: parent.path,
      PI_SUBAGENT_THREAD_CAP: "4",
      PI_SUBAGENT_RUN_ID: child.runId,
      PI_SUBAGENT_INCARNATION: child.incarnation,
    });
  }));

  it("resolves run ID, canonical path, relative path, and unique name", () => withTeam(({ context }) => {
    const parent = reserve(context, "Parent");
    const childContext = { ...context, agentPath: parent.path, parentPath: parent.parentPath };
    const child = reserve(childContext, "Child", { parentPath: parent.path });
    assert.equal(resolveTeamTarget(context, child.runId).runId, child.runId);
    assert.equal(resolveTeamTarget(context, child.path).runId, child.runId);
    assert.equal(resolveTeamTarget(childContext, "./child").runId, child.runId);
    assert.equal(resolveTeamTarget(context, "Child").runId, child.runId);
    assert.deepEqual(listTeamAgents(context, parent.path).map((agent) => agent.path), [parent.path, child.path]);
  }));

  it("rejects ambiguous, unknown, and escaping targets", () => withTeam(({ context }) => {
    reserve(context, "same");
    reserve(context, "same");
    assert.throws(() => resolveTeamTarget(context, "same"), /ambiguous/i);
    assert.throws(() => resolveTeamTarget(context, "missing"), /unknown/i);
    assert.throws(() => resolveTeamTarget(context, "../../other-team/agent"), /cross-team/i);
  }));

  it("reports normalized lifecycle statuses", () => withTeam(({ context }) => {
    const starting = reserve(context, "starting");
    const running = reserve(context, "running");
    updateAgent(context, running.runId, { status: "waiting", surface: "surface:2" });
    releaseAgentSlot(context, starting.runId, "errored");
    assert.deepEqual(
      listTeamAgents(context).map((agent) => agent.status).sort(),
      ["errored", "running", "waiting"],
    );
  }, 3));
});
