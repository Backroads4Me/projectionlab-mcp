// projectionlab_diff plan-to-plan mode: field-level comparison of two
// different plans, so a plan rebuilt by hand can be checked against the
// original. The stored ids of both plans and of their events are ignored, a
// reference to another event of the same plan compares by the event it names,
// and pathsOnly reports the differing paths with no values.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
const SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-diffplans-")),
  "snapshots",
);
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const { registerDiffTool } = await import("../dist/tools/diff.js");
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

function fakeBridge(state) {
  const bridge = {
    state,
    exportCalls: 0,
    async exportData() {
      bridge.exportCalls++;
      return structuredClone(bridge.state);
    },
  };
  return bridge;
}

function freshSnapshots() {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  return new SnapshotManager();
}

/**
 * One plan as ProjectionLab stores it. `prefix` namespaces every id it holds,
 * so two copies of the same content carry unrelated ids the way two plans
 * built separately do. Its milestones and accounts are referenced by those
 * ids: an income source ends at the milestone, an expense starts at it, and a
 * priority names the plan's own account. `accountId` on the account is a
 * Current Finances id, which every plan of the account book shares.
 */
function planOf(prefix, name) {
  const milestoneId = `${prefix}-m1`;
  return {
    id: `${prefix}-plan`,
    name,
    lastUpdated: 100,
    simKey: 1,
    meta: { runKey: 1 },
    retirementAge: 55,
    endAge: 92,
    milestones: [{ id: milestoneId, name: "Retire", year: 2041 }],
    income: {
      events: [
        {
          id: `${prefix}-i1`,
          name: "Salary",
          amount: 100000,
          end: { type: "milestone", value: milestoneId },
        },
        { id: `${prefix}-i2`, name: "Rental", amount: 12000 },
      ],
    },
    expenses: {
      events: [
        {
          id: `${prefix}-e1`,
          name: "Living",
          amount: 60000,
          start: { type: "milestone", value: milestoneId },
        },
      ],
    },
    accounts: {
      events: [
        {
          id: `${prefix}-a1`,
          name: "Checking",
          balance: 5000,
          accountId: "cf-acc-1",
        },
      ],
    },
    priorities: {
      events: [
        { id: `${prefix}-p1`, name: "Pay off house", accountId: `${prefix}-a1` },
      ],
    },
    variables: { inflation: 0.025 },
  };
}

function register(bridge, snapshots = freshSnapshots()) {
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  return (args) => server.tools.get("projectionlab_diff").handler(args);
}

/** Two plans with the same content and nothing in common among their ids. */
function sameContentPlans() {
  return [planOf("a", "Original"), planOf("b", "Rebuilt")];
}

const text = (result) => JSON.parse(result.content[0].text);

async function errorFor(diff, args) {
  const result = await diff(args);
  assert.equal(result.isError, true, JSON.stringify(result));
  return text(result);
}

test("two plans with different ids and the same content compare as equal", async () => {
  const [original, rebuilt] = sameContentPlans();
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({ planA: "Original", planB: "Rebuilt" }),
  );

  assert.equal(out.mode, "plans");
  assert.equal(out.changed, false);
  assert.deepEqual(out.planA, { id: "a-plan", name: "Original" });
  assert.deepEqual(out.planB, { id: "b-plan", name: "Rebuilt" });
  assert.equal(out.readFrom.source, "live");
  assert.ok(Date.parse(out.readFrom.readAt) > 0, out.readFrom.readAt);
  assert.match(out.message, /rebuilt by hand reads as unchanged/);
  assert.equal(out.changedSections, undefined);

  // Every event matched its counterpart, including the ones that point at the
  // milestone and at the plan's own account by id.
  const income = out.sections.income;
  assert.equal(income.kind, "events");
  assert.equal(income.count, "2 → 2");
  assert.equal(income.sameCount, 2);
  assert.equal(income.differentCount, 0);
  assert.equal(income.onlyInACount, 0);
  assert.equal(income.onlyInBCount, 0);
  assert.equal(out.sections.expenses.sameCount, 1);
  assert.equal(out.sections.milestones.sameCount, 1);
  assert.equal(out.sections.priorities.sameCount, 1);
  assert.equal(out.sections.variables.changed, false);
  assert.equal(out.planSettings.changed, false);

  // The plan fields that only say which plan an object is stay out of it.
  const json = JSON.stringify({
    sections: out.sections,
    planSettings: out.planSettings,
  });
  for (const field of ["lastUpdated", "simKey", "meta"]) {
    assert.equal(json.includes(field), false, `${field} leaked into the diff`);
  }
  assert.equal(json.includes("a-m1"), false, "a stored event id leaked");
  assert.equal(json.includes("a-plan"), false, "a stored plan id leaked");
});

