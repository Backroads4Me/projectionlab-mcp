// The tab lookup and both manifests name the same hosts: the main app is a
// required host permission, Early Access is optional, so adding it never asks
// existing users to approve new access on update.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_URL_PATTERN, EARLY_ACCESS_URL_PATTERN, tabPatternsFor } from "../src/wire.js";

const manifests = ["manifest.json", "manifest.firefox.json"].map((name) => [
  name,
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")),
]);

test("without Early Access the tab lookup names only the main app", () => {
  assert.deepEqual(tabPatternsFor(false), ["https://app.projectionlab.com/*"]);
});

test("with Early Access allowed the tab lookup adds ea.projectionlab.com", () => {
  assert.deepEqual(tabPatternsFor(true), ["https://app.projectionlab.com/*", "https://ea.projectionlab.com/*"]);
});

for (const [name, manifest] of manifests) {
  test(`${name} requires only the main app and makes Early Access optional`, () => {
    assert.deepEqual(manifest.host_permissions, [APP_URL_PATTERN]);
    assert.deepEqual(manifest.optional_host_permissions, [EARLY_ACCESS_URL_PATTERN]);
  });
}
