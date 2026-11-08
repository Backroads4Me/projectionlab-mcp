import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-real-estate-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerGetCurrentFinancesTool } = await import(
  "../dist/tools/getCurrentFinances.js"
);

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

function houseAsset() {
  return {
    id: "house-1",
    name: "Family Home",
    type: "real-estate",
    amount: 500000,
    balance: 300000,
    paymentMethod: "financed",
    classification: "primaryResidence",
    interestRate: 6.5,
    interestType: "fixed",
    monthlyPayment: 2500,
    compounding: "monthly",
    taxRate: 0.011,
    taxRateType: "percentOfValue",
    insuranceRate: 0.003,
    maintenanceRate: 0.01,
    monthlyHOA: 120,
    monthlyHOAType: "fixed",
    yearlyChange: { amount: 0.03, type: "percent" },
    integration: { authToken: "sensitive" },
  };
}

function vehicleAsset() {
  return {
    id: "car-1",
    name: "Truck",
    type: "vehicle",
    amount: 20000,
    balance: 8000,
  };
}

function baseState(plans) {
  return {
    today: {
      investmentAccounts: [],
      savingsAccounts: [],
      debts: [{ id: "debt-1", name: "Student Loan", balance: 4000 }],
      assets: [houseAsset(), vehicleAsset()],
    },
    plans,
  };
}

function register(state) {
  const server = fakeServer();
  const bridge = {
    async exportData() {
      return state;
    },
  };
  registerGetCurrentFinancesTool(server, bridge);
  return server.handlers.get("projectionlab_get_current_finances");
}

function houseIn(output) {
  return output.assets.find((a) => a.id === "house-1");
}

test("real-estate asset gets a labeled block from the Current Finances record", async () => {
  const handler = register(baseState([]));
  const output = resultJson(await handler({}));
  const house = houseIn(output);

  assert.deepEqual(house.realEstate, {
    loanBalance: 300000,
    marketValue: 500000,
    netEquity: 200000,
    paymentMethod: "financed",
    classification: "primaryResidence",
    loan: {
      interestType: "fixed",
      monthlyPayment: 2500,
      compounding: "monthly",
      apr: 6.5,
    },
    propertyTax: { rate: 0.011, rateType: "percentOfValue" },
    insurance: { rate: 0.003 },
    maintenance: { rate: 0.01 },
    monthlyHOA: { amount: 120, type: "fixed" },
    appreciation: { rate: 0.03, type: "percent" },
  });

  // Raw stored fields stay alongside the block, and secrets stay redacted.
  assert.equal(house.balance, 300000);
  assert.equal(house.amount, 500000);
  assert.equal(house.integration.authToken, "[REDACTED]");

  // Non-real-estate assets and other collections are untouched.
  const car = output.assets.find((a) => a.id === "car-1");
  assert.equal("realEstate" in car, false);
  assert.equal(output.debts[0].id, "debt-1");
});

test("plan asset events never feed the block", async () => {
  const state = baseState([
    {
      id: "plan-a",
      name: "Active",
      active: true,
      assets: {
        events: [
          {
            assetId: "house-1",
            amount: 800000,
            paymentMethod: "financed",
            interestRate: 3.1,
            _meta: { overriddenFields: { amount: true } },
          },
        ],
      },
    },
  ]);
  const handler = register(state);
  const block = houseIn(resultJson(await handler({}))).realEstate;

  assert.equal(block.marketValue, 500000);
  assert.equal(block.netEquity, 200000);
  assert.equal(block.loan.apr, 6.5);
  assert.equal("overriddenFields" in block, false);
});

test("absent loan balance reads as zero and equity equals market value", async () => {
  const state = baseState([]);
  delete state.today.assets[0].balance;
  const handler = register(state);
  const block = houseIn(resultJson(await handler({}))).realEstate;

  assert.equal(block.loanBalance, 0);
  assert.equal(block.netEquity, 500000);
});

test("a non-numeric balance passes through and net equity is omitted", async () => {
  const state = baseState([]);
  state.today.assets[0].balance = "not-a-number";
  const handler = register(state);
  const block = houseIn(resultJson(await handler({}))).realEstate;

  assert.equal(block.loanBalance, "not-a-number");
  assert.equal("netEquity" in block, false);
});

test("loan terms appear only when paymentMethod is financed", async () => {
  const state = baseState([]);
  state.today.assets[0].paymentMethod = "ownerPaid";
  const handler = register(state);
  const block = houseIn(resultJson(await handler({}))).realEstate;

  assert.equal(block.paymentMethod, "ownerPaid");
  assert.equal("loan" in block, false);
  // Labels that stay useful without a loan keep flowing.
  assert.deepEqual(block.propertyTax, {
    rate: 0.011,
    rateType: "percentOfValue",
  });
});

test("single-account read carries the block; listPaths stays raw", async () => {
  const state = baseState([]);
  const handler = register(state);

  const account = resultJson(await handler({ accountId: "house-1" }));
  assert.equal(account.collection, "assets");
  assert.deepEqual(account.data.realEstate, houseIn(resultJson(await handler({}))).realEstate);
  assert.equal(account.data.balance, 300000);
  assert.equal(account.data.integration.authToken, "[REDACTED]");

  const paths = resultJson(
    await handler({ accountId: "house-1", listPaths: true }),
  );
  assert.equal(
    paths.data.some(
      (item) => item.path === "realEstate" || item.path.startsWith("realEstate."),
    ),
    false,
  );
  assert.equal(
    paths.data.some((item) => item.path === "balance"),
    true,
  );
});

test("reads never mutate the cached export", async () => {
  const state = baseState([]);
  const handler = register(state);
  const first = resultJson(await handler({}));
  const second = resultJson(await handler({}));

  assert.deepEqual(first, second);
  assert.equal("realEstate" in state.today.assets[0], false);
});
