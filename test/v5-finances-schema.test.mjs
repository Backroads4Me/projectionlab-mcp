// projectionlab_describe_schema on a ProjectionLab 5 export, and its unchanged
// ProjectionLab 4 output.

import assert from "node:assert/strict";
import test from "node:test";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.LOG_LEVEL = "error";

const { registerSchemaTool } = await import("../dist/tools/schema.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

async function describeSchema(exported) {
  const server = fakeServer();
  registerSchemaTool(server, {
    async exportData() {
      return structuredClone(exported);
    },
  });
  const result = await server.tools.get("projectionlab_describe_schema").handler({});
  return result;
}

async function schemaOf(exported) {
  const result = await describeSchema(exported);
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("v5 schema names the envelope and each documents section", async () => {
  const schema = await schemaOf(v5Export());

  assert.equal(schema.layout, "v5");
  assert.deepEqual(schema.topLevelKeys, {
    schema: "number",
    exportedAt: "number",
    documents: "object",
    "documents.currentFinances": "object",
    "documents.plans": "array(2)",
    "documents.settings": "object",
    "documents.accountHistory": "object",
  });
});

test("v5 schema rows carry the stored kind and type, with amounts by kind", async () => {
  const schema = await schemaOf(v5Export());

  assert.deepEqual(schema.accounts, [
    { id: "acct_brokerage", name: "Brokerage", kind: "account", type: "taxable", balance: 50000 },
    { id: "acct_401k", name: "Work 401k", kind: "account", type: "401k", balance: 20000 },
    {
      id: "asset_land",
      name: "Land",
      kind: "real-asset",
      type: "land",
      value: 120000,
      purchasePrice: 100000,
    },
    {
      id: "debt_land_loan",
      name: "Land Loan",
      kind: "debt",
      type: "secured-loan",
      balance: 60000,
      securedByAssetId: "asset_land",
    },
  ]);
});

test("v5 schema lists archived accounts apart", async () => {
  const schema = await schemaOf(v5Export());

  assert.equal(schema.accounts.some((row) => row.id === "acct_old_savings"), false);
  assert.deepEqual(schema.archivedAccounts, [
    {
      id: "acct_old_savings",
      name: "Old Savings",
      kind: "account",
      type: "savings",
      archivedOn: "2025-06-01",
    },
  ]);
});

test("v5 schema counts plans, event counts, and account history instead of progress", async () => {
  const schema = await schemaOf(v5Export());

  assert.deepEqual(
    schema.plans.map((plan) => ({ id: plan.id, name: plan.name })),
    [
      { id: "plan_main", name: "Main Plan" },
      { id: "plan_early", name: "Retire Early" },
    ],
  );
  assert.equal(schema.plans[0].incomeCount, 1);
  assert.equal(schema.plans[0].expenseCount, 1);
  assert.equal(schema.plans[0].milestoneCount, 1);
  assert.equal(schema.progressEntryCount, 0);
  assert.deepEqual(schema.accountHistory, { accountCount: 2, entryCount: 2 });
});

test("v5 schema reports an account of an unrecognized kind without amounts", async () => {
  const exported = v5Export();
  exported.documents.currentFinances.accounts.mystery = {
    id: "mystery",
    name: "Mystery",
    kind: "future-kind",
    balance: 5,
  };
  const schema = await schemaOf(exported);

  assert.deepEqual(schema.accounts.at(-1), {
    id: "mystery",
    name: "Mystery",
    kind: "future-kind",
    type: "unknown",
  });
});

test("v5 schema never carries the plugin API key", async () => {
  const result = await describeSchema(v5Export());
  assert.equal(result.content[0].text.includes("synthetic-plugin-key"), false);
});

test("a v5 export without a plans list is refused", async () => {
  const exported = v5Export();
  delete exported.documents.plans;
  const result = await describeSchema(exported);

  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).message, /documents\.plans/);
});

test("v4 schema is unchanged and carries no v5 fields", async () => {
  const schema = await schemaOf({
    meta: { version: "4.6.0" },
    today: {
      investmentAccounts: [{ id: "inv1", name: "Brokerage", balance: 120000 }],
      savingsAccounts: [{ id: "sav1", name: "Emergency", value: 9000 }],
      debts: [{ id: "d1", name: "Car loan", balance: 8000 }],
      assets: [
        { id: "re1", name: "Lake house", type: "real-estate", balance: 210000, amount: 465000 },
      ],
    },
    plans: [{ id: "p1", name: "Base", income: { events: [{}] }, milestones: [{}, {}] }],
    settings: {},
    progress: { data: [{}, {}, {}] },
  });

  assert.deepEqual(schema, {
    topLevelKeys: {
      meta: "object",
      today: "object",
      plans: "array(1)",
      settings: "object",
      progress: "object",
    },
    accounts: [
      { id: "inv1", name: "Brokerage", type: "investmentAccounts", balance: 120000 },
      { id: "sav1", name: "Emergency", type: "savingsAccounts", balance: 9000 },
      { id: "d1", name: "Car loan", type: "debts", balance: 8000 },
      { id: "re1", name: "Lake house", type: "real-estate", marketValue: 465000, loanBalance: 210000 },
    ],
    plans: [{ id: "p1", name: "Base", incomeCount: 1, expenseCount: 0, milestoneCount: 2 }],
    progressEntryCount: 3,
  });
});

test("v4 schema of an empty export is empty", async () => {
  const schema = await schemaOf({});

  assert.deepEqual(schema, {
    topLevelKeys: {},
    accounts: [],
    plans: [],
    progressEntryCount: 0,
  });
});
