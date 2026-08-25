// Guards the published npm tarball: no stale/renamed build artifacts ship, and
// the expected entrypoints are present. Uses --ignore-scripts so it inspects
// the current dist/ (already built by `npm test`) without triggering a clean
// rebuild that would race other tests. Run `npm run build` first if invoking
// this file directly.
//
// Run: node --test test/pack.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function packFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // npm may print warnings before the JSON; grab from the first '['.
  const json = out.slice(out.indexOf("["));
  return JSON.parse(json)[0].files.map((f) => f.path);
}

test("tarball ships no stale or dead build artifacts", () => {
  const files = packFiles();
  // playwrightBridge was removed; its compiled output must never resurface.
  const stale = files.filter((f) => /playwright/i.test(f));
  assert.deepEqual(stale, [], `stale artifacts in tarball: ${stale.join(", ")}`);
});

test("tarball ships the expected entrypoints", () => {
  const files = packFiles();
  for (const required of [
    "dist/index.js",
    "dist/extensionBridge.js",
    "dist/bridge.js",
    "README.md",
    "HOW-IT-WORKS.md",
  ]) {
    assert.ok(
      files.includes(required),
      `missing ${required} from tarball (have ${files.length} files)`,
    );
  }
});

test("no source .ts or .env leaks into the tarball", () => {
  const files = packFiles();
  const leaks = files.filter(
    (f) => f.startsWith("src/") || f === ".env" || f.endsWith(".ts") && !f.endsWith(".d.ts"),
  );
  assert.deepEqual(leaks, [], `unexpected files in tarball: ${leaks.join(", ")}`);
});
