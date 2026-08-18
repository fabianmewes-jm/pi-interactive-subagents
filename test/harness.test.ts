import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCmuxSurfaceSnapshot,
  cleanupCmuxScenarioSurfaces,
  cleanupTrackedSurfaces,
  selectNewCmuxScenarioSurfaces,
} from "./integration/harness.ts";

describe("cmux integration surface isolation", () => {
  it("parses surface refs and titles from a cmux tree", () => {
    const tree = [
      'window window:1 [current]',
      '├── pane pane:1',
      '│   └── surface surface:155 [terminal] "Coordinator" [selected] tty=ttys001',
      '└── pane pane:2',
      '    └── surface surface:788 [terminal] "Worker-case-123" tty=ttys002',
    ].join("\n");

    assert.deepEqual(parseCmuxSurfaceSnapshot(tree), [
      { ref: "surface:155", title: "Coordinator" },
      { ref: "surface:788", title: "Worker-case-123" },
    ]);
  });

  it("selects only matching scenario surfaces created after the snapshot", () => {
    const before = [
      { ref: "surface:155", title: "Coordinator" },
      { ref: "surface:700", title: "Worker-case-123-preexisting" },
    ];
    const after = [
      ...before,
      { ref: "surface:701", title: "followup-case-123" },
      { ref: "surface:702", title: "Worker-case-123" },
      { ref: "surface:703", title: "Other concurrent test" },
    ];

    assert.deepEqual(
      selectNewCmuxScenarioSurfaces(before, after, "case-123"),
      ["surface:701", "surface:702"],
    );
  });
  it("rejects reused, ambiguous, or unavailable-title explicit refs", () => {
    const before = [{ ref: "surface:155", title: "Coordinator" }];
    const closed: string[] = [];
    const run = (current: Array<{ ref: string; title: string }>) =>
      cleanupCmuxScenarioSurfaces(before, "case-123", ["surface:701"], {
        snapshot: () => current,
        close(ref) { closed.push(ref); },
      });

    assert.deepEqual(run([{ ref: "surface:701", title: "Unrelated replacement" }]), []);
    assert.deepEqual(run([
      { ref: "surface:701", title: "Worker-case-123" },
      { ref: "surface:701", title: "Duplicate-case-123" },
    ]), []);
    assert.deepEqual(run(parseCmuxSurfaceSnapshot(
      "└── surface surface:701 [terminal] [selected] tty=ttys002",
    )), []);
    assert.deepEqual(cleanupCmuxScenarioSurfaces(
      [{ ref: "surface:701", title: "Worker-case-123-preexisting" }],
      "case-123",
      ["surface:701"],
      {
        snapshot: () => [{ ref: "surface:701", title: "Worker-case-123-preexisting" }],
        close(ref) { closed.push(ref); },
      },
    ), []);
    assert.deepEqual(closed, []);
  });

  it("keeps refs retryable when snapshots fail", () => {
    const before = [{ ref: "surface:155", title: "Coordinator" }];
    const current = [{ ref: "surface:701", title: "Worker-case-123" }];
    const closeCalls: string[] = [];

    assert.deepEqual(cleanupCmuxScenarioSurfaces(before, "case-123", ["surface:701"], {
      snapshot: () => null,
      close(ref) { closeCalls.push(ref); },
    }), []);
    assert.deepEqual(closeCalls, [], "an unavailable ownership snapshot must close nothing");

    let snapshotCall = 0;
    assert.deepEqual(cleanupCmuxScenarioSurfaces(before, "case-123", ["surface:701"], {
      snapshot: () => snapshotCall++ === 0 ? current : null,
      close(ref) { closeCalls.push(ref); },
    }), []);
    assert.deepEqual(closeCalls, ["surface:701"], "failed final confirmation must not report closed refs");
  });

  it("reports only individually successful and snapshot-confirmed closes", () => {
    const before = [{ ref: "surface:155", title: "Coordinator" }];
    let current = [
      { ref: "surface:701", title: "Worker-case-123" },
      { ref: "surface:702", title: "Scout-case-123" },
    ];
    const closeCalls: string[] = [];

    const confirmed = cleanupCmuxScenarioSurfaces(
      before,
      "case-123",
      ["surface:701", "surface:702"],
      {
        snapshot: () => current,
        close(ref) {
          closeCalls.push(ref);
          if (ref === "surface:702") throw new Error("injected close failure");
          current = current.filter((surface) => surface.ref !== ref);
        },
      },
    );

    assert.deepEqual(closeCalls, ["surface:701", "surface:702"]);
    assert.deepEqual(confirmed, ["surface:701"]);
    assert.deepEqual(current.map((surface) => surface.ref), ["surface:702"]);
  });

  it("preserves generic tracked-surface cleanup and retains failures", () => {
    const env = {
      dir: "/tmp/not-used",
      backend: "cmux" as const,
      surfaces: [{ ref: "surface:701" }, { ref: "surface:702" }],
      tempFiles: [],
    };
    assert.deepEqual(cleanupTrackedSurfaces(env, {
      close(ref) {
        if (ref === "surface:702") throw new Error("injected generic close failure");
      },
    }), ["surface:701"]);
    assert.deepEqual(env.surfaces, [{ ref: "surface:702" }]);
  });

  it("revalidates ownership when suite teardown retries an unconfirmed tracked root", () => {
    const baseline = [{ ref: "surface:155", title: "Coordinator" }];
    const owned = [{ ref: "surface:701", title: "followup-case-123" }];
    const env = {
      dir: "/tmp/not-used",
      backend: "cmux" as const,
      surfaces: [{
        ref: "surface:701",
        cmuxOwnership: { baseline, titleFragment: "case-123" },
      }],
      tempFiles: [],
    };
    const firstCloseCalls: string[] = [];
    let firstSnapshot = 0;
    const firstConfirmed = cleanupCmuxScenarioSurfaces(
      baseline,
      "case-123",
      ["surface:701"],
      {
        snapshot: () => firstSnapshot++ === 0 ? owned : null,
        close(ref) { firstCloseCalls.push(ref); },
      },
    );
    assert.deepEqual(firstCloseCalls, ["surface:701"]);
    assert.deepEqual(firstConfirmed, []);

    const retryCloseCalls: string[] = [];
    assert.deepEqual(cleanupTrackedSurfaces(env, {
      snapshot: () => [{ ref: "surface:701", title: "Unrelated reused surface" }],
      close(ref) { retryCloseCalls.push(ref); },
    }), []);
    assert.deepEqual(retryCloseCalls, [], "suite retry must not close a reused short ref");
    assert.equal(env.surfaces.length, 1, "unconfirmed root remains tracked for a safe retry");

    let current = [...owned];
    assert.deepEqual(cleanupTrackedSurfaces(env, {
      snapshot: () => current,
      close(ref) { current = current.filter((surface) => surface.ref !== ref); },
    }), ["surface:701"]);
    assert.deepEqual(env.surfaces, [], "confirmed valid retry removes the tracked root");
  });

});
