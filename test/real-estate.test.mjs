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
  return { id: "car-1", name: "Truck", type: "vehicle", amount: 20000, balance: 8000 };
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

test("real-estate asset gets a labeled block sourced from the today record", async () => {
  const handler = register(baseState([]));
  const output = resultJson(await handler({}));
  const house = output.assets.find((a) => a.id === "house-1");

  assert.equal(house.realEstate.source, "today-record");
  assert.equal(house.realEstate.marketValue, 500000);
  assert.equal(house.realEstate.loanBalance, 300000);
  assert.equal(house.realEstate.netEquity, 200000);
  assert.equal(house.realEstate.paymentMethod, "financed");
  assert.equal(house.realEstate.classification, "primaryResidence");
  assert.deepEqual(house.realEstate.loan, {
    interestType: "fixed",
    monthlyPayment: 2500,
    compounding: "monthly",
    apr: 6.5,
  });
  assert.deepEqual(house.realEstate.propertyTax, {
    rate: 0.011,
    rateType: "percentOfValue",
  });
  assert.deepEqual(house.realEstate.insurance, { rate: 0.003 });
  assert.deepEqual(house.realEstate.maintenance, { rate: 0.01 });
  assert.deepEqual(house.realEstate.monthlyHOA, {
    amount: 120,
    type: "fixed",
  });
  assert.deepEqual(house.realEstate.appreciation, {
    rate: 0.03,
    type: "percent",
  });

  // Raw stored fields stay alongside the block.
  assert.equal(house.balance, 300000);
  assert.equal(house.amount, 500000);
  assert.equal(house.integration.authToken, "[REDACTED]");

  // Non-real-estate assets are untouched.
  const car = output.assets.find((a) => a.id === "car-1");
  assert.equal("realEstate" in car, false);
  assert.equal(output.debts[0].id, "debt-1");
});

test("active plan asset event supplies the values and lists overridden fields", async () => {
  const state = baseState([
    { id: "plan-a", name: "Baseline" },
    {
      id: "plan-b",
      name: "Active",
      active: true,
      assets: {
        events: [
          {
            assetId: "house-1",
            amount: 550000,
            paymentMethod: "financed",
            _meta: { overriddenFields: { amount: true, monthlyHOA: false } },
          },
          { assetId: "unrelated", amount: 1 },
        ],
      },
    },
  ]);
  const handler = register(state);
  const output = resultJson(await handler({}));
  const house = output.assets.find((a) => a.id === "house-1");

  assert.equal(house.realEstate.source, "active-plan-event");
  assert.equal(house.realEstate.marketValue, 550000);
  // Loan balance always comes from the Current Finances master record.
  assert.equal(house.realEstate.loanBalance, 300000);
  assert.equal(house.realEstate.netEquity, 250000);
  assert.deepEqual(house.realEstate.overriddenFields, ["amount"]);
  // Fields the event does not carry are not invented from the today record.
  assert.equal("propertyTax" in house.realEstate, false);
});

test("plan lookup falls back to the first plan when none is active", async () => {
  const state = baseState([
    {
      id: "plan-only",
      name: "Only",
      assets: { events: [{ assetId: "house-1", amount: 600000 }] },
    },
  ]);
  const handler = register(state);
  const output = resultJson(await handler({}));
  const house = output.assets.find((a) => a.id === "house-1");

  assert.equal(house.realEstate.source, "active-plan-event");
  assert.equal(house.realEstate.marketValue, 600000);
  assert.equal(house.realEstate.netEquity, 300000);
  assert.equal("overriddenFields" in house.realEstate, false);
});

test("net equity is omitted unless both values are numbers", async () => {
  const state = baseState([]);
  state.today.assets[0].balance = "not-a-number";
  const handler = register(state);
  const output = resultJson(await handler({}));
  const house = output.assets.find((a) => a.id === "house-1");

  assert.equal(house.realEstate.loanBalance, "not-a-number");
  assert.equal("netEquity" in house.realEstate, false);
});

test("single-account read carries the block; listPaths stays raw", async () => {
  const state = baseState([]);
  const handler = register(state);

  const account = resultJson(await handler({ accountId: "house-1" }));
  assert.equal(account.collection, "assets");
  assert.equal(account.data.realEstate.marketValue, 500000);
  assert.equal(account.data.realEstate.loanBalance, 300000);
  assert.equal(account.data.balance, 300000);
  assert.equal(account.data.integration.authToken, "[REDACTED]");

  const paths = resultJson(
    await handler({ accountId: "house-1", listPaths: true }),
  );
  assert.equal(
    paths.data.some((item) => item.path === "realEstate" || item.path.startsWith("realEstate.")),
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
