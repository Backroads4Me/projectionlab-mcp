// Unit and regression tests for Package D (data model and knowledge)
// supporting ProjectionLab 5 layout and contract 2 alongside ProjectionLab 4.

import assert from "node:assert/strict";
import test from "node:test";
import { v5Export } from "./fixtures/v5-export.mjs";

const {
  DATA_MODEL_GROUPS,
  DATA_MODEL_PROJECTIONLAB_VERSION,
  DATA_MODEL_V5_GROUPS,
  DATA_MODEL_V5_PROJECTIONLAB_VERSION,
  getDataModelGroups,
  matchDataModelField,
  annotateAddressableValues,
  refusedEnumChoices,
  enumRefusalError,
} = await import("../dist/dataModel.js");

const {
  renderDataModelMarkdown,
  renderDataModelV4Markdown,
  renderDataModelV5Markdown,
  registerDataModelResource,
} = await import("../dist/resources/dataModel.js");

const {
  KNOWLEDGE,
  KNOWLEDGE_V4,
  KNOWLEDGE_V5,
  renderKnowledgeMarkdown,
  registerKnowledgeResource,
} = await import("../dist/resources/knowledge.js");

const { exportSections, sectionOf, detectLayout } = await import(
  "../dist/layout.js"
);

function fakeServer() {
  const resources = new Map();
  return {
    resources,
    registerResource(name, uri, meta, handler) {
      resources.set(uri, { name, meta, handler });
    },
  };
}

function fakeBridge(contract = 1, state = undefined) {
  return {
    knownApiContract() {
      return contract;
    },
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      throw new Error("resources must not query the page");
    },
    async exportData() {
      return structuredClone(state);
    },
  };
}

function v4Export() {
  return {
    meta: { version: "4.6.0" },
    today: {
      savingsAccounts: [{ id: "s1", name: "Savings", balance: 5000 }],
      investmentAccounts: [{ id: "i1", name: "Brokerage", balance: 50000 }],
      assets: [],
      debts: [],
    },
    plans: [{ id: "p1", name: "Main", active: true }],
    settings: { currency: "USD" },
    progress: {},
  };
}

test("getDataModelGroups returns appropriate groups per layout", () => {
  const v4Groups = getDataModelGroups("v4");
  const defaultGroups = getDataModelGroups();
  const v5Groups = getDataModelGroups("v5");

  assert.equal(v4Groups, DATA_MODEL_GROUPS);
  assert.equal(defaultGroups, DATA_MODEL_GROUPS);
  assert.equal(v5Groups, DATA_MODEL_V5_GROUPS);

  // v5 includes envelope, currentFinances, accounts, assets, income, expenses, settings, accountHistory
  const scopes = new Set(v5Groups.map((g) => g.scope));
  assert.ok(scopes.has("envelope"));
  assert.ok(scopes.has("currentFinances"));
  assert.ok(scopes.has("accounts"));
  assert.ok(scopes.has("assets"));
  assert.ok(scopes.has("income"));
  assert.ok(scopes.has("expenses"));
  assert.ok(scopes.has("priorities"));
  assert.ok(scopes.has("milestones"));
  assert.ok(scopes.has("variables"));
  assert.ok(scopes.has("montecarlo"));
  assert.ok(scopes.has("withdrawalStrategy"));
  assert.ok(scopes.has("settings"));
  assert.ok(scopes.has("accountHistory"));

  // v5 fields are export-shape unless a stored-value test on ProjectionLab 5 confirmed them
  const observedV5 = new Set([
    "variables.bondSettings.allocation",
    "variables.alignment.type",
    "variables.alignment.date",
    "settings.plan.alignment.type",
    "settings.plan.alignment.date",
    "expenses.fundWithAccounts",
    // Confirmed against the ProjectionLab 5.0.0 web build: the option arrays the
    // app ships, the labels it renders, and the code that binds each array to its
    // field.
    "assets.interestType",
    "assets.compounding",
    "assets.yearlyChange.type",
    "income.yearlyChange.type",
    "income.yearlyChange.amount",
    "income.yearlyChange.limit",
    "income.yearlyChange.limitType",
    "income.yearlyChange.custom",
    "expenses.spendingType",
    "expenses.yearlyChange.type",
    "expenses.yearlyChange.amount",
    "expenses.yearlyChange.limit",
    "expenses.yearlyChange.limitType",
    "expenses.yearlyChange.custom",
    "priorities.desiredContribution",
    "accounts.owner",
    "accounts.liquidity",
    "accounts.withdraw",
    "accounts.withdrawAge",
    "accounts.investmentGrowthType",
    "accounts.investmentGrowthRate",
    "accounts.dividendType",
    "accounts.dividendRate",
    "accounts.yearlyFee",
    "accounts.yearlyFeeType",
    "accounts.rmdType",
    "accounts.EWAge",
    "accounts.hasEWPenalty",
    "accounts.EWPenaltyRate",
    "expenses.healthcareType",
  ]);
  for (const group of v5Groups) {
    for (const [pattern, field] of Object.entries(group.fields)) {
      const key = `${group.scope}.${pattern}`;
      assert.equal(
        field.evidence,
        observedV5.has(key) ? "observed" : "export-shape",
        `Field ${key} has the wrong evidence`,
      );
    }
  }
});

