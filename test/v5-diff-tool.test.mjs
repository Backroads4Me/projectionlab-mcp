// projectionlab_diff: ProjectionLab 5 layout support and layout mismatch checks.
// Validates v5 point-in-time diffing, account matching by id with v5 amount names,
// plan event matching by id within sections, settings and accountHistory diffing,
// plan-to-plan diffing on v5, redaction of v5 secrets, refusal of cross-layout diffs,
// and v4 regression behavior.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
const SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-v5-diff-")),
  "snapshots",
);
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const { registerDiffTool } = await import("../dist/tools/diff.js");
const { SnapshotManager } = await import("../dist/snapshot.js");
const {
  diffCurrentFinances,
  diffPlanList,
  diffPlanPair,
  createDiffBudget,
} = await import("../dist/diff.js");

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

function register(bridge, snapshots) {
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  return (args) => server.tools.get("projectionlab_diff").handler(args);
}

const text = (result) => JSON.parse(result.content[0].text);

async function errorFor(diff, args) {
  const result = await diff(args);
  assert.equal(result.isError, true, JSON.stringify(result));
  return text(result);
}

test("v5 diff against live export: accounts by id, events by id, settings and accountHistory", async () => {
  const snapshots = freshSnapshots();
  const baseExport = v5Export();

  // Create a snapshot representing the baseline state
  const snapshotData = {
    plans: structuredClone(baseExport.documents.plans),
    currentFinances: structuredClone(baseExport.documents.currentFinances),
    settings: structuredClone(baseExport.documents.settings),
    accountHistory: structuredClone(baseExport.documents.accountHistory),
  };
  const saved = await snapshots.create(
    "testBaseline",
    ["plans", "currentFinances", "settings", "accountHistory"],
    snapshotData,
    "v5",
  );

  // Prepare modified live v5 state
  const live = v5Export();
  const docs = live.documents;

  // 1. Current finances changes:
  // - acct_brokerage: balance changed (50000 -> 55000)
  docs.currentFinances.accounts.acct_brokerage.balance = 55_000;
  // - asset_land: value changed (120000 -> 130000)
  docs.currentFinances.accounts.asset_land.value = 130_000;
  // - acct_old_savings: removed
  delete docs.currentFinances.accounts.acct_old_savings;
  // - acct_new: added
  docs.currentFinances.accounts.acct_new = {
    id: "acct_new",
    name: "High Yield Savings",
    kind: "account",
    type: "savings",
    balance: 10_000,
    costBasis: 0,
  };

  // 2. Plans changes:
  // - plan_main: rename Salary event to "Senior Salary" (same id: plan_main_ev_salary)
  const mainPlan = docs.plans.find((p) => p.id === "plan_main");
  const salaryEvent = mainPlan.income.events.find(
    (e) => e.id === "plan_main_ev_salary",
  );
  salaryEvent.name = "Senior Salary";
  // Modify Living expense amount (50000 -> 55000)
  const livingEvent = mainPlan.expenses.events.find(
    (e) => e.id === "plan_main_ev_living",
  );
  livingEvent.amount = 55_000;
  // Add a new income event
  mainPlan.income.events.push({
    id: "plan_main_ev_consulting",
    kind: "income",
    type: "other",
    name: "Consulting",
    amount: 15_000,
  });

  // - plan_early removed, plan_new added
  docs.plans = [
    mainPlan,
    {
      schema: 5,
      id: "plan_new",
      name: "Coast FIRE",
      income: { events: [] },
      expenses: { events: [] },
      milestones: [],
    },
  ];

  // 3. Settings changed
  docs.settings.seenVersion = "5.1.0";

  // 4. Account history changed
  docs.accountHistory.acct_brokerage["2026"] = {
    schema: 5,
    kind: "account",
    balance: { acct_brokerage: 55_000 },
  };

  const bridge = fakeBridge(live);
  const diff = register(bridge, snapshots);
  const out = text(await diff({ from: { snapshotId: saved.id } }));

  assert.equal(out.from.source, "snapshot");
  assert.equal(out.to.source, "live");
  assert.equal(out.changed, true);
  assert.deepEqual(out.comparedSections, [
    "plans",
    "currentFinances",
    "settings",
    "accountHistory",
  ]);

  // Verify accounts diff uses v5 amount property names and matches by id
  const accts = out.sections.currentFinances.collections.accounts;
  assert.equal(accts.kind, "rows");
  assert.equal(accts.changed, true);
  assert.equal(accts.addedCount, 1);
  assert.deepEqual(accts.added, [{ id: "acct_new", name: "High Yield Savings" }]);
  assert.equal(accts.removedCount, 1);
  assert.deepEqual(accts.removed, [{ id: "acct_old_savings", name: "Old Savings" }]);
  assert.equal(accts.modifiedCount, 2);

  const brokerageMod = accts.modified.find((m) => m.id === "acct_brokerage");
  assert.ok(brokerageMod);
  assert.equal(brokerageMod.changes.balance, "50000 → 55000");

  const landMod = accts.modified.find((m) => m.id === "asset_land");
  assert.ok(landMod);
  assert.equal(landMod.changes.value, "120000 → 130000");

  // Verify plans diff matches plans by id
  const plans = out.sections.plans;
  assert.equal(plans.planCount, "2 → 2");
  assert.equal(plans.addedCount, 1);
  assert.deepEqual(plans.added, [{ id: "plan_new", name: "Coast FIRE" }]);
  assert.equal(plans.removedCount, 1);
  assert.deepEqual(plans.removed, [{ id: "plan_early", name: "Retire Early" }]);
  assert.equal(plans.changedCount, 1);

  // In v5, renamed event matches by id and is reported as modified, not removed+added
  const changedMain = plans.changedPlans.find((p) => p.id === "plan_main");
  assert.ok(changedMain);
  const incomeDiff = changedMain.sections.income;
  assert.equal(incomeDiff.addedCount, 1);
  assert.deepEqual(incomeDiff.added, ["Consulting"]);
  assert.equal(incomeDiff.removedCount, 0); // Not removed!
  assert.equal(incomeDiff.modifiedCount, 1);
  assert.equal(incomeDiff.modified[0].name, "Senior Salary");
  assert.equal(incomeDiff.modified[0].changes.name, '"Salary" → "Senior Salary"');

  const expensesDiff = changedMain.sections.expenses;
  assert.equal(expensesDiff.modifiedCount, 1);
  assert.equal(expensesDiff.modified[0].changes.amount, "50000 → 55000");

  // Verify settings diff and apiKey redaction
  const settingsDiff = out.sections.settings;
  assert.equal(settingsDiff.changed, true);
  assert.equal(settingsDiff.changes.seenVersion, '"5.0.0" → "5.1.0"');
  // Plugin apiKey must not be exposed in settings diff
  assert.equal(JSON.stringify(out).includes("synthetic-plugin-key"), false);

  // Verify accountHistory diff
  const historyDiff = out.sections.accountHistory;
  assert.equal(historyDiff.changed, true);
});

