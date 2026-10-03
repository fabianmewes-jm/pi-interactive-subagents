/**
 * Integration tests for the multiplexer surface layer.
 *
 * These tests exercise real mux operations: creating panes,
 * sending commands, reading screen output, and closing surfaces.
 * No LLM calls — fast and free.
 *
 * Run inside a supported multiplexer:
 *   cmux bash -c 'npm run test:integration'
 *   tmux new 'npm run test:integration'
 *   zellij --session pi  # then run: npm run test:integration
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  captureCmuxFocusSnapshot,
  closeOwnedMuxTarget,
  isStableCmuxId,
  muxInstanceIdentity,
  pollForExit,
  surfaceExists,
} from "../../pi-extension/subagents/cmux.ts";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnvVerified,
  snapshotCmuxSurfaces,
  trackRegistryOwnedSurfaces,
  createTrackedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendEscape,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
if (backends.length === 0) {
  console.log("⚠️  No mux backend available — skipping mux-surface integration tests");
  console.log("   Run inside cmux or tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`mux-surface [${backend}]`, { timeout: 60_000 }, () => {
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
        assert.ok(suiteBaseline, "cmux mux-surface baseline snapshot must succeed");
        const current = snapshotCmuxSurfaces();
        assert.ok(current, "cmux mux-surface postcondition snapshot must succeed");
        const remaining = current.filter((surface) => suiteOwned.has(surface.ref));
        const evidence = [...suiteOwned].map(([ref, title]) => `${ref} ${JSON.stringify(title)}`);
        console.log(`cmux mux-surface owned surfaces (${evidence.length}): ${evidence.join(", ") || "none"}`);
        assert.deepEqual(
          remaining,
          [],
          `cmux mux-surface suite leaked owned surfaces: ${remaining.map((surface) => `${surface.ref} ${JSON.stringify(surface.title)}`).join(", ")}`,
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
            `owned UUID unexpectedly predates mux-surface suite: ${tracked.ref}`,
          );
          suiteOwned.set(tracked.ref, tracked.cmuxOwnership?.titleFragment ?? "unlabeled");
        }
        await cleanupTestEnvVerified(env);
      }
    });

    scenarioIt("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    if (backend === "cmux") {
    scenarioIt("reconciles an externally closed exact cmux UUID without touching another surface", async () => {
      const owned = createTrackedSurface(env, "external-close-owned");
      const unrelated = createTrackedSurface(env, "external-close-unrelated");
      assert.equal(isStableCmuxId(owned), true);
      assert.equal(isStableCmuxId(unrelated), true);
      await sleep(1000);

      closeSurface(owned);
      untrackSurface(env, owned);
      const result = await pollForExit(owned, new AbortController().signal, {
        interval: 10,
        surfaceExists,
      });
      assert.equal(result.reason, "disappeared");
      assert.equal(surfaceExists(unrelated), true);
      sendCommand(unrelated, "echo UNRELATED_SURVIVED");
      await waitForScreen(unrelated, /UNRELATED_SURVIVED/, 10_000, 30);
    });

    scenarioIt("closes a recorded cmux target through its proven instance only", async () => {
      const owned = createTrackedSurface(env, "owned-instance-close");
      const unrelated = createTrackedSurface(env, "owned-instance-unrelated");
      const instanceId = muxInstanceIdentity("cmux");
      assert.ok(instanceId);

      closeOwnedMuxTarget({ backend: "cmux", id: owned, instanceId });
      untrackSurface(env, owned);
      assert.equal(surfaceExists(owned), false);
      assert.equal(surfaceExists(unrelated), true);
    });

    scenarioIt("keeps the current stable cmux context unchanged for background lifecycle operations", async () => {
      const stable = () => {
        const snapshot = captureCmuxFocusSnapshot();
        assert.ok(snapshot?.windowId && snapshot.workspaceId && snapshot.paneId && snapshot.surfaceId);
        return {
          windowId: snapshot.windowId,
          workspaceId: snapshot.workspaceId,
          paneId: snapshot.paneId,
          surfaceId: snapshot.surfaceId,
        };
      };
      const before = stable();
      const target = createTrackedSurface(env, "focus-neutral-lifecycle");
      assert.deepEqual(stable(), before);

      sendCommand(target, "printf FOCUS_NEUTRAL");
      assert.deepEqual(stable(), before);
      readScreen(target, 5);
      assert.deepEqual(stable(), before);
      await readScreenAsync(target, 5);
      assert.deepEqual(stable(), before);
      sendEscape(target);
      assert.deepEqual(stable(), before);

      const instanceId = muxInstanceIdentity("cmux");
      assert.ok(instanceId);
      closeOwnedMuxTarget({ backend: "cmux", id: target, instanceId });
      untrackSurface(env, target);
      assert.deepEqual(stable(), before);
    });

    }

    scenarioIt("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    scenarioIt("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    scenarioIt("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    scenarioIt("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    scenarioIt("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-mux-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });

    scenarioIt("delivers Escape as byte 27 to the target surface", async () => {
      const surface = createTrackedSurface(env, "escape-byte-test");
      await sleep(1000);

      const marker = uniqueId();
      const byteFile = `/tmp/pi-mux-escape-${marker}.txt`;
      trackTempFile(env, byteFile);

      const nodeProgram =
        "const fs = require('node:fs');" +
        "if (!process.stdin.isTTY) throw new Error('stdin is not a TTY');" +
        "process.stdin.setRawMode(true);" +
        "process.stdin.resume();" +
        "process.stdout.write('ESC_READY\\n');" +
        "process.stdin.once('data', (chunk) => {" +
        `fs.writeFileSync(${JSON.stringify(byteFile)}, Array.from(chunk).join(','));` +
        "process.exit(0);" +
        "});";
      const command = `node -e ${JSON.stringify(nodeProgram)}`;

      sendLongCommand(surface, command);
      await waitForScreen(surface, /ESC_READY/, 15_000, 50);

      sendEscape(surface);

      const content = await waitForFile(byteFile, 15_000, /^27$/);
      assert.equal(content.trim(), "27");
    });
  });
}