test("matchDataModelField matches v5 fields and preserves v4 defaults", () => {
  // v5 field matches
  const kindField = matchDataModelField("accounts", "kind", "v5");
  assert.ok(kindField);
  assert.equal(kindField.evidence, "export-shape");
  assert.deepEqual(kindField.allowedValues, ["account", "debt", "real-asset"]);

  const archivedField = matchDataModelField("accounts", "archivedOn", "v5");
  assert.ok(archivedField);
  assert.equal(archivedField.evidence, "export-shape");
  assert.match(archivedField.note ?? "", /archived accounts/);

  const securedField = matchDataModelField("accounts", "securedByAssetId", "v5");
  assert.ok(securedField);
  assert.equal(securedField.evidence, "export-shape");
  assert.match(securedField.note ?? "", /secured by an asset/);

  const incomeTypeField = matchDataModelField("income", "start.type", "v5");
  assert.ok(incomeTypeField);
  assert.equal(incomeTypeField.evidence, "export-shape");
  assert.deepEqual(incomeTypeField.allowedValues, [
    "date",
    "year",
    "age",
    "milestone",
    "lifeExpectancy",
    "lastLifeExpectancy",
    "keyword",
  ]);

  const expenseTypeField = matchDataModelField("expenses", "spendingType", "v5");
  assert.ok(expenseTypeField);
  assert.equal(expenseTypeField.evidence, "observed");
  assert.deepEqual(expenseTypeField.allowedValues, [
    "essential",
    "discretionary",
    "hybrid",
    "none",
  ]);

  const historyBalanceField = matchDataModelField(
    "accountHistory",
    "acct_brokerage.2025.balance.acct_brokerage",
    "v5",
  );
  assert.ok(historyBalanceField);
  assert.equal(historyBalanceField.evidence, "export-shape");
  assert.equal(historyBalanceField.units, "dollars");

  const settingsPlanActive = matchDataModelField("settings", "plan.activeId", "v5");
  assert.ok(settingsPlanActive);
  assert.equal(settingsPlanActive.evidence, "export-shape");

  // v4 regression check: default layout (no arg) behaves as v4
  const v4FieldDefault = matchDataModelField("savingsAccounts", "balance");
  assert.ok(v4FieldDefault);
  assert.equal(v4FieldDefault.evidence, "ui-label");
  assert.equal(v4FieldDefault.units, "dollars");

  const v4FieldExplicit = matchDataModelField("savingsAccounts", "balance", "v4");
  assert.ok(v4FieldExplicit);
  assert.equal(v4FieldExplicit.evidence, "ui-label");
  assert.equal(v4FieldExplicit.units, "dollars");
});

test("annotateAddressableValues annotates correctly per layout", () => {
  const v5Values = [
    { path: "kind", value: "account" },
    { path: "balance", value: 1000 },
    { path: "unrecognized", value: "foo" },
  ];
  const annotatedV5 = annotateAddressableValues("accounts", v5Values, "v5");
  assert.equal(annotatedV5[0].description !== undefined, true);
  assert.deepEqual(annotatedV5[0].allowedValues, ["account", "debt", "real-asset"]);
  assert.equal(annotatedV5[1].units, "dollars");
  assert.equal(annotatedV5[2].description, undefined);

  // v4 regression check
  const v4Values = [{ path: "inflation", value: 3 }];
  const annotatedV4 = annotateAddressableValues("variables", v4Values);
  assert.equal(annotatedV4[0].units, "percentage points");
});

