// On a ProjectionLab 5 account (Plugin API contract 2), ProjectionLab has
// no restoreProgress, so restore_progress and a rollback of a snapshot
// holding progress refuse with WRITE_NOT_SUPPORTED, dry run included, before
// they preview, snapshot, or write anything. The other writes are allowed;
// test/v5-plan-writes.test.mjs, test/v5-account-writes.test.mjs and
// test/v5-settings-writes.test.mjs cover them.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-refusal-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { CONTRACT_2_WRITES } = await import("../dist/layout.js");
const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");
const { registerUpdatePlanSettingsTool } = await import("../dist/tools/updatePlanSettings.js");
const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

/** A ProjectionLab 5 bridge that records every call it receives. */
function v5Bridge() {
  const calls = [];
  const record = (name) => async () => {
    calls.push(name);
  };
  const bridge = {
    calls,
    async apiContract() {
      calls.push("apiContract");
      return 2;
    },
    async exportData() {
      calls.push("exportData");
      return v5Export();
    },
    updateAccount: record("updateAccount"),
    restorePlans: record("restorePlans"),
    restorePlansIfUnchanged: record("restorePlansIfUnchanged"),
    restoreCurrentFinances: record("restoreCurrentFinances"),
    restoreProgress: record("restoreProgress"),
    restoreSettings: record("restoreSettings"),
  };
  return bridge;
}

/** A snapshot store holding one v5 snapshot of every section, recording creates. */
function snapshotStore() {
  const created = [];
  const snap = {
    id: "snap-v5",
    timestamp: new Date(0).toISOString(),
    operation: "test",
    sections: ["currentFinances", "plans", "settings", "progress"],
    layout: "v5",
    data: {
      currentFinances: v5Export().documents.currentFinances,
      plans: v5Export().documents.plans,
      settings: {},
      progress: {},
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

const calls = {
  projectionlab_restore_progress: { progress: {} },
  projectionlab_rollback: { snapshotId: "snap-v5" },
};

test("CONTRACT_2_WRITES allows every write method but restoreProgress", () => {
  assert.deepEqual(
    [...CONTRACT_2_WRITES],
    ["restorePlans", "updateAccount", "restoreCurrentFinances", "restoreSettings"],
  );
});

for (const confirm of [false, true]) {
  for (const [name, input] of Object.entries(calls)) {
    test(`${name} refuses on contract 2 before any preview or snapshot (confirm: ${confirm})`, async () => {
      const bridge = v5Bridge();
      const snapshots = snapshotStore();
      const handler = register(bridge, snapshots).get(name);
      assert.ok(handler, name);
      const result = JSON.parse((await handler({ ...input, confirm })).content[0].text);
      assert.equal(result.error, "WRITE_NOT_SUPPORTED", JSON.stringify(result));
      assert.equal(result.message, "ProjectionLab 5 removed restoreProgress");
      assert.match(result.suggestion, /Restore in the ProjectionLab app/);
      assert.match(result.suggestion, /Nothing was written/);
      assert.deepEqual(snapshots.created, []);
      // Rollback reads the export to check the snapshot's layout first;
      // every other tool refuses before reading anything.
      const expected = name === "projectionlab_rollback" ? ["exportData", "apiContract"] : ["apiContract"];
      assert.deepEqual(bridge.calls, expected);
    });
  }
}
