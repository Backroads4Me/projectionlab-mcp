// Plan writes on a ProjectionLab 5 account (Plugin API contract 2). The
// fake bridge holds a v5 export and applies each plans write to it, so the
// tools' own verification reads back what was written.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-plan-writes-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { registerUpdatePlanSettingsTool } = await import("../dist/tools/updatePlanSettings.js");
const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

/** A ProjectionLab 5 bridge whose plans writes replace its export's plans. */
function v5Bridge(state = v5Export()) {
  const writes = [];
  const apply = (name) => async (...args) => {
    const plans = name === "restorePlans" ? args[0] : args[1];
    const layout = args[args.length - 1];
    writes.push({ name, plans: structuredClone(plans), layout });
    state.documents.plans = structuredClone(plans);
  };
  const refuse = (name) => async () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    state,
    writes,
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      return 2;
    },
    async exportData() {
      return structuredClone(state);
    },
    restorePlans: apply("restorePlans"),
    restorePlansIfUnchanged: apply("restorePlansIfUnchanged"),
    updateAccount: refuse("updateAccount"),
    restoreCurrentFinances: refuse("restoreCurrentFinances"),
    restoreProgress: refuse("restoreProgress"),
    restoreSettings: refuse("restoreSettings"),
  };
}

/** A snapshot store recording creates; `held` is what get/list serve. */
function snapshotStore(held) {
  const created = [];
  return {
    created,
    async create(operation, sections, data, layout) {
      created.push({ operation, sections, data: structuredClone(data), layout });
      return { id: `snap-${created.length}` };
    },
    async get() {
      return structuredClone(held);
    },
    async list() {
      return held ? [structuredClone(held)] : [];
    },
  };
}

function tools(bridge, snapshots) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
  };
  registerUpdatePlanSettingsTool(server, bridge, snapshots);
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerClonePlanTool(server, bridge, snapshots);
  registerDeletePlanTool(server, bridge, snapshots);
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);
  return async (name, input) => JSON.parse((await map.get(name)(input)).content[0].text);
}

const planById = (plans, id) => plans.find((p) => p.id === id);

test("update_plan_event previews, then writes the v5 plans with only that event changed", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const before = v5Export().documents.plans;
  const input = {
    planIdentifier: "plan_main",
    section: "income",
    eventIdentifier: "plan_main_ev_salary",
    patch: { amount: 12345 },
  };

  const dry = await call("projectionlab_update_plan_event", input);
  assert.equal(dry.dryRun, true, JSON.stringify(dry));
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);

  const done = await call("projectionlab_update_plan_event", { ...input, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));

  assert.equal(snapshots.created.length, 1);
  assert.equal(snapshots.created[0].layout, "v5");
  assert.deepEqual(snapshots.created[0].data.plans, before);

  assert.equal(bridge.writes.length, 1);
  const [write] = bridge.writes;
  assert.equal(write.name, "restorePlansIfUnchanged");
  assert.equal(write.layout, "v5");
  assert.equal(write.plans.length, before.length);
  assert.deepEqual(planById(write.plans, "plan_early"), planById(before, "plan_early"));
  const expected = structuredClone(planById(before, "plan_main"));
  expected.income.events[0].amount = 12345;
  assert.deepEqual(planById(write.plans, "plan_main"), expected);
});

test("update_plan_section replaces one v5 section and leaves the rest of the plan", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const before = v5Export().documents.plans;
  const milestones = [{ id: "plan_main_ms_retire", name: "Retire" }];

  const done = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "milestones",
    sectionData: milestones,
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  const [write] = bridge.writes;
  assert.equal(write.layout, "v5");
  assert.deepEqual(planById(write.plans, "plan_main"), { ...planById(before, "plan_main"), milestones });
  assert.deepEqual(planById(write.plans, "plan_early"), planById(before, "plan_early"));
});

test("update_plan_settings patches a v5 plan setting", async () => {
  const state = v5Export();
  planById(state.documents.plans, "plan_main").variables = { inflation: 3 };
  const bridge = v5Bridge(state);
  const call = tools(bridge, snapshotStore());

  const done = await call("projectionlab_update_plan_settings", {
    planIdentifier: "plan_main",
    section: "variables",
    changes: { inflation: 2.5 },
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(planById(bridge.writes[0].plans, "plan_main").variables, { inflation: 2.5 });
});

test("clone_plan adds a v5 plan copy under a new id", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const before = v5Export().documents.plans;

  const done = await call("projectionlab_clone_plan", {
    planIdentifier: "plan_main",
    newName: "Main Copy",
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  const [write] = bridge.writes;
  assert.equal(write.plans.length, before.length + 1);
  const copy = write.plans.find((p) => p.name === "Main Copy");
  assert.ok(copy);
  assert.notEqual(copy.id, "plan_main");
  assert.equal(copy.schema, planById(before, "plan_main").schema);
  assert.deepEqual(copy.income, planById(before, "plan_main").income);
});

test("delete_plan removes one v5 plan", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const before = v5Export().documents.plans;

  const done = await call("projectionlab_delete_plan", { planId: "plan_early", confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(bridge.writes[0].plans, before.filter((p) => p.id !== "plan_early"));
});

test("restore_plans writes v5 plans", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const plans = v5Export().documents.plans;
  plans[0].name = "Renamed";

  const done = await call("projectionlab_restore_plans", { plans, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(bridge.writes[0].layout, "v5");
  assert.deepEqual(bridge.writes[0].plans, plans);
});

test("rollback restores the plans of a v5 plans snapshot", async () => {
  const state = v5Export();
  state.documents.plans[0].name = "Changed since";
  const bridge = v5Bridge(state);
  const held = {
    id: "snap-v5",
    timestamp: new Date(0).toISOString(),
    operation: "test",
    sections: ["plans"],
    layout: "v5",
    data: { plans: v5Export().documents.plans },
  };
  const call = tools(bridge, snapshotStore(held));

  const done = await call("projectionlab_rollback", { snapshotId: "snap-v5", confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(bridge.writes.length, 1);
  assert.equal(bridge.writes[0].layout, "v5");
  assert.deepEqual(bridge.writes[0].plans, v5Export().documents.plans);
});

test("update_plan_event enforces the recorded v5 spending types on an expense", async () => {
  // ProjectionLab 5's four spending types are recorded with evidence "observed",
  // so a value outside them is refused before anything reaches the executor and
  // one inside them writes normally.
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const refused = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "expenses",
    eventIdentifier: "plan_main_ev_living",
    patch: { spendingType: "flexible" },
    confirm: true,
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.equal(bridge.writes.length, 0);

  const done = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "expenses",
    eventIdentifier: "plan_main_ev_living",
    patch: { spendingType: "hybrid" },
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(planById(bridge.writes[0].plans, "plan_main").expenses.events[0].spendingType, "hybrid");
});
