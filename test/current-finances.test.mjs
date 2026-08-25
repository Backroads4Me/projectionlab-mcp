import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
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
const { config } = await import("../dist/config.js");

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

function initialState() {
  return {
    today: {
      investmentAccounts: [
        {
          id: "account-1",
          name: "Test Brokerage",
          balance: 100000,
          allocation: { stocks: 0.6, bonds: 0.4 },
          integration: { authToken: "sensitive" },
        },
      ],
      savingsAccounts: [],
      debts: [],
      assets: [],
    },
  };
}

test("get Current Finances targets one account and lists redacted typed paths", async () => {
  const server = fakeServer();
  const bridge = {
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
  assert.equal(output.collection, "investmentAccounts");
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
    async exportData() {
      return state;
    },
    async updateAccount(accountId, data, force) {
      actions.push({ kind: "update", accountId, data, force });
      const account = state.today.investmentAccounts.find(
        (item) => item.id === accountId,
      );
      Object.assign(account, data);
    },
  };
  const snapshots = {
    async create(operation, sections, data) {
      actions.push({ kind: "snapshot" });
      assert.equal(operation, "updateAccount");
      assert.deepEqual(sections, ["currentFinances"]);
      assert.equal(
        data.currentFinances.investmentAccounts[0].allocation.stocks,
        0.6,
      );
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
  assert.equal(actions[0].kind, "snapshot");
  assert.deepEqual(actions[1], {
    kind: "update",
    accountId: "account-1",
    data: { allocation: { stocks: 0.7, bonds: 0.4 } },
    force: undefined,
  });
  assert.deepEqual(state.today.investmentAccounts[0].allocation, {
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

test("Current Finances updates respect PL_READ_ONLY before reading", async () => {
  const server = fakeServer();
  let bridgeCalled = false;
  const bridge = {
    async exportData() {
      bridgeCalled = true;
      return initialState();
    },
    async updateAccount() {
      bridgeCalled = true;
    },
  };
  registerUpdateAccountTool(server, bridge, { create: async () => {} });

  config.readOnly = true;
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
    config.readOnly = false;
  }
});
