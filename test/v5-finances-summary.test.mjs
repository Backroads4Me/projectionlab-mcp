// Current Finances summary (projectionlab_get_summary, projectionlab://summary,
// buildSummary) on a ProjectionLab 5 export.

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.LOG_LEVEL = "error";

const { registerSummaryTool } = await import("../dist/tools/summary.js");
const { registerSummaryResource } = await import("../dist/resources/summary.js");
const { buildSummary } = await import("../dist/summary.js");

function fakeServer() {
  const tools = new Map();
  const resources = new Map();
  return {
    tools,
    resources,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
    registerResource(name, uri, meta, handler) {
      resources.set(name, { uri, meta, handler });
    },
  };
}

async function toolSummary(exported) {
  const server = fakeServer();
  registerSummaryTool(server, {
    async exportData() {
      return structuredClone(exported);
    },
  });
  const tool = server.tools.get("projectionlab_get_summary");
  const result = await tool.handler({});
  return { tool, result };
}

async function summaryOf(exported) {
  const { result } = await toolSummary(exported);
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("v5 summary totals unarchived accounts, real-asset values and debts", async () => {
  const output = await summaryOf(v5Export());

  assert.equal(output.scope, "currentFinances");
  assert.equal(output.projectedOutcomesAvailable, false);
  assert.equal(output.layout, "v5");
  // 50000 brokerage + 20000 401k + 120000 land - 60000 land loan; the
  // archived savings account holds 0 and is counted nowhere.
  assert.equal(output.totalNetWorth, 130000);
  assert.equal("endingNetWorth" in output, false);
  assert.equal("chanceOfSuccess" in output, false);
});

test("v5 summary groups accounts by stored kind and type, never by v4 category names", async () => {
  const output = await summaryOf(v5Export());

  assert.deepEqual(output.accountsByType, {
    "account:taxable": { count: 1, total: 50000 },
    "account:401k": { count: 1, total: 20000 },
    "real-asset:land": { count: 1, total: 120000 },
    "debt:secured-loan": { count: 1, total: 60000 },
  });
  assert.deepEqual(output.accountsByKind, {
    account: { count: 2, total: 70000 },
    "real-asset": { count: 1, total: 120000 },
    debt: { count: 1, total: 60000 },
  });
  for (const v4Name of ["investmentAccounts", "savingsAccounts", "debts", "assets"]) {
    assert.equal(v4Name in output.accountsByType, false);
  }
});

test("v5 summary reports archived accounts apart and leaves them out of every total", async () => {
  const exported = v5Export();
  exported.documents.currentFinances.accounts.acct_old_savings.balance = 999;
  const output = await summaryOf(exported);

  assert.deepEqual(output.archivedAccounts, [
    {
      id: "acct_old_savings",
      name: "Old Savings",
      kind: "account",
      type: "savings",
      archivedOn: "2025-06-01",
    },
  ]);
  assert.equal(output.totalNetWorth, 130000);
  assert.equal("account:savings" in output.accountsByType, false);
  assert.equal(output.accountsByKind.account.count, 2);
});

test("v5 summary links a secured debt to its real asset and reports equity", async () => {
  const exported = v5Export();
  const accounts = exported.documents.currentFinances.accounts;
  accounts.debt_land_loan2 = {
    id: "debt_land_loan2",
    name: "Land Line of Credit",
    kind: "debt",
    type: "secured-loan",
    owner: "joint",
    balance: 5000,
    securedByAssetId: "asset_land",
  };
  accounts.debt_card = {
    id: "debt_card",
    name: "Card",
    kind: "debt",
    type: "credit-card",
    owner: "me",
    balance: 2000,
  };
  accounts.debt_paid_off = {
    id: "debt_paid_off",
    name: "Old Land Loan",
    kind: "debt",
    type: "secured-loan",
    owner: "joint",
    balance: 30000,
    securedByAssetId: "asset_land",
    archivedOn: "2024-01-01",
  };
  const output = await summaryOf(exported);

  assert.equal(output.realAssets.length, 1);
  const land = output.realAssets[0];
  assert.equal(land.id, "asset_land");
  assert.equal(land.type, "land");
  assert.equal(land.value, 120000);
  assert.equal(land.purchasePrice, 100000);
  // The archived debt is excluded; the unsecured card is tied to no asset.
  assert.equal(land.loanBalance, 65000);
  assert.equal(land.equity, 55000);
  assert.deepEqual(
    land.securedDebts.map((debt) => debt.id),
    ["debt_land_loan", "debt_land_loan2"],
  );
  // Net worth counts every unarchived debt, secured or not.
  assert.equal(output.totalNetWorth, 130000 - 5000 - 2000);
});

test("an unsecured debt lowers net worth but not any asset's equity", async () => {
  const exported = v5Export();
  delete exported.documents.currentFinances.accounts.debt_land_loan.securedByAssetId;
  const output = await summaryOf(exported);

  assert.equal(output.totalNetWorth, 130000);
  assert.equal(output.realAssets[0].loanBalance, 0);
  assert.equal(output.realAssets[0].equity, 120000);
  assert.deepEqual(output.realAssets[0].securedDebts, []);
});

test("a debt balance stored as a negative number still subtracts", async () => {
  const exported = v5Export();
  exported.documents.currentFinances.accounts.debt_land_loan.balance = -60000;
  const output = await summaryOf(exported);

  assert.equal(output.totalNetWorth, 130000);
  assert.equal(output.accountsByKind.debt.total, 60000);
});

test("v5 accounts of an unrecognized kind are reported, not totaled", async () => {
  const exported = v5Export();
  exported.documents.currentFinances.accounts.mystery = {
    id: "mystery",
    name: "Mystery",
    kind: "future-kind",
    type: "other",
    balance: 777,
  };
  const output = await summaryOf(exported);

  assert.equal(output.totalNetWorth, 130000);
  assert.deepEqual(output.unrecognizedAccounts, [
    { id: "mystery", name: "Mystery", kind: "future-kind" },
  ]);
});

test("v5 summary reads both household people and survives an absent spouse or household", async () => {
  const full = await summaryOf(v5Export());
  assert.deepEqual(full.household, {
    partnerStatus: "placeholder",
    people: [
      { role: "me", name: "Alex", birthYear: 1980, birthMonth: 4, lifeExpectancy: 95 },
      { role: "spouse", name: "Sam", birthYear: 1982, birthMonth: 9, lifeExpectancy: 95 },
    ],
  });

  const noSpouse = v5Export();
  delete noSpouse.documents.currentFinances.household.people.spouse;
  const solo = await summaryOf(noSpouse);
  assert.deepEqual(
    solo.household.people.map((person) => person.role),
    ["me"],
  );

  const noHousehold = v5Export();
  delete noHousehold.documents.currentFinances.household;
  const bare = await summaryOf(noHousehold);
  assert.equal("household" in bare, false);
  assert.equal(bare.totalNetWorth, 130000);
});

test("v5 summary lists every plan without choosing an active one", async () => {
  const output = await summaryOf(v5Export());

  assert.equal(output.planCount, 2);
  assert.deepEqual(
    output.plans.map((plan) => plan.id),
    ["plan_main", "plan_early"],
  );
  assert.deepEqual(output.plans[0], {
    id: "plan_main",
    name: "Main Plan",
    incomeCount: 1,
    expenseCount: 1,
    milestoneCount: 1,
  });
  assert.equal("active" in output.plans[0], false);
  assert.equal("activePlan" in output, false);
});

test("v5 summary never carries the plugin API key", async () => {
  const output = await summaryOf(v5Export());
  assert.equal(JSON.stringify(output).includes("synthetic-plugin-key"), false);
});

test("v5 summary structured output satisfies the declared output schema", async () => {
  const { tool, result } = await toolSummary(v5Export());
  const schema = z.object(tool.definition.outputSchema).strict();
  const parsed = schema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("a v5 export without a plans list is refused, never summarized as no plans", async () => {
  const exported = v5Export();
  delete exported.documents.plans;
  const { result } = await toolSummary(exported);

  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).message, /documents\.plans/);
});

test("the summary resource reads a v5 export the way the tool does", async () => {
  const server = fakeServer();
  registerSummaryResource(server, {
    async exportData() {
      return v5Export();
    },
  });
  const resource = server.resources.get("summary");
  const result = await resource.handler(new URL("projectionlab://summary"));
  const output = JSON.parse(result.contents[0].text);

  assert.equal(output.layout, "v5");
  assert.equal(output.totalNetWorth, 130000);
  assert.equal(output.realAssets[0].equity, 60000);
  assert.equal(output.archivedAccounts.length, 1);
  assert.equal(JSON.stringify(output).includes("synthetic-plugin-key"), false);
});

test("the summary resource reports an unreadable v5 export as an error document", async () => {
  const exported = v5Export();
  delete exported.documents.plans;
  const server = fakeServer();
  registerSummaryResource(server, {
    async exportData() {
      return exported;
    },
  });
  const result = await server.resources
    .get("summary")
    .handler(new URL("projectionlab://summary"));
  const output = JSON.parse(result.contents[0].text);

  assert.equal(output.error, "Failed to build summary");
  assert.match(output.details, /documents\.plans/);
});
