// The projectionlab://data-model resource, listPaths annotations from the
// registry, and the refusal of values outside an observed enum in the shared
// write path. Tool calls go through each tool's zod schema first, as an MCP
// client's call does.

import assert from "node:assert/strict";
import test from "node:test";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { v5Export } from "./fixtures/v5-export.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-data-model-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerDataModelResource } = await import(
  "../dist/resources/dataModel.js"
);
const { matchDataModelField, UI_LABELS_V5 } = await import("../dist/dataModel.js");
const { renderDataModelMarkdown } = await import(
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

/** The v5 fixture with the settings, events and account fields these tests
 * read and write placed on its Main Plan and brokerage account. */
function planState() {
  const state = v5Export();
  const plan = state.documents.plans[0];
  plan.variables = {
    assumptionsMode: "fixed",
    inflation: 3,
    filingStatus: "single",
    alignment: { type: "calendar" },
    taxStrategy: { bracketRate: 0.22 },
  };
  plan.withdrawalStrategy = { enabled: false };
  plan.expenses.events[0].spendingType = "essential";
  plan.expenses.events[0].unregisteredNote = "not in the data model";
  plan.milestones[0].criteria = [{ type: "year", value: "2040-01-01", modifier: "include" }];
  Object.assign(state.documents.currentFinances.accounts.acct_brokerage, {
    investmentGrowthType: "plan",
    allocation: { stocks: 0.6 },
  });
  return state;
}

const mainPlan = (state) => state.documents.plans[0];

function fakeBridge(state) {
  const bridge = {
    state,
    writes: [],
    async apiContract() { return 2; },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      return structuredClone(state);
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.documents.plans = structuredClone(plans);
    },
    async updateAccount(accountId, data) {
      bridge.writes.push(`account:${accountId}`);
      Object.assign(state.documents.currentFinances.accounts[accountId], data);
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
  assert.match(markdown, /^# ProjectionLab Data Model \(ProjectionLab 5\.0\.0\)/);
  assert.match(markdown, /\[export-shape\][^]*not yet confirmed by a stored-value test/);
  assert.doesNotMatch(markdown, /ProjectionLab 4/);
  assert.match(
    markdown,
    /`inflation` \[export-shape\][^\n]*Units: percentage points/,
  );
  assert.match(
    markdown,
    /`taxStrategy\.bracketRate` \[export-shape\][^\n]*Units: decimal fraction/,
  );
  assert.equal(/\$\d/.test(markdown), false);
});

test("listPaths for variables carries units for inflation and bracketRate", async () => {
  const server = fakeServer();
  const getSettings = caller(server, "projectionlab_get_plan_settings", fakeBridge(planState()));
  const output = text(
    await getSettings({ planIdentifier: "Main Plan", section: "variables" }),
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

test("listPaths marks which allowed values list a write is held to", async () => {
  const server = fakeServer();
  const getSettings = caller(server, "projectionlab_get_plan_settings", fakeBridge(planState()));
  const output = text(
    await getSettings({ planIdentifier: "Main Plan", section: "variables" }),
  );
  const settings = output.sections[0].settings;

  // variables.alignment.type is observed, so a write outside its list fails.
  const alignment = settings.find((item) => item.path === "alignment.type");
  assert.equal(alignment.allowedValuesEnforced, true);

  // variables.filingStatus is export-shape: the list is what exports show, not a rule.
  const filing = settings.find((item) => item.path === "filingStatus");
  assert.ok(filing.allowedValues.length > 0, "the entry carries a list");
  assert.equal(filing.allowedValuesEnforced, false);

  // A field with no list carries neither field.
  const inflation = settings.find((item) => item.path === "inflation");
  assert.equal(inflation.allowedValues, undefined);
  assert.equal(inflation.allowedValuesEnforced, undefined);
});

test("the data-model resource marks an enforced list and leaves a hint unmarked", async () => {
  const server = fakeServer();
  registerDataModelResource(server);
  const markdown = await resourceText(server, "projectionlab://data-model");
  const entry = (pattern) =>
    markdown.split("\n").find((line) => line.startsWith(`- \`${pattern}\` [`));

  assert.match(
    entry("alignment.type"),
    /Allowed values: calendar, rolling, au-tax, uk-tax, custom\. A write of any other value is refused\./,
  );
  assert.equal(
    entry("assumptionsMode").includes("A write of any other value is refused"),
    false,
  );
});

test("plan settings listings carry the app's label and location where recorded", async () => {
  const server = fakeServer();
  const getSettings = caller(server, "projectionlab_get_plan_settings", fakeBridge(planState()));
  const output = text(await getSettings({ planIdentifier: "Main Plan" }));
  const find = (section, path) =>
    output.sections
      .find((entry) => entry.section === section)
      .settings.find((item) => item.path === path);
  const inflation = find("variables", "inflation");
  assert.equal(inflation.uiLabel, "Inflation Rate");
  assert.equal(inflation.uiLocation, "Plan Settings > Rates (Fixed mode)");
  assert.equal(find("withdrawalStrategy", "enabled").uiLabel, "Textbook Strategy");
  // A field with no recorded label gains neither key.
  const mode = find("variables", "assumptionsMode");
  assert.equal("uiLabel" in mode, false);
  assert.equal("uiLocation" in mode, false);
});

test("the data-model resource shows where each labelled plan setting is in the app", async () => {
  const server = fakeServer();
  registerDataModelResource(server);
  const markdown = await resourceText(server, "projectionlab://data-model");
  assert.equal(markdown, renderDataModelMarkdown());
  assert.match(
    markdown,
    /`inflation` \[export-shape\][^\n]*In the app \(ProjectionLab 5\.0\.0\): "Inflation Rate" under Plan Settings > Rates \(Fixed mode\)\./,
  );
  assert.match(markdown, /## Fields in the app/);
  assert.match(markdown, /- `income\.owner`: "Earner" under Plan > income event\./);
  assert.match(markdown, /## Fields the tools cannot change/);
  assert.match(
    markdown,
    /- `withdrawalStrategy\.guyton-klinger\.guardrail`: "Guardrail" under Optimize > Drawdown Strategy > Textbook Withdrawals, Strategy "Guyton-Klinger"\./,
  );
  assert.equal(/`variables\.assumptionsMode`:/.test(markdown), false);
});

test("UI labels attach to matching fields", () => {
  assert.equal(matchDataModelField("variables", "inflation")?.uiLabel, "Inflation Rate");
  assert.equal(matchDataModelField("expenses", "spendingType")?.uiLabel, "Spending Type");
  assert.equal(matchDataModelField("accounts", "value")?.uiLabel, "Current Value");
  assert.equal(
    matchDataModelField("currentFinances", "household.people.me.lifeExpectancy")?.uiLabel,
    "Life Expectancy",
  );
});

test("every UI_LABELS_V5 path resolves with its label against the v5 data model", () => {
  for (const [scope, labels] of Object.entries(UI_LABELS_V5)) {
    for (const [path, [label, location]] of Object.entries(labels)) {
      const field = matchDataModelField(scope, path);
      assert.ok(
        field,
        `UI_LABELS_V5.${scope}.${path} has no ProjectionLab 5 data model entry`,
      );
      assert.equal(field.uiLabel, label, `${scope}.${path} uiLabel`);
      assert.equal(field.uiLocation, location, `${scope}.${path} uiLocation`);
    }
  }
});

test("listPaths for an event annotates the spending type and leaves unknown fields bare", async () => {
  const server = fakeServer();
  const getSection = caller(server, "projectionlab_get_plan_section", fakeBridge(planState()));
  const output = text(
    await getSection({
      planIdentifier: "Main Plan",
      section: "expenses",
      eventIdentifier: "Living",
      listPaths: true,
    }),
  );
  const spending = output.data.find((item) => item.path === "spendingType");
  assert.deepEqual(spending.allowedValues, ["essential", "discretionary", "hybrid", "none"]);
  assert.match(spending.description, /total spending/);
  const amount = output.data.find((item) => item.path === "amount");
  assert.equal(amount.units, "dollars");
  // A field the data model does not register gains no annotation.
  const note = output.data.find((item) => item.path === "unregisteredNote");
  assert.equal(note.description, undefined);
  assert.equal(note.units, undefined);
});

test("listPaths for a Current Finances account annotates balance only where registered", async () => {
  const server = fakeServer();
  const getFinances = caller(server, "projectionlab_get_current_finances", fakeBridge(planState()));
  const output = text(
    await getFinances({ accountId: "acct_brokerage", listPaths: true }),
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
    planIdentifier: "Main Plan",
    section: "variables",
    changes: { "alignment.type": "turbo" },
    confirm: true,
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"variables\.alignment\.type"/);
  assert.match(err.message, /Allowed values: calendar, rolling, au-tax, uk-tax, custom/);
  assert.match(err.suggestion, /projectionlab:\/\/data-model/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(mainPlan(state).variables.alignment.type, "calendar");
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
      planIdentifier: "Main Plan",
      section: "variables",
      changes: { "alignment.type": "rolling" },
      confirm: true,
    }),
  );
  assert.equal(out.success, true);
  assert.equal(out.verified, true);
  assert.deepEqual(bridge.writes, ["plans"]);
  assert.equal(mainPlan(state).variables.alignment.type, "rolling");
});

test("an export-shape enum accepts a value outside its listed options", async () => {
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
      planIdentifier: "Main Plan",
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
      planIdentifier: "Main Plan",
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
    planIdentifier: "Main Plan",
    section: "expenses",
    eventIdentifier: "Living",
    pathChanges: { spendingType: "luxury" },
    confirm: true,
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"expenses\.spendingType"/);
  assert.match(err.message, /Allowed values: essential, discretionary, hybrid, none/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(mainPlan(state).expenses.events[0].spendingType, "essential");
});

test("writing an account enum refuses unobserved values and accepts observed ones", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(planState());
  const update = caller(
    server,
    "projectionlab_update_account",
    bridge,
    new SnapshotManager(),
  );
  const err = await errorFor(update, {
    accountId: "acct_brokerage",
    pathChanges: { investmentGrowthType: "turbo" },
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"accounts\.investmentGrowthType"/);
  assert.match(err.message, /Allowed values: plan, fixed, custom, none/);
  assert.deepEqual(bridge.writes, []);
  const out = text(
    await update({
      accountId: "acct_brokerage",
      pathChanges: { investmentGrowthType: "fixed" },
    }),
  );
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.changes.investmentGrowthType, {
    before: "plan",
    after: "fixed",
  });
});

test("a milestone criterion's type matches its indexed path and its export-shape list is not enforced", async () => {
  const field = matchDataModelField("milestones", "criteria.0.type");
  assert.ok(field.allowedValues.includes("year"));
  const server = fakeServer();
  const bridge = fakeBridge(planState());
  const update = caller(
    server,
    "projectionlab_update_plan_event",
    bridge,
    new SnapshotManager(),
  );
  const out = text(
    await update({
      planIdentifier: "Main Plan",
      section: "milestones",
      eventIdentifier: "Retirement",
      pathChanges: { "criteria.0.type": "someday" },
    }),
  );
  assert.equal(out.dryRun, true);
  assert.deepEqual(bridge.writes, []);
});

test("the legacy patch input refuses an unobserved enum value too", async () => {
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
    planIdentifier: "Main Plan",
    section: "expenses",
    eventIdentifier: "Living",
    patch: { spendingType: "luxury" },
    confirm: true,
  });
  assert.equal(err.error, "INVALID_INPUT");
  assert.match(err.message, /"expenses\.spendingType"/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(mainPlan(state).expenses.events[0].spendingType, "essential");
});

test("path patches reject non-index segments on arrays", async () => {
  const { applyExistingPathChanges } = await import("../dist/pathPatch.js");
  const context = {
    label: "milestone",
    discoveryTool: "projectionlab_get_plan_section",
    example: '{ "criteria.0.amount": 1 }',
  };
  const data = {
    name: "Retire",
    criteria: [
      { amount: 100, type: "netWorth" },
      { amount: 200, type: "income" },
    ],
  };
  // "length" is an own property of arrays; it must not be patchable.
  const refused = (path) =>
    assert.throws(
      () => applyExistingPathChanges(data, { [path]: 3 }, context),
      (err) => err.code === "INVALID_INPUT",
      `${path} must be refused`,
    );
  refused("criteria.length");
  refused("criteria.length.amount");
  refused("criteria.at");
  refused("criteria.01.amount");
  refused("criteria.1.5.amount");
  refused("criteria.2.amount");
  // Indexes stay addressable.
  const { updated } = applyExistingPathChanges(
    data,
    { "criteria.1.amount": 250 },
    context,
  );
  assert.equal(updated.criteria[1].amount, 250);
  assert.equal(data.criteria[1].amount, 200);
});
