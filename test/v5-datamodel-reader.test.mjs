// The ProjectionLab 5 data model (src/dataModel.ts) and the
// projectionlab://data-model and projectionlab://knowledge resources.

import assert from "node:assert/strict";
import test from "node:test";
import { v5Export } from "./fixtures/v5-export.mjs";

const {
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
  registerDataModelResource,
} = await import("../dist/resources/dataModel.js");

const { KNOWLEDGE, registerKnowledgeResource } = await import(
  "../dist/resources/knowledge.js"
);

const { exportSections, sectionOf } = await import("../dist/layout.js");

function fakeServer() {
  const resources = new Map();
  return {
    resources,
    registerResource(name, uri, meta, handler) {
      resources.set(uri, { name, meta, handler });
    },
  };
}

test("getDataModelGroups returns the ProjectionLab 5 groups", () => {
  const v5Groups = getDataModelGroups();
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

test("matchDataModelField matches v5 fields", () => {
  // v5 field matches
  const kindField = matchDataModelField("accounts", "kind");
  assert.ok(kindField);
  assert.equal(kindField.evidence, "export-shape");
  assert.deepEqual(kindField.allowedValues, ["account", "debt", "real-asset"]);

  const archivedField = matchDataModelField("accounts", "archivedOn");
  assert.ok(archivedField);
  assert.equal(archivedField.evidence, "export-shape");
  assert.match(archivedField.note ?? "", /archived accounts/);

  const securedField = matchDataModelField("accounts", "securedByAssetId");
  assert.ok(securedField);
  assert.equal(securedField.evidence, "export-shape");
  assert.match(securedField.note ?? "", /secured by an asset/);

  const incomeTypeField = matchDataModelField("income", "start.type");
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

  const expenseTypeField = matchDataModelField("expenses", "spendingType");
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
  );
  assert.ok(historyBalanceField);
  assert.equal(historyBalanceField.evidence, "export-shape");
  assert.equal(historyBalanceField.units, "dollars");

  const settingsPlanActive = matchDataModelField("settings", "plan.activeId");
  assert.ok(settingsPlanActive);
  assert.equal(settingsPlanActive.evidence, "export-shape");

  // ProjectionLab 4 Current Finances collections are not in the data model.
  assert.equal(matchDataModelField("savingsAccounts", "balance"), undefined);
});

test("annotateAddressableValues annotates v5 values", () => {
  const v5Values = [
    { path: "kind", value: "account" },
    { path: "balance", value: 1000 },
    { path: "unrecognized", value: "foo" },
  ];
  const annotatedV5 = annotateAddressableValues("accounts", v5Values);
  assert.equal(annotatedV5[0].description !== undefined, true);
  assert.deepEqual(annotatedV5[0].allowedValues, ["account", "debt", "real-asset"]);
  assert.equal(annotatedV5[1].units, "dollars");
  // An export-shape list is a hint: a write is not held to it.
  assert.equal(annotatedV5[0].allowedValuesEnforced, false);
  assert.equal(annotatedV5[1].allowedValuesEnforced, undefined);
  assert.equal(annotatedV5[2].description, undefined);

  const [inflation] = annotateAddressableValues("variables", [{ path: "inflation", value: 3 }]);
  assert.equal(inflation.units, "percentage points");
});

test("annotateAddressableValues flags an observed v5 list as enforced", () => {
  const [growth] = annotateAddressableValues(
    "accounts",
    [{ path: "investmentGrowthType", value: "plan" }],
  );
  assert.deepEqual(growth.allowedValues, ["plan", "fixed", "custom", "none"]);
  assert.equal(growth.allowedValuesEnforced, true);
});

test("refusedEnumChoices and enumRefusalError refuse only observed option lists", () => {
  // v5 fields carry export-shape evidence; writes are refused only on observed option lists
  const v5Choices = refusedEnumChoices("accounts", "kind", "unsupported");
  assert.equal(v5Choices, undefined);

  // variables.assumptionsMode is export-shape on ProjectionLab 5, so its list is a hint.
  assert.equal(refusedEnumChoices("variables", "assumptionsMode", "invalid"), undefined);

  const refusal = enumRefusalError("variables", "alignment.type", "fiscal");
  assert.ok(refusal);
  assert.equal(refusal.code, "INVALID_INPUT");
  assert.equal(enumRefusalError("variables", "alignment.type", "rolling"), undefined);

  // v5 year alignment is an observed enum, on a plan and in settings
  const alignments = ["calendar", "rolling", "au-tax", "uk-tax", "custom"];
  assert.deepEqual(refusedEnumChoices("variables", "alignment.type", "fiscal"), alignments);
  assert.deepEqual(refusedEnumChoices("settings", "plan.alignment.type", "fiscal"), alignments);
  for (const value of alignments) {
    assert.equal(refusedEnumChoices("variables", "alignment.type", value), undefined);
  }
});

test("v5 account growth and dividend sources accept every option the app offers", () => {
  // The build's Stock Growth Rate and Stock Dividend Yield menus each offer
  // plan, fixed, custom and none, with no account-type filter.
  const sources = ["plan", "fixed", "custom", "none"];
  for (const field of ["investmentGrowthType", "dividendType"]) {
    for (const value of sources) {
      assert.equal(
        refusedEnumChoices("accounts", field, value),
        undefined,
        `${field} refuses "${value}"`,
      );
    }
    assert.deepEqual(refusedEnumChoices("accounts", field, "rate"), sources);
  }
});

test("projectionlab://data-model renders the ProjectionLab 5 data model", async () => {
  const server = fakeServer();
  registerDataModelResource(server);

  const handler = server.resources.get("projectionlab://data-model").handler;
  const res = await handler(new URL("projectionlab://data-model"));
  const markdown = res.contents[0].text;
  assert.equal(markdown, renderDataModelMarkdown());
  assert.equal(markdown.includes("ProjectionLab 4"), false);

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
  assert.match(
    markdown,
    /Allowed values: calendar, rolling, au-tax, uk-tax, custom\. A write of any other value is refused\./,
  );
  assert.equal(
    /Allowed values: account, debt, real-asset\. A write/.test(markdown),
    false,
    "an export-shape list is printed without the enforcement sentence",
  );

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

test("projectionlab://knowledge renders the ProjectionLab 5 reference", async () => {
  const server = fakeServer();
  registerKnowledgeResource(server);

  const handler = server.resources.get("projectionlab://knowledge").handler;
  const res = await handler(new URL("projectionlab://knowledge"));
  const markdown = res.contents[0].text;
  assert.equal(markdown, KNOWLEDGE);

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

test("exportSections and sectionOf operate on synthetic v5 export", () => {
  const raw = v5Export();

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