test("v5 snapshot to snapshot diff", async () => {
  const snapshots = freshSnapshots();
  const baseExport = v5Export();

  const snap1 = await snapshots.create(
    "snap1",
    ["plans", "currentFinances"],
    {
      plans: structuredClone(baseExport.documents.plans),
      currentFinances: structuredClone(baseExport.documents.currentFinances),
    },
    "v5",
  );

  const edited = v5Export();
  edited.documents.currentFinances.accounts.acct_brokerage.balance = 99_000;

  const snap2 = await snapshots.create(
    "snap2",
    ["plans", "currentFinances"],
    {
      plans: structuredClone(edited.documents.plans),
      currentFinances: structuredClone(edited.documents.currentFinances),
    },
    "v5",
  );

  const bridge = fakeBridge(v5Export());
  const diff = register(bridge, snapshots);
  const out = text(
    await diff({
      from: { snapshotId: snap1.id },
      to: { snapshotId: snap2.id },
    }),
  );

  assert.equal(out.from.source, "snapshot");
  assert.equal(out.to.source, "snapshot");
  assert.equal(out.changed, true);
  const acctMod = out.sections.currentFinances.collections.accounts.modified[0];
  assert.equal(acctMod.id, "acct_brokerage");
  assert.equal(acctMod.changes.balance, "50000 → 99000");
});

