// projectionlab_diff: field-level diff of a snapshot against another snapshot
// or the live export. Selector resolution is the one rollback uses, computed
// plan fields are excluded, secret-named fields are redacted, and the payload
// is capped with an omitted count.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
const SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-diff-")),
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

/** The plans as they were when the snapshot was taken. */
function oldPlans() {
  return [
    {
      id: "p1",
      name: "Retire at 55",
      lastUpdated: 100,
      simKey: 1,
      meta: { runKey: 1 },
      retirementAge: 55,
      income: {
        events: [
          {
            id: "i1",
            name: "Salary",
            amount: 100000,
            rothConversions: [{ amount: 1000, year: 62 }],
          },
          { id: "i2", name: "Rental", amount: 12000 },
        ],
      },
      expenses: { events: [{ id: "e1", name: "Living", amount: 60000 }] },
      milestones: [{ id: "m1", name: "Retire" }],
      variables: { inflation: 0.025 },
    },
    {
      id: "p2",
      name: "Work forever",
      lastUpdated: 200,
      income: { events: [] },
      expenses: { events: [] },
      milestones: [],
    },
  ];
}

/** The same plans after edits, plus a re-save that only moves computed fields. */
function editedPlans() {
  const plans = oldPlans();
  const p1 = plans[0];
  p1.lastUpdated = 9999;
  p1.simKey = 777;
  p1.meta = { runKey: 888, yearlySummary: { endAge: 90 } };
  p1.retirementAge = 57;
  p1.income.events = [
    {
      id: "i1",
      name: "Salary",
      amount: 110000,
      rothConversions: [{ amount: 2000, year: 62 }],
    },
    { id: "i3", name: "Dividends", amount: 4000 },
  ];
  const whatIf = {
    id: "p3",
    name: "What if",
    lastUpdated: 300,
    income: { events: [] },
    expenses: { events: [] },
    milestones: [],
  };
  return [p1, whatIf];
}

function register(bridge, snapshots) {
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  return (args) => server.tools.get("projectionlab_diff").handler(args);
}

function snapshotOf(snapshots, plans) {
  return snapshots.create("updatePlanSection", ["plans"], { plans });
}

const text = (result) => JSON.parse(result.content[0].text);

async function errorFor(diff, args) {
  const result = await diff(args);
  assert.equal(result.isError, true, JSON.stringify(result));
  return text(result);
}

test("diff reports added, removed and modified events against the live data", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshotOf(snapshots, oldPlans());
  const bridge = fakeBridge({ plans: editedPlans(), today: {} });
  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );

  assert.equal(out.from.source, "snapshot");
  assert.equal(out.from.snapshotId, saved.id);
  assert.deepEqual(out.from.sections, ["plans"]);
  assert.equal(out.to.source, "live");
  assert.ok(Date.parse(out.to.readAt) > 0, out.to.readAt);
  assert.deepEqual(out.comparedSections, ["plans"]);
  assert.equal(out.changed, true);
  assert.equal(out.message, undefined);

  const plans = out.sections.plans;
  assert.equal(plans.planCount, "2 → 2");
  assert.deepEqual(plans.added, [{ id: "p3", name: "What if" }]);
  assert.deepEqual(plans.removed, [{ id: "p2", name: "Work forever" }]);
  assert.equal(plans.addedCount, 1);
  assert.equal(plans.removedCount, 1);
  assert.equal(plans.changedCount, 1);

  const [p1] = plans.changedPlans;
  assert.equal(p1.id, "p1");
  assert.equal(p1.name, "Retire at 55");
  assert.equal(p1.changes.retirementAge, "55 → 57");

  const income = p1.sections.income;
  assert.equal(income.kind, "events");
  assert.equal(income.count, "2 → 2");
  assert.deepEqual(income.added, ["Dividends"]);
  assert.deepEqual(income.removed, ["Rental"]);
  assert.deepEqual(income.modified, [
    {
      name: "Salary",
      changes: {
        amount: "100000 → 110000",
        "rothConversions.0.amount": "1000 → 2000",
      },
    },
  ]);

  // Untouched sections and plans are counted, not spelled out.
  assert.equal(p1.sections.expenses.changed, false);
  assert.equal(p1.sections.expenses.unchangedCount, 1);
  assert.equal(p1.sections.variables.changed, false);
  assert.deepEqual(p1.changedSections, ["income"]);
});

