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
