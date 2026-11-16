// Plan reads on both export layouts: projectionlab_get_plan,
// projectionlab_get_plan_section and projectionlab_get_plan_settings against
// the synthetic v5 export, plus v4 regression checks that pin the v4 output.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "plmcp-v5-plans-home-"));
process.env.LOG_LEVEL = "error";

const { registerGetPlanTool } = await import("../dist/tools/getPlan.js");
const { registerGetPlanSectionTool } = await import("../dist/tools/getPlanSection.js");
const { registerGetPlanSettingsTool } = await import("../dist/tools/getPlanSettings.js");
const { CONTRACT_2_WRITES } = await import("../dist/layout.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function setup(register, raw) {
  const server = fakeServer();
  register(server, {
    async exportData() {
      return structuredClone(raw);
    },
  });
  return server;
}

const PLAN_MARK = "\n\nFull plan data:\n";

/** Splits a get_plan reply into its summary header and full plan data. */
function parsePlanReply(result) {
  const text = result.content[0].text;
  assert.ok(text.startsWith("Plan summary: "), text);
  const [head, body] = text.slice("Plan summary: ".length).split(PLAN_MARK);
  return { header: JSON.parse(head), plan: JSON.parse(body) };
}

const parse = (result) => JSON.parse(result.content[0].text);

function v4Export() {
  const at = (value) => ({ type: "date", value });
  return {
    meta: { version: "4.6.0" },
    today: { investmentAccounts: [{ id: "inv1", name: "Brokerage", balance: 10 }] },
    plans: [
      {
        id: "p1",
        name: "Retire at 55",
        active: true,
        lastUpdated: 100,
        income: { events: [{ id: "i1", name: "Salary", amount: 100000, start: at("2026-01-01") }] },
        expenses: { events: [{ id: "e1", name: "Living", amount: 60000 }] },
        accounts: { events: [{ id: "inv1", name: "Brokerage" }] },
        assets: { events: [] },
        milestones: [{ id: "m1", name: "Retire" }],
        priorities: { events: [] },
        variables: { inflation: 3, estate: { enabled: true } },
        montecarlo: { trials: 500 },
        withdrawalStrategy: { enabled: false },
      },
      { id: "p2", name: "Work forever", active: false, lastUpdated: 200, income: { events: [] } },
    ],
    settings: { plugins: { apiKey: "synthetic-plugin-key" } },
    progress: { data: [] },
  };
}

// --- projectionlab_get_plan ---

test("get_plan reads a v5 plan by id and says the active flag is not reported", async () => {
  const raw = v5Export();
  const server = setup(registerGetPlanTool, raw);
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "plan_main" });
  assert.equal(reply.isError, undefined);
  const { header, plan } = parsePlanReply(reply);
  assert.equal(header.name, "Main Plan");
  assert.equal(header.id, "plan_main");
  assert.equal(header.milestoneCount, 1);
  assert.equal(header.incomeEventCount, 1);
  assert.equal(header.expenseEventCount, 1);
  assert.equal(header.accountEventCount, 1);
  assert.equal(header.assetEventCount, 1);
  assert.equal(header.layout, "v5");
  assert.equal(header.active, "not reported");
  assert.ok(header.sections.includes("startingConditions"));
  assert.deepEqual(plan, raw.documents.plans[0]);
});

test("get_plan resolves a v5 plan by partial name and never picks a plan for you", async () => {
  const server = setup(registerGetPlanTool, v5Export());
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "retire early" });
  const { header, plan } = parsePlanReply(reply);
  assert.equal(header.id, "plan_early");
  assert.equal(header.active, "not reported");
  assert.equal("active" in plan, false);
});

test("get_plan lists the v5 plans when none matches", async () => {
  const server = setup(registerGetPlanTool, v5Export());
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "nope" });
  assert.equal(reply.isError, true);
  const out = parse(reply);
  assert.equal(out.error, "INVALID_INPUT");
  assert.match(out.message, /No plan matching "nope"/);
  assert.match(out.suggestion, /"Main Plan" \(plan_main\)/);
  assert.match(out.suggestion, /"Retire Early" \(plan_early\)/);
});

test("get_plan refuses an ambiguous v5 plan name", async () => {
  const server = setup(registerGetPlanTool, v5Export());
  // "a" is a name substring of both "Main Plan" and "Retire Early".
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "a" });
  assert.equal(reply.isError, true);
  assert.match(parse(reply).message, /More than one plan matches "a"/);
});

test("get_plan reports a v5 export with an empty plans list as having no plans", async () => {
  const raw = v5Export();
  raw.documents.plans = [];
  const server = setup(registerGetPlanTool, raw);
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "x" });
  assert.equal(reply.isError, true);
  assert.equal(parse(reply).message, "No plans found in ProjectionLab");
});

