// Selector guards for projectionlab_rollback: exactly one of snapshotId, nBack
// or beforeTime, the newest-first order nBack and beforeTime share with
// projectionlab_list_snapshots, the strict boundary of beforeTime, and the
// error each bad selector produces.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
const SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-rollback-selectors-")),
  "snapshots",
);
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { SnapshotManager } = await import("../dist/snapshot.js");

const HOUR = 60 * 60 * 1000;

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function samplePlans() {
  return [
    {
      id: "p1",
      name: "Retire at 55",
      lastUpdated: 100,
      income: { events: [{ id: "i1", name: "Salary" }] },
      expenses: { events: [{ id: "e1", name: "Living" }] },
      milestones: [{ id: "m1", name: "Retire" }],
    },
  ];
}

function fakeBridge(initial) {
  let stamp = 1000;
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: [],
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.plans = structuredClone(plans).map((p) => ({ ...p, lastUpdated: ++stamp }));
    },
    async restoreProgress(progress) {
      bridge.writes.push("progress");
      state.progress = structuredClone(progress);
    },
  };
  return bridge;
}

/** Start each test from an empty snapshot directory. */
function freshSnapshots() {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  return new SnapshotManager();
}

function rollbackHandler(snapshots, bridge) {
  const server = fakeServer();
  registerSnapshotTools(server, bridge ?? fakeBridge({ today: {}, plans: [] }), snapshots);
  return (args) => server.tools.get("projectionlab_rollback").handler(args);
}

const parse = (result) => JSON.parse(result.content[0].text);

async function errorFor(rollback, args) {
  const result = await rollback(args);
  assert.equal(result.isError, true, JSON.stringify(result));
  return parse(result);
}

/** Write a snapshot file directly so its timestamp is exact. */
function writeSnapshot({ id, timestamp, operation }) {
  writeFileSync(
    join(SNAPSHOT_DIR, `${id}.json`),
    JSON.stringify({
      id,
      timestamp,
      operation,
      sections: ["progress"],
      data: { progress: { source: operation } },
    }),
  );
}

function listTool(snapshots) {
  const server = fakeServer();
  registerSnapshotTools(server, fakeBridge({ today: {}, plans: [] }), snapshots);
  return async () =>
    parse(await server.tools.get("projectionlab_list_snapshots").handler({}));
}

async function createSnapshots(snapshots, operations) {
  const created = [];
  for (const operation of operations) {
    created.push(
      await snapshots.create(operation, ["progress"], { progress: { operation } }),
    );
    // Timestamps are millisecond precision; keep the ordering unambiguous.
    await new Promise((r) => setTimeout(r, 5));
  }
  return created;
}

test("rollback requires exactly one snapshot selector", async () => {
  const snapshots = freshSnapshots();
  const bridge = fakeBridge({ today: {}, plans: [] });
  const rollback = rollbackHandler(snapshots, bridge);
  await createSnapshots(snapshots, ["update_plan_section"]);

  const none = await errorFor(rollback, { confirm: false });
  assert.equal(none.error, "INVALID_INPUT");
  assert.match(none.message, /No rollback snapshot selector supplied/);
  assert.match(none.suggestion, /Supply exactly one/);
  for (const name of ["snapshotId", "nBack", "beforeTime"]) {
    assert.ok(none.suggestion.includes(name), none.suggestion);
  }

  const list = await snapshots.list();
  const both = await errorFor(rollback, {
    snapshotId: list[0].id,
    nBack: 1,
    confirm: false,
  });
  assert.equal(both.error, "INVALID_INPUT");
  assert.match(both.message, /snapshotId and nBack/);

  const allThree = await errorFor(rollback, {
    snapshotId: list[0].id,
    nBack: 1,
    beforeTime: new Date().toISOString(),
    confirm: false,
  });
  assert.equal(allThree.error, "INVALID_INPUT");
  assert.match(allThree.message, /snapshotId and nBack and beforeTime/);

  assert.deepEqual(bridge.writes, []);
});

test("rollback nBack follows the newest-first order of list_snapshots", async () => {
  const snapshots = freshSnapshots();
  const rollback = rollbackHandler(snapshots);
  const [oldest, middle, newest] = await createSnapshots(snapshots, [
    "update_plan_section",
    "update_account",
    "restore_plans",
  ]);

  const listed = await listTool(snapshots)();
  assert.deepEqual(
    listed.map((s) => s.id),
    [newest.id, middle.id, oldest.id],
  );

  for (const [nBack, expected] of [
    [1, newest],
    [2, middle],
    [3, oldest],
  ]) {
    const preview = parse(await rollback({ nBack, confirm: false }));
    assert.equal(preview.dryRun, true);
    assert.equal(preview.snapshotId, expected.id);
    assert.equal(preview.timestamp, expected.timestamp);
    assert.equal(preview.operation, expected.operation);
    assert.deepEqual(preview.sections, ["progress"]);
  }
});

