// A diff large enough to exceed the inline limit is written to the exports
// folder and returned as a pointer that still names the comparison.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.HOME = mkdtempSync(join(tmpdir(), "plmcp-diff-home-"));
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-diff-large-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerDiffTool } = await import("../dist/tools/diff.js");
const { SnapshotManager } = await import("../dist/snapshot.js");
const { FILE_THRESHOLD } = await import("../dist/largeOutput.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

const text = (result) => JSON.parse(result.content[0].text);

test("a diff over the inline limit is spilled to a file with its summary", async () => {
  const long = "y".repeat(300);
  const fields = {};
  for (let i = 0; i < 200; i++) fields[`f${i}`] = long;

  const salary = { id: "i1", name: "Salary", ...fields };
  const plan = {
    id: "p1",
    name: "Huge",
    income: { events: [structuredClone(salary)] },
    expenses: { events: [] },
    milestones: [],
  };

  // 200 recorded field changes, plus enough added events with long names that
  // the payload exceeds the inline limit.
  const added = Array.from({ length: 198 }, (_, n) => ({
    id: `added-${n}`,
    name: `Event ${String(n).padStart(3, "0")}${"n".repeat(285)}`,
  }));

  const snapshots = new SnapshotManager();
  const saved = await snapshots.create("updatePlanSection", ["plans"], {
    plans: [structuredClone(plan)],
  });

  const changed = structuredClone(plan);
  for (let i = 0; i < 200; i++) changed.income.events[0][`f${i}`] = "z".repeat(300);
  changed.income.events.push(...added);

  const bridge = {
    async exportData() {
      return { plans: [changed], today: {} };
    },
  };
  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);

  const inline = text(
    await server.tools.get("projectionlab_diff").handler({
      from: { snapshotId: saved.id },
    }),
  );
  assert.equal(inline.truncated, true);
  const reported = /Result is (\d+) chars/.exec(inline.reason);
  assert.ok(reported, inline.reason);
  assert.ok(
    Number(reported[1]) > FILE_THRESHOLD,
    `${reported[1]} chars is not over the ${FILE_THRESHOLD} limit`,
  );
  assert.equal(inline.changed, true);
  assert.deepEqual(inline.comparedSections, ["plans"]);
  assert.equal(inline.from.snapshotId, saved.id);
  assert.equal(inline.sections, undefined);
  assert.match(inline.hint, /Read the file/);
  assert.equal(
    inline.filePath,
    join(homedir(), ".projectionlab-mcp", "exports", inline.filePath.split("/").pop()),
  );
  assert.match(inline.filePath.split("/").pop(), /^diff-.*\.json$/);
  assert.deepEqual(
    readdirSync(join(homedir(), ".projectionlab-mcp", "exports")),
    [inline.filePath.split("/").pop()],
  );

  const spilled = JSON.parse(readFileSync(inline.filePath, "utf-8"));
  assert.equal(spilled.changed, true);
  const income = spilled.sections.plans.changedPlans[0].sections.income;
  assert.equal(income.addedCount, 198);
  assert.equal(
    Object.keys(income.modified[0].changes).length,
    200,
    "the cap still bounds recorded field changes in the spilled file",
  );
  assert.equal(spilled.omittedFieldChanges, undefined);
});
