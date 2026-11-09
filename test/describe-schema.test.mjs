// projectionlab_describe_schema output: an asset's loan and market value are
// reported as separate named fields, real estate keeps its "real-estate" type,
// every non-asset row keeps the plain balance shape, and the progress entry
// count reads ProjectionLab's progress export.

import assert from "node:assert/strict";
import test from "node:test";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "true";
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

function fakeBridge(state) {
  return {
    async exportData() {
      return structuredClone(state);
    },
  };
}

async function schemaAccounts(today) {
  const server = fakeServer();
  registerSchemaTool(server, fakeBridge({ today, plans: [] }));
  const result = await server.tools
    .get("projectionlab_describe_schema")
    .handler({});
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text).accounts;
}

test("real-estate assets report market value and loan balance, not balance", async () => {
  const accounts = await schemaAccounts({
    investmentAccounts: [{ id: "inv1", name: "Brokerage", balance: 120000 }],
    savingsAccounts: [{ id: "sav1", name: "Emergency", value: 9000 }],
    debts: [{ id: "d1", name: "Car loan", balance: 8000 }],
    assets: [
      { id: "re1", name: "Lake house", type: "real-estate", balance: 210000, amount: 465000 },
      { id: "veh1", name: "Coach", balance: 95000 },
    ],
  });

  assert.deepEqual(accounts, [
    { id: "inv1", name: "Brokerage", type: "investmentAccounts", balance: 120000 },
    { id: "sav1", name: "Emergency", type: "savingsAccounts", balance: 9000 },
    { id: "d1", name: "Car loan", type: "debts", balance: 8000 },
    { id: "re1", name: "Lake house", type: "real-estate", marketValue: 465000, loanBalance: 210000 },
    { id: "veh1", name: "Coach", type: "assets", marketValue: 0, loanBalance: 95000 },
  ]);
  const re = accounts.find((a) => a.id === "re1");
  assert.equal("balance" in re, false);
});

test("real-estate rows default absent market value and loan to zero", async () => {
  const accounts = await schemaAccounts({
    assets: [
      { id: "re1", name: "Paid-off cabin", type: "real-estate", amount: 150000 },
      { id: "re2", name: "Financed lot", type: "real-estate", balance: 60000 },
    ],
  });

  assert.deepEqual(accounts, [
    { id: "re1", name: "Paid-off cabin", type: "real-estate", marketValue: 150000, loanBalance: 0 },
    { id: "re2", name: "Financed lot", type: "real-estate", marketValue: 0, loanBalance: 60000 },
  ]);
});

test("the real-estate label applies only to assets rows and only to the stored type", async () => {
  const accounts = await schemaAccounts({
    // A real-estate-typed record in another section is still that section's
    // row: there the balance is the whole point.
    debts: [{ id: "d1", name: "Heirlooms mortgage", type: "real-estate", balance: 100000, amount: 300000 }],
    assets: [
      // Only the stored "real-estate" type marks the record as real estate;
      // other asset types still split market value from the loan.
      { id: "a1", name: "Boat", type: "vehicle", balance: 30000, amount: 40000 },
    ],
  });

  assert.deepEqual(accounts, [
    { id: "d1", name: "Heirlooms mortgage", type: "debts", balance: 100000 },
    { id: "a1", name: "Boat", type: "assets", marketValue: 40000, loanBalance: 30000 },
  ]);
});

test("a paid-in-full asset reports its market value and no loan", async () => {
  const accounts = await schemaAccounts({
    assets: [
      { id: "car1", name: "Truck", type: "vehicle", amount: 25000, balance: 0 },
      { id: "art1", name: "Painting", value: 5000 },
    ],
  });

  assert.deepEqual(accounts, [
    { id: "car1", name: "Truck", type: "assets", marketValue: 25000, loanBalance: 0 },
    { id: "art1", name: "Painting", type: "assets", marketValue: 5000, loanBalance: 0 },
  ]);
  assert.equal(accounts.some((a) => "balance" in a), false);
});

test("progressEntryCount counts ProjectionLab's progress.data entries", async () => {
  const count = async (progress) => {
    const server = fakeServer();
    registerSchemaTool(server, fakeBridge({ today: {}, plans: [], progress }));
    const result = await server.tools.get("projectionlab_describe_schema").handler({});
    return JSON.parse(result.content[0].text).progressEntryCount;
  };
  assert.equal(await count({ data: [{ date: 1 }, { date: 2 }, { date: 3 }] }), 3);
  assert.equal(await count([{ date: 1 }]), 1);
  assert.equal(await count({}), 0);
  assert.equal(await count(undefined), 0);
});
