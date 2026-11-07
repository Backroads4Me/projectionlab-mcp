// Unit tests for plan-version conflict detection and plan cloning.
//
// Run: node --test test/plan-version.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL = "error";

const { planChanges, assertPlanVersion, assertPlansUnchanged } = await import(
  "../dist/planVersion.js"
);
const { buildPlanClone, verifyPlanClone } = await import("../dist/clonePlan.js");

const plan = (id, lastUpdated, extra = {}) => ({ id, name: id, lastUpdated, ...extra });

test("planChanges reports saved, removed and added plans", () => {
  const read = [plan("a", 1), plan("b", 1), plan("c", 1)];
  const current = [plan("a", 1), plan("b", 2), plan("d", 1)];
  assert.deepEqual(planChanges(read, current).sort(), [
    "plan b was saved",
    "plan c was removed",
    "plan d was added",
  ]);
  assert.deepEqual(planChanges(read, read), []);
});

test("assertPlansUnchanged refuses when a plan was saved after the read", async () => {
  const read = [plan("a", 1)];
  const bridge = (plans) => ({ exportData: async () => ({ plans }) });
  await assertPlansUnchanged(bridge([plan("a", 1)]), read);
  await assert.rejects(assertPlansUnchanged(bridge([plan("a", 5)]), read), (err) => {
    assert.equal(err.code, "PLAN_CONFLICT");
    return true;
  });
});

test("assertPlanVersion compares against the previewed version", () => {
  assertPlanVersion(plan("a", 7), undefined);
  assertPlanVersion(plan("a", 7), "7");
  assert.throws(() => assertPlanVersion(plan("a", 8), "7"), { code: "PLAN_CONFLICT" });
});

test("buildPlanClone keeps event ids and gives the plan a new identity", () => {
  const source = plan("p1", 100, {
    active: true,
    simKey: 3,
    meta: { index: 0, runKey: 4, dirty: false },
    milestones: [{ id: "retirement" }, { id: "m-1" }],
    expenses: { events: [{ id: "e-1", start: { type: "milestone", value: "m-1" } }] },
    priorities: { events: [{ id: "pr-1", accountId: "acc-1" }] },
  });
  const other = plan("p2", 200, { simKey: 7, meta: { index: 1, runKey: 9 } });
  const clone = buildPlanClone(source, [source, other], "  What if  ", 999);

  assert.notEqual(clone.id, "p1");
  assert.equal(clone.name, "What if");
  assert.equal(clone.lastUpdated, 999);
  assert.equal(clone.active, false);
  assert.equal(clone.simKey, 8);
  assert.equal(clone.meta.index, 2);
  assert.equal(clone.meta.runKey, 10);
  assert.deepEqual(clone.milestones, source.milestones);
  assert.deepEqual(clone.expenses, source.expenses);
  assert.deepEqual(clone.priorities, source.priorities);
  // The source is not mutated.
  assert.equal(source.id, "p1");
  assert.equal(source.meta.index, 0);
});

test("buildPlanClone rejects empty and duplicate names", () => {
  const source = plan("p1", 1, { name: "Baseline" });
  assert.throws(() => buildPlanClone(source, [source], "   "), { code: "INVALID_INPUT" });
  assert.throws(() => buildPlanClone(source, [source], " baseline "), { code: "INVALID_INPUT" });
});

test("verifyPlanClone checks originals are untouched and the copy exists once", () => {
  const before = [plan("a", 1), plan("b", 1)];
  const clone = plan("c", 2);
  assert.deepEqual(verifyPlanClone(before, [...before, clone], clone), []);

  const problems = verifyPlanClone(before, [plan("a", 1), plan("b", 9), clone, clone], clone);
  assert.ok(problems.includes("original plan b was modified"));
  assert.ok(problems.some((p) => p.includes("found it 2 times")));

  const dropped = verifyPlanClone(before, [plan("a", 1), clone], clone);
  assert.ok(dropped.includes("original plan b is missing"));
});
