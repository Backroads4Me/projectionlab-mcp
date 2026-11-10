// compareVersions orders major.minor.patch triples numerically and refuses
// anything else with null so callers can treat unparsable as "say nothing".
//
// Run: node --test test/version-compare.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

const { compareVersions } = await import("../dist/versionCompare.js");

test("each position orders correctly", () => {
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.9.9", "2.0.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.2", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("positions compare as numbers, not strings", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("10.0.0", "9.9.9"), 1);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
});

test("unparsable input returns null", () => {
  for (const bad of [
    "v1.2.3",
    "1.2.3-beta",
    "1.2.3+build5",
    "1.2",
    "1.2.3.4",
    "1.2.-3",
    "1.2.x",
    "",
    "..",
    " 1.2.3",
    "1.2.3 ",
    "01.2.3",
  ]) {
    assert.equal(compareVersions(bad, "1.0.0"), null, `${JSON.stringify(bad)} as a`);
    assert.equal(compareVersions("1.0.0", bad), null, `${JSON.stringify(bad)} as b`);
  }
});