test("diff omits the plan fields ProjectionLab computes on its own", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshotOf(snapshots, oldPlans());
  // The only differences are the computed fields: a plan ProjectionLab
  // re-saved, not one an agent edited.
  const resaved = oldPlans().map((plan) => ({
    ...plan,
    lastUpdated: plan.lastUpdated + 5000,
    simKey: 4242,
    meta: { runKey: 4242, yearlySummary: { endAge: 95 } },
  }));
  const bridge = fakeBridge({ plans: resaved, today: {} });
  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );

  assert.equal(out.changed, false);
  assert.match(out.message, /lastUpdated, simKey, meta/);
  const plans = out.sections.plans;
  assert.equal(plans.changedCount, 0);
  assert.deepEqual(plans.unchanged.sort(), ["Retire at 55", "Work forever"]);
  const json = JSON.stringify(plans);
  for (const field of ["lastUpdated", "simKey", "meta"]) {
    assert.equal(json.includes(field), false, `${field} leaked into the diff`);
  }
});

test("diff compares two snapshots and leaves the snapshot store alone", async () => {
  const snapshots = freshSnapshots();
  const before = await snapshotOf(snapshots, oldPlans());
  await new Promise((r) => setTimeout(r, 5));
  const after = await snapshotOf(snapshots, editedPlans());
  const bridge = fakeBridge({ plans: [], today: {} });

  const out = text(
    await register(bridge, snapshots)({
      from: { snapshotId: before.id },
      to: { snapshotId: after.id },
    }),
  );
  assert.equal(out.to.source, "snapshot");
  assert.equal(out.to.snapshotId, after.id);
  assert.equal(out.sections.plans.changedCount, 1);
  assert.deepEqual(out.sections.plans.added, [{ id: "p3", name: "What if" }]);

  // A read-only tool: it reads the live export only when `to` is omitted, and
  // it never writes or snapshots.
  assert.equal(bridge.exportCalls, 0);
  assert.deepEqual(
    (await snapshots.list()).map((s) => s.id).sort(),
    [before.id, after.id].sort(),
  );

  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  const { annotations } = server.tools
    .get("projectionlab_diff")
    .definition;
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.equal(annotations.openWorldHint, false);
});

test("diff picks the snapshot rollback picks for nBack and beforeTime", async () => {
  const snapshots = freshSnapshots();
  const created = [];
  for (const plans of [oldPlans(), editedPlans(), oldPlans().slice(0, 1)]) {
    created.push(await snapshotOf(snapshots, plans));
    await new Promise((r) => setTimeout(r, 5));
  }

  const bridge = fakeBridge({ plans: [], today: {} });
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);
  const diff = (args) => server.tools.get("projectionlab_diff").handler(args);
  const rollback = (args) =>
    server.tools.get("projectionlab_rollback").handler(args);

  // nBack 2 and a time just before the newest snapshot both name the middle
  // one, and both tools agree on which snapshot that is.
  const selectors = [
    { nBack: 2 },
    { beforeTime: new Date(Date.parse(created[2].timestamp) - 1).toISOString() },
  ];
  for (const selector of selectors) {
    const fromDiff = text(await diff({ from: selector })).from;
    const fromRollback = text(await rollback({ ...selector, confirm: false }));
    assert.equal(fromDiff.snapshotId, created[1].id, JSON.stringify(selector));
    assert.equal(fromDiff.snapshotId, fromRollback.snapshotId);
    assert.equal(fromDiff.timestamp, fromRollback.timestamp);
    assert.equal(fromDiff.operation, fromRollback.operation);
  }

  const endpoints = text(
    await diff({ from: { nBack: 1 }, to: { nBack: 3 } }),
  );
  assert.equal(endpoints.from.snapshotId, created[2].id);
  assert.equal(endpoints.to.snapshotId, created[0].id);
});