test("get_plan refuses a v5 export that has no plans list rather than reading no plans", async () => {
  const raw = v5Export();
  delete raw.documents.plans;
  const server = setup(registerGetPlanTool, raw);
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "x" });
  assert.equal(reply.isError, true);
  assert.match(parse(reply).message, /no plans list in documents\.plans/);
});

test("get_plan redacts secret-named fields inside a v5 plan", async () => {
  const raw = v5Export();
  raw.documents.plans[0].variables = { authToken: "abc123", note: "key is test-api-key" };
  const server = setup(registerGetPlanTool, raw);
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "plan_main" });
  const text = reply.content[0].text;
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("test-api-key"), false);
  assert.equal(parsePlanReply(reply).plan.variables.authToken, "[REDACTED]");
});

test("get_plan keeps the v4 header exactly, with no layout or active field", async () => {
  const server = setup(registerGetPlanTool, v4Export());
  const reply = await server.tools.get("projectionlab_get_plan").handler({ planIdentifier: "Retire" });
  const { header, plan } = parsePlanReply(reply);
  assert.deepEqual(Object.keys(header), [
    "name",
    "id",
    "milestoneCount",
    "incomeEventCount",
    "expenseEventCount",
    "accountEventCount",
    "assetEventCount",
    "sections",
  ]);
  assert.equal(header.name, "Retire at 55");
  assert.equal(header.incomeEventCount, 1);
  assert.equal(plan.active, true);
});

// --- projectionlab_get_plan_section ---

async function section(raw, args) {
  const server = setup(registerGetPlanSectionTool, raw);
  return server.tools.get("projectionlab_get_plan_section").handler(args);
}

test("get_plan_section returns every v5 section of a plan", async () => {
  const raw = v5Export();
  const plan = raw.documents.plans[0];
  for (const name of [
    "income",
    "expenses",
    "accounts",
    "assets",
    "milestones",
    "variables",
    "withdrawalStrategy",
    "montecarlo",
    "priorities",
  ]) {
    const reply = await section(raw, { planIdentifier: "Main Plan", section: name, listPaths: false });
    assert.equal(reply.isError, undefined, name);
    const out = parse(reply);
    assert.equal(out.planName, "Main Plan");
    assert.equal(out.planId, "plan_main");
    assert.equal(out.section, name);
    assert.deepEqual(out.data, plan[name], name);
  }
});

test("get_plan_section selects a v5 event by id and by name", async () => {
  const raw = v5Export();
  const byId = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "income",
      eventIdentifier: "plan_main_ev_salary",
      listPaths: false,
    }),
  );
  assert.equal(byId.data.name, "Salary");
  assert.deepEqual(byId.data.start, { type: "date", value: "2026-01-01" });
  assert.deepEqual(byId.data.end, { type: "milestone", value: "plan_main_ms_retire" });

  const byName = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "expenses",
      eventIdentifier: "living",
      listPaths: false,
    }),
  );
  assert.equal(byName.data.id, "plan_main_ev_living");
  assert.deepEqual(byName.data.end, { type: "keyword", value: "placeholder" });
});

test("get_plan_section listPaths annotates a v5 event from the v5 data model", async () => {
  const raw = v5Export();
  raw.documents.plans[0].income.events[0].yearlyChange = {
    type: "increase",
    amount: 3,
    limitEnabled: true,
    limit: 100000,
    limitType: "today$",
  };
  const out = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "income",
      eventIdentifier: "plan_main_ev_salary",
      listPaths: true,
    }),
  );
  const at = (path) => out.data.find((v) => v.path === path);
  assert.deepEqual(at("yearlyChange.type").allowedValues, [
    "none",
    "increase",
    "decrease",
    "custom",
    "match-inflation",
    "inflation+",
    "inflation-",
  ]);
  assert.equal(at("yearlyChange.limit").units, "dollars");
  assert.equal(at("yearlyChange.limitType").description, "Unit of yearlyChange.limit.");
});

test("get_plan_section selects a v5 account or asset event by the Current Finances id it links", async () => {
  const raw = v5Export();
  const account = parse(
    await section(raw, {
      planIdentifier: "plan_early",
      section: "accounts",
      eventIdentifier: "acct_brokerage",
      listPaths: false,
    }),
  );
  assert.equal(account.data.id, "plan_early_ev_brokerage");
  assert.equal(account.data.accountId, "acct_brokerage");

  const asset = parse(
    await section(raw, {
      planIdentifier: "plan_early",
      section: "assets",
      eventIdentifier: "asset_land",
      listPaths: false,
    }),
  );
  assert.equal(asset.data.id, "plan_early_ev_land");
  assert.equal(asset.data.assetId, "asset_land");
});