test("a reference to the same-named milestone compares equal across plans", async () => {
  const [original, rebuilt] = sameContentPlans();
  // The rebuilt plan's milestone carries a different id, which the fixture
  // already guarantees; what matters is that both plans' events point at it by
  // their own plan's id.
  assert.equal(original.income.events[0].end.value, "a-m1");
  assert.equal(rebuilt.income.events[0].end.value, "b-m1");

  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({
      planA: "Original",
      planB: "Rebuilt",
      section: "income",
    }),
  );

  assert.equal(out.changed, false);
  assert.deepEqual(Object.keys(out.sections), ["income"]);
  assert.equal(out.sections.income.sameCount, 2);
});

test("a reference to a differently named milestone reads as a difference", async () => {
  const [original, rebuilt] = sameContentPlans();
  rebuilt.milestones[0].name = "Stop working";
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({
      planA: "Original",
      planB: "Rebuilt",
      section: "income",
    }),
  );

  const income = out.sections.income;
  assert.equal(out.changed, true);
  assert.equal(income.differentCount, 1);
  assert.deepEqual(income.different, [
    {
      name: "Salary",
      changes: {
        "end.value": '"@milestones:Retire" → "@milestones:Stop working"',
      },
    },
  ]);
});

test("an id that is not an event of the plan is compared as it is", async () => {
  const [original, rebuilt] = sameContentPlans();
  // Current Finances ids belong to the account book, not to a plan, so a plan
  // pointing at another account is a real difference and stays readable.
  rebuilt.accounts.events[0].accountId = "cf-acc-2";
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({
      planA: "Original",
      planB: "Rebuilt",
      section: "accounts",
    }),
  );

  assert.deepEqual(out.sections.accounts.different, [
    { name: "Checking", changes: { accountId: '"cf-acc-1" → "cf-acc-2"' } },
  ]);
});

test("an event only one plan carries is reported against that plan", async () => {
  const [original, rebuilt] = sameContentPlans();
  rebuilt.income.events.pop();
  original.expenses.events.push({
    id: "a-e2",
    name: "Boat",
    amount: 9000,
  });
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({ planA: "Original", planB: "Rebuilt" }),
  );

  const income = out.sections.income;
  assert.equal(income.count, "2 → 1");
  assert.equal(income.onlyInACount, 1);
  assert.deepEqual(income.onlyInA, ["Rental"]);
  assert.equal(income.onlyInBCount, 0);
  assert.equal(income.sameCount, 1);

  const expenses = out.sections.expenses;
  assert.equal(expenses.onlyInACount, 1);
  assert.deepEqual(expenses.onlyInA, ["Boat"]);

  assert.deepEqual(out.changedSections.sort(), ["expenses", "income"]);
});

test("a plan setting that differs is reported outside the sections", async () => {
  const [original, rebuilt] = sameContentPlans();
  rebuilt.retirementAge = 57;
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const out = text(
    await register(bridge)({ planA: "Original", planB: "Rebuilt" }),
  );

  assert.equal(out.changed, true);
  assert.equal(out.changedSections, undefined);
  assert.deepEqual(out.planSettings, {
    kind: "fields",
    changed: true,
    changes: { retirementAge: "55 → 57" },
  });
});

test("pathsOnly reports the differing paths and never a value", async () => {
  const [original, rebuilt] = sameContentPlans();
  const SENTINEL = "PRIVATE-SENTINEL-note-value";
  rebuilt.expenses.events[0].note = SENTINEL;
  rebuilt.expenses.events[0].amount = 61000;
  rebuilt.retirementAge = 57;
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const diff = register(bridge);

  // The sentinel is a value the diff would otherwise print, so its absence in
  // the paths-only output means something.
  const withValues = (await diff({ planA: "Original", planB: "Rebuilt" }))
    .content[0].text;
  assert.ok(withValues.includes(SENTINEL), "sentinel never reached the output");

  const json = (
    await diff({ planA: "Original", planB: "Rebuilt", pathsOnly: true })
  ).content[0].text;
  assert.equal(json.includes(SENTINEL), false, json);
  assert.equal(json.includes("61000"), false, json);

  const out = JSON.parse(json);
  assert.equal(out.pathsOnly, true);
  assert.equal(out.changed, true);
  assert.deepEqual(out.sections.expenses.different, [
    { name: "Living", paths: ["amount", "note"] },
  ]);
  assert.deepEqual(out.planSettings, {
    kind: "fields",
    changed: true,
    paths: ["retirementAge"],
  });
});