test("diff reports Current Finances rows by collection and id", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshots.create("updateAccount", ["currentFinances"], {
    currentFinances: {
      savingsAccounts: [{ id: "s1", name: "Emergency", balance: 10000 }],
      assets: [
        {
          id: "a1",
          name: "House",
          type: "real-estate",
          amount: 500000,
          balance: 200000,
        },
      ],
      debts: [{ id: "d1", name: "Car loan", balance: 9000 }],
    },
  });

  const bridge = fakeBridge({
    plans: [],
    today: {
      savingsAccounts: [],
      assets: [
        {
          id: "a1",
          name: "House",
          type: "real-estate",
          amount: 520000,
          balance: 180000,
        },
      ],
      debts: [
        { id: "d1", name: "Car loan", balance: 9000 },
        { id: "d2", name: "Student loan", balance: 4000 },
      ],
      lastUpdatedByUser: "yesterday",
    },
  });

  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  assert.deepEqual(out.comparedSections, ["currentFinances"]);
  const cf = out.sections.currentFinances;
  assert.equal(cf.changed, true);
  assert.deepEqual(cf.collections.assets.modified, [
    {
      id: "a1",
      name: "House",
      changes: { amount: "500000 → 520000", balance: "200000 → 180000" },
    },
  ]);
  assert.deepEqual(cf.collections.savingsAccounts.removed, [
    { id: "s1", name: "Emergency" },
  ]);
  assert.deepEqual(cf.collections.debts.added, [
    { id: "d2", name: "Student loan" },
  ]);
  assert.equal(cf.collections.debts.unchangedCount, 1);
  assert.deepEqual(cf.changes, {
    lastUpdatedByUser: '(absent) → "yesterday"',
  });
});

test("diff redacts secret-named fields and the API key", async () => {
  const snapshots = freshSnapshots();
  const before = oldPlans();
  before[0].income.events[0].apiKey = "abc123secret";
  before[0].income.events[0].note = "imported from a csv";
  const saved = await snapshotOf(snapshots, before);

  const after = editedPlans();
  after[0].income.events[0].apiKey = "abc123secretChanged";
  after[0].income.events[0].note = "paste test-api-key to sync";
  const bridge = fakeBridge({ plans: after, today: {} });

  const raw = await register(bridge, snapshots)({
    from: { snapshotId: saved.id },
  });
  const json = raw.content[0].text;

  assert.equal(json.includes("abc123secret"), false, json);
  assert.equal(json.includes("test-api-key"), false, json);
  const [salary] = JSON.parse(json).sections.plans.changedPlans[0].sections.income
    .modified;
  assert.equal(salary.name, "Salary");
  assert.equal(salary.changes.apiKey, "[REDACTED]");
  assert.equal(
    salary.changes.note,
    '"imported from a csv" → "paste [REDACTED] to sync"',
  );
});

test("a renamed event reads as removed and added, the way the section dry run keys events", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshotOf(snapshots, oldPlans());
  const after = oldPlans();
  after[0].income.events[1].name = "Beach house";
  const bridge = fakeBridge({ plans: after, today: {} });

  const income = text(
    await register(bridge, snapshots)({
      from: { snapshotId: saved.id },
      planIdentifier: "p1",
      section: "income",
    }),
  ).sections.plans.changedPlans[0].sections.income;

  assert.deepEqual(income.removed, ["Rental"]);
  assert.deepEqual(income.added, ["Beach house"]);
  assert.equal(income.modifiedCount, 0);
});

test("diff caps reported field changes and counts what it left out", async () => {
  const snapshots = freshSnapshots();
  const wide = {};
  for (let i = 0; i < 260; i++) wide[`f${i}`] = i;
  const before = [
    {
      id: "p1",
      name: "Wide",
      income: { events: [{ id: "i1", name: "E", ...wide }] },
    },
  ];
  const saved = await snapshotOf(snapshots, before);

  const after = structuredClone(before);
  for (let i = 0; i < 260; i++) after[0].income.events[0][`f${i}`] = i + 1000;
  const bridge = fakeBridge({ plans: after, today: {} });

  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  const { changes } =
    out.sections.plans.changedPlans[0].sections.income.modified[0];
  assert.equal(Object.keys(changes).length, 200);
  assert.equal(out.fieldChangeCap, 200);
  assert.equal(out.omittedFieldChanges, 60);
});