test("get_plan_section prefers an id or name match over a link match", async () => {
  const raw = v5Export();
  raw.documents.plans[0].accounts.events.push({
    id: "acct_brokerage",
    accountId: "acct_401k",
    kind: "account",
    name: "Named by id",
  });
  const out = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "accounts",
      eventIdentifier: "acct_brokerage",
      listPaths: false,
    }),
  );
  assert.equal(out.data.name, "Named by id");
});

test("get_plan_section refuses a v5 link that several events share", async () => {
  const raw = v5Export();
  raw.documents.plans[0].priorities.events.push({
    id: "plan_main_ev_save2",
    kind: "priority",
    type: "taxable",
    name: "Save again",
    accountId: "acct_brokerage",
  });
  const reply = await section(raw, {
    planIdentifier: "plan_main",
    section: "priorities",
    eventIdentifier: "acct_brokerage",
    listPaths: false,
  });
  assert.equal(reply.isError, true);
  const out = parse(reply);
  assert.match(out.message, /More than one event matches "acct_brokerage"/);
  assert.match(out.suggestion, /plan_main_ev_save\b/);
  assert.match(out.suggestion, /plan_main_ev_save2/);
});

test("get_plan_section names the v5 events available when none matches", async () => {
  const reply = await section(v5Export(), {
    planIdentifier: "plan_main",
    section: "accounts",
    eventIdentifier: "acct_missing",
    listPaths: false,
  });
  assert.equal(reply.isError, true);
  const out = parse(reply);
  assert.match(out.message, /No event matching "acct_missing" in section "accounts" of plan "Main Plan"/);
  assert.match(out.suggestion, /Brokerage/);
});

test("get_plan_section narrows a v5 section by path and flattens it with listPaths", async () => {
  const raw = v5Export();
  const byPath = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "income",
      path: "events[0].amount",
      listPaths: false,
    }),
  );
  assert.equal(byPath.data, 90000);

  const listed = parse(
    await section(raw, {
      planIdentifier: "plan_main",
      section: "income",
      eventIdentifier: "Salary",
      listPaths: true,
    }),
  );
  const byPathName = Object.fromEntries(listed.data.map((entry) => [entry.path, entry]));
  assert.equal(byPathName["start.type"].type, "string");
  assert.equal(byPathName["start.type"].value, "date");
  assert.equal(byPathName["end.value"].value, "plan_main_ms_retire");
  assert.equal(byPathName.amount.value, 90000);
});

test("get_plan_section reports a v5 section the plan lacks", async () => {
  const raw = v5Export();
  delete raw.documents.plans[0].priorities;
  const reply = await section(raw, { planIdentifier: "plan_main", section: "priorities", listPaths: false });
  assert.equal(reply.isError, true);
  const out = parse(reply);
  assert.match(out.message, /Section "priorities" not found in plan "Main Plan"/);
  assert.match(out.suggestion, /Available sections: .*income/);
});

test("get_plan_section redacts secret-named fields in a v5 plan", async () => {
  const raw = v5Export();
  raw.documents.plans[0].variables = { apiKey: "leaky", inflation: 3, memo: "test-api-key" };
  const reply = await section(raw, { planIdentifier: "plan_main", section: "variables", listPaths: false });
  const text = reply.content[0].text;
  assert.equal(text.includes("leaky"), false);
  assert.equal(text.includes("test-api-key"), false);
  assert.equal(parse(reply).data.apiKey, "[REDACTED]");
  assert.equal(parse(reply).data.inflation, 3);
});

test("get_plan_section does not match a v4 event by a linked id, and keeps its v4 output", async () => {
  const raw = v4Export();
  raw.plans[0].accounts.events[0].accountId = "linked-elsewhere";
  const miss = await section(raw, {
    planIdentifier: "p1",
    section: "accounts",
    eventIdentifier: "linked-elsewhere",
    listPaths: false,
  });
  assert.equal(miss.isError, true);
  assert.match(parse(miss).message, /No event matching "linked-elsewhere"/);

  const hit = parse(
    await section(raw, { planIdentifier: "Retire", section: "income", eventIdentifier: "i1", listPaths: false }),
  );
  assert.deepEqual(Object.keys(hit), ["planName", "planId", "section", "eventIdentifier", "data"]);
  assert.equal(hit.planName, "Retire at 55");
  assert.equal(hit.data.amount, 100000);
});

// --- projectionlab_get_plan_settings ---

async function settings(raw, args) {
  const server = setup(registerGetPlanSettingsTool, raw);
  return server.tools.get("projectionlab_get_plan_settings").handler(args);
}

const UPDATE_TOOL = "projectionlab_update_plan_settings";

