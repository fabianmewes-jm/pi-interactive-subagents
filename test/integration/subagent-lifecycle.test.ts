/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn REAL pi sessions with REAL LLM calls (haiku by default).
 * Each test creates a mux surface, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Costs: ~$0.01-0.05 per test run (haiku).
 * Duration: ~30-90s per test.
 *
 * Run inside a supported multiplexer:
 *   cmux bash -c 'npm run test:integration'
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: openai-codex/gpt-5.6-sol)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { captureCmuxFocusSnapshot, surfaceExists } from "../../pi-extension/subagents/cmux.ts";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnvVerified,
  createTrackedSurface,
  snapshotCmuxSurfaces,
  startPi,
  waitForScreen,
  waitForFile,
  waitForCondition,
  assertConditionFor,
  sleep,
  uniqueId,
  trackTempFile,
  trackTeamDir,
  trackRegistryOwnedSurfaces,
  readScreen,
  sendCommand,
  closeSurface,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

interface IntegrationAgentRecord {
  runId: string;
  displayName: string;
  path: string;
  parentPath: string | null;
  status: string;
  slot: number;
  surface?: string;
  surfaces?: Array<{ id: string; state: string }>;
  sessionPath: string;
  incarnation?: string;
  launchPolicy: Record<string, unknown>;
}

function readAgents(teamDir: string): IntegrationAgentRecord[] {
  return readdirSync(`${teamDir}/agents`)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(`${teamDir}/agents/${name}`, "utf8")));
}

