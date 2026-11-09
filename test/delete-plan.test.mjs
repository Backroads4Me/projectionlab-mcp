// Exact-ID lookup, refusals, snapshot-before-write and post-write
// verification for projectionlab_delete_plan, against an in-memory bridge
// that behaves like ProjectionLab: it re-stamps each plan's lastUpdated when
// plans are restored.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-delete-plan-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const {
  selectPlanForDeletion,
  verifyPlanDeletion,
  withoutPlan,
} = await import("../dist/deletePlan.js");
const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { config } = await import("../dist/config.js");
const { SnapshotManager } = await import("../dist/snapshot.js");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      active: true,
      lastUpdated: 100,
      income: { events: [{ id: "i1", name: "Salary" }] },
      expenses: { events: [{ id: "e1", name: "Living" }] },
      milestones: [{ id: "m1", name: "Retire" }],
    },
    {
      id: "p2",
      name: "Work forever",
      active: false,
      lastUpdated: 200,
      income: { events: [] },
      expenses: { events: [{ id: "e2", name: "Living" }, { id: "e3", name: "Travel" }] },
      milestones: [],
    },
  ];
}

function fakeBridge(initial, opts = {}) {
  let stamp = 1000;
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: [],
    exportCalls: 0,
    async exportData() {
      bridge.exportCalls++;
      // Simulate a save in the ProjectionLab UI between the tool's read
      // and its pre-write conflict check.
      if (opts.saveOnSecondRead && bridge.exportCalls === 2) {
        state.plans[0].lastUpdated = 999;
      }
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes.push("plans");
      if (opts.dropWrites) return;
      // ProjectionLab saves each plan and re-stamps it.
      state.plans = structuredClone(plans).map((p) => ({ ...p, lastUpdated: ++stamp }));
    },
  };
  return bridge;
}

function register(bridge) {
  const server = fakeServer();
  registerDeletePlanTool(server, bridge, new SnapshotManager());
  return server.tools.get("projectionlab_delete_plan").handler;
}

function text(result) {
  return JSON.parse(result.content[0].text);
}

test("selectPlanForDeletion takes an exact id only", () => {
  const plans = samplePlans();
  assert.equal(selectPlanForDeletion(plans, "p2").name, "Work forever");

  for (const name of ["Work forever", "work", "Retire at 55"]) {
    assert.throws(
      () => selectPlanForDeletion(plans, name),
      (err) => {
        assert.equal(err.code, "INVALID_INPUT");
        assert.match(err.message, /exact plan ID/);
        return true;
      },
      `name match "${name}" must be refused`,
    );
  }
  assert.throws(() => selectPlanForDeletion(plans, "nope"), { code: "INVALID_INPUT" });
});

test("selectPlanForDeletion allows deleting a plan carrying active: true", () => {
  const plans = samplePlans();
  // p1 has active: true; deleting it is allowed
  assert.equal(selectPlanForDeletion(plans, "p1").name, "Retire at 55");
});

test("selectPlanForDeletion refuses the last remaining plan", () => {
  const onlyActive = [{ id: "solo", name: "Alone", active: true }];
  assert.throws(
    () => selectPlanForDeletion(onlyActive, "solo"),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      assert.match(err.message, /only plan/);
      return true;
    },
  );
  const only = [{ id: "solo", name: "Alone", active: false }];
  assert.throws(
    () => selectPlanForDeletion(only, "solo"),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      assert.match(err.message, /only plan/);
      return true;
    },
  );

  // Malformed entries are not plans, so "solo" is still the only one.
  const padded = [null, 42, "junk", { id: "solo", name: "Alone", active: false }];
  assert.throws(
    () => selectPlanForDeletion(padded, "solo"),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      assert.match(err.message, /only plan/);
      return true;
    },
  );
});

test("withoutPlan removes exactly the plan with that id", () => {
  const plans = samplePlans();
  assert.deepEqual(
    withoutPlan(plans, "p2").map((p) => p.id),
    ["p1"],
  );
  assert.deepEqual(withoutPlan(plans, "missing"), plans);
});


test("verifyPlanDeletion accepts a clean delete across re-stamping", () => {
  const before = samplePlans();
  const after = [structuredClone(before[0])];
  after[0].lastUpdated = 5555;
  assert.deepEqual(verifyPlanDeletion(before, after, "p2"), []);
});

test("verifyPlanDeletion reports missing, modified, resurrection and count changes", () => {
  const before = samplePlans();

  const kept = structuredClone(before);
  assert.ok(
    verifyPlanDeletion(before, kept, "p2").some((p) => p.includes("still present")),
  );

  assert.ok(
    verifyPlanDeletion(before, [], "p2").some((p) => p.includes("plan p1 is missing")),
  );

  const modified = structuredClone(before);
  modified[0].name = "Renamed";
  assert.ok(
    verifyPlanDeletion(before, [modified[0]], "p2").some((p) => p.includes("plan p1 was modified")),
  );

  const withSimKeyAndMeta = structuredClone(before);
  withSimKeyAndMeta[0].simKey = 999;
  withSimKeyAndMeta[0].meta = { runKey: 123, yearlySummary: { endAge: 90 } };
  // Changes to simKey and meta on untouched plans are ignored
  assert.deepEqual(verifyPlanDeletion(before, [withSimKeyAndMeta[0]], "p2"), []);

  const duplicated = [structuredClone(before[0]), structuredClone(before[0])];
  assert.ok(
    verifyPlanDeletion(before, duplicated, "p2").some((p) =>
      p.includes("plan count is 2, expected 1"),
    ),
  );
});