test("pathsOnly also hides values in the points-in-time mode", async () => {
  const snapshots = freshSnapshots();
  const [original] = sameContentPlans();
  const saved = await snapshots.create("updatePlanSection", ["plans"], {
    plans: [original],
  });
  const edited = structuredClone(original);
  edited.income.events[0].note = "PRIVATE-SENTINEL-live-value";
  const bridge = fakeBridge({ plans: [edited], today: {} });

  const json = (
    await register(bridge, snapshots)({
      from: { snapshotId: saved.id },
      pathsOnly: true,
    })
  ).content[0].text;
  assert.equal(json.includes("PRIVATE-SENTINEL-live-value"), false, json);

  const out = JSON.parse(json);
  assert.equal(out.changed, true);
  assert.deepEqual(out.sections.plans.changedPlans[0].sections.income.modified, [
    { name: "Salary", paths: ["note"] },
  ]);
});

test("both plans can come from one snapshot, without reading the browser", async () => {
  const snapshots = freshSnapshots();
  const [original, rebuilt] = sameContentPlans();
  const saved = await snapshots.create("updatePlanSection", ["plans"], {
    plans: [original, rebuilt],
  });
  const bridge = fakeBridge({ plans: [], today: {} });

  const out = text(
    await register(bridge, snapshots)({
      planA: "Original",
      planB: "Rebuilt",
      from: { snapshotId: saved.id },
    }),
  );

  assert.equal(out.changed, false);
  assert.equal(out.readFrom.source, "snapshot");
  assert.equal(out.readFrom.snapshotId, saved.id);
  assert.deepEqual(out.readFrom.sections, ["plans"]);
  assert.equal(bridge.exportCalls, 0);
});

test("a snapshot with no plans data says so", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshots.create("restoreSettings", ["settings"], {
    settings: { theme: "dark" },
  });
  const bridge = fakeBridge({ plans: sameContentPlans(), today: {} });

  const out = await errorFor(register(bridge, snapshots), {
    planA: "Original",
    planB: "Rebuilt",
    from: { snapshotId: saved.id },
  });
  assert.equal(out.error, "INVALID_INPUT");
  assert.match(out.message, /holds no plans data/);
});

test("planA and planB cannot borrow arguments from the points-in-time mode", async () => {
  const snapshots = freshSnapshots();
  const [original, rebuilt] = sameContentPlans();
  const saved = await snapshots.create("updatePlanSection", ["plans"], {
    plans: [original, rebuilt],
  });
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const diff = register(bridge, snapshots);

  const withTo = await errorFor(diff, {
    planA: "Original",
    planB: "Rebuilt",
    to: { snapshotId: saved.id },
  });
  assert.equal(withTo.error, "INVALID_INPUT");
  assert.match(withTo.message, /planA and planB compare two plans, and to belongs/);
  assert.match(withTo.suggestion, /Drop to/);

  const withPlanIdentifier = await errorFor(diff, {
    planA: "Original",
    planB: "Rebuilt",
    planIdentifier: "Original",
  });
  assert.equal(withPlanIdentifier.error, "INVALID_INPUT");
  assert.match(
    withPlanIdentifier.message,
    /planA and planB compare two plans, and planIdentifier belongs/,
  );

  const missingB = await errorFor(diff, { planA: "Original" });
  assert.equal(missingB.error, "INVALID_INPUT");
  assert.match(missingB.message, /planB is missing/);

  const missingA = await errorFor(diff, { planB: "Rebuilt" });
  assert.equal(missingA.error, "INVALID_INPUT");
  assert.match(missingA.message, /planA is missing/);

  const nothing = await errorFor(diff, {});
  assert.equal(nothing.error, "INVALID_INPUT");
  assert.match(nothing.message, /No from snapshot selector supplied/);
  assert.match(nothing.suggestion, /planA and planB together/);
});

test("a plan-to-plan call refuses to compare a plan with itself", async () => {
  const [original, rebuilt] = sameContentPlans();
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });

  const out = await errorFor(register(bridge), {
    planA: "Original",
    planB: "original",
  });
  assert.equal(out.error, "INVALID_INPUT");
  assert.match(out.message, /both name the same plan \("Original"\)/);
});

test("a plan name that matches nothing names the side that failed", async () => {
  const [original, rebuilt] = sameContentPlans();
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });

  const out = await errorFor(register(bridge), {
    planA: "Original",
    planB: "no such plan",
  });
  assert.equal(out.error, "INVALID_INPUT");
  assert.match(out.message, /No plan matching "no such plan" found for planB/);
  assert.match(out.suggestion, /planB's values are reported second/);
  assert.match(out.suggestion, /"Original"/);
});

test("the plan-to-plan mode reads the live app once and writes nothing", async () => {
  const [original, rebuilt] = sameContentPlans();
  const bridge = fakeBridge({ plans: [original, rebuilt], today: {} });
  const snapshots = freshSnapshots();
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);

  const { annotations } = server.tools.get("projectionlab_diff").definition;
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.equal(annotations.openWorldHint, false);

  await server.tools
    .get("projectionlab_diff")
    .handler({ planA: "Original", planB: "Rebuilt" });
  assert.equal(bridge.exportCalls, 1);
  assert.deepEqual(await snapshots.list(), []);
});
