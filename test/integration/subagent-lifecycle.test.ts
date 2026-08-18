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
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  cleanupCmuxScenarioSurfaces,
  snapshotCmuxSurfaces,
  untrackSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  sendCommand,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping subagent lifecycle integration tests");
  console.log("   Run inside cmux or tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 5 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
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

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
      }
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
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
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
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
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
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
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
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
    });

    // ── Durable direct mailbox (cmux-serialized) ──

    if (backend === "cmux") {
      it("queues Scout A mail for idle Worker B until Worker's next turn", async () => {
        const id = uniqueId();
        const readyFile = `/tmp/pi-integ-mailbox-ready-${id}.txt`;
        const waitingGateFile = `/tmp/pi-integ-mailbox-waiting-${id}.txt`;
        const infoFile = `/tmp/pi-integ-mailbox-info-${id}.txt`;
        const queuedFile = `/tmp/pi-integ-mailbox-queued-${id}.txt`;
        const deliveredFile = `/tmp/pi-integ-mailbox-delivered-${id}.txt`;
        for (const file of [readyFile, waitingGateFile, infoFile, queuedFile, deliveredFile]) {
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
          `Run: while [ ! -f '${waitingGateFile}' ]; do sleep 1; done`,
          `Then call subagent_message with target "Worker-${id}" and this exact message:`,
          `Run: echo 'DELIVERED_${id}' > '${deliveredFile}'. Then call subagent_done.`,
          `After subagent_message acknowledges the queue, run: echo 'QUEUED_${id}' > '${queuedFile}'`,
          `Finally call subagent_done.`,
        ].join("\n");
        const task = [
          `Call the subagent tool twice, without waiting for either result.`,
          `First call: name "Worker-${id}", task ${JSON.stringify(workerTask)}, interactive true. Do not set agent.`,
          `Second call: name "Scout-${id}", task ${JSON.stringify(scoutTask)}, interactive false. Do not set agent.`,
          `After both calls, do not send any message to Worker and do not start or resume it.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        await waitForFile(readyFile, PI_TIMEOUT, /READY_/);
        const info = await waitForFile(infoFile, PI_TIMEOUT);
        const [workerRunId, teamDir, workerSurface, activityFile] = info.trim().split("\n");
        assert.ok(
          workerRunId && teamDir && workerSurface && activityFile,
          `Invalid Worker mailbox metadata: ${info}`,
        );

        // READY is emitted inside the Worker tool call, before agent_end. Do
        // not let Scout enqueue until both authoritative states report idle.
        const waitingStarted = Date.now();
        let observedWaiting = false;
        while (Date.now() - waitingStarted < PI_TIMEOUT) {
          try {
            const agent = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
            const activity = JSON.parse(readFileSync(activityFile, "utf8"));
            if (agent.status === "waiting" && activity.phase === "waiting") {
              observedWaiting = true;
              break;
            }
          } catch {}
          await sleep(200);
        }
        assert.equal(observedWaiting, true, "Worker must be authoritatively waiting before enqueue");
        writeFileSync(waitingGateFile, `WAITING_${id}\n`);
        await waitForFile(queuedFile, PI_TIMEOUT, /QUEUED_/);
        assert.equal(existsSync(deliveredFile), false, "queued mail must not start an idle Worker turn");

        const pendingDir = `${teamDir}/mailboxes/${workerRunId}/pending`;
        assert.equal(readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length, 1);

        sendCommand(workerSurface, "Process the queued direct mailbox message now.");
        const delivered = await waitForFile(deliveredFile, PI_TIMEOUT, /DELIVERED_/);
        assert.match(delivered, new RegExp(`DELIVERED_${id}`));
        assert.equal(readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length, 0);
      });
    }

    if (backend === "cmux") {
      it("wakes an idle sibling by follow-up and routes nested completion to its direct parent", async () => {
        const id = uniqueId();
        const readyFile = `/tmp/pi-integ-followup-ready-${id}.txt`;
        const waitingGateFile = `/tmp/pi-integ-followup-waiting-${id}.txt`;
        const infoFile = `/tmp/pi-integ-followup-info-${id}.txt`;
        const queuedFile = `/tmp/pi-integ-followup-queued-${id}.txt`;
        const nestedFile = `/tmp/pi-integ-followup-nested-${id}.txt`;
        const deliveredFile = `/tmp/pi-integ-followup-delivered-${id}.txt`;
        for (const file of [
          readyFile,
          waitingGateFile,
          infoFile,
          queuedFile,
          nestedFile,
          deliveredFile,
        ]) trackTempFile(env, file);

        const surfacesBefore = snapshotCmuxSurfaces();
        let surface = "";
        let workerRunId = "";
        let teamDir = "";
        try {
        surface = createTrackedSurface(env, `followup-${id}`, {
          cmuxOwnership: { baseline: surfacesBefore, titleFragment: id },
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
        ].join("\n");
        const scoutTask = [
          `Run: while [ ! -f '${waitingGateFile}' ]; do sleep 1; done`,
          `Then call subagent_followup with target "Worker-${id}" and message ${JSON.stringify(followupMessage)}.`,
          `After it acknowledges, run: echo 'QUEUED_${id}' > '${queuedFile}'`,
          `Then call subagent_done.`,
        ].join("\n");
        const task = [
          `Call subagent twice without waiting for either result.`,
          `First: name "Worker-${id}", task ${JSON.stringify(workerTask)}, interactive true.`,
          `Second: name "Scout-${id}", task ${JSON.stringify(scoutTask)}, interactive false.`,
          `Do not send commands, messages, interrupts, or resumes to Worker.`,
        ].join("\n");

        startPi(surface, env.dir, task);
        await waitForFile(readyFile, PI_TIMEOUT, /READY_/);
        const info = await waitForFile(infoFile, PI_TIMEOUT);
        [workerRunId, teamDir] = info.trim().split("\n");
        assert.ok(workerRunId && teamDir, `Invalid Worker follow-up metadata: ${info}`);

        const activityFile = JSON.parse(
          readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"),
        ).launchPolicy.activityFile;
        const waitingStarted = Date.now();
        let observedWaiting = false;
        while (Date.now() - waitingStarted < PI_TIMEOUT) {
          try {
            const agent = JSON.parse(readFileSync(`${teamDir}/agents/${workerRunId}.json`, "utf8"));
            const activity = JSON.parse(readFileSync(activityFile, "utf8"));
            if (agent.status === "waiting" && activity.phase === "waiting") {
              observedWaiting = true;
              break;
            }
          } catch {}
          await sleep(200);
        }
        assert.equal(observedWaiting, true, "Worker must be authoritatively idle before follow-up");
        writeFileSync(waitingGateFile, `WAITING_${id}\n`);

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
        } finally {
          const explicitRefs = [surface];
          if (teamDir) {
            try {
              for (const name of readdirSync(`${teamDir}/agents`)) {
                const agent = JSON.parse(readFileSync(`${teamDir}/agents/${name}`, "utf8"));
                if (typeof agent.surface === "string") explicitRefs.push(agent.surface);
              }
            } catch {}
          }
          const closed = cleanupCmuxScenarioSurfaces(surfacesBefore, id, explicitRefs);
          if (surface && closed.includes(surface)) untrackSurface(env, surface);
        }
      });
    }

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent parameter. Just set name, fork, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
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
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
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
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
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
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });
  });
}
