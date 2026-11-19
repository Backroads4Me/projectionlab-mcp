// Events sharing a name are reported by their start: a milestone's name, a
// date, a keyword, or an age, with an occurrence number only when the start
// does not tell them apart. Pairing is unchanged; only the reported names are.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-start-labels-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { eventDisplayNames, startLabel } = await import("../dist/plans.js");
const { diffPlanList, diffPlanPair, createDiffBudget } = await import(
  "../dist/diff.js"
);
const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);

const milestones = [
  { id: "retirement", name: "Ted's Retirement" },
  { id: "m-rv", name: "Stop RV life" },
  { id: "m-ltc", name: "Long Term Care" },
];
const names = new Map(milestones.map((m) => [m.id, m.name]));

function travel(id, startValue, amount) {
  return {
    id,
    name: "Travel",
    amount,
    start: { type: "milestone", value: startValue, modifier: "include" },
  };
}

function plan(id, expenses, extra = {}) {
  return {
    id,
    name: `Plan ${id}`,
    milestones: structuredClone(milestones),
    expenses: { events: expenses },
    ...extra,
  };
}

test("startLabel names each kind of start", () => {
  assert.equal(startLabel({ type: "milestone", value: "m-rv" }, names), "Stop RV life");
  assert.equal(
    startLabel({ type: "milestone", value: "retirement", modifier: -1 }, names),
    "Ted's Retirement -1",
  );
  assert.equal(
    startLabel({ type: "milestone", value: "retirement", modifier: 2 }, names),
    "Ted's Retirement +2",
  );
  assert.equal(
    startLabel({ type: "milestone", value: "m-rv", modifier: "include" }, names),
    "Stop RV life",
  );
  assert.equal(startLabel({ type: "milestone", value: "unknown-id" }, names), "unknown-id");
  assert.equal(
    startLabel({ type: "milestone", value: "@milestones:Slow Go" }, new Map()),
    "Slow Go",
  );
  assert.equal(startLabel({ type: "date", value: "2034-10-01" }, names), "2034-10-01");
  assert.equal(startLabel({ type: "year", value: 2040 }, names), "2040");
  assert.equal(startLabel({ type: "age", value: 65 }, names), "age 65");
  assert.equal(startLabel({ type: "keyword", value: "now" }, names), "now");
  assert.equal(startLabel({ type: "lifeExpectancy" }, names), "life expectancy");
  assert.equal(startLabel(undefined, names), undefined);
});

test("repeated names carry their start; a single name stays bare", () => {
  const events = [
    travel("t1", "retirement"),
    travel("t2", "m-rv"),
    { id: "med1", name: "Medicare", start: { type: "date", value: "2034-10-01" } },
    { id: "med2", name: "Medicare", start: { type: "date", value: "2040-09-01" } },
    { id: "rent", name: "Rent", start: { type: "keyword", value: "now" } },
  ];
  assert.deepEqual(eventDisplayNames(events, names), [
    "Travel (starts Ted's Retirement)",
    "Travel (starts Stop RV life)",
    "Medicare (starts 2034-10-01)",
    "Medicare (starts 2040-09-01)",
    "Rent",
  ]);
});

test("a shared start or no start falls back to the occurrence", () => {
  const events = [
    travel("t1", "m-rv"),
    travel("t2", "m-rv"),
    travel("t3", "m-ltc"),
    { id: "a1", name: "Brokerage" },
    { id: "a2", name: "Brokerage" },
  ];
  assert.deepEqual(eventDisplayNames(events, names), [
    "Travel #1",
    "Travel #2",
    "Travel (starts Long Term Care)",
    "Brokerage #1",
    "Brokerage #2",
  ]);
});

test("without milestones every repeated name takes the occurrence", () => {
  assert.deepEqual(
    eventDisplayNames([travel("t1", "m-rv"), travel("t2", "m-ltc")]),
    ["Travel #1", "Travel #2"],
  );
});

test("the v5 time diff names repeated events by start and carries their id", () => {
  const before = [
    plan("p1", [travel("t1", "retirement", 100), travel("t2", "m-rv", 200), travel("t3", "m-ltc", 300)]),
  ];
  const after = [
    plan("p1", [travel("t1", "retirement", 100), travel("t2", "m-rv", 250), travel("t4", "retirement", 50)]),
  ];
  after[0].expenses.events[2].start.value = "m-ltc";
  const result = diffPlanList(before, after, createDiffBudget(), { layout: "v5" });
  const expenses = result.changedPlans[0].sections.expenses;
  assert.deepEqual(expenses.modified, [
    {
      name: "Travel (starts Stop RV life)",
      id: "t2",
      changes: { amount: "200 → 250" },
    },
  ]);
  // t3 and t4 both start at Long Term Care on their own side, where each is
  // the only Travel to do so.
  assert.deepEqual(expenses.added, ["Travel (starts Long Term Care)"]);
  assert.deepEqual(expenses.removed, ["Travel (starts Long Term Care)"]);
});

test("a renamed milestone renames the label on the later side only", () => {
  const before = [plan("p1", [travel("t1", "retirement", 100), travel("t2", "m-rv", 200)])];
  const after = structuredClone(before);
  after[0].milestones[1].name = "Leave the RV";
  after[0].expenses.events[1].amount = 300;
  const result = diffPlanList(before, after, createDiffBudget(), { layout: "v5" });
  const expenses = result.changedPlans[0].sections.expenses;
  assert.deepEqual(expenses.modified, [
    { name: "Travel (starts Leave the RV)", id: "t2", changes: { amount: "200 → 300" } },
  ]);
});

test("the plan-to-plan diff names repeated events by the milestone they start at", () => {
  const a = plan("a", [travel("a-t1", "retirement", 100), travel("a-t2", "m-rv", 200)]);
  const b = plan("b", [travel("b-t1", "retirement", 100), travel("b-t2", "m-rv", 250)]);
  const result = diffPlanPair(a, b, createDiffBudget(), "expenses");
  assert.deepEqual(result.sections.expenses.different, [
    { name: "Travel (starts Stop RV life)", changes: { amount: "200 → 250" } },
  ]);
});

test("the section dry run names repeated events by start", async () => {
  const state = v5Export();
  const main = state.documents.plans.find((p) => p.id === "plan_main");
  main.milestones = structuredClone(milestones);
  main.expenses.events = [travel("t1", "retirement", 100), travel("t2", "m-rv", 200)];
  let handler;
  registerUpdatePlanSectionTool(
    {
      registerTool(_name, _definition, h) {
        handler = h;
      },
    },
    {
      async editAccess() {
        return "enabled";
      },
      async apiContract() {
        return 2;
      },
      async exportData() {
        return structuredClone(state);
      },
    },
    { async create() {} },
  );
  const sectionData = structuredClone(main.expenses);
  sectionData.events[1].amount = 250;
  const result = await handler({
    planIdentifier: "plan_main",
    section: "expenses",
    sectionData,
    confirm: false,
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const text = result.content[0].text;
  assert.match(text, /Travel \(starts Stop RV life\)/);
  assert.match(text, /Travel \(starts Ted's Retirement\)/);
  assert.doesNotMatch(text, /Travel #/);
});
