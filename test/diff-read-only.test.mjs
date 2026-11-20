// projectionlab_diff works while writes are disabled: with plan edits turned
// off in the extension it still diffs a snapshot against the live export and saves nothing, while
// the write path (projectionlab_rollback) refuses the same call.

import assert from "node:assert/strict";
import test from "node:test";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asV5Export } from "./helpers/v5-envelope.mjs";

process.env.PL_API_KEY = "test-api-key";
const SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-diff-readonly-")),
  "snapshots",
);
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const { registerDiffTool } = await import("../dist/tools/diff.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { SnapshotManager } = await import("../dist/snapshot.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

const text = (result) => JSON.parse(result.content[0].text);

test("diff runs with plan edits turned off and saves nothing", async () => {
  const snapshots = new SnapshotManager();
  const saved = await snapshots.create("updatePlanSection", ["plans"], {
    plans: [
      {
        id: "p1",
        name: "Retire at 55",
        lastUpdated: 100,
        income: { events: [{ id: "i1", name: "Salary", amount: 100000 }] },
        expenses: { events: [] },
        milestones: [],
      },
    ],
  });

  const state = {
    plans: [
      {
        id: "p1",
        name: "Retire at 55",
        lastUpdated: 500,
        income: {
          events: [
            { id: "i1", name: "Salary", amount: 105000 },
            { id: "i2", name: "Pension", amount: 5000 },
          ],
        },
        expenses: { events: [] },
        milestones: [],
      },
    ],
  };
  const bridge = {
    writes: [],
    async editAccess() {
      return "disabled";
    },
    async exportData() {
      return asV5Export(structuredClone(state));
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.plans = structuredClone(plans);
    },
  };

  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);

  const out = text(
    await server.tools.get("projectionlab_diff").handler({
      from: { nBack: 1 },
      planIdentifier: "Retire at 55",
    }),
  );
  assert.equal(out.changed, true);
  assert.deepEqual(out.sections.plans.changedPlans[0].sections.income.added, [
    "Pension",
  ]);
  assert.deepEqual(
    out.sections.plans.changedPlans[0].sections.income.modified,
    [{ name: "Salary", id: "i1", changes: { amount: "100000 → 105000" } }],
  );

  assert.deepEqual(bridge.writes, [], "diff must not write");
  assert.deepEqual(readdirSync(SNAPSHOT_DIR).sort(), [`${saved.id}.json`]);

  // The same read-only mode that lets diff through blocks the write tool.
  const rollback = text(
    await server.tools
      .get("projectionlab_rollback")
      .handler({ nBack: 1, confirm: false }),
  );
  assert.equal(rollback.error, "READ_ONLY_MODE");
});