test("refusedEnumChoices and enumRefusalError work per layout", () => {
  // v5 fields carry export-shape evidence; writes are refused only on observed option lists
  const v5Choices = refusedEnumChoices("accounts", "kind", "unsupported", "v5");
  assert.equal(v5Choices, undefined);

  // v4 regression check: variables.assumptionsMode is an observed enum with allowed values
  const v4Choices = refusedEnumChoices("variables", "assumptionsMode", "invalid");
  assert.deepEqual(v4Choices, ["fixed", "historical", "custom"]);

  const v4Accepted = refusedEnumChoices("variables", "assumptionsMode", "historical");
  assert.equal(v4Accepted, undefined);

  const v4Error = enumRefusalError("variables", "assumptionsMode", "invalid");
  assert.ok(v4Error);
  assert.equal(v4Error.code, "INVALID_INPUT");

  // v5 year alignment is an observed enum, on a plan and in settings
  const alignments = ["calendar", "rolling", "au-tax", "uk-tax", "custom"];
  assert.deepEqual(refusedEnumChoices("variables", "alignment.type", "fiscal", "v5"), alignments);
  assert.deepEqual(refusedEnumChoices("settings", "plan.alignment.type", "fiscal", "v5"), alignments);
  for (const value of alignments) {
    assert.equal(refusedEnumChoices("variables", "alignment.type", value, "v5"), undefined);
  }
});