test("diff narrows to one plan and one section", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshotOf(snapshots, oldPlans());
  const bridge = fakeBridge({ plans: editedPlans(), today: {} });
  const diff = register(bridge, snapshots);

  const narrowed = text(
    await diff({
      from: { snapshotId: saved.id },
      planIdentifier: "retire",
      section: "income",
    }),
  );
  assert.equal(narrowed.planIdentifier, "retire");
  assert.equal(narrowed.section, "income");
  const plans = narrowed.sections.plans;
  assert.equal(plans.changedCount, 1);
  assert.equal(plans.unchanged, undefined);
  assert.deepEqual(Object.keys(plans.changedPlans[0].sections), ["income"]);

  const byId = text(
    await diff({ from: { snapshotId: saved.id }, planIdentifier: "p2" }),
  );
  assert.deepEqual(byId.sections.plans.removed, [
    { id: "p2", name: "Work forever" },
  ]);
  assert.equal(byId.sections.plans.changedCount, 0);
});

test("diff refuses bad selectors, missing snapshots, empty comparisons and unknown plans", async () => {
  const snapshots = freshSnapshots();
  const plansSnapshot = await snapshotOf(snapshots, oldPlans());
  const settingsSnapshot = await snapshots.create(
    "restoreSettings",
    ["settings"],
    { settings: { theme: "dark" } },
  );
  // settings is comparable here, so the section filter reaches its own check.
  const bridge = fakeBridge({
    plans: editedPlans(),
    today: {},
    settings: { theme: "dark" },
  });
  const diff = register(bridge, snapshots);

  const none = await errorFor(diff, { from: {} });
  assert.equal(none.error, "INVALID_INPUT");
  assert.match(none.message, /No from snapshot selector supplied/);

  const both = await errorFor(diff, {
    from: { snapshotId: plansSnapshot.id, nBack: 1 },
  });
  assert.equal(both.error, "INVALID_INPUT");
  assert.match(
    both.message,
    /Supply exactly one from snapshot selector, received snapshotId and nBack/,
  );

  const badTo = await errorFor(diff, {
    from: { snapshotId: plansSnapshot.id },
    to: { nBack: 1, beforeTime: "2026-11-08T15:30:00Z" },
  });
  assert.equal(badTo.error, "INVALID_INPUT");
  assert.match(badTo.message, /Supply exactly one to snapshot selector/);

  const unknown = await errorFor(diff, {
    from: { snapshotId: "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(unknown.error, "SNAPSHOT_NOT_FOUND");

  const outOfRange = await errorFor(diff, { from: { nBack: 9 } });
  assert.equal(outOfRange.error, "SNAPSHOT_NOT_FOUND");
  assert.match(outOfRange.message, /nBack 9 is out of range/);

  const noShared = await errorFor(diff, {
    from: { snapshotId: plansSnapshot.id },
    to: { snapshotId: settingsSnapshot.id },
  });
  assert.equal(noShared.error, "INVALID_INPUT");
  assert.match(noShared.message, /share no comparable data section/);
  assert.match(noShared.message, /from holds \[plans\]/);
  assert.match(noShared.message, /to holds \[settings\]/);

  const missingPlan = await errorFor(diff, {
    from: { snapshotId: plansSnapshot.id },
    planIdentifier: "no such plan",
  });
  assert.equal(missingPlan.error, "INVALID_INPUT");
  assert.match(missingPlan.message, /No plan matching "no such plan"/);

  const sectionWithoutPlans = await errorFor(diff, {
    from: { snapshotId: settingsSnapshot.id },
    section: "income",
  });
  assert.equal(sectionWithoutPlans.error, "INVALID_INPUT");
  assert.match(sectionWithoutPlans.message, /narrows the plans comparison/);
});

test("diff compares no section that carries data on only one side", async () => {
  const snapshots = freshSnapshots();
  // A snapshot can list a section it saved no data for, and the live export
  // can leave a section out; neither is a change a rollback would make.
  const saved = await snapshots.create("updatePlanSection", ["plans", "progress"], {
    plans: oldPlans(),
  });
  const bridge = fakeBridge({ plans: editedPlans(), today: {} });
  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  assert.deepEqual(out.comparedSections, ["plans"]);
  assert.deepEqual(out.notCompared, [
    { section: "progress", reason: "the from snapshot holds no data for it" },
  ]);

  const withProgress = await snapshots.create(
    "restoreProgress",
    ["plans", "progress"],
    { plans: oldPlans(), progress: [{ year: 2026, balance: 1 }] },
  );
  const missingOnLive = text(
    await register(bridge, snapshots)({ from: { snapshotId: withProgress.id } }),
  );
  assert.deepEqual(missingOnLive.comparedSections, ["plans"]);
  assert.deepEqual(missingOnLive.notCompared, [
    { section: "progress", reason: "the live export returned no such section" },
  ]);

  const empty = await snapshots.create("restoreProgress", ["progress"], {});
  const nothing = await errorFor(register(bridge, snapshots), {
    from: { snapshotId: empty.id },
  });
  assert.equal(nothing.error, "INVALID_INPUT");
  assert.match(nothing.message, /no section carries data on both sides/);
});

test("diff says which sections were compared and which were skipped", async () => {
  const snapshots = freshSnapshots();
  const both = await snapshots.create(
    "updatePlanSection",
    ["plans", "settings"],
    { plans: oldPlans(), settings: { theme: "dark" } },
  );
  const settingsOnly = await snapshots.create("restoreSettings", ["settings"], {
    settings: { theme: "light" },
  });
  const bridge = fakeBridge({ plans: editedPlans(), today: {}, settings: {} });
  const out = text(
    await register(bridge, snapshots)({
      from: { snapshotId: both.id },
      to: { snapshotId: settingsOnly.id },
    }),
  );

  assert.deepEqual(out.comparedSections, ["settings"]);
  assert.deepEqual(out.notCompared, [
    { section: "plans", reason: "the to snapshot does not hold it" },
  ]);
  assert.deepEqual(out.sections.settings.changes, {
    theme: '"dark" → "light"',
  });
  assert.equal(out.sections.plans, undefined);
});

function wideFields(from) {
  const fields = {};
  for (let i = 0; i < 60; i++) fields[`f${i}`] = from + i;
  return fields;
}

test("a difference past the cap still counts as changed, event by event", async () => {
  const snapshots = freshSnapshots();
  const before = [
    {
      id: "p1",
      name: "Many events",
      income: {
        events: [1, 2, 3, 4, 5].map((n) => ({
          id: `i${n}`,
          name: `ev${n}`,
          ...wideFields(n * 100),
        })),
      },
      expenses: { events: [] },
      milestones: [],
    },
  ];
  const saved = await snapshotOf(snapshots, before);

  const after = structuredClone(before);
  for (const event of after[0].income.events) {
    for (let i = 0; i < 60; i++) event[`f${i}`] = 1000 + i;
  }
  const bridge = fakeBridge({ plans: after, today: {} });

  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  const income = out.sections.plans.changedPlans[0].sections.income;

  // 300 differences, 200 recorded: the last event shows nothing but is still
  // counted, so the diff never reads as "no differences".
  assert.equal(out.changed, true);
  assert.equal(out.sections.plans.changed, true);
  assert.equal(income.changed, true);
  assert.equal(income.modifiedCount, 5);
  assert.equal(income.unchangedCount, 0);
  assert.equal(income.modified.length, 5);
  assert.equal(income.modified[0].changes.f0, "100 → 1000");
  assert.equal(income.modified[3].omittedChanges, 40);
  assert.equal(income.modified[4].changes, undefined);
  assert.equal(income.modified[4].omittedChanges, 60);
  assert.equal(out.omittedFieldChanges, 100);
});

test("a Current Finances row past the cap still counts as modified", async () => {
  const snapshots = freshSnapshots();
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    id: `a${n}`,
    name: `Asset ${n}`,
    ...wideFields(n),
  }));
  const saved = await snapshots.create("updateAccount", ["currentFinances"], {
    currentFinances: { assets: structuredClone(rows) },
  });

  const after = structuredClone(rows);
  for (const row of after) {
    for (let i = 0; i < 60; i++) row[`f${i}`] = 1000 + i;
  }
  const bridge = fakeBridge({ plans: [], today: { assets: after } });

  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  const assets = out.sections.currentFinances.collections.assets;

  assert.equal(out.changed, true);
  assert.equal(out.sections.currentFinances.changed, true);
  assert.equal(assets.changed, true);
  assert.equal(assets.modifiedCount, 5);
  assert.equal(assets.unchangedCount, 0);
  assert.equal(assets.modified[0].changes.f0, "1 → 1000");
  assert.equal(assets.modified[4].changes, undefined);
  assert.equal(assets.modified[4].omittedChanges, 60);
  assert.equal(out.omittedFieldChanges, 100);
});