test("get_plan_settings reads a v5 plan's own sections and reports the workspace selection as not reported", async () => {
  const raw = v5Export();
  raw.documents.plans[0].variables = { inflation: 3, estate: { enabled: true } };
  raw.documents.plans[0].montecarlo = { trials: 500 };
  const reply = await settings(raw, { planIdentifier: "Main Plan" });
  assert.equal(reply.isError, undefined);
  const out = parse(reply);
  assert.equal(out.planName, "Main Plan");
  assert.equal(out.planId, "plan_main");
  assert.equal(out.layout, "v5");
  assert.deepEqual(out.planSelection, {
    activeId: "not reported",
    baselineId: "not reported",
    alignment: { type: "calendar" },
    tabs: { pinned: false },
  });
  assert.deepEqual(
    out.sections.map((s) => [s.section, s.settingCount]),
    [
      ["variables", 2],
      ["montecarlo", 1],
      ["withdrawalStrategy", 0],
    ],
  );
  const variables = out.sections[0].settings.map((s) => s.path);
  assert.deepEqual(variables, ["estate.enabled", "inflation"]);
});

test("get_plan_settings mutableWith follows what a v5 page accepts as a write", async () => {
  const out = parse(await settings(v5Export(), { planIdentifier: "plan_main" }));
  assert.equal(out.mutableWith, CONTRACT_2_WRITES.has("restorePlans") ? UPDATE_TOOL : null);
});

test("get_plan_settings reports an active or baseline plan only when the export holds one", async () => {
  const raw = v5Export();
  raw.documents.settings.plan.activeId = "plan_early";
  raw.documents.settings.plan.baselineId = "plan_main";
  const out = parse(await settings(raw, { planIdentifier: "plan_main" }));
  assert.equal(out.planSelection.activeId, "plan_early");
  assert.equal(out.planSelection.baselineId, "plan_main");
});

test("get_plan_settings reports every selection field as not reported when the export has no plan settings", async () => {
  const raw = v5Export();
  delete raw.documents.settings.plan;
  const out = parse(await settings(raw, { planIdentifier: "plan_main" }));
  assert.deepEqual(out.planSelection, {
    activeId: "not reported",
    baselineId: "not reported",
    alignment: "not reported",
    tabs: "not reported",
  });
});

test("get_plan_settings annotates v5 settings from the v5 data model", async () => {
  const raw = v5Export();
  raw.documents.plans[0].variables = { alignment: { type: "calendar" } };
  const out = parse(await settings(raw, { planIdentifier: "plan_main", section: "variables" }));
  const alignment = out.sections[0].settings.find((s) => s.path === "alignment.type");
  assert.deepEqual(alignment.allowedValues, ["calendar", "rolling", "au-tax", "uk-tax", "custom"]);
});

test("get_plan_settings returns one v5 section and treats a missing section as empty", async () => {
  const raw = v5Export();
  raw.documents.plans[1].withdrawalStrategy = { mode: "fixed", fixed: { amount: 40000 } };
  delete raw.documents.plans[1].montecarlo;
  const one = parse(await settings(raw, { planIdentifier: "plan_early", section: "withdrawalStrategy" }));
  assert.equal(one.sections.length, 1);
  assert.deepEqual(
    one.sections[0].settings.map((s) => [s.path, s.value]),
    [
      ["fixed.amount", 40000],
      ["mode", "fixed"],
    ],
  );
  const all = parse(await settings(raw, { planIdentifier: "plan_early" }));
  assert.equal(all.sections.find((s) => s.section === "montecarlo").settingCount, 0);
});

test("get_plan_settings redacts secret-named settings of a v5 plan", async () => {
  const raw = v5Export();
  raw.documents.plans[0].variables = { integration: { authToken: "sensitive" } };
  const reply = await settings(raw, { planIdentifier: "plan_main", section: "variables" });
  assert.equal(reply.content[0].text.includes("sensitive"), false);
  assert.equal(parse(reply).sections[0].settings[0].redacted, true);
});

test("get_plan_settings keeps the v4 output exactly, with no layout or planSelection", async () => {
  const out = parse(await settings(v4Export(), { planIdentifier: "p1" }));
  assert.deepEqual(Object.keys(out), ["planName", "planId", "mutableWith", "sections"]);
  assert.equal(out.planName, "Retire at 55");
  assert.equal(out.mutableWith, UPDATE_TOOL);
  assert.deepEqual(
    out.sections.map((s) => [s.section, s.settingCount]),
    [
      ["variables", 2],
      ["montecarlo", 1],
      ["withdrawalStrategy", 1],
    ],
  );
});

test("get_plan_settings and get_plan_section share the v5 plan lookup errors", async () => {
  const raw = v5Export();
  const settingsReply = await settings(raw, { planIdentifier: "nope" });
  const sectionReply = await section(raw, { planIdentifier: "nope", section: "income", listPaths: false });
  assert.deepEqual(parse(settingsReply), parse(sectionReply));
});
