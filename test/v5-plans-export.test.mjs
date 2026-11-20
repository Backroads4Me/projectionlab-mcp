// Whole-export reads: projectionlab_export_data and the
// projectionlab://plan-data resource keep every secret redacted, and the plan
// helpers in src/plans.ts and src/planSettings.ts read the ProjectionLab 5
// export and refuse a ProjectionLab 4 one.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.HOME = mkdtempSync(join(tmpdir(), "plmcp-v5-export-home-"));
process.env.LOG_LEVEL = "error";

const { registerExportTool } = await import("../dist/tools/export.js");
const { registerPlanDataResource } = await import("../dist/resources/planData.js");
const { FILE_THRESHOLD } = await import("../dist/largeOutput.js");
const plans = await import("../dist/plans.js");
const { planSelection } = await import("../dist/planSettings.js");

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

const bridgeOf = (raw) => ({
  async exportData() {
    return structuredClone(raw);
  },
});

/** A ProjectionLab 4 export, which the plan helpers refuse. */
function v4Export() {
  return {
    meta: { version: "4.6.0" },
    today: { note: "key is test-api-key", investmentAccounts: [] },
    plans: [
      { id: "p1", name: "Retire at 55", active: true },
      { id: "p2", name: "Work forever" },
      { id: "p3" },
    ],
    settings: { plugins: { apiKey: "synthetic-plugin-key" } },
    progress: { data: [] },
  };
}

async function exportText(raw) {
  const server = fakeServer();
  registerExportTool(server, bridgeOf(raw));
  const result = await server.tools.get("projectionlab_export_data").handler({});
  assert.equal(result.isError, undefined);
  return result.content[0].text;
}

async function resourceText(raw) {
  const server = fakeServer();
  registerPlanDataResource(server, bridgeOf(raw));
  const { handler } = server.resources.get("projectionlab://plan-data");
  const result = await handler(new URL("projectionlab://plan-data"));
  return result.contents[0].text;
}

// --- projectionlab_export_data ---

test("export_data returns a v5 export with the plugin API key redacted by name", async () => {
  const raw = v5Export();
  const text = await exportText(raw);
  assert.equal(text.includes("synthetic-plugin-key"), false);
  const out = JSON.parse(text);
  assert.equal(out.documents.settings.plugins.apiKey, "[REDACTED]");
  assert.equal(out.documents.settings.plugins.enabled, true);
  assert.equal(out.schema, raw.schema);
  assert.deepEqual(out.documents.plans, raw.documents.plans);
  assert.deepEqual(out.documents.currentFinances, raw.documents.currentFinances);
  assert.deepEqual(out.documents.accountHistory, raw.documents.accountHistory);
});

test("export_data also scrubs the literal API key and secret-named fields anywhere in a v5 export", async () => {
  const raw = v5Export();
  raw.documents.currentFinances.accounts.acct_brokerage.note = "pasted test-api-key here";
  raw.documents.plans[0].variables = { authToken: "abc123" };
  const text = await exportText(raw);
  assert.equal(text.includes("test-api-key"), false);
  assert.equal(text.includes("abc123"), false);
  assert.match(text, /pasted \[REDACTED\] here/);
});

test("export_data names the v5 plans in the pointer when the export spills to a file", async () => {
  const raw = v5Export();
  raw.documents.currentFinances.padding = "x".repeat(FILE_THRESHOLD);
  const text = await exportText(raw);
  const out = JSON.parse(text);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.planNames, ["Main Plan", "Retire Early"]);
  const written = readFileSync(out.filePath, "utf8");
  assert.equal(written.includes("synthetic-plugin-key"), false);
  assert.equal(JSON.parse(written).documents.settings.plugins.apiKey, "[REDACTED]");
});

test("export_data still returns a v5 export that lacks a plans list", async () => {
  const raw = v5Export();
  delete raw.documents.plans;
  raw.documents.currentFinances.padding = "x".repeat(FILE_THRESHOLD);
  const out = JSON.parse(await exportText(raw));
  assert.equal(out.truncated, true);
  assert.deepEqual(out.planNames, []);
});

