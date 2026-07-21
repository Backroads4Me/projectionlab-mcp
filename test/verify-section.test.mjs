// Unit tests for verifySectionApplied — the write-verification logic that
// replaced the count-only check (reviewer P1).
//
// Run: node --test test/verify-section.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

const { verifySectionApplied } = await import("../dist/plans.js");

test("event section: exact match verifies", () => {
  const submitted = { events: [{ name: "Retire", age: 60 }, { name: "SS", age: 67 }] };
  const actual = { events: [{ name: "SS", age: 67, id: "x" }, { name: "Retire", age: 60, id: "y" }] };
  assert.equal(verifySectionApplied(submitted, actual).ok, true); // reorder + server ids tolerated
});

test("event section: dropped event fails", () => {
  const submitted = { events: [{ name: "Retire", age: 60 }, { name: "SS", age: 67 }] };
  const actual = { events: [{ name: "Retire", age: 60 }] };
  const r = verifySectionApplied(submitted, actual);
  assert.equal(r.ok, false);
  assert.match(r.reason, /count/);
});

test("event section: count preserved but value changed fails", () => {
  const submitted = { events: [{ name: "Retire", age: 60 }] };
  const actual = { events: [{ name: "Retire", age: 55 }] }; // PL altered the value
  const r = verifySectionApplied(submitted, actual);
  assert.equal(r.ok, false);
  assert.match(r.reason, /changed/);
});

test("event section: renamed event (identifier missing) fails", () => {
  const submitted = { events: [{ name: "Retire", age: 60 }] };
  const actual = { events: [{ name: "Retirement", age: 60 }] };
  const r = verifySectionApplied(submitted, actual);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
});

test("array section (milestones): verifies by content", () => {
  assert.equal(verifySectionApplied([{ name: "FI" }], [{ name: "FI", id: "1" }]).ok, true);
  assert.equal(verifySectionApplied([{ name: "FI" }], [{ name: "FI", id: "1" }, { name: "extra" }]).ok, false);
});

test("duplicate names: one corrupted twin no longer verifies (one-to-one)", () => {
  const submitted = { events: [{ name: "Gift", amount: 100 }, { name: "Gift", amount: 100 }] };
  // One actual "Gift" is correct, the other was corrupted to 999.
  const actual = { events: [{ name: "Gift", amount: 100 }, { name: "Gift", amount: 999 }] };
  const r = verifySectionApplied(submitted, actual);
  assert.equal(r.ok, false);
});

test("duplicate names: both intact still verifies", () => {
  const submitted = { events: [{ name: "Gift", amount: 100 }, { name: "Gift", amount: 100 }] };
  const actual = { events: [{ name: "Gift", amount: 100 }, { name: "Gift", amount: 100 }] };
  assert.equal(verifySectionApplied(submitted, actual).ok, true);
});

test("matches by id one-to-one when ids are present", () => {
  const submitted = { events: [{ id: "a", name: "X", v: 1 }, { id: "b", name: "X", v: 2 }] };
  const actual = { events: [{ id: "b", name: "X", v: 2 }, { id: "a", name: "X", v: 1 }] };
  assert.equal(verifySectionApplied(submitted, actual).ok, true);
  // Corrupt the value of id "b": must fail even though a same-named twin is intact.
  const corrupted = { events: [{ id: "b", name: "X", v: 9 }, { id: "a", name: "X", v: 1 }] };
  assert.equal(verifySectionApplied(submitted, corrupted).ok, false);
});

test("non-event section: zero-vs-zero no longer passes falsely", () => {
  // The old count-only check treated 0 events == 0 events as verified even when
  // the object was rejected/blanked. Now the object content is compared.
  const submitted = { retirementAge: 62, inflation: 0.03 };
  assert.equal(verifySectionApplied(submitted, {}).ok, false);
  assert.equal(verifySectionApplied(submitted, { retirementAge: 62, inflation: 0.03 }).ok, true);
  assert.equal(verifySectionApplied(submitted, { retirementAge: 65, inflation: 0.03 }).ok, false);
});

test("non-event section: server-added fields are tolerated", () => {
  const submitted = { retirementAge: 62 };
  assert.equal(verifySectionApplied(submitted, { retirementAge: 62, _computed: true }).ok, true);
});
