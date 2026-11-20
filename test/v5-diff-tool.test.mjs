// projectionlab_diff on ProjectionLab 5: point-in-time diffing, account
// matching by id with v5 amount names, plan event matching by id within
// sections, settings and accountHistory diffing, plan-to-plan diffing,
// redaction of v5 secrets, and refusal of a ProjectionLab 4 snapshot or
// export.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A snapshot on disk whose recorded layout is `recorded`, or absent when
 * `recorded` is undefined, as a ProjectionLab 4 server wrote it.
 */
async function legacySnapshot(snapshots, recorded) {
  const snap = await snapshots.create("v4Snap", ["plans"], {
    plans: [{ id: "p1", name: "V4 Plan" }],
  });
  const file = join(SNAPSHOT_DIR, `${snap.id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf-8"));
  if (recorded === undefined) delete stored.layout;
  else stored.layout = recorded;
  writeFileSync(file, JSON.stringify(stored));
  return snap;
}

for (const recorded of ["v4", undefined]) {
  test(`refuses a diff from or to a snapshot recording layout ${recorded}`, async () => {
    const snapshots = freshSnapshots();
    const legacy = await legacySnapshot(snapshots, recorded);
    const current = await snapshots.create("v5Snap", ["plans"], {
      plans: v5Export().documents.plans,
    });
    const diff = register(fakeBridge(v5Export()), snapshots);

    for (const args of [
      { from: { snapshotId: legacy.id } },
      { from: { snapshotId: legacy.id }, to: { snapshotId: current.id } },
      { from: { snapshotId: current.id }, to: { snapshotId: legacy.id } },
    ]) {
      const err = await errorFor(diff, args);
      assert.equal(err.error, "LAYOUT_MISMATCH", JSON.stringify(args));
      assert.match(err.message, /ProjectionLab 4/);
      assert.match(err.suggestion, /Compare snapshots taken from ProjectionLab 5/);
      assert.match(err.suggestion, /Nothing was compared/);
    }
  });
}

test("refuses a diff against a live ProjectionLab 4 export", async () => {
  const snapshots = freshSnapshots();
  const current = await snapshots.create("v5Snap", ["plans"], {
    plans: v5Export().documents.plans,
  });
  const diff = register(
    fakeBridge({ plans: [{ id: "p1", name: "V4 Live" }], today: {} }),
    snapshots,
  );
  const err = await errorFor(diff, { from: { snapshotId: current.id } });
  assert.equal(err.error, "UNSUPPORTED_API_VERSION");
});
