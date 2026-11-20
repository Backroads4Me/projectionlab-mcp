import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-current-finances-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerGetCurrentFinancesTool } = await import(
  "../dist/tools/getCurrentFinances.js"
);
const { registerUpdateAccountTool } = await import(
  "../dist/tools/updateAccount.js"
);
const { currentFinancesProblems } = await import(
  "../dist/currentFinances.js"
);
const { config } = await import("../dist/config.js");

/** What every fake bridge here reports as its executor's edit access. */
const editAccess = { value: "enabled" };

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
}

function resultJson(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

/** A ProjectionLab 5 export holding one brokerage account. */
function initialState() {
  return {
    schema: 1,
    exportedAt: 1,
    documents: {
      currentFinances: {
        schema: 5,
        accounts: {
          "account-1": {
            id: "account-1",
            name: "Test Brokerage",
            kind: "account",
            type: "taxable",
            balance: 100000,
            allocation: { stocks: 0.6, bonds: 0.4 },
            integration: { authToken: "sensitive" },
          },
        },
      },
      plans: [],
      settings: { schema: 5 },
    },
  };
}

test("get Current Finances targets one account and lists redacted typed paths", async () => {
  const server = fakeServer();
  const bridge = {
    async apiContract() { return 2; },
    async editAccess() {
      return editAccess.value;
    },
    async exportData() {
      return initialState();
    },
  };
  registerGetCurrentFinancesTool(server, bridge);
  const handler = server.handlers.get("projectionlab_get_current_finances");

  const output = resultJson(
    await handler({ accountId: "account-1", listPaths: true }),
  );
  assert.equal(output.accountId, "account-1");
  assert.equal(output.collection, "accounts");
  assert.deepEqual(
    output.data.find((item) => item.path === "allocation.stocks"),
    {
      path: "allocation.stocks",
      type: "number",
      value: 0.6,
    },
  );
  assert.deepEqual(
    output.data.find((item) => item.path === "integration.authToken"),
    {
      path: "integration.authToken",
      type: "string",
      value: "[REDACTED]",
      redacted: true,
    },
  );
});

test("Current Finances path patch validates dry-run, preserves siblings, snapshots, and verifies", async () => {
  const server = fakeServer();
  let state = initialState();
  const actions = [];
  const bridge = {
    async apiContract() { return 2; },
    async editAccess() {
      return editAccess.value;
    },
    async exportData() {
      return state;
    },
    async updateAccount(accountId, data, force) {
      actions.push({ kind: "update", accountId, data, force });
      Object.assign(state.documents.currentFinances.accounts[accountId], data);
    },
  };
  const snapshots = {
    async create(operation, sections, data) {
      actions.push({ kind: "snapshot" });
      assert.equal(operation, "updateAccount");
      assert.deepEqual(sections, ["currentFinances"]);
      assert.equal(
        data.currentFinances.accounts["account-1"].allocation.stocks,
        0.6,
      );
      return { id: "snap-account" };
    },
  };
  registerUpdateAccountTool(server, bridge, snapshots);
  const handler = server.handlers.get("projectionlab_update_account");

  const dryRun = resultJson(
    await handler({
      accountId: "account-1",
      pathChanges: { "allocation.stocks": 0.7 },
      force: false,
      confirm: false,
    }),
  );
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.changes, {
    "allocation.stocks": { before: 0.6, after: 0.7 },
  });
  assert.deepEqual(actions, []);

  const executed = resultJson(
    await handler({
      accountId: "account-1",
      pathChanges: { "allocation.stocks": 0.7 },
      force: false,
      confirm: true,
    }),
  );
  assert.equal(executed.verified, true);
  assert.equal(executed.snapshotId, "snap-account");
  assert.equal(actions[0].kind, "snapshot");
  assert.deepEqual(actions[1], {
    kind: "update",
    accountId: "account-1",
    data: { allocation: { stocks: 0.7, bonds: 0.4 } },
    force: undefined,
  });
  assert.deepEqual(state.documents.currentFinances.accounts["account-1"].allocation, {
    stocks: 0.7,
    bonds: 0.4,
  });

  actions.length = 0;
  const noOp = resultJson(
    await handler({
      accountId: "account-1",
      pathChanges: { "allocation.stocks": 0.7 },
      force: false,
      confirm: true,
    }),
  );
  assert.equal(noOp.verified, true);
  assert.deepEqual(actions, []);
});

test("Current Finances updates reject unsafe input before snapshot or mutation", async () => {
  const server = fakeServer();
  let exportCalls = 0;
  const bridge = {
    async apiContract() { return 2; },
    async editAccess() {
      return editAccess.value;
    },
    async exportData() {
      exportCalls++;
      return initialState();
    },
    async updateAccount() {
      throw new Error("must not update");
    },
  };
  let snapshotCalled = false;
  registerUpdateAccountTool(server, bridge, {
    async create() {
      snapshotCalled = true;
    },
  });
  const handler = server.handlers.get("projectionlab_update_account");

  for (const input of [
    {},
    { data: { balance: 1 }, pathChanges: { balance: 1 } },
  ]) {
    const result = await handler({
      accountId: "account-1",
      force: false,
      confirm: false,
      ...input,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).message, /exactly one/);
  }
  assert.equal(exportCalls, 0);

  const unknown = await handler({
    accountId: "account-1",
    pathChanges: { "allocation.crypto": 0.1 },
    force: false,
    confirm: true,
  });
  assert.equal(unknown.isError, true);
  assert.match(JSON.parse(unknown.content[0].text).message, /Unknown/);
  assert.equal(snapshotCalled, false);
});