test("rollback nBack counts the pre-rollback snapshot, so 1 undoes a rollback", async () => {
  const snapshots = freshSnapshots();
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });

  // A confirmed write snapshots the plans, then changes them.
  const restoreServer = fakeServer();
  registerRestoreTools(restoreServer, bridge, snapshots);
  const edited = structuredClone(samplePlans());
  edited[0].name = "Edited by agent";
  await restoreServer.tools
    .get("projectionlab_restore_plans")
    .handler({ plans: edited, confirm: true });
  assert.equal(bridge.state.plans[0].name, "Edited by agent");

  const writeSnapshotId = (await snapshots.list()).find(
    (s) => s.operation === "restorePlans",
  ).id;

  const rollback = rollbackHandler(snapshots, bridge);

  // nBack 1 is that write snapshot, so it restores the pre-edit plans.
  const first = parse(await rollback({ nBack: 1, confirm: true }));
  assert.equal(first.verified, true);
  assert.equal(first.fromSnapshot, writeSnapshotId);
  assert.equal(bridge.state.plans[0].name, "Retire at 55");

  const preRollback = (await snapshots.list()).find(
    (s) => s.operation === `rollback_pre_${writeSnapshotId}`,
  );
  assert.ok(preRollback, "the confirmed rollback saves a pre-rollback snapshot");

  // The next nBack 1 is that pre-rollback snapshot, undoing the rollback.
  const second = parse(await rollback({ nBack: 1, confirm: true }));
  assert.equal(second.verified, true);
  assert.equal(second.fromSnapshot, preRollback.id);
  assert.equal(bridge.state.plans[0].name, "Edited by agent");
});

test("rollback refuses nBack that is not a positive integer", async () => {
  const snapshots = freshSnapshots();
  const rollback = rollbackHandler(snapshots);
  await createSnapshots(snapshots, ["update_account"]);

  for (const nBack of [0, -1, 1.5, NaN]) {
    const err = await errorFor(rollback, { nBack, confirm: false });
    assert.equal(err.error, "INVALID_INPUT", String(nBack));
    assert.match(err.message, /nBack must be a positive integer/);
  }
});

test("rollback refuses nBack past the oldest snapshot", async () => {
  const snapshots = freshSnapshots();
  const rollback = rollbackHandler(snapshots);

  const empty = await errorFor(rollback, { nBack: 1, confirm: false });
  assert.equal(empty.error, "SNAPSHOT_NOT_FOUND");
  assert.match(empty.message, /no snapshots exist/);

  await createSnapshots(snapshots, ["update_account", "clone_plan"]);

  const past = await errorFor(rollback, { nBack: 3, confirm: false });
  assert.equal(past.error, "SNAPSHOT_NOT_FOUND");
  assert.match(past.message, /nBack 3 is out of range; only 2 snapshots exist/);
  assert.match(past.suggestion, /projectionlab_list_snapshots/);
});

test("rollback beforeTime takes the latest snapshot strictly before the time", async () => {
  const snapshots = freshSnapshots();
  const base = Date.now();
  const t1 = new Date(base - 6 * HOUR).toISOString();
  const t2 = new Date(base - 3 * HOUR).toISOString();
  const t3 = new Date(base - 1 * HOUR).toISOString();
  for (const [id, timestamp, operation] of [
    ["11111111-1111-4111-8111-111111111111", t1, "update_plan_section"],
    ["22222222-2222-4222-8222-222222222222", t2, "update_account"],
    ["33333333-3333-4333-8333-333333333333", t3, "clone_plan"],
  ]) {
    writeSnapshot({ id, timestamp, operation });
  }
  const rollback = rollbackHandler(snapshots);

  // A time exactly equal to a snapshot's timestamp excludes it.
  const atBoundary = parse(await rollback({ beforeTime: t3, confirm: false }));
  assert.equal(atBoundary.snapshotId, "22222222-2222-4222-8222-222222222222");
  assert.equal(atBoundary.operation, "update_account");

  const afterBoundary = parse(
    await rollback({ beforeTime: new Date(Date.parse(t3) + 500).toISOString(), confirm: false }),
  );
  assert.equal(afterBoundary.snapshotId, "33333333-3333-4333-8333-333333333333");
  assert.equal(afterBoundary.timestamp, t3);

  const between = parse(
    await rollback({
      beforeTime: new Date((Date.parse(t1) + Date.parse(t2)) / 2).toISOString(),
      confirm: false,
    }),
  );
  assert.equal(between.snapshotId, "11111111-1111-4111-8111-111111111111");

  const tooEarly = await errorFor(rollback, { beforeTime: t1, confirm: false });
  assert.equal(tooEarly.error, "SNAPSHOT_NOT_FOUND");
  assert.ok(
    tooEarly.message.includes(`the oldest is ${t1}`),
    tooEarly.message,
  );

  const noneAtAll = await errorFor(rollback, {
    beforeTime: new Date(base - 30 * 24 * HOUR).toISOString(),
    confirm: false,
  });
  assert.equal(noneAtAll.error, "SNAPSHOT_NOT_FOUND");
});

test("rollback refuses an unparseable beforeTime", async () => {
  const snapshots = freshSnapshots();
  const rollback = rollbackHandler(snapshots);
  await createSnapshots(snapshots, ["update_account"]);

  for (const beforeTime of ["not-a-time", "", "2026-13-45T99:99:99Z"]) {
    const err = await errorFor(rollback, { beforeTime, confirm: false });
    assert.equal(err.error, "INVALID_INPUT", beforeTime);
    assert.match(err.message, /is not a readable time/);
    assert.match(err.suggestion, /ISO 8601/);
  }
});
