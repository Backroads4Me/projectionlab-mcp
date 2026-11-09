// The projectionlab://data-model resource, listPaths annotations from the
// registry, and the refusal of values outside an observed enum in the shared
// write path. Tool calls go through each tool's zod schema first, as an MCP
// client's call does.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-data-model-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerDataModelResource } = await import(
  "../dist/resources/dataModel.js"
);
const { registerGetPlanSettingsTool } = await import(
  "../dist/tools/getPlanSettings.js"
);
const { registerGetPlanSectionTool } = await import(
  "../dist/tools/getPlanSection.js"
);
const { registerGetCurrentFinancesTool } = await import(
  "../dist/tools/getCurrentFinances.js"
);
const { registerUpdatePlanSettingsTool } = await import(
  "../dist/tools/updatePlanSettings.js"
);
const { registerUpdatePlanEventTool } = await import(
  "../dist/tools/updatePlanEvent.js"
);
const { registerUpdateAccountTool } = await import(
  "../dist/tools/updateAccount.js"
);
const { SnapshotManager } = await import("../dist/snapshot.js");
const { z } = await import("zod");

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
      resources.set(uri, { name, meta, handler });
    },
  };
}

/** Registers one tool and returns a caller that validates through its schema. */
function caller(server, toolName, ...registerArgs) {
  const registrars = {
    projectionlab_get_plan_settings: registerGetPlanSettingsTool,
    projectionlab_get_plan_section: registerGetPlanSectionTool,
    projectionlab_get_current_finances: registerGetCurrentFinancesTool,
    projectionlab_update_plan_settings: registerUpdatePlanSettingsTool,
    projectionlab_update_plan_event: registerUpdatePlanEventTool,
    projectionlab_update_account: registerUpdateAccountTool,
  };
  registrars[toolName](server, ...registerArgs);
  const { definition, handler } = server.tools.get(toolName);
  const schema = z.object(definition.inputSchema).strict();
  return (args) => handler(schema.parse(args));
}

function text(result) {
  return JSON.parse(result.content[0].text);
}

async function errorFor(call, args) {
  const result = await call(args);
  assert.equal(result.isError, true, JSON.stringify(result));
  return text(result);
}

function planState() {
  return {
    plans: [
      {
        id: "plan-1",
        name: "Retire",
        lastUpdated: 100,
        variables: {
          assumptionsMode: "fixed",
          inflation: 3,
          filingStatus: "single",
          taxStrategy: { bracketRate: 0.22 },
        },
        montecarlo: { trials: 1000, sampling: "block-bootstrap" },
        withdrawalStrategy: { enabled: false, strategy: "fixed-%" },
        expenses: {
          events: [
            {
              id: "e1",
              name: "Living",
              type: "living-expenses",
              spendingType: "essential",
              amount: 50000,
              amountType: "today$",
              frequency: "yearly",
            },
          ],
        },
      },
    ],
    today: {
      savingsAccounts: [],
      investmentAccounts: [
        {
          id: "i1",
          name: "Brokerage",
          type: "taxable",
          balance: 100000,
          costBasis: 60000,
          allocation: { stocks: 0.6 },
        },
      ],
      debts: [],
      assets: [
        {
          id: "a1",
          name: "House",
          type: "real-estate",
          amount: 400000,
          amountType: "today$",
          paymentMethod: "pay-in-full",
        },
      ],
    },
  };
}

function fakeBridge(state) {
  const bridge = {
    state,
    writes: [],
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.plans = structuredClone(plans);
    },
    async updateAccount(accountId, data) {
      bridge.writes.push(`account:${accountId}`);
      for (const collection of ["assets", "investmentAccounts"]) {
        const entry = state.today[collection].find((a) => a.id === accountId);
        if (entry) Object.assign(entry, data);
      }
    },
  };
  return bridge;
}

async function resourceText(server, uri) {
  const result = await server.resources.get(uri).handler(new URL(uri));
  return result.contents[0].text;
}

test("data-model resource is version-stamped and names each rate's scale", async () => {
  const server = fakeServer();
  registerDataModelResource(server);
  const markdown = await resourceText(server, "projectionlab://data-model");
  assert.match(markdown, /ProjectionLab 4\.6\.0/);
  assert.match(markdown, /\[ui-label\][^]*not yet confirmed by a stored-value test/);
  assert.match(markdown, /v5/);
  assert.match(
    markdown,
    /`inflation` \[observed\][^]*Units: percentage points/,
  );
  assert.match(
    markdown,
    /`taxStrategy\.bracketRate` \[observed\][^]*Units: decimal fraction/,
  );
  assert.equal(/\$\d/.test(markdown), false);
});

test("listPaths for variables carries units for inflation and bracketRate", async () => {
  const server = fakeServer();
  const getSettings = caller(server, "projectionlab_get_plan_settings", fakeBridge(planState()));
  const output = text(
    await getSettings({ planIdentifier: "Retire", section: "variables" }),
  );
  const settings = output.sections[0].settings;
  const inflation = settings.find((item) => item.path === "inflation");
  assert.equal(inflation.units, "percentage points");
  assert.equal(typeof inflation.description, "string");
  assert.equal(inflation.description.length > 0, true);
  const bracket = settings.find(
    (item) => item.path === "taxStrategy.bracketRate",
  );
  assert.equal(bracket.units, "decimal fraction");
  // Existing fields are untouched and unregistered fields gain nothing.
  const mode = settings.find((item) => item.path === "assumptionsMode");
  assert.deepEqual(mode.allowedValues, ["fixed", "historical", "custom"]);
  assert.equal(mode.units, undefined);
});

