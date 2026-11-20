// The export layout and Plugin API contract (src/layout.ts): reading a
// ProjectionLab 5 export's sections, refusing a ProjectionLab 4 export or
// page, and refusing to roll back a snapshot not taken from ProjectionLab 5.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
const SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-layout-")), "snapshots");
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const layout = await import("../dist/layout.js");
const { assertPlansUnchanged } = await import("../dist/planVersion.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { SnapshotManager } = await import("../dist/snapshot.js");

/** A ProjectionLab 4 export, which the server refuses. */
const v4Export = () => ({
  meta: { version: "4.6.0" },
  today: { accounts: [{ id: "a1", name: "Brokerage", balance: 1 }] },
  plans: [{ id: "p1", name: "Plan", lastUpdated: 1 }],
  settings: { plugins: { apiKey: "synthetic-plugin-key" } },
  progress: { data: [] },
});

test("isV5Export recognizes the ProjectionLab 5 envelope by shape", () => {
  assert.equal(layout.isV5Export(v5Export()), true);
  assert.equal(layout.isV5Export(v4Export()), false);
  assert.equal(layout.isV5Export({}), false);
  assert.equal(layout.isV5Export(null), false);
  // A numeric schema alone, or documents alone, is not the v5 envelope.
  assert.equal(layout.isV5Export({ schema: 1, plans: [] }), false);
  assert.equal(layout.isV5Export({ documents: {} }), false);
});

test("exportSections reads v5 documents under the shared section names", () => {
  const raw = v5Export();
  const sections = layout.exportSections(raw);
  assert.equal(sections.plans, raw.documents.plans);
  assert.equal(sections.currentFinances, raw.documents.currentFinances);
  assert.equal(sections.settings, raw.documents.settings);
  assert.equal(sections.accountHistory, raw.documents.accountHistory);
  assert.equal(sections.progress, undefined);
  assert.equal(layout.sectionOf(raw, "currentFinances"), raw.documents.currentFinances);
  assert.equal(layout.sectionOf(raw, "progress"), undefined);
});

test("exportSections refuses a ProjectionLab 4 export", () => {
  for (const raw of [v4Export(), {}, null]) {
    assert.throws(
      () => layout.exportSections(raw),
      (err) => err.code === "UNSUPPORTED_API_VERSION" && /ProjectionLab 5 format/.test(err.message),
    );
  }
});

test("a v5 export without a plans list is refused, never read as no plans", () => {
  const raw = v5Export();
  delete raw.documents.plans;
  assert.throws(() => layout.exportSections(raw), /documents\.plans/);
});

test("the plan conflict check compares against v5 plans, not an empty list", async () => {
  const raw = v5Export();
  const read = structuredClone(raw.documents.plans);
  const bridge = { exportData: async () => raw };
  await assertPlansUnchanged(bridge, read);
  raw.documents.plans[0].lastUpdated += 1;
  await assert.rejects(assertPlansUnchanged(bridge, read), (err) => err.code === "PLAN_CONFLICT");
});

test("contractFromVersion accepts contract 2 and refuses a ProjectionLab 4 page or any other version", () => {
  assert.equal(layout.contractFromVersion(2), 2);
  for (const version of [undefined, null]) {
    assert.throws(
      () => layout.contractFromVersion(version),
      (err) => err.code === "UNSUPPORTED_API_VERSION" && /ProjectionLab 4 Plugin API/.test(err.message),
    );
  }
  for (const version of [1, 3, "2", true]) {
    assert.throws(() => layout.contractFromVersion(version), (err) => err.code === "UNSUPPORTED_API_VERSION");
  }
});

test("assertSnapshotLayout accepts only a ProjectionLab 5 snapshot", () => {
  layout.assertSnapshotLayout("v5");
  for (const recorded of ["v4", undefined, null]) {
    assert.throws(() => layout.assertSnapshotLayout(recorded), (err) => err.code === "LAYOUT_MISMATCH");
  }
  assert.throws(
    () => layout.assertSnapshotLayout("v4", "Custom fix."),
    (err) => err.suggestion === "Custom fix.",
  );
});

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function fakeBridge(data) {
  const bridge = {
    writes: [],
    async editAccess() { return "enabled"; },
    async apiContract() { return 2; },
    async exportData() {
      return structuredClone(data);
    },
    restorePlansIfUnchanged,
    async restorePlans() {
      bridge.writes.push("plans");
    },
    async restoreCurrentFinances() {
      bridge.writes.push("currentFinances");
    },
    async restoreSettings() {
      bridge.writes.push("settings");
    },
  };
  return bridge;
}

async function rollbackTool(bridge) {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const snapshots = new SnapshotManager();
  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  return { snapshots, rollback: server.tools.get("projectionlab_rollback").handler };
}

const parse = (result) => JSON.parse(result.content[0].text);

/**
 * A snapshot on disk whose recorded layout is `recorded`, or absent when
 * `recorded` is undefined, as a ProjectionLab 4 server wrote it.
 */
async function legacySnapshot(snapshots, recorded) {
  const snap = await snapshots.create("updatePlanEvent", ["plans"], { plans: v4Export().plans });
  const file = join(SNAPSHOT_DIR, `${snap.id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf-8"));
  if (recorded === undefined) delete stored.layout;
  else stored.layout = recorded;
  writeFileSync(file, JSON.stringify(stored));
  return snap;
}

test("snapshots record the ProjectionLab 5 layout", async () => {
  const { snapshots } = await rollbackTool(fakeBridge(v5Export()));
  const snap = await snapshots.create("test", ["plans"], { plans: [] });
  assert.equal(snap.layout, "v5");
  assert.equal((await snapshots.get(snap.id)).layout, "v5");
  assert.equal((await snapshots.list())[0].layout, "v5");
});

for (const recorded of ["v4", undefined]) {
  for (const confirm of [false, true]) {
    test(`a snapshot recording layout ${recorded} is refused before any write (confirm: ${confirm})`, async () => {
      const bridge = fakeBridge(v5Export());
      const { snapshots, rollback } = await rollbackTool(bridge);
      const snap = await legacySnapshot(snapshots, recorded);
      const result = parse(await rollback({ snapshotId: snap.id, confirm }));
      assert.equal(result.error, "LAYOUT_MISMATCH", JSON.stringify(result));
      assert.match(result.message, /ProjectionLab 4/);
      assert.match(result.suggestion, /Restore action in the ProjectionLab app/);
      assert.deepEqual(bridge.writes, []);
      assert.equal((await snapshots.list()).length, 1, "no pre-rollback snapshot was taken");
    });
  }
}
