// Identifier guards, per-plan counts, restore verification and rollback,
// against an in-memory bridge that behaves like ProjectionLab: it re-stamps
// each plan's lastUpdated when plans are restored.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-write-safety-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { requirePlanIndex, requireEventIndex } = await import("../dist/plans.js");
const { registerSchemaTool } = await import("../dist/tools/schema.js");
const { registerSummaryTool } = await import("../dist/tools/summary.js");
const { registerRestoreTools, restoredSectionMatches } = await import(
  "../dist/tools/restore.js"
);
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { registerGetPlanTool } = await import("../dist/tools/getPlan.js");
const { SnapshotManager } = await import("../dist/snapshot.js");
const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);
const { z } = await import("zod");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function samplePlans() {
  return [
    {
      id: "p1",
      name: "Retire at 55",
      lastUpdated: 100,
      income: { events: [{ id: "i1", name: "Salary" }, { id: "i2", name: "Pension" }] },
      expenses: { events: [{ id: "e1", name: "Living" }] },
      milestones: [{ id: "m1", name: "Retire" }, { id: "m2", name: "Medicare" }, { id: "m3", name: "SS" }],
    },
    {
      id: "p2",
      name: "Work forever",
      lastUpdated: 200,
      income: { events: [] },
      expenses: { events: [{ id: "e2", name: "Living" }, { id: "e3", name: "Travel" }] },
      milestones: [],
    },
  ];
}

function fakeBridge(initial) {
  let stamp = 1000;
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: [],
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes.push("plans");
      // ProjectionLab saves each plan and re-stamps it.
      state.plans = structuredClone(plans).map((p) => ({ ...p, lastUpdated: ++stamp }));
    },
    async restoreCurrentFinances(today) {
      bridge.writes.push("currentFinances");
      state.today = { ...structuredClone(today), appDefault: true };
    },
    async restoreProgress(progress) {
      bridge.writes.push("progress");
      state.progress = structuredClone(progress);
    },
    async restoreSettings(settings) {
      bridge.writes.push("settings");
      state.settings = structuredClone(settings);
    },
  };
  return bridge;
}

test("blank identifiers match no plan or event", () => {
  const plans = samplePlans();
  for (const blank of ["", "   "]) {
    assert.equal(requirePlanIndex(plans, blank), -1);
    assert.equal(requireEventIndex([{ name: "Salary" }, { id: "x" }], blank), -1);
  }
  assert.equal(requirePlanIndex(plans, "work"), 1);
});

test("plan tools reject a blank planIdentifier at the schema", () => {
  const server = fakeServer();
  registerGetPlanTool(server, fakeBridge({ plans: samplePlans() }));
  const schema = server.tools.get("projectionlab_get_plan").definition.inputSchema;
  assert.equal(schema.planIdentifier.safeParse("").success, false);
  assert.equal(schema.planIdentifier.safeParse("  ").success, false);
  assert.equal(schema.planIdentifier.safeParse("Retire").success, true);
});

test("replacement tools refuse a call that omits the replacement data", () => {
  // The MCP SDK validates arguments with z.object(inputSchema), so a call
  // without the data field must fail there instead of writing undefined.
  const server = fakeServer();
  const bridge = fakeBridge({ plans: samplePlans() });
  const snapshots = new SnapshotManager();
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);
  const cases = [
    ["projectionlab_update_plan_section", { planIdentifier: "Retire", section: "income", confirm: true }, "sectionData"],
    ["projectionlab_restore_progress", { confirm: true }, "progress"],
  ];
  for (const [name, args, field] of cases) {
    const schema = z.object(server.tools.get(name).definition.inputSchema);
    const result = schema.safeParse(args);
    assert.equal(result.success, false, name);
    assert.deepEqual(result.error.issues.map((i) => i.path.join(".")), [field], name);
  }
});