test("Current Finances updates refuse while plan edits are off, before reading", async () => {
  const server = fakeServer();
  let bridgeCalled = false;
  const bridge = {
    async apiContract() {
      bridgeCalled = true;
      return 2;
    },
    async editAccess() {
      return editAccess.value;
    },
    async exportData() {
      bridgeCalled = true;
      return initialState();
    },
    async updateAccount() {
      bridgeCalled = true;
    },
  };
  registerUpdateAccountTool(server, bridge, { create: async () => {} });

  editAccess.value = "disabled";
  try {
    const result = await server.handlers.get("projectionlab_update_account")({
      accountId: "account-1",
      data: { balance: 90000 },
      force: false,
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "READ_ONLY_MODE");
    assert.equal(bridgeCalled, false);
  } finally {
    editAccess.value = "enabled";
  }
});

// --- post-write comparison of the two reads ---

/** A v5 Current Finances document with one record of each kind. */
const finances = (balance, extra = {}) => ({
  accounts: {
    i1: { id: "i1", name: "Brokerage", kind: "account", type: "taxable", balance, costBasis: 90000, ...extra },
    s1: { id: "s1", name: "Emergency", kind: "account", type: "savings", balance: 25000 },
    d1: { id: "d1", name: "Car loan", kind: "debt", type: "loan", balance: 1200 },
    a1: { id: "a1", name: "House", kind: "real-asset", type: "house", value: 400000 },
  },
});

test("currentFinancesProblems verifies an untouched read", () => {
  assert.deepEqual(currentFinancesProblems(finances(100000), finances(100000)), []);
});

test("currentFinancesProblems reports a money field that moved", () => {
  const problems = currentFinancesProblems(
    finances(100000),
    finances(100000, { costBasis: 42 }),
  );
  assert.deepEqual(problems, [
    "Current Finances accounts i1 costBasis changed from 90000 to 42",
  ]);

  const after = finances(100000);
  after.accounts.s1.balance = 1;
  assert.deepEqual(currentFinancesProblems(finances(100000), after), [
    "Current Finances accounts s1 balance changed from 25000 to 1",
  ]);
});

test("currentFinancesProblems reports accounts the re-read dropped or added", () => {
  const after = finances(100000);
  delete after.accounts.d1;
  assert.deepEqual(currentFinancesProblems(finances(100000), after), [
    "Current Finances accounts d1 is missing",
  ]);

  const added = finances(100000);
  added.accounts.s2 = { id: "s2", name: "Sinking fund", kind: "account", balance: 500 };
  assert.deepEqual(currentFinancesProblems(finances(100000), added), [
    "Current Finances accounts s2 was added",
  ]);
});

test("currentFinancesProblems tolerates reordered records and extra fields", () => {
  const before = {
    accounts: {
      s1: { id: "s1", kind: "account", balance: 1 },
      d1: { id: "d1", kind: "debt", balance: 5 },
    },
  };
  const after = {
    accounts: {
      d1: { id: "d1", kind: "debt", balance: 5, note: "app-added" },
      s1: { id: "s1", kind: "account", balance: 1 },
    },
  };
  assert.deepEqual(currentFinancesProblems(before, after), []);
});

test("currentFinancesProblems compares only fields the first read carried", () => {
  const before = { accounts: { a1: { id: "a1", name: "House" } } };
  assert.deepEqual(currentFinancesProblems(before, { accounts: { a1: { id: "a1", name: "House", value: 400000 } } }), []);
  assert.deepEqual(currentFinancesProblems(before, { accounts: { a1: { id: "a1", name: "House", value: null } } }), []);

  // A null on either side is the same as the field being absent.
  assert.deepEqual(
    currentFinancesProblems(
      { accounts: { a1: { id: "a1", value: null } } },
      { accounts: { a1: { id: "a1" } } },
    ),
    [],
  );
  const lost = currentFinancesProblems(
    { accounts: { a1: { id: "a1", value: 400000 } } },
    { accounts: { a1: { id: "a1", value: null } } },
  );
  assert.deepEqual(lost, ["Current Finances accounts a1 lost its value"]);
});

test("currentFinancesProblems has nothing to compare without a baseline", () => {
  const after = finances(100000);
  assert.deepEqual(currentFinancesProblems(undefined, after), []);
  assert.deepEqual(currentFinancesProblems(null, after), []);
  assert.deepEqual(currentFinancesProblems([], after), []);
  assert.deepEqual(currentFinancesProblems({}, after), []);
  assert.deepEqual(currentFinancesProblems({ accounts: {} }, undefined), []);
});

test("currentFinancesProblems reports a baseline the re-read lost entirely", () => {
  assert.deepEqual(currentFinancesProblems(finances(100000), undefined), [
    "Current Finances is missing from the re-read",
  ]);
  assert.deepEqual(currentFinancesProblems(finances(100000), []), [
    "Current Finances is missing from the re-read",
  ]);
});