test("verifyPlanDeletion reports a kept plan whose simKey or stamp is lost or goes backwards", () => {
  const before = samplePlans();
  before[0].simKey = 7;

  const noKey = structuredClone(before[0]);
  delete noKey.simKey;
  assert.deepEqual(verifyPlanDeletion(before, [noKey], "p2"), ["plan p1 lost its simKey"]);

  const older = structuredClone(before[0]);
  older.lastUpdated = before[0].lastUpdated - 1;
  assert.deepEqual(verifyPlanDeletion(before, [older], "p2"), [
    `plan p1 lastUpdated moved backwards from ${before[0].lastUpdated} to ${older.lastUpdated}`,
  ]);

  const noStamp = structuredClone(before[0]);
  delete noStamp.lastUpdated;
  assert.deepEqual(verifyPlanDeletion(before, [noStamp], "p2"), [
    "plan p1 lost its lastUpdated",
  ]);
});

test("the delete tool requires a non-blank planId at the schema", () => {
  const server = fakeServer();
  registerDeletePlanTool(server, fakeBridge({ plans: samplePlans() }), {
    create: async () => ({ id: "unused" }),
  });
  const schema = server.tools.get("projectionlab_delete_plan").definition.inputSchema;
  assert.equal(schema.planId.safeParse("").success, false);
  assert.equal(schema.planId.safeParse("  ").success, false);
  assert.equal(schema.planId.safeParse("p2").success, true);
});

test("delete_plan previews without writing by default", async () => {
  const bridge = fakeBridge({ plans: samplePlans() });
  const result = await register(bridge)({ planId: "p2", confirm: false });
  const out = text(result);

  assert.equal(bridge.writes.length, 0);
  assert.equal(out.dryRun, true);
  assert.equal(out.operation, "deletePlan");
  assert.deepEqual(out.plan, { name: "Work forever", id: "p2" });
  assert.equal(out.planCount, "2 → 1");
  assert.deepEqual(out.eventCounts, {
    income: 0,
    expenses: 2,
    accounts: 0,
    assets: 0,
    milestones: 0,
    priorities: 0,
  });
  assert.match(out.warning, /confirm=true/);
});

test("delete_plan allows deleting a plan carrying active: true and refuses a name match", async () => {
  const bridge = fakeBridge({ plans: samplePlans() });
  const handler = register(bridge);

  const active = await handler({ planId: "p1", confirm: false });
  assert.equal(active.isError, undefined);
  assert.equal(text(active).plan.id, "p1");

  const byName = await handler({ planId: "Work forever", confirm: true });
  assert.equal(byName.isError, true);
  assert.equal(text(byName).error, "INVALID_INPUT");

  assert.equal(bridge.writes.length, 0);
});

test("delete_plan confirmed removes the plan, verifies, and rollback restores it", async () => {
  const bridge = fakeBridge({ plans: samplePlans() });
  const server = fakeServer();
  const snapshots = new SnapshotManager();
  registerDeletePlanTool(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);

  const out = text(
    await server.tools
      .get("projectionlab_delete_plan")
      .handler({ planId: "p2", confirm: true }),
  );

  assert.equal(out.success, true);
  assert.equal(out.verified, true);
  assert.equal(out.verificationProblems, undefined);
  assert.match(out.snapshotId, UUID_RE);
  assert.match(out.message, /projectionlab_rollback/);
  assert.deepEqual(
    bridge.state.plans.map((p) => p.id),
    ["p1"],
  );
  assert.equal(bridge.state.plans[0].active, true);

  const rolled = text(
    await server.tools
      .get("projectionlab_rollback")
      .handler({ snapshotId: out.snapshotId, confirm: true }),
  );

  assert.equal(rolled.verified, true);
  assert.deepEqual(rolled.restoredSections, ["plans"]);
  assert.deepEqual(
    bridge.state.plans.map((p) => p.id),
    ["p1", "p2"],
  );
  const restored = bridge.state.plans.find((p) => p.id === "p2");
  assert.equal(restored.name, "Work forever");
  assert.equal(restored.active, false);
  assert.deepEqual(
    restored.expenses.events.map((e) => e.id),
    ["e2", "e3"],
  );
});

test("delete_plan refuses with PLAN_CONFLICT when a plan was saved meanwhile", async () => {
  const bridge = fakeBridge({ plans: samplePlans() }, { saveOnSecondRead: true });
  const result = await register(bridge)({ planId: "p2", confirm: true });

  assert.equal(result.isError, true);
  assert.equal(text(result).error, "PLAN_CONFLICT");
  assert.equal(bridge.writes.length, 0);
});

test("delete_plan reports verification problems but keeps the snapshot id", async () => {
  const bridge = fakeBridge({ plans: samplePlans() }, { dropWrites: true });
  const result = await register(bridge)({ planId: "p2", confirm: true });
  const out = text(result);

  assert.equal(out.success, true);
  assert.equal(out.verified, false);
  assert.ok(out.verificationProblems.some((p) => p.includes("still present")));
  assert.match(out.snapshotId, UUID_RE);
});

test("delete_plan respects PL_READ_ONLY before reading or writing", async () => {
  const bridge = fakeBridge({ plans: samplePlans() });
  const handler = register(bridge);

  config.readOnly = true;
  try {
    const result = await handler({ planId: "p2", confirm: true });
    assert.equal(result.isError, true);
    assert.equal(text(result).error, "READ_ONLY_MODE");
    assert.equal(bridge.exportCalls, 0);
    assert.equal(bridge.writes.length, 0);
  } finally {
    config.readOnly = false;
  }
});