test("export_data describes the ProjectionLab 5 export", () => {
  const server = fakeServer();
  registerExportTool(server, bridgeOf(v5Export()));
  const { definition } = server.tools.get("projectionlab_export_data");
  assert.doesNotMatch(definition.description, /ProjectionLab 4/);
  assert.match(definition.description, /ProjectionLab 5's documents envelope/);
  assert.match(
    definition.description,
    /saved to a file and a pointer is returned\. Prefer projectionlab_get_plan /,
  );
  assert.equal(definition.annotations.readOnlyHint, true);
});

// --- projectionlab://plan-data ---

test("plan-data resource returns a v5 export with every secret redacted", async () => {
  const raw = v5Export();
  raw.documents.plans[1].memo = "has test-api-key inside";
  const text = await resourceText(raw);
  assert.equal(text.includes("synthetic-plugin-key"), false);
  assert.equal(text.includes("test-api-key"), false);
  const out = JSON.parse(text);
  assert.equal(out.documents.settings.plugins.apiKey, "[REDACTED]");
  assert.equal(out.documents.plans[0].name, "Main Plan");
  assert.equal(out.documents.plans[1].memo, "has [REDACTED] inside");
  assert.deepEqual(out.documents.currentFinances.accounts, raw.documents.currentFinances.accounts);
});

// --- plan helpers ---

test("requirePlans reads the v5 plans and refuses an empty list", () => {
  const v5 = v5Export();
  assert.equal(plans.requirePlans(v5), v5.documents.plans);

  v5.documents.plans = [];
  assert.throws(() => plans.requirePlans(v5), /No plans found in ProjectionLab/);
});

test("requirePlans refuses a ProjectionLab 4 export", () => {
  assert.throws(() => plans.requirePlans(v4Export()), { code: "UNSUPPORTED_API_VERSION" });
  assert.throws(() => plans.requirePlans({ plans: "nope" }), { code: "UNSUPPORTED_API_VERSION" });
});

test("requirePlans refuses a v5 export with no plans list", () => {
  const v5 = v5Export();
  delete v5.documents.plans;
  assert.throws(() => plans.requirePlans(v5), /no plans list in documents\.plans/);
});

test("exportPlanNames names the v5 plans and has none for a missing list or another layout", () => {
  assert.deepEqual(plans.exportPlanNames(v5Export()), ["Main Plan", "Retire Early"]);
  assert.deepEqual(plans.exportPlanNames(v4Export()), []);
  assert.deepEqual(plans.exportPlanNames({}), []);
  const v5 = v5Export();
  delete v5.documents.plans;
  assert.deepEqual(plans.exportPlanNames(v5), []);
});

test("resolveLinkedEventIndex matches accountId or assetId exactly", () => {
  const events = [
    { id: "e1", accountId: "acct_a" },
    { id: "e2", assetId: "asset_b" },
    null,
    { id: "acct_c" },
  ];
  assert.equal(plans.resolveLinkedEventIndex(events, "acct_a"), 0);
  assert.equal(plans.resolveLinkedEventIndex(events, "asset_b"), 1);
  assert.equal(plans.resolveLinkedEventIndex(events, "acct_c"), -1);
  assert.equal(plans.resolveLinkedEventIndex(events, "acct"), -1);
  assert.throws(
    () => plans.resolveLinkedEventIndex([...events, { id: "e5", accountId: "acct_a" }], "acct_a"),
    /More than one event matches "acct_a"/,
  );
});

test("resolveEventIndex matches an event by id and name only", () => {
  const events = [{ id: "inv1", name: "Brokerage", accountId: "elsewhere" }];
  assert.equal(plans.resolveEventIndex(events, "inv1"), 0);
  assert.equal(plans.resolveEventIndex(events, "broker"), 0);
  assert.equal(plans.resolveEventIndex(events, "elsewhere"), -1);
});

test("planSelection reads documents.settings.plan and refuses a ProjectionLab 4 export", () => {
  assert.deepEqual(planSelection(v5Export()), {
    activeId: "not reported",
    baselineId: "not reported",
    alignment: { type: "calendar" },
    tabs: { pinned: false },
  });
  assert.throws(() => planSelection(v4Export()), { code: "UNSUPPORTED_API_VERSION" });
  assert.equal(plans.NOT_REPORTED, "not reported");

  const odd = v5Export();
  odd.documents.settings = null;
  assert.equal(planSelection(odd).activeId, "not reported");
  odd.documents.settings = { plan: [] };
  assert.equal(planSelection(odd).alignment, "not reported");
});
