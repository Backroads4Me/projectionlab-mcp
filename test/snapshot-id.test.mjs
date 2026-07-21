// Verifies SnapshotManager.get rejects non-UUID / path-traversal snapshot IDs
// (reviewer P2) rather than joining caller input into a filesystem path.
//
// Run: node --test test/snapshot-id.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { SnapshotManager } = await import("../dist/snapshot.js");
const mgr = new SnapshotManager();

const BAD_IDS = [
  "../../../../etc/passwd",
  "..%2f..%2fsecret",
  "not-a-uuid",
  "abc/def",
  "",
  "123e4567-e89b-12d3-a456-42661417400", // one char short
];

for (const id of BAD_IDS) {
  test(`rejects invalid snapshot id: ${JSON.stringify(id)}`, async () => {
    await assert.rejects(
      mgr.get(id),
      (err) => {
        assert.equal(err.code, "SNAPSHOT_NOT_FOUND");
        return true;
      },
    );
  });
}

test("a well-formed but absent UUID reports not-found (not a crash)", async () => {
  await assert.rejects(mgr.get("123e4567-e89b-12d3-a456-426614174000"), (err) => {
    assert.equal(err.code, "SNAPSHOT_NOT_FOUND");
    return true;
  });
});

test("round-trips a real snapshot created by the manager", async () => {
  const snap = await mgr.create("test-op", ["plans"], { plans: [{ id: "p1" }] });
  const got = await mgr.get(snap.id);
  assert.equal(got.id, snap.id);
  assert.deepEqual(got.sections, ["plans"]);
});
