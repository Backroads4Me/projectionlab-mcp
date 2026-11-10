// SnapshotManager prunes by file modification time, so retention does not
// depend on reading and parsing every snapshot file after each write.
//
// Run: node --test test/snapshot-prune.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-prune-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { SnapshotManager } = await import("../dist/snapshot.js");

test("prune deletes expired files by mtime without parsing them", async () => {
  const dir = process.env.PL_SNAPSHOT_DIR;
  mkdirSync(dir, { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  const stale = join(dir, "stale.json");
  const fresh = join(dir, "fresh.json");
  // Neither file parses as a snapshot; only mtime decides their fate.
  writeFileSync(stale, "not json");
  writeFileSync(fresh, "not json");
  const old = new Date(Date.now() - 31 * day);
  utimesSync(stale, old, old);

  const snapshots = new SnapshotManager();
  await snapshots.create("op", ["plans"], { plans: [] }); // triggers the background prune

  for (let i = 0; i < 100 && existsSync(stale); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(!existsSync(stale), "a 31-day-old file must be pruned even though it never parses");
  assert.ok(existsSync(fresh), "a recent file must survive");
});
