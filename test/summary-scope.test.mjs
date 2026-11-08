import assert from "node:assert/strict";
import test from "node:test";

process.env.PL_API_KEY = "test-api-key";
process.env.LOG_LEVEL = "error";

const { registerSummaryTool } = await import("../dist/tools/summary.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

test("summary explicitly reports Current Finances scope, not projected outcomes", async () => {
  const server = fakeServer();
  registerSummaryTool(server, {
    async exportData() {
      return {
        today: {
          investmentAccounts: [{ balance: 125000 }],
          savingsAccounts: [{ balance: 25000 }],
          debts: [{ balance: 10000 }],
          assets: [],
        },
        plans: [
          {
            id: "plan-1",
            name: "codex",
            successRate: 0.91,
            endingNetWorth: 999999,
          },
        ],
      };
    },
  });

  const tool = server.tools.get("projectionlab_get_summary");
  assert.equal(tool.definition.title, "Current Finances Summary");
  assert.match(tool.definition.description, /does not return ending net worth/i);

  const result = await tool.handler({});
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.scope, "currentFinances");
  assert.equal(output.projectedOutcomesAvailable, false);
  assert.equal(output.totalNetWorth, 140000);
  assert.equal(output.planCount, 1);
  assert.equal("successRate" in output.plans[0], false);
  assert.equal("endingNetWorth" in output.plans[0], false);
  assert.equal("endingNetWorth" in output, false);
  assert.equal("chanceOfSuccess" in output, false);
});

test("summary net worth accounts for paid-in-full assets, financed assets with loans, and debts", async () => {
  const server = fakeServer();
  registerSummaryTool(server, {
    async exportData() {
      return {
        today: {
          investmentAccounts: [{ balance: 100000 }],
          savingsAccounts: [{ balance: 20000 }],
          assets: [
            // Paid-in-full home: amount = market value, balance = 0
            { id: "a1", name: "House", type: "real-estate", amount: 400000, balance: 0 },
            // Financed car: amount = market value, balance = outstanding loan
            { id: "a2", name: "Car", type: "vehicle", amount: 35000, balance: 15000 },
            // Fallback to value if amount is absent
            { id: "a3", name: "Collectibles", value: 5000 },
          ],
          debts: [{ id: "d1", name: "Student Loan", balance: 25000 }],
        },
        plans: [],
      };
    },
  });

  const tool = server.tools.get("projectionlab_get_summary");
  const result = await tool.handler({});
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);

  // Assets group total = 400000 + 35000 + 5000 = 440000
  assert.equal(output.accountsByType.assets.count, 3);
  assert.equal(output.accountsByType.assets.total, 440000);

  // Total Net Worth =
  //   100000 (investments)
  // +  20000 (savings)
  // + 400000 (house asset amount)
  // +  35000 (car asset amount)
  // -  15000 (car loan balance)
  // +   5000 (collectibles value)
  // -  25000 (student loan debt)
  // = 520000
  assert.equal(output.totalNetWorth, 520000);
});
