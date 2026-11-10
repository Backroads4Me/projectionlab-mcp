// Large tool results spill to ~/.projectionlab-mcp/exports and files older
// than the 30 day retention are pruned by modification time, in the
// background, without touching non-.json files.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "plmcp-exports-home-"));
process.env.HOME = HOME;
process.env.LOG_LEVEL = "error";

const { textOrFile, EXPORT_DIR, FILE_THRESHOLD } = await import(
  "../dist/largeOutput.js"
);

const DAY_MS = 24 * 60 * 60 * 1000;

function makeOld(filePath, days) {
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(filePath, when, when);
}

async function waitForGone(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(filePath)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

test("a large result writes a file and pruning removes expired .json exports", async () => {
  assert.equal(EXPORT_DIR, join(HOME, ".projectionlab-mcp", "exports"));

  const fresh = await textOrFile("x".repeat(FILE_THRESHOLD + 1), "keep");
  const freshPath = JSON.parse(fresh).filePath;
  assert.ok(existsSync(freshPath));

  const expired = join(EXPORT_DIR, "diff-2020-01-01T00-00-00.000Z.json");
  writeFileSync(expired, "{}");
  makeOld(expired, 40);
  const staleText = join(EXPORT_DIR, "notes-old.txt");
  writeFileSync(staleText, "keep me");
  makeOld(staleText, 40);
  const recentExpiredNeighbor = join(EXPORT_DIR, "diff-recent.json");
  writeFileSync(recentExpiredNeighbor, "{}");
  makeOld(recentExpiredNeighbor, 10);

  // Any large result triggers the background prune.
  await textOrFile("y".repeat(FILE_THRESHOLD + 1), "trigger");

  assert.ok(await waitForGone(expired), "expired .json export must be pruned");
  assert.ok(existsSync(staleText), "non-.json files are left alone");
  assert.ok(existsSync(recentExpiredNeighbor), "files inside retention stay");
  assert.ok(existsSync(freshPath), "the fresh export stays");
});
