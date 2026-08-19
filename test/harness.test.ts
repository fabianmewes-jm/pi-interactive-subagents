import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCmuxSurfaceSnapshot,
  cleanupCmuxScenarioSurfaces,
  cleanupTrackedSurfaces,
  cleanupTestEnvVerified,
  collectRegistryOwnedCmuxSurfaces,
  selectNewCmuxScenarioSurfaces,
  trackRegistryOwnedSurfaces,
  type TestEnv,
} from "./integration/harness.ts";

const COORDINATOR = "11111111-1111-4111-8111-111111111111";
const ROOT = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const SCOUT = "44444444-4444-4444-8444-444444444444";
const baseline = [{ ref: COORDINATOR, title: "Coordinator" }];

function env(surfaces: TestEnv["surfaces"] = []): TestEnv {
  return { dir: "/tmp/unused", backend: "cmux", surfaces, tempFiles: [], cmuxBaseline: baseline, teams: [], surfaceHistory: [...surfaces] };
}

describe("cmux integration surface isolation", () => {
  it("parses text trees and selects only new scenario titles", () => {
    const tree = 'surface surface:155 [terminal] "Coordinator"\nsurface surface:788 [terminal] "Worker-case-123"';
    assert.deepEqual(parseCmuxSurfaceSnapshot(tree), [
      { ref: "surface:155", title: "Coordinator" },
      { ref: "surface:788", title: "Worker-case-123" },
    ]);
    assert.deepEqual(selectNewCmuxScenarioSurfaces(baseline, [
      ...baseline,
      { ref: ROOT, title: "root-case-123" },
      { ref: WORKER, title: "Worker-case-123" },
      { ref: SCOUT, title: "unrelated" },
    ], "case-123"), [ROOT, WORKER]);
  });

  it("closes only explicit stable IDs proven new, unique, and scenario-titled", () => {
    let current = [...baseline, { ref: ROOT, title: "root-case-123" }, { ref: WORKER, title: "Worker-case-123" }];
    const calls: string[] = [];
    assert.deepEqual(cleanupCmuxScenarioSurfaces(baseline, "case-123", [ROOT, WORKER], {
      snapshot: () => current,
      close(ref) { calls.push(ref); current = current.filter((surface) => surface.ref !== ref); },
    }), [ROOT, WORKER]);
    assert.deepEqual(calls, [ROOT, WORKER]);
  });

  it("rejects short refs, UUID reuse, ambiguity, and pre-existing IDs", () => {
    const calls: string[] = [];
    const run = (refs: string[], current: Array<{ ref: string; title: string }>, before = baseline) =>
      cleanupCmuxScenarioSurfaces(before, "case-123", refs, {
        snapshot: () => current,
        close(ref) { calls.push(ref); },
      });
    assert.deepEqual(run(["surface:9"], [{ ref: "surface:9", title: "Worker-case-123" }]), []);
    assert.deepEqual(run([ROOT], [{ ref: ROOT, title: "unrelated replacement" }]), []);
    assert.deepEqual(run([ROOT], [{ ref: ROOT, title: "a-case-123" }, { ref: ROOT, title: "b-case-123" }]), []);
    assert.deepEqual(run([ROOT], [{ ref: ROOT, title: "root-case-123" }], [{ ref: ROOT, title: "old" }]), []);
    assert.deepEqual(calls, []);
  });

  it("keeps close/snapshot failures tracked and confirms an already absent owned UUID", () => {
    const tracked = env([{ ref: ROOT, cmuxOwnership: { baseline, titleFragment: "case-123" } }]);
    assert.deepEqual(cleanupTrackedSurfaces(tracked, {
      snapshot: () => [{ ref: ROOT, title: "root-case-123" }],
      close() { throw new Error("injected close failure"); },
    }), []);
    assert.equal(tracked.surfaces.length, 1);
    assert.deepEqual(cleanupTrackedSurfaces(tracked, { snapshot: () => baseline }), [ROOT]);
    assert.deepEqual(tracked.surfaces, []);
    assert.deepEqual(cleanupCmuxScenarioSurfaces(baseline, "Worker-case-123", [WORKER], {
      snapshot: () => baseline,
      close() { throw new Error("absent IDs are not closed"); },
    }), [WORKER]);
    const uncertain = env([{ ref: WORKER, cmuxOwnership: { baseline, titleFragment: "Worker-case-123" } }]);
    let snapshots = 0;
    assert.deepEqual(cleanupTrackedSurfaces(uncertain, {
      snapshot: () => snapshots++ === 0 ? [{ ref: WORKER, title: "Worker-case-123" }] : null,
      close() {},
    }), []);
    assert.equal(uncertain.surfaces.length, 1, "failed close confirmation remains retryable");
  });

  it("collects current/history descendant UUIDs and tolerates absent or malformed registries", () => {
    assert.deepEqual(collectRegistryOwnedCmuxSurfaces("/absent/team"), []);
    const team = mkdtempSync(join(tmpdir(), "pi-harness-registry-"));
    mkdirSync(join(team, "agents"));
    try {
      writeFileSync(join(team, "agents", "worker.json"), JSON.stringify({
        displayName: "Worker-case-123",
        surface: WORKER,
        surfaces: [{ id: ROOT, state: "closed" }, { id: WORKER, state: "active" }, { id: "surface:9" }],
      }));
      writeFileSync(join(team, "agents", "bad.json"), "bad-json");
      assert.deepEqual(collectRegistryOwnedCmuxSurfaces(team), [
        { ref: WORKER, titleFragment: "Worker-case-123", ambiguous: undefined, ownershipClaims: ["worker.json:Worker-case-123"] },
        { ref: ROOT, titleFragment: "Worker-case-123", ambiguous: undefined, ownershipClaims: ["worker.json:Worker-case-123"] },
      ]);
      writeFileSync(join(team, "agents", "ambiguous.json"), JSON.stringify({
        displayName: "Different-owner-case-123", surface: WORKER,
      }));
      assert.deepEqual(collectRegistryOwnedCmuxSurfaces(team), [
        {
          ref: WORKER,
          titleFragment: "Different-owner-case-123 | Worker-case-123",
          ambiguous: true,
          ownershipClaims: ["ambiguous.json:Different-owner-case-123", "worker.json:Worker-case-123"],
        },
        { ref: ROOT, titleFragment: "Worker-case-123", ambiguous: undefined, ownershipClaims: ["worker.json:Worker-case-123"] },
      ], "conflicting UUID claims must remain explicit unresolved evidence");
    } finally { rmSync(team, { recursive: true, force: true }); }
  });

  it("preserves same-title and cross-team UUID conflicts as unresolved ledger evidence", () => {
    const first = mkdtempSync(join(tmpdir(), "pi-harness-conflict-a-"));
    const second = mkdtempSync(join(tmpdir(), "pi-harness-conflict-b-"));
    mkdirSync(join(first, "agents"));
    mkdirSync(join(second, "agents"));
    const tracked = env();
    tracked.teams.push({ dir: first, rootRef: ROOT }, { dir: second, rootRef: ROOT });
    try {
      writeFileSync(join(first, "agents", "worker-a.json"), JSON.stringify({
        displayName: "Worker-case-123", surface: WORKER,
      }));
      writeFileSync(join(first, "agents", "worker-b.json"), JSON.stringify({
        displayName: "Worker-case-123", surface: WORKER,
      }));
      writeFileSync(join(second, "agents", "worker-c.json"), JSON.stringify({
        displayName: "Worker-case-123", surface: WORKER,
      }));
      const [owned] = trackRegistryOwnedSurfaces(tracked);
      assert.equal(owned.ref, WORKER);
      assert.equal(owned.titleFragment, "Worker-case-123");
      assert.equal(owned.ambiguous, true);
      assert.deepEqual(owned.ownershipClaims, [
        `${first}/worker-a.json:Worker-case-123`,
        `${first}/worker-b.json:Worker-case-123`,
        `${second}/worker-c.json:Worker-case-123`,
      ]);
      assert.equal(tracked.surfaces[0].cmuxOwnership?.ambiguous, true);
      assert.deepEqual(tracked.surfaces[0].cmuxOwnership?.ownershipClaims, owned.ownershipClaims);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("tracks registry descendants before temp removal and retains ambiguous cleanup", () => {
    const team = mkdtempSync(join(tmpdir(), "pi-harness-track-"));
    mkdirSync(join(team, "agents"));
    const tracked = env();
    tracked.teams.push({ dir: team, rootRef: ROOT });
    try {
      writeFileSync(join(team, "agents", "worker.json"), JSON.stringify({
        displayName: "Worker-case-123", surface: WORKER, surfaces: [{ id: WORKER, state: "active" }],
      }));
      writeFileSync(join(team, "agents", "conflict.json"), JSON.stringify({
        displayName: "Conflicting-case-123", surface: WORKER,
      }));
      assert.deepEqual(trackRegistryOwnedSurfaces(tracked), [{
        ref: WORKER,
        titleFragment: "Conflicting-case-123 | Worker-case-123",
        ambiguous: true,
        ownershipClaims: [
          `${team}/conflict.json:Conflicting-case-123`,
          `${team}/worker.json:Worker-case-123`,
        ],
      }]);
      const calls: string[] = [];
      assert.deepEqual(cleanupTrackedSurfaces(tracked, {
        snapshot: () => [{ ref: WORKER, title: "Worker-case-123" }],
        close(ref) { calls.push(ref); },
      }), []);
      assert.deepEqual(calls, []);
      assert.equal(tracked.surfaces.length, 1);
      assert.equal(tracked.surfaceHistory[0].cmuxOwnership?.ambiguous, true);
      assert.deepEqual(tracked.surfaceHistory[0].cmuxOwnership?.ownershipClaims, [
        `${team}/conflict.json:Conflicting-case-123`,
        `${team}/worker.json:Worker-case-123`,
      ]);
      assert.deepEqual(cleanupTrackedSurfaces(tracked, {
        snapshot: () => baseline,
        close(ref) { calls.push(ref); },
      }), [WORKER], "confirmed disappearance resolves ambiguous evidence without closing");
      assert.deepEqual(calls, []);
      assert.deepEqual(tracked.surfaces, []);
    } finally { rmSync(team, { recursive: true, force: true }); }
  });
  it("verified cleanup reports visible ambiguous ownership, retains the root, and retries after disappearance", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-harness-ambiguous-"));
    const tracked = env([
      { ref: ROOT, cmuxOwnership: { baseline, titleFragment: "root-case-123" } },
      { ref: WORKER, cmuxOwnership: { baseline, titleFragment: "claim-a | claim-b", ambiguous: true } },
    ]);
    tracked.dir = temp;
    tracked.teams.push({ dir: join(temp, "missing-team"), rootRef: ROOT });
    let current = [{ ref: ROOT, title: "root-case-123" }, { ref: WORKER, title: "claim-a" }];
    const calls: string[] = [];
    await assert.rejects(
      cleanupTestEnvVerified(tracked, 100, {
        snapshot: () => current,
        close(ref) { calls.push(ref); current = current.filter((surface) => surface.ref !== ref); },
      }),
      /retained roots while descendants were unresolved/,
    );
    assert.deepEqual(calls, [], "visible ambiguity must close neither descendant nor root");
    assert.equal(current.some((surface) => surface.ref === ROOT), true);
    assert.equal(tracked.surfaces.length, 2, "ambiguous evidence and root remain retryable");

    current = current.filter((surface) => surface.ref !== WORKER);
    await cleanupTestEnvVerified(tracked, 100, {
      snapshot: () => current,
      close(ref) { calls.push(ref); current = current.filter((surface) => surface.ref !== ref); },
    });
    assert.deepEqual(calls, [ROOT]);
  });

  it("never closes the root when descendant close retries fail", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-harness-close-failure-"));
    const tracked = env([
      { ref: ROOT, cmuxOwnership: { baseline, titleFragment: "root-case-123" } },
      { ref: WORKER, cmuxOwnership: { baseline, titleFragment: "Worker-case-123" } },
    ]);
    tracked.dir = temp;
    tracked.teams.push({ dir: join(temp, "missing-team"), rootRef: ROOT });
    let current = [{ ref: ROOT, title: "root-case-123" }, { ref: WORKER, title: "Worker-case-123" }];
    const calls: string[] = [];
    await assert.rejects(cleanupTestEnvVerified(tracked, 50, {
      snapshot: () => current,
      close(ref) {
        calls.push(ref);
        if (ref === WORKER) throw new Error("injected descendant close failure");
        current = current.filter((surface) => surface.ref !== ref);
      },
    }), /retained roots while descendants were unresolved/);
    assert.ok(calls.length >= 1);
    assert.equal(calls.every((ref) => ref === WORKER), true);
    assert.equal(current.some((surface) => surface.ref === ROOT), true);
    assert.equal(tracked.surfaces.some((surface) => surface.ref === ROOT), true);

    calls.length = 0;
    await cleanupTestEnvVerified(tracked, 500, {
      snapshot: () => current,
      close(ref) {
        calls.push(ref);
        current = current.filter((surface) => surface.ref !== ref);
      },
    });
    assert.deepEqual(calls, [WORKER, ROOT]);
  });

  it("keeps the associated root alive until descendant metadata, lease, and surface finalize", async () => {
    const team = mkdtempSync(join(tmpdir(), "pi-harness-order-team-"));
    const temp = mkdtempSync(join(tmpdir(), "pi-harness-order-env-"));
    mkdirSync(join(team, "agents"));
    mkdirSync(join(team, "leases", "1"), { recursive: true });
    const rootRecord = join(team, "agents", "root.json");
    const workerRecord = join(team, "agents", "worker.json");
    writeFileSync(rootRecord, JSON.stringify({
      runId: "root-run", displayName: "root-case-123", parentPath: null,
      surface: ROOT, surfaces: [{ id: ROOT, state: "active" }], status: "running",
    }));
    writeFileSync(workerRecord, JSON.stringify({
      runId: "worker-run", displayName: "Worker-case-123", parentPath: "/root",
      surface: WORKER, surfaces: [{ id: WORKER, state: "active" }], status: "waiting",
    }));
    writeFileSync(join(team, "leases", "1", "owner.json"), JSON.stringify({ runId: "worker-run" }));
    const tracked = env([
      { ref: ROOT, cmuxOwnership: { baseline, titleFragment: "root-case-123" } },
      { ref: WORKER, cmuxOwnership: { baseline, titleFragment: "Worker-case-123" } },
    ]);
    tracked.dir = temp;
    tracked.teams.push({ dir: team, rootRef: ROOT });
    let current = [{ ref: ROOT, title: "root-case-123" }, { ref: WORKER, title: "Worker-case-123" }];
    const calls: string[] = [];
    try {
      await cleanupTestEnvVerified(tracked, 1_000, {
        snapshot: () => current,
        close(ref) {
          calls.push(ref);
          if (ref === WORKER) {
            assert.equal(current.some((surface) => surface.ref === ROOT), true, "root watcher must still exist");
            current = current.filter((surface) => surface.ref !== WORKER);
            writeFileSync(workerRecord, JSON.stringify({
              runId: "worker-run", displayName: "Worker-case-123", parentPath: "/root",
              surface: WORKER, surfaces: [{ id: WORKER, state: "closed" }], status: "completed",
            }));
            rmSync(join(team, "leases", "1"), { recursive: true, force: true });
            return;
          }
          const worker = JSON.parse(readFileSync(workerRecord, "utf8"));
          assert.equal(worker.status, "completed");
          assert.equal(existsSync(join(team, "leases", "1")), false);
          current = current.filter((surface) => surface.ref !== ROOT);
        },
      });
      assert.deepEqual(calls, [WORKER, ROOT]);
      assert.deepEqual(tracked.surfaces, []);
    } finally {
      rmSync(team, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("safely closes an explicitly associated root when the team registry is absent", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-harness-no-registry-"));
    const tracked = env([{ ref: ROOT, cmuxOwnership: { baseline, titleFragment: "root-case-123" } }]);
    tracked.dir = temp;
    tracked.teams.push({ dir: join(temp, "missing-team"), rootRef: ROOT });
    let current = [{ ref: ROOT, title: "root-case-123" }];
    const calls: string[] = [];
    await cleanupTestEnvVerified(tracked, 500, {
      snapshot: () => current,
      close(ref) { calls.push(ref); current = []; },
    });
    assert.deepEqual(calls, [ROOT]);
  });

});