test("plan settings changed past the cap still count as changed", async () => {
  const snapshots = freshSnapshots();
  const incomeFields = {};
  for (let i = 0; i < 200; i++) incomeFields[`f${i}`] = i;
  const settingsFields = {};
  for (let i = 0; i < 30; i++) settingsFields[`s${i}`] = i;

  const plan = {
    id: "p1",
    name: "Budget used up",
    income: { events: [{ id: "i1", name: "Salary", ...incomeFields }] },
    expenses: { events: [] },
    milestones: [],
    ...settingsFields,
  };
  const saved = await snapshotOf(snapshots, [plan]);

  const after = structuredClone(plan);
  for (let i = 0; i < 200; i++) after.income.events[0][`f${i}`] = i + 1;
  for (let i = 0; i < 30; i++) after[`s${i}`] = i + 1;
  const bridge = fakeBridge({ plans: [after], today: {} });

  const out = text(
    await register(bridge, snapshots)({ from: { snapshotId: saved.id } }),
  );
  const changedPlan = out.sections.plans.changedPlans[0];

  // income consumed the whole budget; the plan settings that follow are still
  // reported as changed, with their own omitted count.
  assert.equal(out.changed, true);
  assert.equal(changedPlan.changed, true);
  assert.deepEqual(changedPlan.changedSections, ["income"]);
  assert.equal(
    Object.keys(changedPlan.sections.income.modified[0].changes).length,
    200,
  );
  assert.equal(changedPlan.changes, undefined);
  assert.equal(changedPlan.omittedChanges, 30);
  assert.equal(out.omittedFieldChanges, 30);
});

