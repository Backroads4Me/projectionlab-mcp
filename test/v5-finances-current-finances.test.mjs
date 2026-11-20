// projectionlab_get_current_finances on a ProjectionLab 5 export: accounts
// keyed by id and narrowed by kind, archived accounts, real-asset equity from
// secured debts, and redaction.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-v5-finances-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerGetCurrentFinancesTool } = await import(
  "../dist/tools/getCurrentFinances.js"
);
const { refusedEnumChoices } = await import("../dist/dataModel.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function handlerFor(exported) {
  const server = fakeServer();
  registerGetCurrentFinancesTool(server, {
    async exportData() {
      return structuredClone(exported);
    },
  });
  return server.tools.get("projectionlab_get_current_finances");
}

async function call(exported, args = {}) {
  const tool = handlerFor(exported);
  return tool.handler({ listPaths: false, includeArchived: false, ...args });
}

async function json(exported, args) {
  const result = await call(exported, args);
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("v5 whole-section read lists unarchived accounts and the archived ones apart", async () => {
  const output = await json(v5Export());

  assert.deepEqual(Object.keys(output.accounts), [
    "acct_brokerage",
    "acct_401k",
    "asset_land",
    "debt_land_loan",
  ]);
  assert.deepEqual(output.archivedAccounts, [
    {
      id: "acct_old_savings",
      name: "Old Savings",
      kind: "account",
      type: "savings",
      archivedOn: "2025-06-01",
    },
  ]);
  // The rest of the document is returned as stored.
  assert.equal(output.household.people.me.name, "Alex");
  assert.equal(output.location.country, "US");
});

test("includeArchived keeps archived accounts in the listing", async () => {
  const output = await json(v5Export(), { includeArchived: true });

  assert.equal("acct_old_savings" in output.accounts, true);
  assert.equal(output.accounts.acct_old_savings.archivedOn, "2025-06-01");
  assert.equal("archivedAccounts" in output, false);
});

test("a v5 real asset carries a realAsset block built from the debts that name it", async () => {
  const exported = v5Export();
  exported.documents.currentFinances.accounts.debt_unrelated = {
    id: "debt_unrelated",
    name: "Card",
    kind: "debt",
    type: "credit-card",
    owner: "me",
    balance: 1500,
  };
  const output = await json(exported);

  assert.deepEqual(output.accounts.asset_land.realAsset, {
    value: 120000,
    purchasePrice: 100000,
    loanBalance: 60000,
    equity: 60000,
    securedDebts: [{ id: "debt_land_loan", name: "Land Loan", balance: 60000 }],
  });
  // Stored fields stay beside the block.
  assert.equal(output.accounts.asset_land.value, 120000);
  assert.equal(output.accounts.asset_land.type, "land");
  // Other kinds get no block.
  assert.equal("realAsset" in output.accounts.acct_brokerage, false);
  assert.equal("realAsset" in output.accounts.debt_land_loan, false);
});

test("the read does not mutate the exported document", async () => {
  const exported = v5Export();
  const before = structuredClone(exported);
  await json(exported);
  assert.deepEqual(exported, before);
});

test("a v5 account is read by exact id, with its kind and type", async () => {
  const output = await json(v5Export(), { accountId: "acct_brokerage" });

  assert.equal(output.accountId, "acct_brokerage");
  assert.equal(output.accountName, "Brokerage");
  assert.equal(output.collection, "accounts");
  assert.equal(output.kind, "account");
  assert.equal(output.type, "taxable");
  assert.equal("archived" in output, false);
  assert.equal(output.data.balance, 50000);
  assert.equal(output.data.costBasis, 40000);
  assert.equal("realAsset" in output.data, false);
});

test("a v5 real asset read by id includes its equity block", async () => {
  const output = await json(v5Export(), { accountId: "asset_land" });

  assert.equal(output.kind, "real-asset");
  assert.equal(output.data.value, 120000);
  assert.equal(output.data.realAsset.equity, 60000);
  assert.equal(output.data.realAsset.securedDebts[0].id, "debt_land_loan");
});

test("a v5 debt read by id keeps its link to the asset it secures", async () => {
  const output = await json(v5Export(), { accountId: "debt_land_loan" });

  assert.equal(output.kind, "debt");
  assert.equal(output.data.balance, 60000);
  assert.equal(output.data.securedByAssetId, "asset_land");
});

test("an archived v5 account is returned and flagged when addressed by exact id", async () => {
  const output = await json(v5Export(), { accountId: "acct_old_savings" });

  assert.equal(output.archived, true);
  assert.equal(output.data.archivedOn, "2025-06-01");
});

test("an unknown v5 account id is refused and counts every stored account", async () => {
  const result = await call(v5Export(), { accountId: "nope" });

  assert.equal(result.isError, true);
  const error = JSON.parse(result.content[0].text);
  assert.equal(error.error, "INVALID_INPUT");
  assert.match(error.message, /"nope"/);
  assert.match(error.suggestion, /5 available account record/);
});

test("listPaths annotates a v5 account from the v5 accounts group", async () => {
  const output = await json(v5Export(), {
    accountId: "acct_brokerage",
    listPaths: true,
  });

  assert.equal(output.listPaths, true);
  const balance = output.data.find((item) => item.path === "balance");
  assert.equal(balance.type, "number");
  assert.equal(balance.value, 50000);
  assert.equal(balance.units, "dollars");
  assert.equal(balance.uiLabel, "Balance");
  const kind = output.data.find((item) => item.path === "kind");
  assert.deepEqual(kind.allowedValues, ["account", "debt", "real-asset"]);
  assert.equal(output.data.some((item) => item.path === "costBasis"), true);
});

test("a v5 account listing describes each value with the entry update_account enforces", async () => {
  const state = v5Export();
  state.documents.currentFinances.accounts.acct_brokerage.investmentGrowthType = "plan";
  const output = await json(state, {
    accountId: "acct_brokerage",
    listPaths: true,
  });

  const growth = output.data.find((item) => item.path === "investmentGrowthType");
  const sources = ["plan", "fixed", "custom", "none"];
  assert.deepEqual(growth.allowedValues, sources);
  assert.deepEqual(
    refusedEnumChoices("accounts", "investmentGrowthType", "rate"),
    sources,
  );
});

test("listPaths without an accountId is refused on v5 too", async () => {
  const result = await call(v5Export(), { listPaths: true });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).message, /listPaths requires accountId/);
});

test("v5 reads scrub secret-named fields and the literal API key", async () => {
  const exported = v5Export();
  const brokerage = exported.documents.currentFinances.accounts.acct_brokerage;
  brokerage.integration = { authToken: "sensitive-token" };
  brokerage.notes = "synced with key test-api-key";
  const whole = await call(exported);
  const byId = await call(exported, { accountId: "acct_brokerage" });

  for (const result of [whole, byId]) {
    const text = result.content[0].text;
    assert.equal(text.includes("sensitive-token"), false);
    assert.equal(text.includes("test-api-key"), false);
    assert.equal(text.includes("[REDACTED]"), true);
  }
});

test("a v5 export without Current Finances is refused", async () => {
  const exported = v5Export();
  delete exported.documents.currentFinances;
  const result = await call(exported);

  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).message, /No current finances data/);
});