test("projectionlab://data-model resource renders v5 layout correctly", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(2);
  registerDataModelResource(server, bridge);

  const handler = server.resources.get("projectionlab://data-model").handler;
  const res = await handler(new URL("projectionlab://data-model"));
  const markdown = res.contents[0].text;

  // Checks on v5 markdown
  assert.match(markdown, /ProjectionLab 5\.0\.0/);
  assert.match(markdown, /documents\.currentFinances\.accounts/);
  assert.match(markdown, /`kind` \[export-shape\]/);
  assert.match(markdown, /Allowed values: account, debt, real-asset/);
  assert.match(markdown, /`archivedOn` \[export-shape\]/);
  assert.match(markdown, /`securedByAssetId` \[export-shape\]/);
  assert.match(markdown, /`start\.type` \[export-shape\]/);
  assert.match(
    markdown,
    /Allowed values: date, year, age, milestone, lifeExpectancy, lastLifeExpectancy, keyword/,
  );
  assert.match(markdown, /## Application and plan settings/);
  assert.match(markdown, /`plan\.activeId` \[export-shape\]/);
  assert.match(markdown, /## Account history/);

  // Evidence legend check
  assert.match(markdown, /Evidence tags: \[export-shape\] means/);
  assert.match(markdown, /\[observed\] means a value was set through the ProjectionLab 5 UI/);
  assert.match(markdown, /`plan\.alignment\.type` \[observed\]/);
  assert.match(markdown, /Allowed values: calendar, rolling, au-tax, uk-tax, custom/);

  // Requirement: solo 401k prose without guessed string
  assert.match(markdown, /Solo 401k, Roth Solo 401k, and SEP IRA/);
  assert.match(markdown, /"roth-401k"/);
  assert.match(markdown, /subtype "sep"/);
  assert.equal(markdown.includes("solo-401k"), false);

  // Requirement: no em dashes
  assert.equal(markdown.includes("\u2014"), false);

  // No unescaped dollar amounts resembling regex capture groups
  assert.equal(/\$\d/.test(markdown), false);
});

test("projectionlab://data-model resource handles explicit ?layout=v5 and ?layout=v4", async () => {
  const server = fakeServer();
  // Register without bridge to verify query parameter fallback
  registerDataModelResource(server);

  const handler = server.resources.get("projectionlab://data-model").handler;

  const resV5 = await handler(new URL("projectionlab://data-model?layout=v5"));
  assert.match(resV5.contents[0].text, /ProjectionLab 5\.0\.0/);

  const resV4 = await handler(new URL("projectionlab://data-model?layout=v4"));
  assert.match(resV4.contents[0].text, /ProjectionLab 4\.6\.0/);

  // Default without query param and without bridge defaults to v4
  const resDefault = await handler(new URL("projectionlab://data-model"));
  assert.match(resDefault.contents[0].text, /ProjectionLab 4\.6\.0/);
});

test("projectionlab://data-model v4 regression check with v4 bridge", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(1);
  registerDataModelResource(server, bridge);

  const handler = server.resources.get("projectionlab://data-model").handler;
  const res = await handler(new URL("projectionlab://data-model"));
  const markdown = res.contents[0].text;

  assert.equal(markdown, renderDataModelV4Markdown());
  assert.match(markdown, /ProjectionLab 4\.6\.0/);
  assert.match(markdown, /## Current Finances: savings accounts/);
});

test("projectionlab://knowledge resource renders v5 reference correctly", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(2);
  registerKnowledgeResource(server, bridge);

  const handler = server.resources.get("projectionlab://knowledge").handler;
  const res = await handler(new URL("projectionlab://knowledge"));
  const markdown = res.contents[0].text;

  assert.match(markdown, /# ProjectionLab 5 & FIRE Reference/);
  assert.match(markdown, /Plugin API contract 2/);
  assert.match(markdown, /documents: { currentFinances, plans, settings, accountHistory }/);
  assert.match(markdown, /documents\.currentFinances/);
  assert.match(markdown, /`"account"`/);
  assert.match(markdown, /`"debt"`/);
  assert.match(markdown, /`"real-asset"`/);
  assert.match(markdown, /`archivedOn`/);
  assert.match(markdown, /`securedByAssetId`/);
  assert.match(markdown, /`settings\.plan\.activeId`/);
  assert.match(markdown, /documents\.accountHistory/);

  // Evidence legend check
  assert.match(markdown, /## Evidence legend/);
  assert.match(markdown, /`\[export-shape\]`/);
  assert.match(markdown, /is not yet confirmed by a stored-value test/);

  // Requirement: solo 401k prose without guessed string
  assert.match(markdown, /Solo 401k, Roth Solo 401k, and SEP IRA/);
  assert.match(markdown, /"roth-401k"/);
  assert.match(markdown, /subtype: "sep"/);
  assert.equal(markdown.includes("solo-401k"), false);

  // Requirement: no em dashes
  assert.equal(markdown.includes("\u2014"), false);

  // Requirement: no changelog wording
  assert.equal(/\bpreviously\b/i.test(markdown), false);
  assert.equal(/\bchanged to\b/i.test(markdown), false);
});

test("projectionlab://knowledge resource handles explicit ?layout=v5 and ?layout=v4", async () => {
  const server = fakeServer();
  registerKnowledgeResource(server);

  const handler = server.resources.get("projectionlab://knowledge").handler;

  const resV5 = await handler(new URL("projectionlab://knowledge?layout=v5"));
  assert.equal(resV5.contents[0].text, KNOWLEDGE_V5);

  const resV4 = await handler(new URL("projectionlab://knowledge?layout=v4"));
  assert.equal(resV4.contents[0].text, KNOWLEDGE_V4);

  const resDefault = await handler(new URL("projectionlab://knowledge"));
  assert.equal(resDefault.contents[0].text, KNOWLEDGE_V4);
  assert.equal(resDefault.contents[0].text, KNOWLEDGE);
});

test("projectionlab://knowledge v4 regression check with v4 bridge", async () => {
  const server = fakeServer();
  const bridge = fakeBridge(1);
  registerKnowledgeResource(server, bridge);

  const handler = server.resources.get("projectionlab://knowledge").handler;
  const res = await handler(new URL("projectionlab://knowledge"));

  assert.equal(res.contents[0].text, KNOWLEDGE_V4);
});

test("resource handlers render v4 before any contract is known and never query the page", async () => {
  const server = fakeServer();
  const unknownBridge = {
    knownApiContract() {
      return undefined;
    },
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      throw new Error("resources must not query the page");
    },
  };
  registerDataModelResource(server, unknownBridge);
  registerKnowledgeResource(server, unknownBridge);

  const dmHandler = server.resources.get("projectionlab://data-model").handler;
  const dmRes = await dmHandler(new URL("projectionlab://data-model"));
  assert.match(dmRes.contents[0].text, /ProjectionLab 4\.6\.0/);

  const knHandler = server.resources.get("projectionlab://knowledge").handler;
  const knRes = await knHandler(new URL("projectionlab://knowledge"));
  assert.equal(knRes.contents[0].text, KNOWLEDGE_V4);
});

test("exportSections and sectionOf operate on synthetic v5 export", () => {
  const raw = v5Export();
  assert.equal(detectLayout(raw), "v5");

  const sections = exportSections(raw);
  assert.ok(sections.currentFinances);
  assert.ok(sections.plans);
  assert.ok(sections.settings);
  assert.ok(sections.accountHistory);

  assert.equal(sections.accountHistory, raw.documents.accountHistory);
  assert.equal(sectionOf(raw, "currentFinances"), raw.documents.currentFinances);
  assert.equal(sectionOf(raw, "plans"), raw.documents.plans);
  assert.equal(sectionOf(raw, "settings"), raw.documents.settings);
});