test("v5 plan-to-plan diff comparing two v5 plans", async () => {
  const baseExport = v5Export();
  const bridge = fakeBridge(baseExport);
  const snapshots = freshSnapshots();
  const diff = register(bridge, snapshots);

  // Unmodified plans have identical content (milestone token normalization works)
  const equalOut = text(
    await diff({
      planA: "Main Plan",
      planB: "Retire Early",
    }),
  );
  assert.equal(equalOut.changed, false);
  assert.equal(equalOut.planA.name, "Main Plan");
  assert.equal(equalOut.planB.name, "Retire Early");

  // Modify one event in Retire Early to verify differences are reported
  baseExport.documents.plans[1].income.events[0].amount = 120_000;
  const changedOut = text(
    await diff({
      planA: "Main Plan",
      planB: "Retire Early",
    }),
  );
  assert.equal(changedOut.changed, true);
  assert.equal(changedOut.changedSections[0], "income");
  const incomeDiff = changedOut.sections.income;
  assert.equal(incomeDiff.differentCount, 1);
  assert.equal(incomeDiff.different[0].name, "Salary");
  assert.equal(incomeDiff.different[0].changes.amount, "90000 → 120000");
});

test("refuses diff across different layouts with LAYOUT_MISMATCH", async () => {
  const snapshots = freshSnapshots();

  // Create a v4 snapshot
  const v4Snapshot = await snapshots.create(
    "v4Snap",
    ["plans"],
    {
      plans: [{ id: "p1", name: "V4 Plan" }],
      today: { investmentAccounts: [] },
    },
    "v4",
  );

  // Create a v5 snapshot
  const v5Snapshot = await snapshots.create(
    "v5Snap",
    ["plans"],
    {
      plans: [{ schema: 5, id: "p1", name: "V5 Plan" }],
    },
    "v5",
  );

  // 1. v4 snapshot against live v5
  const bridgeV5 = fakeBridge(v5Export());
  const diffOnV5 = register(bridgeV5, snapshots);
  const err1 = await errorFor(diffOnV5, {
    from: { snapshotId: v4Snapshot.id },
  });
  assert.equal(err1.error, "LAYOUT_MISMATCH");
  assert.match(err1.message, /v4/);
  assert.match(err1.message, /v5/);

  // 2. v5 snapshot against live v4
  const bridgeV4 = fakeBridge({
    plans: [{ id: "p1", name: "V4 Live" }],
    today: {},
  });
  const diffOnV4 = register(bridgeV4, snapshots);
  const err2 = await errorFor(diffOnV4, {
    from: { snapshotId: v5Snapshot.id },
  });
  assert.equal(err2.error, "LAYOUT_MISMATCH");

  // 3. v4 snapshot against v5 snapshot
  const err3 = await errorFor(diffOnV5, {
    from: { snapshotId: v4Snapshot.id },
    to: { snapshotId: v5Snapshot.id },
  });
  assert.equal(err3.error, "LAYOUT_MISMATCH");
});