test("listPaths for an event annotates the spending type and leaves unknown fields bare", async () => {
  const server = fakeServer();
  const getSection = caller(server, "projectionlab_get_plan_section", fakeBridge(planState()));
  const output = text(
    await getSection({
      planIdentifier: "Retire",
      section: "expenses",
      eventIdentifier: "Living",
      listPaths: true,
    }),
  );
  const spending = output.data.find((item) => item.path === "spendingType");
  assert.deepEqual(spending.allowedValues, ["essential", "discretionary"]);
  assert.match(spending.description, /essential or discretionary/);
  const amount = output.data.find((item) => item.path === "amount");
  assert.equal(amount.units, "dollars");
  const id = output.data.find((item) => item.path === "id");
  assert.equal(id.description, undefined);
});

test("listPaths for a Current Finances account annotates balance only where registered", async () => {
  const server = fakeServer();
  const getFinances = caller(server, "projectionlab_get_current_finances", fakeBridge(planState()));
  const output = text(
    await getFinances({ accountId: "i1", listPaths: true }),
  );
  const balance = output.data.find((item) => item.path === "balance");
  assert.equal(balance.units, "dollars");
  const stocks = output.data.find((item) => item.path === "allocation.stocks");
  assert.equal(stocks.description, undefined);
  assert.equal(stocks.units, undefined);
});

test("writing an unobserved value to an observed enum is refused with the choices and nothing is written", async () => {
  const server = fakeServer();
  const state = planState();
  const bridge = fakeBridge(state);
  const update = caller(
    server,
    "projectionlab_update_plan_settings",
    bridge,
    new SnapshotManager(),
  );
  const err = await errorFor(update, {
    planIdentifier: "Retire",
    section: "variables",
    changes: { assumptionsMode: "turbo" },
    confirm: true,
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"variables\.assumptionsMode"/);
  assert.match(err.message, /Allowed values: fixed, historical, custom/);
  assert.match(err.suggestion, /projectionlab:\/\/data-model/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(state.plans[0].variables.assumptionsMode, "fixed");
});

test("writing an allowed value goes through and verifies", async () => {
  const server = fakeServer();
  const state = planState();
  const bridge = fakeBridge(state);
  const update = caller(
    server,
    "projectionlab_update_plan_settings",
    bridge,
    new SnapshotManager(),
  );
  const out = text(
    await update({
      planIdentifier: "Retire",
      section: "variables",
      changes: { assumptionsMode: "historical" },
      confirm: true,
    }),
  );
  assert.equal(out.success, true);
  assert.equal(out.verified, true);
  assert.deepEqual(bridge.writes, ["plans"]);
  assert.equal(state.plans[0].variables.assumptionsMode, "historical");
});

test("a ui-label enum accepts a value outside its listed options", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(planState());
  const update = caller(
    server,
    "projectionlab_update_plan_settings",
    bridge,
    new SnapshotManager(),
  );
  const out = text(
    await update({
      planIdentifier: "Retire",
      section: "variables",
      changes: { filingStatus: "common-law" },
    }),
  );
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.changes.filingStatus, {
    before: "single",
    after: "common-law",
  });
});

test("numeric fields are not range-checked", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(planState());
  const update = caller(
    server,
    "projectionlab_update_plan_settings",
    bridge,
    new SnapshotManager(),
  );
  const out = text(
    await update({
      planIdentifier: "Retire",
      section: "variables",
      changes: { inflation: 0.03 },
    }),
  );
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.changes.inflation, { before: 3, after: 0.03 });
});

test("writing an unobserved event enum value is refused with the choices", async () => {
  const server = fakeServer();
  const state = planState();
  const bridge = fakeBridge(state);
  const update = caller(
    server,
    "projectionlab_update_plan_event",
    bridge,
    new SnapshotManager(),
  );
  const err = await errorFor(update, {
    planIdentifier: "Retire",
    section: "expenses",
    eventIdentifier: "Living",
    pathChanges: { spendingType: "luxury" },
    confirm: true,
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"expenses\.spendingType"/);
  assert.match(err.message, /Allowed values: essential, discretionary/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(state.plans[0].expenses.events[0].spendingType, "essential");
});

test("writing an asset payment method refuses unobserved values and accepts observed ones", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(planState());
  const update = caller(
    server,
    "projectionlab_update_account",
    bridge,
    new SnapshotManager(),
  );
  const err = await errorFor(update, {
    accountId: "a1",
    pathChanges: { paymentMethod: "lease" },
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"assets\.paymentMethod"/);
  assert.match(err.message, /Allowed values: pay-in-full, financed/);
  assert.deepEqual(bridge.writes, []);
  const out = text(
    await update({
      accountId: "a1",
      pathChanges: { paymentMethod: "financed" },
    }),
  );
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.changes.paymentMethod, {
    before: "pay-in-full",
    after: "financed",
  });
});
