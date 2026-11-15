// Export layouts and Plugin API contracts (src/layout.ts): telling a
// ProjectionLab 4 export from a ProjectionLab 5 one, reading their sections
// under one set of names, and the rollback refusal across layouts.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
const SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-layout-")), "snapshots");
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const layout = await import("../dist/layout.js");
const { assertPlansUnchanged } = await import("../dist/planVersion.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { SnapshotManager } = await import("../dist/snapshot.js");

const v4Export = () => ({
  meta: { version: "4.6.0" },
  today: { accounts: [{ id: "a1", name: "Brokerage", balance: 1 }] },
  plans: [{ id: "p1", name: "Plan", lastUpdated: 1 }],
  settings: { plugins: { apiKey: "synthetic-plugin-key" } },
  progress: { data: [] },
});

test("detectLayout tells the two export layouts apart by shape", () => {
  assert.equal(layout.detectLayout(v5Export()), "v5");
  assert.equal(layout.detectLayout(v4Export()), "v4");
  assert.equal(layout.detectLayout({}), "v4");
  assert.equal(layout.detectLayout(null), "v4");
  // A numeric schema alone, or documents alone, is not the v5 envelope.
  assert.equal(layout.detectLayout({ schema: 1, plans: [] }), "v4");
  assert.equal(layout.detectLayout({ documents: {} }), "v4");
});

test("exportSections reads v5 documents under the shared section names", () => {
  const raw = v5Export();
  const sections = layout.exportSections(raw);
  assert.equal(sections.layout, "v5");
  assert.equal(sections.plans, raw.documents.plans);
  assert.equal(sections.currentFinances, raw.documents.currentFinances);
  assert.equal(sections.settings, raw.documents.settings);
  assert.equal(sections.accountHistory, raw.documents.accountHistory);
  assert.equal(sections.progress, undefined);
  assert.equal(layout.sectionOf(raw, "currentFinances"), raw.documents.currentFinances);
  assert.equal(layout.sectionOf(raw, "progress"), undefined);
});

test("exportSections reads v4 sections as before", () => {
  const raw = v4Export();
  const sections = layout.exportSections(raw);
  assert.equal(sections.layout, "v4");
  assert.equal(sections.plans, raw.plans);
  assert.equal(sections.currentFinances, raw.today);
  assert.equal(sections.progress, raw.progress);
  assert.equal(sections.accountHistory, undefined);
  assert.deepEqual(layout.exportSections({}).plans, []);
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

test("contractFromVersion maps api.version to a supported contract or refuses", () => {
  assert.equal(layout.contractFromVersion(undefined), 1);
  assert.equal(layout.contractFromVersion(null), 1);
  assert.equal(layout.contractFromVersion(2), 2);
  for (const version of [1, 3, "2", true]) {
    assert.throws(() => layout.contractFromVersion(version), (err) => err.code === "UNSUPPORTED_API_VERSION");
  }
  assert.equal(layout.layoutForContract(1), "v4");
  assert.equal(layout.layoutForContract(2), "v5");
});

test("assertSnapshotLayout refuses a snapshot from the other layout", () => {
  layout.assertSnapshotLayout("v5", "v5");
  layout.assertSnapshotLayout("v4", "v4");
  // A snapshot with no recorded layout was taken from ProjectionLab 4.
  layout.assertSnapshotLayout(undefined, "v4");
  assert.throws(() => layout.assertSnapshotLayout(undefined, "v5"), (err) => err.code === "LAYOUT_MISMATCH");
  assert.throws(() => layout.assertSnapshotLayout("v5", "v4"), (err) => err.code === "LAYOUT_MISMATCH");
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
    async restoreProgress() {
      bridge.writes.push("progress");
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

test("snapshots record the layout they were taken from", async () => {
  const { snapshots } = await rollbackTool(fakeBridge(v5Export()));
  const snap = await snapshots.create("test", ["plans"], { plans: [] }, "v5");
  assert.equal(snap.layout, "v5");
  assert.equal((await snapshots.get(snap.id)).layout, "v5");
  assert.equal((await snapshots.list())[0].layout, "v5");
});

for (const confirm of [false, true]) {
  test(`a v4 snapshot is refused on a v5 account (confirm: ${confirm})`, async () => {
    const bridge = fakeBridge(v5Export());
    const { snapshots, rollback } = await rollbackTool(bridge);
    const snap = await snapshots.create("updatePlanEvent", ["plans"], { plans: v4Export().plans }, "v4");
    const result = parse(await rollback({ snapshotId: snap.id, confirm }));
    assert.equal(result.error, "LAYOUT_MISMATCH");
    assert.match(result.suggestion, /Restore action in the ProjectionLab app/);
    assert.deepEqual(bridge.writes, []);
  });
}

test("a snapshot with no recorded layout is treated as v4 and refused on v5", async () => {
  const bridge = fakeBridge(v5Export());
  const { snapshots, rollback } = await rollbackTool(bridge);
  const snap = await snapshots.create("updatePlanEvent", ["plans"], { plans: v4Export().plans }, undefined);
  const result = parse(await rollback({ snapshotId: snap.id, confirm: true }));
  assert.equal(result.error, "LAYOUT_MISMATCH");
  assert.deepEqual(bridge.writes, []);
});

test("a v4 snapshot still rolls back on a v4 account", async () => {
  const data = v4Export();
  const bridge = fakeBridge(data);
  const { snapshots, rollback } = await rollbackTool(bridge);
  const snap = await snapshots.create("updatePlanEvent", ["plans"], { plans: data.plans }, "v4");
  const result = parse(await rollback({ snapshotId: snap.id, confirm: true }));
  assert.equal(result.success, true);
  assert.deepEqual(bridge.writes, ["plans"]);
});