test("v4 regression: plans list with schema: 5 and kind string diffed without layout uses v4 keying and does not throw", () => {
  const budget = createDiffBudget({});

  const beforePlans = [
    {
      schema: 5,
      id: "p1",
      name: "Retire Early",
      income: {
        events: [
          {
            id: "e1",
            schema: 5,
            kind: "income",
            name: "Old Salary",
            amount: 80000,
          },
        ],
      },
    },
  ];

  const afterPlans = [
    {
      schema: 5,
      id: "p1",
      name: "Retire Early",
      income: {
        events: [
          {
            id: "e1",
            schema: 5,
            kind: "income",
            name: "New Salary",
            amount: 80000,
          },
        ],
      },
    },
  ];

  // Must not throw even with schema: 5 and kind string present
  const result = diffPlanList(beforePlans, afterPlans, budget);

  assert.equal(result.changed, true);
  const planDiff = result.changedPlans[0];
  const incomeDiff = planDiff.sections.income;

  // With v4 name-plus-occurrence keying, renaming an event means old is removed and new is added
  assert.equal(incomeDiff.addedCount, 1);
  assert.deepEqual(incomeDiff.added, ["New Salary"]);
  assert.equal(incomeDiff.removedCount, 1);
  assert.deepEqual(incomeDiff.removed, ["Old Salary"]);
  assert.equal(incomeDiff.modifiedCount, 0);
});

test("v4 regression check: points-in-time and plan-to-plan behave as before on v4", async () => {
  const snapshots = freshSnapshots();

  const oldV4Plans = [
    {
      id: "p1",
      name: "Retire 55",
      income: {
        events: [{ id: "e1", name: "Salary", amount: 80000 }],
      },
    },
    {
      id: "p2",
      name: "Work Forever",
      income: {
        events: [{ id: "e2", name: "Salary", amount: 80000 }],
      },
    },
  ];

  const editedV4Plans = [
    {
      id: "p1",
      name: "Retire 55",
      income: {
        // In v4, renaming event means old is removed and new is added
        events: [{ id: "e1", name: "Senior Salary", amount: 80000 }],
      },
    },
    {
      id: "p2",
      name: "Work Forever",
      income: {
        events: [{ id: "e2", name: "Salary", amount: 80000 }],
      },
    },
  ];

  const v4TodayOld = {
    investmentAccounts: [
      { id: "inv1", name: "Brokerage", balance: 10000 },
    ],
  };

  const v4TodayNew = {
    investmentAccounts: [
      { id: "inv1", name: "Brokerage", balance: 15000 },
    ],
  };

  const savedV4 = await snapshots.create(
    "v4Baseline",
    ["plans", "currentFinances"],
    {
      plans: oldV4Plans,
      today: v4TodayOld,
    },
    "v4",
  );

  const bridge = fakeBridge({
    plans: editedV4Plans,
    today: v4TodayNew,
  });

  const diff = register(bridge, snapshots);
  const out = text(await diff({ from: { snapshotId: savedV4.id } }));

  assert.equal(out.changed, true);
  // In v4, event renaming produces added + removed (not modified)
  const planDiff = out.sections.plans.changedPlans[0];
  const incomeDiff = planDiff.sections.income;
  assert.equal(incomeDiff.addedCount, 1);
  assert.deepEqual(incomeDiff.added, ["Senior Salary"]);
  assert.equal(incomeDiff.removedCount, 1);
  assert.deepEqual(incomeDiff.removed, ["Salary"]);
  assert.equal(incomeDiff.modifiedCount, 0);

  // Current finances in v4 diffs collection investmentAccounts
  const invDiff = out.sections.currentFinances.collections.investmentAccounts;
  assert.equal(invDiff.modifiedCount, 1);
  assert.equal(invDiff.modified[0].changes.balance, "10000 → 15000");

  // Plan to plan on v4 works between two distinct plans
  const p2p = text(
    await diff({
      planA: "Retire 55",
      planB: "Work Forever",
    }),
  );
  // In v4, events match by name, so Senior Salary vs Salary are reported in onlyInA / onlyInB
  assert.equal(p2p.changed, true);
  assert.deepEqual(p2p.sections.income.onlyInA, ["Senior Salary"]);
  assert.deepEqual(p2p.sections.income.onlyInB, ["Salary"]);
});