function readSession(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function activeLeases(teamDir: string): any[] {
  return readdirSync(`${teamDir}/leases`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => JSON.parse(readFileSync(`${teamDir}/leases/${entry.name}/owner.json`, "utf8")));
}

function stableFocus() {
  const focus = captureCmuxFocusSnapshot();
  assert.ok(focus?.windowId && focus.workspaceId && focus.paneId && focus.surfaceId);
  return {
    windowId: focus.windowId,
    workspaceId: focus.workspaceId,
    paneId: focus.paneId,
    surfaceId: focus.surfaceId,
  };
}

const TERMINAL = new Set(["completed", "errored"]);

function registerTeam(env: TestEnv, teamDir: string, rootSurface: string): string {
  assert.ok(teamDir, "scenario must capture its team registry before cleanup");
  trackTeamDir(env, teamDir, rootSurface);
  return teamDir;
}

function finishNonTerminalAgents(teamDir: string, names: readonly string[]): void {
  const agents = readAgents(teamDir);
  for (const name of names) {
    const agent = agents.find((candidate) => candidate.displayName === name);
    if (agent && !TERMINAL.has(agent.status) && agent.surface && surfaceExists(agent.surface)) {
      sendCommand(agent.surface, "Call subagent_done now. Do not do anything else.");
    }
  }
}

async function waitForTerminalRegistry(
  teamDir: string,
  names: readonly string[],
): Promise<IntegrationAgentRecord[]> {
  await waitForCondition(`terminal registry records and absent surfaces: ${names.join(", ")}`, () => {
    const agents = readAgents(teamDir);
    return names.every((name) => {
      const agent = agents.find((candidate) => candidate.displayName === name);
      return !!agent && TERMINAL.has(agent.status) &&
        agent.surfaces?.every((surface) => surface.state !== "active" && !surfaceExists(surface.id)) === true;
    });
  });
  const agents = readAgents(teamDir);
  const selected = names.map((name) => agents.find((agent) => agent.displayName === name)!);
  for (const agent of selected) {
    assert.ok(agent, "missing terminal registry record");
    assert.equal(agent.surfaces?.every((surface) => surface.state !== "active"), true);
    assert.equal(agent.surfaces?.every((surface) => !surfaceExists(surface.id)), true);
  }
  return selected;
}

async function waitForTerminalAgents(
  teamDir: string,
  names: readonly string[],
  notificationType: "subagent_result" | "subagent_ping" = "subagent_result",
): Promise<IntegrationAgentRecord[]> {
  const selected = await waitForTerminalRegistry(teamDir, names);
  await waitForCondition(`direct-parent notifications: ${names.join(", ")}`, () => {
    const root = readAgents(teamDir).find((agent) => agent.parentPath === null);
    if (!root) return false;
    const entries = readSession(root.sessionPath);
    return names.every((name) => entries.filter((entry) =>
      entry.type === "custom_message" && entry.customType === notificationType && entry.details?.name === name
    ).length === 1);
  });
  return selected;
}

function markerTeamAndRun(content: string): { teamDir: string; runId: string } {
  const lines = content.includes("\n") ? content.trim().split("\n") : content.trim().split("|");
  assert.ok(lines.length >= 3, `marker must include payload, team dir, and run id: ${content}`);
  return { teamDir: lines[1], runId: lines[2] };
}

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping subagent lifecycle integration tests");
  console.log("   Run inside cmux or tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 10 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    let suiteBaseline: ReturnType<typeof snapshotCmuxSurfaces> = null;
    const suiteOwned = new Map<string, string>();

    before(() => {
      prevMux = setBackend(backend);
      suiteBaseline = backend === "cmux" ? snapshotCmuxSurfaces() : null;
    });

    after(() => {
      try {
        if (backend !== "cmux") return;
        assert.ok(suiteBaseline, "cmux suite baseline snapshot must succeed");
        const current = snapshotCmuxSurfaces();
        assert.ok(current, "cmux suite postcondition snapshot must succeed");
        const remaining = current.filter((surface) => suiteOwned.has(surface.ref));
        const evidence = [...suiteOwned].map(([ref, title]) => `${ref} ${JSON.stringify(title)}`);
        console.log(`cmux lifecycle owned surfaces (${evidence.length}): ${evidence.join(", ") || "none"}`);
        assert.deepEqual(
          remaining,
          [],
          `cmux lifecycle suite leaked owned surfaces: ${remaining.map((surface) => `${surface.ref} ${JSON.stringify(surface.title)}`).join(", ")}`,
        );
      } finally {
        restoreBackend(prevMux);
      }
    });

    const scenarioIt = (name: string, run: () => Promise<void>) => it(name, async () => {
      env = createTestEnv(backend);
      try {
        await run();
      } finally {
        trackRegistryOwnedSurfaces(env);
        for (const tracked of env.surfaceHistory) {
          if (backend !== "cmux") continue;
          assert.equal(
            suiteBaseline?.some((surface) => surface.ref === tracked.ref),
            false,
            `owned UUID unexpectedly predates lifecycle suite: ${tracked.ref}`,
          );
          suiteOwned.set(tracked.ref, tracked.cmuxOwnership?.titleFragment ?? "unlabeled");
        }
        await cleanupTestEnvVerified(env);
      }
    });

    // ── Basic spawn + completion ──

    scenarioIt("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: printf 'PASS_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );
      const { teamDir } = markerTeamAndRun(content);
      registerTeam(env, teamDir, surface);

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(surface, /INTEGRATION_COMPLETE/, PI_TIMEOUT);

      assert.match(screen, /INTEGRATION_COMPLETE/);
      const [echo] = await waitForTerminalAgents(teamDir, [`Echo-${id}`]);
      assert.ok(existsSync(echo.sessionPath));
      const entries = readSession(echo.sessionPath);
      assert.ok(entries.length >= 2);
      assert.equal(entries[0].type, "session");
      assert.ok(entries[0].id);
    });

    // ── In-progress activity snapshots ──

    scenarioIt("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: printf 'START_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const started = await waitForFile(startFile, PI_TIMEOUT, /START_/);
      const { teamDir } = markerTeamAndRun(started);
      registerTeam(env, teamDir, surface);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
      await waitForTerminalAgents(teamDir, [`Status-${id}`]);
    });

    // ── Parallel subagent spawn ──

    scenarioIt("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: printf 'DONE_A_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: printf 'DONE_B_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
      const teamA = markerTeamAndRun(contentA).teamDir;
      assert.equal(markerTeamAndRun(contentB).teamDir, teamA);
      registerTeam(env, teamA, surface);
      await waitForTerminalAgents(teamA, [`ParaA-${id}`, `ParaB-${id}`]);
    });

    // ── Durable direct mailbox (cmux-serialized) ──

    if (backend === "cmux") {
      scenarioIt("queues Scout A mail for idle Worker B until Worker's next turn", async () => {
        const id = uniqueId();
        const readyFile = `/tmp/pi-integ-mailbox-ready-${id}.txt`;
        const infoFile = `/tmp/pi-integ-mailbox-info-${id}.txt`;
        const queuedFile = `/tmp/pi-integ-mailbox-queued-${id}.txt`;
        const deliveredFile = `/tmp/pi-integ-mailbox-delivered-${id}.txt`;
        for (const file of [readyFile, infoFile, queuedFile, deliveredFile]) {
          trackTempFile(env, file);
        }

        const surface = createTrackedSurface(env, `mailbox-${id}`);
        await sleep(1000);

        const workerTask = [
          `Run this exact bash command first:`,
          `printf '%s\\n%s\\n%s\\n%s\\n' "$PI_SUBAGENT_RUN_ID" "$PI_SUBAGENT_TEAM_DIR" "$PI_SUBAGENT_SURFACE" "$PI_SUBAGENT_ACTIVITY_FILE" > '${infoFile}'; echo 'READY_${id}' > '${readyFile}'`,
          `Then finish your response and remain idle. Do not call subagent_done.`,
          `On a later turn, obey any direct mailbox message delivered to you.`,
        ].join("\n");
        const scoutTask = [
          `Call subagent_message twice in order, both targeting "Worker-${id}".`,
          `First exact message: Run: echo 'FIRST_${id}' > '${deliveredFile}'.`,
          `Second exact message: Run: echo 'SECOND_${id}' >> '${deliveredFile}'. Then call subagent_done.`,
          `After both queue acknowledgements, run: echo 'QUEUED_${id}' > '${queuedFile}'.`,
          `Finally call subagent_done.`,
        ].join(" ");
        const task = [
          `Call the subagent tool once: name "Worker-${id}", agent "test-team", task ${JSON.stringify(workerTask)}, interactive true.`,
          `After that call, do not send any message to Worker and do not start or resume it.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        await waitForFile(readyFile, PI_TIMEOUT, /READY_/);
        const info = await waitForFile(infoFile, PI_TIMEOUT);
        const [workerRunId, teamDir, workerSurface, activityFile] = info.trim().split("\n");
        assert.ok(
          workerRunId && teamDir && workerSurface && activityFile,
          `Invalid Worker mailbox metadata: ${info}`,
        );
        registerTeam(env, teamDir, surface);

        // READY is emitted inside the Worker tool call, before agent_end. Do
        // not let Scout enqueue until both authoritative states report idle.
        await waitForCondition("Worker registry and activity waiting before enqueue", () => {
          const agent = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
          const activity = JSON.parse(readFileSync(activityFile, "utf8"));
          return agent.status === "waiting" && activity.phase === "waiting";
        });
        sendCommand(surface, [
          `Now call subagent once: name "Scout-${id}", agent "test-team", task ${JSON.stringify(scoutTask)}, interactive false.`,
          `Do not send or follow up Worker yourself.`,
        ].join(" "));
        await waitForFile(queuedFile, PI_TIMEOUT, /QUEUED_/);
        assert.equal(existsSync(deliveredFile), false, "queued mail must not start an idle Worker turn");

        const pendingDir = `${teamDir}/mailboxes/${workerRunId}/pending`;
        assert.equal(readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length, 2);
        const workerSessionPath = readAgents(teamDir).find((agent) => agent.runId === workerRunId)!.sessionPath;
        const entriesBeforeWake = readSession(workerSessionPath).length;
        await assertConditionFor("queued FIFO mail does not wake idle Worker", () => {
          const agent = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
          const activity = JSON.parse(readFileSync(activityFile, "utf8"));
          const entries = readSession(workerSessionPath);
          return agent.status === "waiting" &&
            activity.phase === "waiting" &&
            readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length === 2 &&
            !existsSync(deliveredFile) &&
            entries.length === entriesBeforeWake &&
            entries.every((entry) => !(entry.type === "custom_message" && entry.customType === "subagent_mailbox"));
        }, 4_000, 200);

        sendCommand(workerSurface, "Process the queued direct mailbox message now.");
        const delivered = await waitForFile(deliveredFile, PI_TIMEOUT, /SECOND_/);
        assert.deepEqual(delivered.trim().split("\n"), [`FIRST_${id}`, `SECOND_${id}`]);
        assert.equal(readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length, 0);
        const workerRecord = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
        const mailboxEntries = readSession(workerRecord.sessionPath).filter((entry) =>
          entry.type === "custom_message" && entry.customType === "subagent_mailbox"
        );
        assert.equal(mailboxEntries.length, 1, "FIFO mailbox batch must be model-visible exactly once");
        assert.ok(mailboxEntries[0].content.indexOf(`FIRST_${id}`) < mailboxEntries[0].content.indexOf(`SECOND_${id}`));
        finishNonTerminalAgents(teamDir, [`Worker-${id}`, `Scout-${id}`]);
        await waitForTerminalAgents(teamDir, [`Worker-${id}`, `Scout-${id}`]);
        assert.equal(activeLeases(teamDir).length, 1);
      });
    }

    if (backend === "cmux") {
      scenarioIt("wakes an idle sibling by follow-up and routes nested completion to its direct parent", async () => {
        const id = uniqueId();
        const readyFile = `/tmp/pi-integ-followup-ready-${id}.txt`;
        const infoFile = `/tmp/pi-integ-followup-info-${id}.txt`;
        const queuedFile = `/tmp/pi-integ-followup-queued-${id}.txt`;
        const nestedFile = `/tmp/pi-integ-followup-nested-${id}.txt`;
        const deliveredFile = `/tmp/pi-integ-followup-delivered-${id}.txt`;
        for (const file of [
          readyFile,
          infoFile,
          queuedFile,
          nestedFile,
          deliveredFile,
        ]) trackTempFile(env, file);

        let surface = "";
        let workerRunId = "";
        let teamDir = "";
        surface = createTrackedSurface(env, `followup-${id}`, {
          cmuxOwnership: { baseline: env.cmuxBaseline, titleFragment: id },
        });
        await sleep(1000);

        const nestedTask = `Run: echo 'NESTED_${id}' > '${nestedFile}'.`;
        const workerTask = [
          `Run this exact bash command first:`,
          `printf '%s\\n%s\\n' "$PI_SUBAGENT_RUN_ID" "$PI_SUBAGENT_TEAM_DIR" > '${infoFile}'; echo 'READY_${id}' > '${readyFile}'`,
          `Then finish your response and remain idle. Do not call subagent_done.`,
          `On the later attributed subagent_mailbox follow-up, obey its actual contents exactly.`,
          `Do not infer follow-up work from this initial task or from transport metadata.`,
        ].join("\n");
        const followupMessage = [
          `Continue in this same run now.`,
          `Call subagent once with name "Nested-${id}", agent "test-echo", interactive false, cwd ${JSON.stringify(env.dir)}, and task ${JSON.stringify(nestedTask)}.`,
          `Only after its automatic result reaches you, run: echo 'DELIVERED_${id}' > '${deliveredFile}'`,
          `Then call subagent_done.`,
        ].join(" ");
        const scoutTask = [
          `Call subagent_followup with target "Worker-${id}" and message ${JSON.stringify(followupMessage)}.`,
          `After it acknowledges, run: echo 'QUEUED_${id}' > '${queuedFile}'`,
          `Then call subagent_done.`,
        ].join(" ");
        const task = [
          `Call subagent once: name "Worker-${id}", agent "test-team", task ${JSON.stringify(workerTask)}, interactive true.`,
          `Do not send commands, messages, interrupts, or resumes to Worker.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        await waitForFile(readyFile, PI_TIMEOUT, /READY_/);
        const info = await waitForFile(infoFile, PI_TIMEOUT);
        [workerRunId, teamDir] = info.trim().split("\n");
        assert.ok(workerRunId && teamDir, `Invalid Worker follow-up metadata: ${info}`);
        registerTeam(env, teamDir, surface);

        const activityFile = JSON.parse(
          readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"),
        ).launchPolicy.activityFile;
        await waitForCondition("Worker registry and activity idle before follow-up", () => {
          const agent = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
          const activity = JSON.parse(readFileSync(activityFile, "utf8"));
          return agent.status === "waiting" && activity.phase === "waiting";
        });
        sendCommand(surface, [
          `Now call subagent once: name "Scout-${id}", agent "test-team", task ${JSON.stringify(scoutTask)}, interactive false.`,
          `Do not follow up Worker yourself.`,
        ].join(" "));

        await waitForFile(queuedFile, PI_TIMEOUT, /QUEUED_/);
        await waitForFile(nestedFile, PI_TIMEOUT, /NESTED_/);
        const delivered = await waitForFile(deliveredFile, PI_TIMEOUT, /DELIVERED_/);
        assert.match(delivered, new RegExp(`DELIVERED_${id}`));

        const agents = readdirSync(`${teamDir}/agents`)
          .map((name) => JSON.parse(readFileSync(`${teamDir}/agents/${name}`, "utf8")));
        const worker = agents.find((agent) => agent.runId === workerRunId);
        const nested = agents.find((agent) => agent.displayName === `Nested-${id}`);
        assert.ok(worker, "Worker registry record should remain available");
        assert.ok(nested, "Worker should have spawned the nested child after its follow-up wake");
        assert.equal(nested.parentPath, worker.path, "nested completion must route to its direct parent");
        assert.equal(nested.launchPolicy.autoExit, true, "nested test agent must terminate deterministically");
        assert.equal(nested.launchPolicy.interactive, false);

        const workerEntries = readFileSync(worker.sessionPath, "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        const mailboxEntries = workerEntries.filter((entry) =>
          entry.type === "custom_message" && entry.customType === "subagent_mailbox"
        );
        assert.equal(mailboxEntries.length, 1, "attributed durable batch must be model-visible exactly once");
        assert.match(mailboxEntries[0].content, new RegExp(`Nested-${id}`));
        const nestedResults = workerEntries.filter((entry) =>
          entry.type === "custom_message" && entry.customType === "subagent_result" &&
          entry.details?.name === nested.displayName
        );
        assert.equal(nestedResults.length, 1, "nested completion must persist in the direct parent's session");
        const root = agents.find((agent) => agent.parentPath == null);
        assert.ok(root);
        const rootEntries = readFileSync(root.sessionPath, "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(rootEntries.some((entry) =>
          entry.type === "custom_message" && entry.customType === "subagent_result" &&
          entry.details?.name === nested.displayName
        ), false, "nested result must not bypass its direct parent");
        const mailboxDir = `${teamDir}/mailboxes/${workerRunId}`;
        assert.equal(readdirSync(`${mailboxDir}/pending`).filter((name) => name.endsWith(".json")).length, 0);
        assert.equal(readdirSync(`${mailboxDir}/inflight`).filter((name) => name.endsWith(".json")).length, 0);
        assert.equal(readdirSync(`${mailboxDir}/delivered`).filter((name) => name.endsWith(".json")).length, 1);
        finishNonTerminalAgents(teamDir, [`Worker-${id}`, `Scout-${id}`]);
        await waitForTerminalAgents(teamDir, [`Worker-${id}`, `Scout-${id}`]);
        await waitForTerminalRegistry(teamDir, [`Nested-${id}`]);
        assert.equal(activeLeases(teamDir).length, 1);
      });
    }

    // ── Serialized real-cmux acceptance matrix ──

    if (backend === "cmux") {
      scenarioIt("enforces the shared cap before surface creation and reuses a released slot", async () => {
        const id = uniqueId();
        const baseline = snapshotCmuxSurfaces();
        const infoFiles = [0, 1, 2].map((index) => `/tmp/pi-integ-cap-${id}-${index}.txt`);
        const shortDone = `/tmp/pi-integ-cap-${id}-short.txt`;
        const replacementInfo = `/tmp/pi-integ-cap-${id}-replacement.txt`;
        for (const file of [...infoFiles, shortDone, replacementInfo]) trackTempFile(env, file);
        let rootSurface = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `cap-${id}`, {
            cmuxOwnership: { baseline, titleFragment: id },
          });
          const hold = (index: number, seconds: number, done?: string) => [
            `Run exactly one bash tool call: printf '%s\\n%s\\n' "$PI_SUBAGENT_TEAM_DIR" "$PI_SUBAGENT_RUN_ID" > '${infoFiles[index]}'; sleep ${seconds}${done ? `; echo DONE_${id} > '${done}'` : ""}.`,
            `Do not poll or loop.`,
          ].join(" ");
          startPi(rootSurface, env.dir, [
            `Call subagent three times in this order without waiting for results.`,
            `Names "CapA-${id}", "CapB-${id}", "CapC-${id}"; agent "test-echo"; tasks respectively ${JSON.stringify(hold(0, 75, shortDone))}, ${JSON.stringify(hold(1, 240))}, ${JSON.stringify(hold(2, 240))}.`,
            `Make all three calls, then say CAP_FILLED_${id}.`,
          ].join("\n"));

          await Promise.all(infoFiles.map((file) => waitForFile(file, PI_TIMEOUT)));
          teamDir = readFileSync(infoFiles[0], "utf8").trim().split("\n")[0];
          registerTeam(env, teamDir, rootSurface);
          await waitForCondition("four capacity leases", () => activeLeases(teamDir).length === 4);
          sendCommand(rootSurface, `Call subagent once now: name "CapRejected-${id}", agent "test-echo", task "echo MUST_NOT_START". Report the exact tool error.`);
          await waitForScreen(rootSurface, /capacity\s+reached/i, PI_TIMEOUT, 300);
          let agents = readAgents(teamDir);
          assert.equal(agents.filter((agent) => agent.parentPath !== null).length, 3);
          assert.equal(agents.some((agent) => agent.displayName === `CapRejected-${id}`), false);
          assert.equal(activeLeases(teamDir).length, 4, "root plus exactly three descendants own leases");
          const current = snapshotCmuxSurfaces() ?? [];
          assert.equal(current.filter((item) => item.title.includes(id)).length, 4, "rejected call creates no surface");

          await waitForFile(shortDone, PI_TIMEOUT, /DONE_/);
          await waitForCondition("short holder lease release", () => activeLeases(teamDir).length === 3);
          sendCommand(rootSurface, [
            `Call subagent once with name "CapReplacement-${id}", agent "test-echo",`,
            `task "Run: echo REPLACEMENT_${id} > '${replacementInfo}'; sleep 10".`,
            `Then say CAP_REPLACED_${id}.`,
          ].join(" "));
          await waitForFile(replacementInfo, PI_TIMEOUT);
          await waitForCondition("replacement lease admission", () => activeLeases(teamDir).length === 4);
          agents = readAgents(teamDir);
          assert.equal(agents.filter((agent) => agent.displayName === `CapReplacement-${id}`).length, 1);
          assert.equal(agents.find((agent) => agent.displayName === `CapA-${id}`)?.status, "completed");
          const root = agents.find((agent) => agent.parentPath === null)!;
          assert.equal(readSession(root.sessionPath).filter((entry) =>
            JSON.stringify(entry).match(/capacity reached/i)).length >= 1, true);
          for (const name of [`CapB-${id}`, `CapC-${id}`]) {
            const child = agents.find((agent) => agent.displayName === name)!;
            assert.ok(child.surface && surfaceExists(child.surface));
            closeSurface(child.surface);
          }
          await waitForTerminalAgents(teamDir, [
            `CapA-${id}`,
            `CapB-${id}`,
            `CapC-${id}`,
            `CapReplacement-${id}`,
          ]);
          assert.equal(activeLeases(teamDir).length, 1);
      });

      scenarioIt("admits exactly one nested child in a final-slot follow-up race", async () => {
        const id = uniqueId();
        const baseline = snapshotCmuxSurfaces();
        const infoFiles = ["a", "b"].map((suffix) => `/tmp/pi-integ-race-${id}-${suffix}.txt`);
        const nestedFiles = ["a", "b"].map((suffix) => `/tmp/pi-integ-race-${id}-nested-${suffix}.txt`);
        for (const file of [...infoFiles, ...nestedFiles]) trackTempFile(env, file);
        let rootSurface = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `race-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          const parentTask = (index: number) => `Run: printf '%s\\n%s\\n' "$PI_SUBAGENT_TEAM_DIR" "$PI_SUBAGENT_RUN_ID" > '${infoFiles[index]}'. Then finish this turn and remain idle; do not call subagent_done.`;
          startPi(rootSurface, env.dir, [
            `Call subagent twice without waiting: names "RaceParentA-${id}" and "RaceParentB-${id}", agent "test-team", interactive true, tasks ${JSON.stringify(parentTask(0))} and ${JSON.stringify(parentTask(1))}.`,
            `After both calls say RACE_PARENTS_${id} and do nothing else.`,
          ].join("\n"));
          await Promise.all(infoFiles.map((file) => waitForFile(file, PI_TIMEOUT)));
          teamDir = readFileSync(infoFiles[0], "utf8").trim().split("\n")[0];
          registerTeam(env, teamDir, rootSurface);
          await waitForCondition("both race parents waiting", () => {
            const parents = readAgents(teamDir).filter((agent) => agent.displayName.startsWith("RaceParent"));
            return parents.length === 2 && parents.every((agent) => agent.status === "waiting");
          });
          const message = (suffix: "A" | "B", index: number) => [
            `Call subagent once with name "RaceNested${suffix}-${id}", agent "test-echo", cwd ${JSON.stringify(env.dir)}, interactive false, task "Run: echo NESTED_${suffix}_${id} > '${nestedFiles[index]}'; sleep 20".`,
            `A successful spawn acknowledgement is not the nested agent's completion: remain idle and do not call subagent_done after that acknowledgement.`,
            `Call subagent_done only after the automatic terminal completion result arrives, or immediately if the spawn returns a capacity error.`,
          ].join(" ");
          sendCommand(rootSurface, [
            `Call subagent_followup twice in this same turn without waiting:`,
            `target "RaceParentA-${id}" with message ${JSON.stringify(message("A", 0))};`,
            `target "RaceParentB-${id}" with message ${JSON.stringify(message("B", 1))}.`,
          ].join(" "));
          await waitForCondition("one nested race admission", () =>
            readAgents(teamDir).filter((agent) => agent.displayName.startsWith("RaceNested")).length === 1,
          );
          const nested = readAgents(teamDir).filter((agent) => agent.displayName.startsWith("RaceNested"));
          assert.equal(nested.length, 1);
          await waitForCondition("capacity loser transcript", () => {
            const parents = readAgents(teamDir).filter((agent) => agent.displayName.startsWith("RaceParent"));
            return parents.filter((agent) => /capacity reached/i.test(JSON.stringify(readSession(agent.sessionPath)))).length === 1;
          });
          await waitForCondition("admitted nested execution", () => nestedFiles.filter(existsSync).length === 1);
          assert.equal(nestedFiles.filter(existsSync).length, 1);
          await waitForTerminalRegistry(teamDir, [nested[0].displayName]);
          finishNonTerminalAgents(teamDir, [`RaceParentA-${id}`, `RaceParentB-${id}`]);
          await waitForTerminalAgents(teamDir, [`RaceParentA-${id}`, `RaceParentB-${id}`]);
          assert.equal(activeLeases(teamDir).length, 1);
      });

      scenarioIt("forks none, all, and the latest positive-N user turns from one conversation", async () => {
        const id = uniqueId();
        const baseline = snapshotCmuxSurfaces();
        const markers = [1, 2, 3].map((n) => `USER_MARKER_${n}_${id}`);
        const files = ["none", "all", "two"].map((mode) => `/tmp/pi-integ-fork-${id}-${mode}.txt`);
        files.forEach((file) => trackTempFile(env, file));
        let rootSurface = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `fork-matrix-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          startPi(rootSurface, env.dir, `Remember ${markers[0]}. Do not call tools. Reply exactly ACK_1_${id}.`);
          await waitForScreen(rootSurface, new RegExp(`ACK_1_${id}`), PI_TIMEOUT);
          sendCommand(rootSurface, `Remember ${markers[1]}. Do not call tools. Reply exactly ACK_2_${id}.`);
          await waitForScreen(rootSurface, new RegExp(`ACK_2_${id}`), PI_TIMEOUT);
          sendCommand(rootSurface, `Remember ${markers[2]}. Do not call tools. Reply exactly ACK_3_${id}.`);
          await waitForScreen(rootSurface, new RegExp(`ACK_3_${id}`), PI_TIMEOUT);
          sendCommand(rootSurface, `Call subagent exactly once: name "ForkTwo-${id}", agent "test-echo", forkTurns "2", task "Run: printf '%s' \"$PI_SUBAGENT_TEAM_DIR\" > '${files[2]}'".`);
          await waitForFile(files[2], PI_TIMEOUT);
          sendCommand(rootSurface, `Call subagent exactly once: name "ForkAll-${id}", agent "test-echo", forkTurns "all", task "Run: printf '%s' \"$PI_SUBAGENT_TEAM_DIR\" > '${files[1]}'".`);
          await waitForFile(files[1], PI_TIMEOUT);
          sendCommand(rootSurface, `Call subagent exactly once: name "ForkNone-${id}", agent "test-echo", forkTurns "none", task "Run: printf '%s' \"$PI_SUBAGENT_TEAM_DIR\" > '${files[0]}'".`);
          await waitForFile(files[0], PI_TIMEOUT);
          teamDir = readFileSync(files[0], "utf8").trim();
          registerTeam(env, teamDir, rootSurface);
          await waitForCondition("fork matrix records", () =>
            readAgents(teamDir).filter((agent) => agent.displayName.startsWith("Fork")).length === 3,
          );
          await waitForTerminalAgents(teamDir, [`ForkNone-${id}`, `ForkAll-${id}`, `ForkTwo-${id}`]);
          const byName = new Map(readAgents(teamDir).map((agent) => [agent.displayName, agent]));
          const none = readFileSync(byName.get(`ForkNone-${id}`)!.sessionPath, "utf8");
          const all = readFileSync(byName.get(`ForkAll-${id}`)!.sessionPath, "utf8");
          const two = readFileSync(byName.get(`ForkTwo-${id}`)!.sessionPath, "utf8");
          for (const marker of markers) assert.doesNotMatch(none, new RegExp(marker));
          for (const marker of markers) assert.match(all, new RegExp(marker));
          assert.doesNotMatch(two, new RegExp(markers[0]));
          assert.match(two, new RegExp(markers[1]));
          assert.match(two, new RegExp(markers[2]));
          for (const child of [`ForkNone-${id}`, `ForkAll-${id}`, `ForkTwo-${id}`]) {
            const header = readSession(byName.get(child)!.sessionPath)[0];
            assert.equal(header.type, "session");
            assert.ok(header.parentSession, `${child} must retain required ancestry`);
          }
      });

      scenarioIt("survives extension reload and resumes a caller-ping run without ownership accumulation", async () => {
        const id = uniqueId();
        const baseline = snapshotCmuxSurfaces();
        const idleInfo = `/tmp/pi-integ-reload-${id}-idle.txt`;
        trackTempFile(env, idleInfo);
        let rootSurface = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `reload-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          const idleTask = `Run: printf '%s\\n%s\\n' "$PI_SUBAGENT_TEAM_DIR" "$PI_SUBAGENT_RUN_ID" > '${idleInfo}'. Then finish this turn and remain idle; do not call subagent_done.`;
          startPi(rootSurface, env.dir, [
            `Call two subagents without waiting.`,
            `First name "ReloadIdle-${id}", agent "test-team", interactive true, task ${JSON.stringify(idleTask)}.`,
            `Second name "ReloadPing-${id}", agent "test-delayed-ping", task "Run: sleep 12. Then caller_ping exact message RELOAD_PING_${id}.".`,
          ].join("\n"));
          await waitForFile(idleInfo, PI_TIMEOUT);
          [teamDir] = readFileSync(idleInfo, "utf8").trim().split("\n");
          registerTeam(env, teamDir, rootSurface);
          await waitForCondition("reload statuses", () => {
            const agents = readAgents(teamDir);
            return agents.find((agent) => agent.displayName === `ReloadIdle-${id}`)?.status === "waiting" &&
              ["running", "waiting"].includes(agents.find((agent) => agent.displayName === `ReloadPing-${id}`)?.status ?? "");
          });
          const beforeAgents = readAgents(teamDir);
          const pingBefore = beforeAgents.find((agent) => agent.displayName === `ReloadPing-${id}`)!;
          const idleBefore = beforeAgents.find((agent) => agent.displayName === `ReloadIdle-${id}`)!;
          const focus = stableFocus();
          sendCommand(rootSurface, "/reload");
          await sleep(3000);
          assert.deepEqual(stableFocus(), focus);
          const afterReload = readAgents(teamDir);
          for (const before of [pingBefore, idleBefore]) {
            const after = afterReload.find((agent) => agent.runId === before.runId)!;
            assert.equal(after.path, before.path);
            assert.equal(after.sessionPath, before.sessionPath);
            assert.equal(after.surface, before.surface);
            assert.deepEqual(after.launchPolicy, before.launchPolicy);
          }
          assert.equal(activeLeases(teamDir).length, 3);
          await waitForCondition("first ping terminalization", () =>
            readAgents(teamDir).find((agent) => agent.runId === pingBefore.runId)?.status === "completed",
          );
          await waitForCondition("reloaded original direct-parent result", () => {
            const root = readAgents(teamDir).find((agent) => agent.parentPath === null)!;
            return readSession(root.sessionPath).filter((entry) =>
              entry.type === "custom_message" && entry.customType === "subagent_result" &&
              entry.details?.name === `ReloadPing-${id}`
            ).length === 1;
          });
          sendCommand(rootSurface, `Call subagent_resume with sessionPath ${JSON.stringify(pingBefore.sessionPath)} and message "Run: sleep 1. Then caller_ping exact message RESUMED_PING_${id}.". Do not override name, model, cwd, thinking, tools, autoExit, or interactive.`);
          await waitForScreen(rootSurface, new RegExp(`RESUMED_PING_${id}`), PI_TIMEOUT, 300);
          await waitForCondition("resumed ping terminalization", () => {
            const current = readAgents(teamDir).find((agent) => agent.runId === pingBefore.runId);
            return current?.status === "completed" && current.incarnation !== pingBefore.incarnation && (current.surfaces?.length ?? 0) === 2;
          });
          const resumed = readAgents(teamDir).find((agent) => agent.runId === pingBefore.runId)!;
          assert.equal(resumed.path, pingBefore.path);
          assert.equal(resumed.sessionPath, pingBefore.sessionPath);
          for (const key of ["agent", "model", "cwd", "thinking", "interactive", "autoExit"]) {
            assert.deepEqual(resumed.launchPolicy[key], pingBefore.launchPolicy[key]);
          }
          assert.equal(new Set(resumed.surfaces!.map((owned) => owned.id)).size, 2);
          assert.equal(resumed.surfaces!.every((owned) => owned.state !== "active"), true);
          assert.equal(resumed.surfaces!.every((owned) => !surfaceExists(owned.id)), true);
          const root = readAgents(teamDir).find((agent) => agent.parentPath === null)!;
          await waitForCondition("resumed caller-ping notification", () =>
            readSession(root.sessionPath).filter((entry) =>
              entry.type === "custom_message" && entry.customType === "subagent_ping" &&
              entry.details?.name === `ReloadPing-${id}` &&
              entry.details?.message === `RESUMED_PING_${id}`
            ).length === 1,
          );
          assert.equal(readSession(root.sessionPath).filter((entry) =>
            entry.type === "custom_message" && entry.customType === "subagent_result" &&
            entry.details?.name === `ReloadPing-${id}`
          ).length, 1);
          const idle = readAgents(teamDir).find((agent) => agent.displayName === `ReloadIdle-${id}`)!;
          assert.ok(idle.surface && surfaceExists(idle.surface));
          sendCommand(idle.surface, "Call subagent_done now. Do not do anything else.");
          await waitForTerminalAgents(teamDir, [`ReloadIdle-${id}`]);
          await waitForTerminalRegistry(teamDir, [`ReloadPing-${id}`]);
          assert.equal(activeLeases(teamDir).length, 1);
          assert.deepEqual(stableFocus(), focus);
      });

      scenarioIt("commits simultaneous completion, follow-up delivery, status, and lease changes exactly once", async () => {
        const id = uniqueId();
        const receiverInfo = `/tmp/pi-integ-simul-${id}-receiver.txt`;
        const delivered = `/tmp/pi-integ-simul-${id}-delivered.txt`;
        const senderDone = `/tmp/pi-integ-simul-${id}-sender.txt`;
        for (const file of [receiverInfo, delivered, senderDone]) trackTempFile(env, file);
        const baseline = snapshotCmuxSurfaces();
        let rootSurface = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `simul-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          const receiverTask = [
            `Run one bash call: printf '%s\\n%s\\n' "$PI_SUBAGENT_TEAM_DIR" "$PI_SUBAGENT_RUN_ID" > '${receiverInfo}'; sleep 15.`,
            `Do not poll. When the queued attributed follow-up starts the next turn, obey it exactly once.`,
          ].join(" ");
          const followup = `Run: echo DELIVERED_${id} > '${delivered}'. Then finish this turn.`;
          const senderTask = [
            `Run exactly one bash call: sleep 10.`,
            `Then call subagent_followup target "SimulReceiver-${id}" with message ${JSON.stringify(followup)}.`,
            `Then run: echo SENDER_${id} > '${senderDone}'. Never poll.`,
          ].join(" ");
          startPi(rootSurface, env.dir, [
            `Call two subagents without waiting.`,
            `First name "SimulReceiver-${id}", agent "test-team", interactive true, task ${JSON.stringify(receiverTask)}.`,
            `Second name "SimulSender-${id}", agent "test-echo", interactive false, task ${JSON.stringify(senderTask)}.`,
          ].join("\n"));
          await waitForFile(receiverInfo, PI_TIMEOUT);
          [teamDir] = readFileSync(receiverInfo, "utf8").trim().split("\n");
          registerTeam(env, teamDir, rootSurface);
          await Promise.all([
            waitForFile(senderDone, PI_TIMEOUT, /SENDER_/),
            waitForFile(delivered, PI_TIMEOUT, /DELIVERED_/),
          ]);
          const receiverBeforeExit = readAgents(teamDir).find((agent) => agent.displayName === `SimulReceiver-${id}`)!;
          assert.ok(receiverBeforeExit.surface);
          sendCommand(receiverBeforeExit.surface, "Call subagent_done now. Do not do anything else.");
          await waitForCondition("simultaneous terminal records and released leases", () => {
            const agents = readAgents(teamDir).filter((agent) => agent.displayName.startsWith("Simul"));
            return agents.length === 2 && agents.every((agent) => agent.status === "completed") && activeLeases(teamDir).length === 1;
          });
          await waitForCondition("two direct-parent result notifications", () => {
            const root = readAgents(teamDir).find((agent) => agent.parentPath === null)!;
            const results = readSession(root.sessionPath).filter((entry) =>
              entry.type === "custom_message" && entry.customType === "subagent_result" &&
              [`SimulReceiver-${id}`, `SimulSender-${id}`].includes(entry.details?.name)
            );
            return results.length === 2;
          });
          const agents = readAgents(teamDir);
          const receiver = agents.find((agent) => agent.displayName === `SimulReceiver-${id}`)!;
          const root = agents.find((agent) => agent.parentPath === null)!;
          assert.equal(readSession(receiver.sessionPath).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_mailbox").length, 1);
          for (const name of [`SimulReceiver-${id}`, `SimulSender-${id}`]) {
            assert.equal(readSession(root.sessionPath).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result" && entry.details?.name === name).length, 1);
          }
          for (const agent of agents.filter((item) => item.displayName.startsWith("Simul"))) {
            assert.equal(agent.surfaces?.length, 1);
            assert.equal(agent.surfaces?.[0].state, "closed");
            assert.equal(surfaceExists(agent.surfaces![0].id), false);
          }
      });

      scenarioIt("terminalizes an externally disappeared owned child without touching an unrelated surface", async () => {
        const id = uniqueId();
        const childInfo = `/tmp/pi-integ-orphan-${id}.txt`;
        trackTempFile(env, childInfo);
        const baseline = snapshotCmuxSurfaces();
        let rootSurface = "";
        let unrelated = "";
        let teamDir = "";
          rootSurface = createTrackedSurface(env, `orphan-root-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          unrelated = createTrackedSurface(env, `orphan-unrelated-${id}`, { cmuxOwnership: { baseline, titleFragment: id } });
          startPi(rootSurface, env.dir, [
            `Call subagent once: name "OrphanChild-${id}", agent "test-echo",`,
            `task "Run one bash call: printf '%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${childInfo}'; sleep 120. Never poll.".`,
          ].join(" "));
          await waitForFile(childInfo, PI_TIMEOUT);
          [teamDir] = readFileSync(childInfo, "utf8").trim().split("\n");
          registerTeam(env, teamDir, rootSurface);
          const child = readAgents(teamDir).find((agent) => agent.displayName === `OrphanChild-${id}`)!;
          assert.ok(child.surface && surfaceExists(child.surface));
          closeSurface(child.surface);
          assert.equal(surfaceExists(unrelated), true);
          await waitForCondition("orphan terminalization", () => {
            const current = readAgents(teamDir).find((agent) => agent.runId === child.runId);
            return current?.status === "errored" && current.surfaces?.[0]?.state === "orphaned" && activeLeases(teamDir).length === 1;
          });
          const root = readAgents(teamDir).find((agent) => agent.parentPath === null)!;
          await waitForCondition("single orphan parent result", () =>
            readSession(root.sessionPath).filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_result" && entry.details?.name === `OrphanChild-${id}`).length === 1,
          );
          assert.equal(surfaceExists(unrelated), true);
          assert.equal(surfaceExists(child.surface), false);
      });
    }

    // ── Fork mode ──

    scenarioIt("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const legacyContext = `LEGACY_CONTEXT_${id}`;
      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  agent: "test-echo"`,
        `  fork: true`,
        `  task: "Run: printf 'FORK_OK_${id}|%s|%s' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${markerFile}'. Then call subagent_done."`,
        `Set name, agent, fork, and task exactly once.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join(" ");

      startPi(surface, env.dir, `Remember ${legacyContext}. Do not call tools. Reply exactly LEGACY_ACK_${id}.`);
      await waitForScreen(surface, new RegExp(`LEGACY_ACK_${id}`), PI_TIMEOUT);
      sendCommand(surface, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);
      const { teamDir } = markerTeamAndRun(content);
      registerTeam(env, teamDir, surface);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(surface, /FORK_COMPLETE/, PI_TIMEOUT);

      assert.match(screen, /FORK_COMPLETE/);
      const [fork] = await waitForTerminalAgents(teamDir, [`Fork-${id}`]);
      assert.ok(existsSync(fork.sessionPath));
      const entries = readSession(fork.sessionPath);
      assert.equal(entries[0].type, "session");
      assert.ok(entries[0].parentSession, "legacy fork must retain parent linkage");
      assert.ok(entries.length >= 2, "legacy fork must inherit context unconditionally");
      assert.match(readFileSync(fork.sessionPath, "utf8"), new RegExp(legacyContext));
    });

    // ── caller_ping ──

    scenarioIt("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();
      const infoFile = `/tmp/pi-integ-ping-${id}.txt`;
      trackTempFile(env, infoFile);

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "Run: printf 'PING_META_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${infoFile}'. Then caller_ping exact message PING_TEST_${id}."`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
      const info = await waitForFile(infoFile, PI_TIMEOUT, /PING_META_/);
      const { teamDir } = markerTeamAndRun(info);
      registerTeam(env, teamDir, surface);
      await waitForTerminalAgents(teamDir, [`Ping-${id}`], "subagent_ping");
    });

    // ── Agent discovery ──

    scenarioIt("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: printf 'DISCO_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
      const { teamDir } = markerTeamAndRun(content);
      registerTeam(env, teamDir, surface);
      await waitForTerminalAgents(teamDir, [`Disco-${id}`]);
    });

    // ── Subagent with custom system prompt ──

    scenarioIt("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Run: printf 'SYSPROMPT_${id}\\n%s\\n%s\\n' \"$PI_SUBAGENT_TEAM_DIR\" \"$PI_SUBAGENT_RUN_ID\" > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
      const { teamDir } = markerTeamAndRun(content);
      registerTeam(env, teamDir, surface);
      await waitForTerminalAgents(teamDir, [`SysP-${id}`]);
    });
  });
}
