// Current Finances writes on a ProjectionLab 5 account (Plugin API contract
// 2). The fake bridge applies each write to its export the way ProjectionLab
// 5 does: updateAccount assigns top-level fields over one
// `currentFinances.accounts` record, and restoreCurrentFinances takes every
// non-account field from the submission, replaces each submitted account
// whole, keeps any stored account the submission leaves out, and re-stamps
// the document's `lastUpdated`.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-account-writes-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

/** A ProjectionLab 5 bridge that applies Current Finances writes to its export. */
function v5Bridge(state = v5Export()) {
  const writes = [];
  const finances = () => state.documents.currentFinances;
  const refuse = (name) => async () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    state,
    writes,
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      return 2;
    },
    async exportData() {
      return structuredClone(state);
    },
    async updateAccount(accountId, data, force) {
      writes.push({ name: "updateAccount", accountId, data: structuredClone(data), force });
      const account = finances().accounts[accountId];
      if (!account) throw new Error(`No account matches id "${accountId}".`);
      if (!force) {
        for (const key of Object.keys(data)) {
          if (!(key in account)) throw new Error(`No matching property for assignment: ${key}`);
        }
      }
      Object.assign(account, structuredClone(data));
    },
    async restoreCurrentFinances(submitted) {
      writes.push({ name: "restoreCurrentFinances", submitted: structuredClone(submitted) });
      const next = structuredClone(submitted);
      next.accounts = { ...finances().accounts, ...next.accounts };
      next.lastUpdated = (finances().lastUpdated ?? 0) + 1;
      state.documents.currentFinances = next;
    },
    restorePlans: refuse("restorePlans"),
    restorePlansIfUnchanged: refuse("restorePlansIfUnchanged"),
    restoreSettings: refuse("restoreSettings"),
  };
}

/** A snapshot store that serves back what it saved, newest first. */
function snapshotStore() {
  const created = [];
  const store = {
    created,
    async create(operation, sections, data) {
      const snapshot = {
        id: `snap-${created.length + 1}`,
        timestamp: new Date(created.length).toISOString(),
        operation,
        sections,
        layout: "v5",
        data: structuredClone(data),
      };
      created.push(snapshot);
      return snapshot;
    },
    async get(id) {
      const found = created.find((s) => s.id === id);
      if (!found) throw new Error(`no snapshot ${id}`);
      return structuredClone(found);
    },
    async list() {
      return created.map((s) => structuredClone(s)).reverse();
    },
  };
  return store;
}

function tools(bridge, snapshots) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
  };
  registerUpdateAccountTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);
  return async (name, input) => JSON.parse((await map.get(name)(input)).content[0].text);
}

test("update_account previews, then patches one v5 account and verifies it", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const input = { accountId: "acct_brokerage", data: { balance: 55_000 } };

  const dry = await call("projectionlab_update_account", input);
  assert.equal(dry.dryRun, true, JSON.stringify(dry));
  assert.equal(dry.kind, "account");
  assert.equal(dry.collection, undefined);
  assert.deepEqual(dry.changes, { balance: { before: 50_000, after: 55_000 } });
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);

  const done = await call("projectionlab_update_account", { ...input, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(done.kind, "account");

  assert.equal(snapshots.created.length, 1);
  assert.deepEqual(snapshots.created[0].sections, ["currentFinances"]);
  assert.deepEqual(snapshots.created[0].data.currentFinances, v5Export().documents.currentFinances);

  assert.deepEqual(bridge.writes, [
    { name: "updateAccount", accountId: "acct_brokerage", data: { balance: 55_000 }, force: undefined },
  ]);
  const expected = v5Export().documents.currentFinances;
  expected.accounts.acct_brokerage.balance = 55_000;
  assert.deepEqual(bridge.state.documents.currentFinances, expected);
});

