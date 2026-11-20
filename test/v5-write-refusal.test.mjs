// The writes ProjectionLab 5 offers, and the refusal of every write on a
// ProjectionLab 4 page (a Plugin API with no version) before it previews,
// snapshots, or writes anything. The allowed writes are covered by
// test/v5-plan-writes.test.mjs, test/v5-account-writes.test.mjs and
// test/v5-settings-writes.test.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-refusal-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { CONTRACT_2_WRITES, projectionLab4Error } = await import("../dist/layout.js");
const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");
const { registerUpdatePlanSettingsTool } = await import("../dist/tools/updatePlanSettings.js");
const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

/**
 * A ProjectionLab 4 page: its export has the ProjectionLab 4 shape and its
 * Plugin API reports no version. Every call is recorded.
 */
function v4PageBridge() {
  const calls = [];
  const record = (name) => async () => {
    calls.push(name);
  };
  return {
    calls,
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      calls.push("apiContract");
      throw projectionLab4Error();
    },
    async exportData() {
      calls.push("exportData");
      return { meta: { version: "4.6.0" }, today: { savingsAccounts: [] }, plans: [], settings: {} };
    },
    updateAccount: record("updateAccount"),
    restorePlans: record("restorePlans"),
    restorePlansIfUnchanged: record("restorePlansIfUnchanged"),
    restoreCurrentFinances: record("restoreCurrentFinances"),
    restoreSettings: record("restoreSettings"),
  };
}

/** A snapshot store holding one v5 snapshot, recording creates. */
function snapshotStore() {
  const created = [];
  const snap = {
    id: "snap-v5",
    timestamp: new Date(0).toISOString(),
    operation: "test",
    sections: ["currentFinances", "plans", "settings"],
    layout: "v5",
    data: {
      currentFinances: v5Export().documents.currentFinances,
      plans: v5Export().documents.plans,
      settings: v5Export().documents.settings,
    },
  };
  return {
    created,
    async create(...args) {
      created.push(args);
      return { id: "never" };
    },
    async get() {
      return structuredClone(snap);
    },
    async list() {
      return [structuredClone(snap)];
    },
  };
}

function register(bridge, snapshots) {
  const tools = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      tools.set(name, handler);
    },
  };
  registerUpdateAccountTool(server, bridge, snapshots);
  registerUpdatePlanSettingsTool(server, bridge, snapshots);
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerClonePlanTool(server, bridge, snapshots);
  registerDeletePlanTool(server, bridge, snapshots);
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);
  return tools;
}

const WRITES = ["updateAccount", "restorePlans", "restorePlansIfUnchanged", "restoreCurrentFinances", "restoreSettings"];

const calls = {
  projectionlab_update_account: { accountId: "acct_brokerage", data: { balance: 1 }, force: false },
  projectionlab_update_plan_settings: { planIdentifier: "plan_main", changes: { name: "Renamed" } },
  projectionlab_clone_plan: { sourcePlanIdentifier: "plan_main", newName: "Copy" },
  projectionlab_delete_plan: { planIdentifier: "plan_early" },
  projectionlab_restore_current_finances: { currentFinances: v5Export().documents.currentFinances },
  projectionlab_restore_plans: { plans: v5Export().documents.plans },
  projectionlab_restore_settings: { settings: v5Export().documents.settings },
  projectionlab_rollback: { snapshotId: "snap-v5" },
};

test("CONTRACT_2_WRITES lists the four writes ProjectionLab 5 offers", () => {
  assert.deepEqual(
    [...CONTRACT_2_WRITES],
    ["restorePlans", "updateAccount", "restoreCurrentFinances", "restoreSettings"],
  );
});

test("no restore_progress tool is registered", () => {
  const tools = register(v4PageBridge(), snapshotStore());
  assert.equal(tools.has("projectionlab_restore_progress"), false);
  assert.ok(tools.has("projectionlab_restore_settings"));
});

for (const confirm of [false, true]) {
  for (const [name, input] of Object.entries(calls)) {
    test(`${name} refuses a ProjectionLab 4 page before any snapshot or write (confirm: ${confirm})`, async () => {
      const bridge = v4PageBridge();
      const snapshots = snapshotStore();
      const handler = register(bridge, snapshots).get(name);
      assert.ok(handler, name);
      const result = JSON.parse((await handler({ ...input, confirm })).content[0].text);
      assert.equal(result.error, "UNSUPPORTED_API_VERSION", JSON.stringify(result));
      assert.match(result.suggestion, /Nothing was (read or )?written/);
      assert.deepEqual(snapshots.created, []);
      assert.deepEqual(bridge.calls.filter((c) => WRITES.includes(c)), []);
    });
  }
}