test("secrets nested under an event path never reach the output", async () => {
  const snapshots = freshSnapshots();
  const event = {
    id: "i1",
    name: "Salary",
    amount: 100,
    credentials: { apiKey: "sekretAlpha1", label: "bank feed" },
    auth: { token: "sekretBravo2" },
    access: [{ password: "sekretCharlie3" }],
  };
  const saved = await snapshotOf(
    snapshots,
    [{ id: "p1", name: "Secrets", income: { events: [event] } }],
  );

  const after = structuredClone(event);
  after.amount = 200;
  after.credentials.apiKey = "sekretAlpha1changed";
  after.auth.token = "sekretBravo2changed";
  after.access[0].password = "sekretCharlie3changed";
  const bridge = fakeBridge({
    plans: [{ id: "p1", name: "Secrets", income: { events: [after] } }],
    today: {},
  });

  const raw = await register(bridge, snapshots)({
    from: { snapshotId: saved.id },
  });
  const json = raw.content[0].text;
  for (const secret of [
    "sekretAlpha1",
    "sekretBravo2",
    "sekretCharlie3",
    "bank feed",
  ]) {
    assert.equal(json.includes(secret), false, `${secret} leaked: ${json}`);
  }

  const [modified] = JSON.parse(json).sections.plans.changedPlans[0].sections
    .income.modified;
  assert.equal(modified.name, "Salary");
  assert.deepEqual(modified.changes, {
    amount: "100 → 200",
    "credentials.apiKey": "[REDACTED]",
    "auth.token": "[REDACTED]",
    "access.0.password": "[REDACTED]",
  });
  assert.equal(
    JSON.parse(json).sections.plans.changedPlans[0].sections.income
      .modifiedCount,
    1,
  );
  assert.equal(JSON.parse(json).changed, true);
});

test("a very long value is truncated with its original length", async () => {
  const snapshots = freshSnapshots();
  const saved = await snapshotOf(
    snapshots,
    [
      {
        id: "p1",
        name: "Long note",
        income: { events: [{ id: "i1", name: "Salary", note: "short" }] },
      },
    ],
  );
  const bridge = fakeBridge({
    plans: [
      {
        id: "p1",
        name: "Long note",
        income: {
          events: [{ id: "i1", name: "Salary", note: "z".repeat(500) }],
        },
      },
    ],
    today: {},
  });

  const raw = await register(bridge, snapshots)({
    from: { snapshotId: saved.id },
  });
  const json = raw.content[0].text;
  const { changes } = JSON.parse(json).sections.plans.changedPlans[0].sections
    .income.modified[0];

  const truncated = '"' + "z".repeat(199) + "...[truncated from 502 characters]";
  assert.equal(changes.note, `"short" → ${truncated}`);
  assert.ok(changes.note.length < 260, changes.note.length);
  assert.equal(json.includes("z".repeat(500)), false);
});