test("schema and summary report event counts per plan", async () => {
  const data = { today: { investmentAccounts: [{ id: "a", balance: 10 }] }, plans: samplePlans() };
  const server = fakeServer();
  registerSchemaTool(server, fakeBridge(data));
  registerSummaryTool(server, fakeBridge(data));

  const schema = JSON.parse(
    (await server.tools.get("projectionlab_describe_schema").handler({})).content[0].text,
  );
  assert.deepEqual(schema.plans, [
    { id: "p1", name: "Retire at 55", incomeCount: 2, expenseCount: 1, milestoneCount: 3 },
    { id: "p2", name: "Work forever", incomeCount: 0, expenseCount: 2, milestoneCount: 0 },
  ]);
  assert.equal("incomeCount" in schema, false);

  const summary = (await server.tools.get("projectionlab_get_summary").handler({})).structuredContent;
  assert.equal(summary.plans[0].incomeCount, 2);
  assert.equal(summary.plans[1].expenseCount, 2);
  assert.equal("incomeCount" in summary, false);
});

test("restore verification tolerates re-stamped plans and app-added fields", () => {
  const plans = samplePlans();
  const saved = plans.map((p) => ({ ...p, lastUpdated: 9999 }));
  assert.equal(restoredSectionMatches("plans", plans, saved), true);
  assert.equal(
    restoredSectionMatches("plans", plans, [{ ...saved[0], name: "Changed" }, saved[1]]),
    false,
  );
  assert.equal(restoredSectionMatches("plans", plans, saved.slice(0, 1)), false);
  assert.equal(
    restoredSectionMatches("currentFinances", { a: 1 }, { a: 1, appDefault: true }),
    true,
  );
});

test("restore_plans reports verified when ProjectionLab re-stamps the plans", async () => {
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });
  const server = fakeServer();
  registerRestoreTools(server, bridge, new SnapshotManager());
  const incoming = samplePlans();
  incoming[0].name = "Retire at 57";

  const result = await server.tools
    .get("projectionlab_restore_plans")
    .handler({ plans: incoming, confirm: true });
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.verified, true);
  assert.equal(bridge.state.plans[0].name, "Retire at 57");
});

async function snapshotFor(bridge, snapshots) {
  // A confirmed restore snapshots the plans first; use that snapshot.
  const server = fakeServer();
  registerRestoreTools(server, bridge, snapshots);
  const incoming = samplePlans();
  incoming[0].name = "Edited by agent";
  await server.tools.get("projectionlab_restore_plans").handler({ plans: incoming, confirm: true });
  const list = await snapshots.list();
  return list.find((s) => s.operation === "restorePlans").id;
}

test("rollback restores the snapshot and verifies it landed", async () => {
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });
  const snapshots = new SnapshotManager();
  const snapshotId = await snapshotFor(bridge, snapshots);
  assert.equal(bridge.state.plans[0].name, "Edited by agent");

  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  const result = await server.tools
    .get("projectionlab_rollback")
    .handler({ snapshotId, confirm: true });
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.success, true);
  assert.equal(output.verified, true);
  assert.deepEqual(output.restoredSections, ["plans"]);
  assert.equal(bridge.state.plans[0].name, "Retire at 55");
});

test("rollback reports unverified sections when the re-read differs", async () => {
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });
  const snapshots = new SnapshotManager();
  const snapshotId = await snapshotFor(bridge, snapshots);
  // The app accepts the write but drops the first plan's milestones.
  bridge.restorePlans = async (plans) => {
    bridge.state.plans = structuredClone(plans).map((p, i) =>
      i === 0 ? { ...p, milestones: [] } : p,
    );
  };

  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  const output = JSON.parse(
    (await server.tools.get("projectionlab_rollback").handler({ snapshotId, confirm: true }))
      .content[0].text,
  );
  // success means the write was accepted; verified reports the re-read.
  assert.equal(output.success, true);
  assert.equal(output.verified, false);
  assert.deepEqual(output.unverifiedSections, ["plans"]);
});

test("rollback refuses with PLAN_CONFLICT when a plan is saved meanwhile", async () => {
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });
  const snapshots = new SnapshotManager();
  const snapshotId = await snapshotFor(bridge, snapshots);
  const before = structuredClone(bridge.state.plans);

  // The first fresh read is the rollback's own; the user saves a plan in the
  // ProjectionLab UI before the conflict check's re-read.
  const exportData = bridge.exportData;
  let reads = 0;
  bridge.exportData = async () => {
    reads++;
    if (reads === 2) bridge.state.plans[1].lastUpdated += 1;
    return exportData();
  };
  bridge.writes.length = 0;

  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  const result = await server.tools
    .get("projectionlab_rollback")
    .handler({ snapshotId, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLAN_CONFLICT/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(bridge.state.plans[0].name, before[0].name);
});
