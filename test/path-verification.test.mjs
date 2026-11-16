// Post-write verification compares what a tool sent with what the plan holds
// afterwards. ProjectionLab rewrites objects as it saves them, emitting keys in
// its own order and filling in defaults, so a write that landed must still count
// as verified: every key and array element the caller sent has to match, and keys
// the app adds on its own are allowed. A dropped key, a changed value or a
// coerced type fails, and the mismatch names the path with the expected and
// stored value.

import assert from "node:assert/strict";
import test from "node:test";

const { findPathChangeMismatches, pathChangesApplied } = await import(
  "../dist/pathPatch.js"
);

const CONTEXT = {
  label: "event field",
  discoveryTool: "projectionlab_get_plan_section",
  example: "yearlyChange.type",
};

function change(after) {
  return { before: undefined, after };
}

function paths(mismatches) {
  return mismatches.map((m) => m.path);
}

test("an object stored with its keys in another order is verified", () => {
  const sent = { type: "increase", amount: 12, limit: 44 };
  const stored = { limit: 44, amount: 12, type: "increase" };
  assert.equal(pathChangesApplied({ yearlyChange: stored }, { yearlyChange: change(sent) }, CONTEXT), true);
  assert.deepEqual(findPathChangeMismatches({ yearlyChange: stored }, { yearlyChange: change(sent) }, CONTEXT), []);
});

test("keys the app adds itself do not fail verification", () => {
  const sent = { type: "increase", amount: 12 };
  const stored = {
    type: "increase",
    amount: 12,
    amountType: "today$",
    limit: 0,
    limitEnabled: false,
    limitType: "today$",
  };
  assert.equal(pathChangesApplied({ yearlyChange: stored }, { yearlyChange: change(sent) }, CONTEXT), true);
});

test("a nested object matches on its own terms", () => {
  const sent = { type: "custom", custom: { type: "%", data: [{ x: 1, y: 5 }, { x: 10, y: 6.25 }] } };
  const stored = { custom: { data: [{ y: 5, x: 1 }, { y: 6.25, x: 10 }], type: "%" }, type: "custom" };
  assert.equal(pathChangesApplied({ yearlyChange: stored }, { yearlyChange: change(sent) }, CONTEXT), true);
});

test("a key the caller sent and the app dropped fails as a value mismatch", () => {
  const sent = { type: "increase", amount: 12 };
  const stored = { type: "increase", amountType: "today$" };
  const mismatches = findPathChangeMismatches({ yearlyChange: stored }, { yearlyChange: change(sent) }, CONTEXT);
  assert.deepEqual(paths(mismatches), ["yearlyChange"]);
  assert.equal(mismatches[0].reason, "value");
  assert.deepEqual(mismatches[0].expected, sent);
  assert.deepEqual(mismatches[0].stored, stored);
});

test("a stored value that differs fails and reports both sides", () => {
  const mismatches = findPathChangeMismatches(
    { amount: 30 },
    { amount: change(12) },
    CONTEXT,
  );
  assert.deepEqual(paths(mismatches), ["amount"]);
  assert.equal(mismatches[0].reason, "value");
  assert.equal(mismatches[0].expected, 12);
  assert.equal(mismatches[0].stored, 30);
});

test("a value the app stored as another type fails as a shape mismatch", () => {
  const mismatches = findPathChangeMismatches({ amount: "12" }, { amount: change(12) }, CONTEXT);
  assert.deepEqual(paths(mismatches), ["amount"]);
  assert.equal(mismatches[0].reason, "shape");
});

test("a path the app does not have fails as absent", () => {
  const mismatches = findPathChangeMismatches(
    { yearlyChange: { type: "increase" } },
    { "yearlyChange.limit": change(44) },
    CONTEXT,
  );
  assert.deepEqual(paths(mismatches), ["yearlyChange.limit"]);
  assert.equal(mismatches[0].reason, "absent");
  assert.equal(mismatches[0].stored, undefined);
});

test("arrays must hold the same elements in the same order", () => {
  const sent = { data: [{ x: 1, y: 5 }, { x: 10, y: 6 }] };
  assert.equal(pathChangesApplied({ c: sent }, { c: change(sent) }, CONTEXT), true);
  assert.equal(
    pathChangesApplied({ c: { data: [{ x: 10, y: 6 }, { x: 1, y: 5 }] } }, { c: change(sent) }, CONTEXT),
    false,
  );
  assert.equal(
    pathChangesApplied({ c: { data: [{ x: 1, y: 5 }] } }, { c: change(sent) }, CONTEXT),
    false,
  );
});

test("every mismatching path is reported, not only the first", () => {
  const mismatches = findPathChangeMismatches(
    { amount: 30, yearlyChange: { type: "decrease" } },
    { amount: change(12), "yearlyChange.type": change("increase") },
    CONTEXT,
  );
  assert.deepEqual(paths(mismatches), ["amount", "yearlyChange.type"]);
});

test("verification reports nothing when the write is an empty patch", () => {
  assert.deepEqual(findPathChangeMismatches({ amount: 1 }, {}, CONTEXT), []);
  assert.equal(pathChangesApplied({ amount: 1 }, {}, CONTEXT), true);
});

test("data that is not an object never verifies, even with nothing expected", () => {
  assert.equal(pathChangesApplied(undefined, {}, CONTEXT), false);
  assert.equal(pathChangesApplied("text", {}, CONTEXT), false);
  assert.equal(pathChangesApplied(null, {}, CONTEXT), false);
});

test("secret-named and unsafe path segments are refused outright", () => {
  assert.throws(() => findPathChangeMismatches({ apiKey: "x" }, { apiKey: change("y") }, CONTEXT), /Invalid event field path/);
  assert.throws(() => findPathChangeMismatches({}, { "__proto__.x": change(1) }, CONTEXT), /Invalid event field path/);
});
