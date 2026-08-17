import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  abandonAgentReservation,
  initializeTeam,
  listTeamAgents,
  readAgent,
  releaseAgentSlot,
  reserveAgentSlot,
  resolveTeamTarget,
  teamEnvironment,
  updateAgent,
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
