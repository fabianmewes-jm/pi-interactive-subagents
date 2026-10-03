import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
import {
  initializeTeam,
  readAgent,
  releaseAgentSlot,
  reserveAgentSlot,
  restoreAgentAfterFailedResume,
} from "../pi-extension/subagents/team.ts";

const api = (subagentsModule as any).__test__;
const baseParams = { name: "Display Worker", task: "Do work" };

function message(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content: [{ type: "text", text }] },
  };
}

function readEntries(path: string) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("per-spawn model and thinking", () => {
  it("uses tool values over frontmatter and frontmatter over Pi environment defaults", () => {
    const env = { PI_PROVIDER: "env-provider", PI_MODEL: "env-model" };
    assert.deepEqual(
      api.resolveEffectiveLaunchOptions(
        { model: "tool/model", thinking: "high", tools: "bash", skills: "tool-skill" },
        { model: "agent/model", thinking: "low", tools: "read", skills: "agent-skill" },
        env,
      ),
      { model: "tool/model", thinking: "high", tools: "bash", skills: "tool-skill" },
    );
    assert.deepEqual(
      api.resolveEffectiveLaunchOptions({}, { model: "agent/model", thinking: "medium" }, env),
      { model: "agent/model", thinking: "medium" },
    );
  });

  it("resolves the Pi environment model before adding a thinking CLI suffix", () => {
    const options = api.resolveEffectiveLaunchOptions(
      { thinking: "high" },
      null,
      { PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
    );
    assert.equal(options.model, "openai-codex/gpt-5.6-sol");
    assert.equal(api.buildPiModelSpec(options.model, options.thinking), "openai-codex/gpt-5.6-sol:high");
    assert.equal(
      api.buildPiModelSpec("openai-codex/gpt-5.6-sol:xhigh", "low"),
      "openai-codex/gpt-5.6-sol:low",
    );
    assert.deepEqual(api.modelEnvironment(options.model, options.thinking), {
      PI_PROVIDER: "openai-codex",
      PI_MODEL: "gpt-5.6-sol",
      PI_REASONING_LEVEL: "high",
    });
  });

  it("inherits valid Pi reasoning and explicitly clears stale model environment values", () => {
    assert.deepEqual(
      api.resolveEffectiveLaunchOptions(
        {},
        null,
        {
          PI_PROVIDER: "openai-codex",
          PI_MODEL: "gpt-5.6-sol",
          PI_REASONING_LEVEL: "medium",
        },
      ),
      { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
    );
    assert.deepEqual(
      api.resolveEffectiveLaunchOptions(
        {},
        { model: "agent/model" },
        { PI_REASONING_LEVEL: "xhigh" },
      ),
      { model: "agent/model" },
    );
    assert.deepEqual(api.modelEnvironment(undefined, undefined), {
      PI_PROVIDER: "",
      PI_MODEL: "",
      PI_REASONING_LEVEL: "",
    });
    assert.deepEqual(api.modelEnvironment("agent/model", undefined), {
      PI_PROVIDER: "agent",
      PI_MODEL: "model",
      PI_REASONING_LEVEL: "",
    });
  });

  it("validates reasoning and requires a resolvable model", () => {
    assert.throws(
      () => api.resolveEffectiveLaunchOptions({ thinking: "extreme" }, null, {}),
      /expected low, medium, or high/,
    );
    assert.throws(
      () => api.resolveEffectiveLaunchOptions({ thinking: "low" }, null, {}),
      /requires an effective model/,
    );
    assert.throws(
      () => api.resolveEffectiveLaunchOptions({ model: "" }, null, {}),
      /non-empty model/,
    );
  });
});

describe("forkTurns compatibility and seeding", () => {
  it("accepts none, all, and positive integers and preserves fork:true as all", () => {
    assert.equal(api.resolveForkTurns({ ...baseParams, forkTurns: "none" }, null), "none");
    assert.equal(api.resolveForkTurns({ ...baseParams, forkTurns: "all" }, null), "all");
    assert.equal(api.resolveForkTurns({ ...baseParams, forkTurns: "2" }, null), 2);
    assert.equal(api.resolveForkTurns({ ...baseParams, fork: true }, null), "all");
    assert.equal(api.resolveForkTurns({ ...baseParams, fork: true, forkTurns: "all" }, null), "all");
  });

  it("rejects malformed values and conflicting fork aliases actionably", () => {
    for (const value of ["0", "-1", "1.5", "latest", " 2", "9007199254740992"]) {
      assert.throws(() => api.resolveForkTurns({ ...baseParams, forkTurns: value }, null), /forkTurns/);
    }
    assert.throws(
      () => api.resolveForkTurns({ ...baseParams, fork: true, forkTurns: "2" }, null),
      /Conflicting context options/,
    );
  });

  it("copies only the latest N proven user turns and their ancestry events", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fork-turns-"));
    try {
      const parent = join(dir, "parent.jsonl");
      const entries = [
        { type: "session", id: "session", version: 3 },
        { type: "model_change", id: "model", parentId: null },
        message("u1", "model", "user", "first"),
        message("a1", "u1", "assistant", "first answer"),
        { type: "tool_event", id: "tool", parentId: "a1", value: "associated" },
        message("off", "u1", "assistant", "abandoned branch"),
        message("u2", "tool", "user", "second"),
        message("a2", "u2", "assistant", "second answer"),
        message("trigger", "a2", "user", "spawn now"),
      ];
      writeFileSync(parent, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

      const one = join(dir, "one.jsonl");
      seedSubagentSessionFile({ mode: "fork", forkTurns: 1, parentSessionFile: parent, childSessionFile: one, childCwd: dir });
      assert.deepEqual(readEntries(one).slice(1).map((entry) => entry.id), ["u2", "a2"]);
      assert.equal(readEntries(one)[1].parentId, null);

      const two = join(dir, "two.jsonl");
      seedSubagentSessionFile({ mode: "fork", forkTurns: 2, parentSessionFile: parent, childSessionFile: two, childCwd: dir });
      assert.deepEqual(readEntries(two).slice(1).map((entry) => entry.id), ["u1", "a1", "tool", "u2", "a2"]);
      assert.equal(readEntries(two).some((entry) => entry.id === "off"), false);

      const all = join(dir, "all.jsonl");
      seedSubagentSessionFile({ mode: "fork", forkTurns: "all", parentSessionFile: parent, childSessionFile: all, childCwd: dir });
      assert.deepEqual(
        readEntries(all).slice(1).map((entry) => entry.id),
        ["model", "u1", "a1", "tool", "u2", "a2"],
      );
      assert.equal(readEntries(all).some((entry) => entry.id === "off"), false);

      const none = join(dir, "none.jsonl");
      seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: parent, childSessionFile: none, childCwd: dir });
      assert.equal(readEntries(none).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("taskName, nested policy, and resume restoration", () => {
  it("reuses the initial prompt builder for stored resume skills", () => {
    assert.deepEqual(
      api.buildPiPromptArgs({
        effectiveSkills: "commit,review",
        taskDelivery: "artifact",
        taskArg: "@resume-message.md",
      }),
      ["", "/skill:commit", "/skill:review", "@resume-message.md"],
    );
    assert.deepEqual(
      api.buildPiPromptArgs({ effectiveSkills: "commit", taskDelivery: "artifact" }),
      ["/skill:commit"],
    );
  });

  it("persists effective deny policies, including an explicit empty policy", () => {
    assert.equal(api.serializeDenyTools(api.resolveDenyTools({ spawning: false })),
      "subagent,subagent_interrupt,subagent_resume,subagents_list");
    assert.equal(api.persistedDenyTools({ effectiveDenyTools: "" }), "");
    assert.equal(
      api.persistedDenyTools({ denyTools: "bash", spawning: false }),
      "bash,subagent,subagent_interrupt,subagent_resume,subagents_list",
    );
  });

  it("resolves taskName with tool-over-frontmatter priority and validates blanks", () => {
    assert.equal(api.resolveTaskName({ taskName: "tool task" }, { taskName: "agent task" }), "tool task");
    assert.equal(api.resolveTaskName({}, { taskName: "agent task" }), "agent task");
    assert.throws(() => api.resolveTaskName({ taskName: "   " }, null), /non-empty/);
  });

  it("uses taskName for the canonical path without changing display identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-name-"));
    try {
      const team = initializeTeam({ artifactDir: join(dir, "artifacts"), sessionPath: join(dir, "root.jsonl"), env: {} });
      const agent = reserveAgentSlot(team, {
        displayName: "Friendly Worker",
        taskName: "Implement API",
        sessionPath: join(dir, "worker.jsonl"),
      });
      assert.equal(agent.displayName, "Friendly Worker");
      assert.equal(agent.path, "/root/implement-api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores run identity, path inputs, launch defaults, and validated overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-resume-policy-"));
    try {
      const sessionPath = join(dir, "worker.jsonl");
      const team = initializeTeam({ artifactDir: join(dir, "artifacts"), sessionPath: join(dir, "root.jsonl"), env: {} });
      const source = reserveAgentSlot(team, {
        runId: "original-run",
        displayName: "Worker",
        taskName: "owned-task",
        role: "worker",
        sessionPath,
        launchPolicy: {
          model: "openai-codex/gpt-5.6-sol",
          thinking: "medium",
          tools: "read,bash",
          skills: "commit",
          cwd: "/repo",
          autoExit: true,
          interactive: false,
          identity: "Worker identity",
          effectiveDenyTools: "",
        },
      });
      releaseAgentSlot(team, source.runId, "completed");
      const terminalSource = { ...source, status: "completed" };
      const restored = api.resolveResumeLaunchBehavior(
        { thinking: "high", interactive: true },
        terminalSource,
        {},
      );
      assert.equal(source.runId, "original-run");
      assert.equal(source.path, "/root/owned-task");
      assert.equal(restored.name, "Worker");
      assert.equal(restored.role, "worker");
      assert.equal(restored.model, "openai-codex/gpt-5.6-sol");
      assert.equal(restored.thinking, "high");
      assert.equal(restored.tools, "read,bash");
      assert.equal(restored.skills, "commit");
      assert.equal(restored.cwd, "/repo");
      assert.equal(restored.interactive, true);
      assert.equal(restored.launchPolicy.identity, "Worker identity");
      assert.equal(restored.launchPolicy.effectiveDenyTools, "");
      const resumed = reserveAgentSlot(team, {
        runId: source.runId,
        path: source.path,
        parentPath: source.parentPath ?? team.agentPath,
        displayName: restored.name,
        role: restored.role,
        sessionPath,
        launchPolicy: restored.launchPolicy,
      });
      assert.equal(resumed.runId, source.runId);
      assert.equal(resumed.path, source.path);
      assert.equal(resumed.launchPolicy.thinking, "high");
      restoreAgentAfterFailedResume(team, terminalSource);
      assert.equal(readAgent(team, source.runId)?.status, "completed");
      assert.equal(readAgent(team, source.runId)?.launchPolicy.thinking, "medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