test("update_account patches a v5 real asset's value through pathChanges", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const done = await call("projectionlab_update_account", {
    accountId: "asset_land",
    pathChanges: { value: 125_000 },
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(done.kind, "real-asset");
  assert.deepEqual(bridge.writes[0].data, { value: 125_000 });
  assert.equal(bridge.state.documents.currentFinances.accounts.asset_land.value, 125_000);
});

test("update_account with force adds a new top-level field to a v5 account", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const done = await call("projectionlab_update_account", {
    accountId: "acct_401k",
    data: { note: "synthetic" },
    force: true,
    confirm: true,
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(bridge.writes[0].force, true);
  assert.equal(bridge.state.documents.currentFinances.accounts.acct_401k.note, "synthetic");
});

test("update_account refuses an unknown v5 account before writing", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const result = await call("projectionlab_update_account", {
    accountId: "acct_missing",
    data: { balance: 1 },
    confirm: true,
  });
  assert.equal(result.error, "INVALID_INPUT", JSON.stringify(result));
  assert.match(result.message, /acct_missing/);
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("update_account refuses a field a v5 account lacks unless force is set", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const result = await call("projectionlab_update_account", {
    accountId: "acct_401k",
    data: { note: "synthetic" },
    confirm: true,
  });
  assert.equal(result.error, "INVALID_INPUT", JSON.stringify(result));
  assert.deepEqual(bridge.writes, []);
});

test("rollback undoes a v5 account change exactly", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const changed = await call("projectionlab_update_account", {
    accountId: "debt_land_loan",
    data: { balance: 58_000, name: "Renamed Loan" },
    confirm: true,
  });
  assert.equal(changed.verified, true, JSON.stringify(changed));

  const preview = await call("projectionlab_rollback", { snapshotId: changed.snapshotId });
  assert.equal(preview.dryRun, true, JSON.stringify(preview));
  assert.equal(preview.keptAccounts, undefined);

  const done = await call("projectionlab_rollback", { snapshotId: changed.snapshotId, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(done.restoredSections, ["currentFinances"]);
  assert.equal(bridge.writes.at(-1).name, "restoreCurrentFinances");
  const { lastUpdated: _restamped, ...restored } = bridge.state.documents.currentFinances;
  const { lastUpdated: _original, ...original } = v5Export().documents.currentFinances;
  assert.deepEqual(restored, original);
});

test("rollback names a v5 account added since the snapshot, which it keeps", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const held = await snapshots.create(
    "test",
    ["currentFinances"],
    { currentFinances: v5Export().documents.currentFinances },
    "v5",
  );
  const added = {
    id: "acct_new", name: "New Account", kind: "account", type: "savings",
    owner: "me", order: 5, icon: "bank", balance: 10, costBasis: 0,
  };
  bridge.state.documents.currentFinances.accounts.acct_new = added;
  bridge.state.documents.currentFinances.accounts.acct_brokerage.balance = 1;
  const rollback = tools(bridge, snapshots);

  const preview = await rollback("projectionlab_rollback", { snapshotId: held.id });
  assert.deepEqual(preview.keptAccounts, [{ id: "acct_new", name: "New Account" }], JSON.stringify(preview));
  assert.match(preview.message, /keptAccounts/);

  const done = await rollback("projectionlab_rollback", { snapshotId: held.id, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(done.keptAccounts, [{ id: "acct_new", name: "New Account" }]);
  const accounts = bridge.state.documents.currentFinances.accounts;
  assert.equal(accounts.acct_brokerage.balance, 50_000);
  assert.deepEqual(accounts.acct_new, added);
});

test("restore_current_finances on v5 lists the accounts it keeps, then merges", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const submitted = v5Export().documents.currentFinances;
  delete submitted.accounts.acct_old_savings;
  delete submitted.accounts.acct_401k;
  submitted.accounts.acct_brokerage.balance = 51_000;
  submitted.location.state = "UT";

  const dry = await call("projectionlab_restore_current_finances", { currentFinances: submitted });
  assert.equal(dry.dryRun, true, JSON.stringify(dry));
  assert.deepEqual(dry.keptAccounts, [
    { id: "acct_401k", name: "Work 401k" },
    { id: "acct_old_savings", name: "Old Savings" },
  ]);
  assert.match(dry.warning, /keptAccounts/);
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);

  const done = await call("projectionlab_restore_current_finances", { currentFinances: submitted, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(snapshots.created[0].data.currentFinances, v5Export().documents.currentFinances);
  const after = bridge.state.documents.currentFinances;
  assert.equal(after.location.state, "UT");
  assert.equal(after.accounts.acct_brokerage.balance, 51_000);
  assert.deepEqual(after.accounts.acct_401k, v5Export().documents.currentFinances.accounts.acct_401k);
});
