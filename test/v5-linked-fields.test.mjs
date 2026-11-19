// Plan event fields ProjectionLab 5 copies from the item an event links to
// (src/linkedFields.ts). Plan writes that change them are refused before any
// snapshot or write; other fields on the same events stay writable.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-linked-fields-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
const { registerGetPlanSectionTool } = await import("../dist/tools/getPlanSection.js");
const { renderDataModelMarkdown } = await import("../dist/resources/dataModel.js");

/** A v5 export whose linked events carry the fields under test. */
function linkedExport() {
  const state = v5Export();
  state.documents.currentFinances.accounts.acct_brokerage.EWAge = 60;
  for (const plan of state.documents.plans) {
    Object.assign(plan.accounts.events[0], { EWAge: 60, hasEWPenalty: false, owner: "me", icon: "chart", dividendRate: 0 });
    plan.accounts.events.push({
      id: `${plan.id}_ev_cash`, kind: "account", type: "savings", name: "Cash", EWAge: 60, owner: "me",
    });
    Object.assign(plan.priorities.events[0], { owner: "me", icon: "chart", amount: 100 });
  }
  return state;
}

function v5Bridge(state = linkedExport()) {
  const writes = [];
  const apply = (name) => async (...args) => {
    const plans = name === "restorePlans" ? args[0] : args[1];
    writes.push({ name });
    state.documents.plans = structuredClone(plans);
  };
  return {
    state,
    writes,
    async editAccess() {
      return "enabled";
    },
    async apiContract() {
      return 2;
    },
    async exportData() {
      return structuredClone(state);
    },
    restorePlans: apply("restorePlans"),
    restorePlansIfUnchanged: apply("restorePlansIfUnchanged"),
  };
}

function snapshotStore() {
  const created = [];
  return {
    created,
    async create(operation) {
      created.push(operation);
      return { id: `snap-${created.length}` };
    },
  };
}

function tools(bridge, snapshots) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
    registerResource() {},
  };
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerGetPlanSectionTool(server, bridge);
  return async (name, input) => {
    const result = await map.get(name)(input);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
}

const eventInput = (section, eventIdentifier, change, confirm = false) => ({
  planIdentifier: "plan_main",
  section,
  eventIdentifier,
  ...change,
  confirm,
});

function assertRefused(result, ...paths) {
  assert.equal(result.isError, true, JSON.stringify(result.body));
  const text = JSON.stringify(result.body);
  for (const path of paths) assert.match(text, new RegExp(path));
  assert.match(text, /projectionlab_update_account|on the account in ProjectionLab|on the linked item in ProjectionLab/);
}

for (const confirm of [false, true]) {
  test(`update_plan_event refuses EWAge on a linked account event (confirm ${confirm})`, async () => {
    const bridge = v5Bridge();
    const snapshots = snapshotStore();
    const call = tools(bridge, snapshots);
    const result = await call(
      "projectionlab_update_plan_event",
      eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { EWAge: 63 } }, confirm),
    );
    assertRefused(result, "EWAge", "acct_brokerage");
    assert.deepEqual(bridge.writes, []);
    assert.deepEqual(snapshots.created, []);
  });
}

test("update_plan_event writes a field the link does not supply on a linked event", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { dividendRate: 1 } }, true),
  );
  assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.equal(result.body.verified, true);
  assert.equal(bridge.writes.length, 1);
});

test("update_plan_event names only the linked paths of a mixed change", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { dividendRate: 1, name: "Renamed", owner: "spouse" } }),
  );
  assertRefused(result, "name", "owner");
  assert.doesNotMatch(result.body.error?.message ?? JSON.stringify(result.body), /dividendRate/);
});

test("update_plan_event lets a value the event already holds through", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { EWAge: 60, dividendRate: 2 } }),
  );
  assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body.changes), ["dividendRate"]);
});

test("update_plan_event refuses the legacy patch input on a linked field", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_brokerage", { patch: { EWAge: 63 } }),
  );
  assertRefused(result, "EWAge");
});

test("update_plan_event writes EWAge on an account event with no accountId", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_cash", { pathChanges: { EWAge: 63 } }, true),
  );
  assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.equal(result.body.verified, true);
});

test("update_plan_event refuses a linked asset's value and loans", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("assets", "plan_main_ev_land", { patch: { value: 1, loans: [{ id: "x" }] } }),
  );
  assertRefused(result, "value", "loans", "asset_land");
});

test("update_plan_event refuses a priority's owner and icon but not its amount", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const refused = await call(
    "projectionlab_update_plan_event",
    eventInput("priorities", "plan_main_ev_save", { pathChanges: { icon: "bank" } }),
  );
  assertRefused(refused, "icon");
  const allowed = await call(
    "projectionlab_update_plan_event",
    eventInput("priorities", "plan_main_ev_save", { pathChanges: { amount: 200 } }),
  );
  assert.equal(allowed.isError, false, JSON.stringify(allowed.body));
});

test("a transfer priority takes only owner from its link", async () => {
  const state = linkedExport();
  state.documents.plans[0].priorities.events[0].goalIntent = "transfer";
  const call = tools(v5Bridge(state), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("priorities", "plan_main_ev_save", { pathChanges: { icon: "bank" } }),
  );
  assert.equal(result.isError, false, JSON.stringify(result.body));
});

test("an overridden field is writable, except on the baseline plan", async () => {
  const state = linkedExport();
  state.documents.plans[0].accounts.events[0]._meta = { overriddenFields: { EWAge: true } };
  const change = eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { EWAge: 63 } });

  const allowed = await tools(v5Bridge(structuredClone(state)), snapshotStore())(
    "projectionlab_update_plan_event",
    change,
  );
  assert.equal(allowed.isError, false, JSON.stringify(allowed.body));

  state.documents.settings.plan.baselineId = "plan_main";
  const refused = await tools(v5Bridge(state), snapshotStore())(
    "projectionlab_update_plan_event",
    change,
  );
  assertRefused(refused, "EWAge");
});

test("update_plan_section refuses a changed linked field and passes unchanged ones", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const section = structuredClone(bridge.state.documents.plans[0].accounts);

  const unchanged = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "accounts",
    sectionData: { events: section.events.map((e) => ({ ...e, dividendRate: 3 })) },
  });
  assert.equal(unchanged.isError, false, JSON.stringify(unchanged.body));

  section.events[0].EWAge = 63;
  section.events[1].EWAge = 64;
  for (const confirm of [false, true]) {
    const result = await call("projectionlab_update_plan_section", {
      planIdentifier: "plan_main",
      section: "accounts",
      sectionData: section,
      confirm,
    });
    assertRefused(result, "EWAge", "Brokerage");
    assert.doesNotMatch(JSON.stringify(result.body), /Cash/);
  }
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("update_plan_section refuses dropping a linked field", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const section = structuredClone(bridge.state.documents.plans[0].accounts);
  delete section.events[0].owner;
  const result = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "accounts",
    sectionData: section,
  });
  assertRefused(result, "owner");
});

test("listPaths marks linked paths on one linked event only", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const linked = await call("projectionlab_get_plan_section", {
    planIdentifier: "plan_main",
    section: "accounts",
    eventIdentifier: "plan_main_ev_brokerage",
    listPaths: true,
  });
  const marks = Object.fromEntries(linked.body.data.map((e) => [e.path, e.syncedFrom]));
  assert.equal(marks.EWAge, "Current Finances account");
  assert.equal(marks.name, "Current Finances account");
  assert.equal(marks.dividendRate, undefined);
  assert.equal(marks.accountId, undefined);

  const unlinked = await call("projectionlab_get_plan_section", {
    planIdentifier: "plan_main",
    section: "accounts",
    eventIdentifier: "plan_main_ev_cash",
    listPaths: true,
  });
  assert.ok(unlinked.body.data.every((e) => e.syncedFrom === undefined));
});

test("the v5 data model lists the linked fields", () => {
  const markdown = renderDataModelMarkdown("v5");
  assert.match(markdown, /`EWAge`/);
  assert.match(markdown, /`purchasePrice`/);
  assert.match(markdown, /syncedFrom/);
});

test("update_plan_section pairs events by id, so renaming a linked event is refused", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const section = structuredClone(bridge.state.documents.plans[0].accounts);
  section.events[0].name = "Renamed";
  const result = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "accounts",
    sectionData: section,
  });
  assertRefused(result, "name", "Brokerage");
});

test("the hint names update_account for a field the record holds, and the app for one it lacks", async () => {
  const call = tools(v5Bridge(), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("accounts", "plan_main_ev_brokerage", { pathChanges: { name: "Renamed", EWAge: 63, hasEWPenalty: true } }),
  );
  assert.equal(result.isError, true);
  const { suggestion } = result.body;
  assert.match(suggestion, /Change name, EWAge with projectionlab_update_account on Current Finances id "acct_brokerage"/);
  assert.match(suggestion, /holds no hasEWPenalty/);
  assert.match(suggestion, /on the account in ProjectionLab/);
});

test("a priority's hint resolves the Current Finances id through the plan's account event", async () => {
  const state = linkedExport();
  // On ProjectionLab 5 a priority's accountId names the plan account event.
  state.documents.plans[0].priorities.events[0].accountId = "plan_main_ev_brokerage";
  const call = tools(v5Bridge(state), snapshotStore());
  const result = await call(
    "projectionlab_update_plan_event",
    eventInput("priorities", "plan_main_ev_save", { pathChanges: { owner: "spouse" } }),
  );
  assert.equal(result.isError, true);
  assert.match(result.body.message, /plan account event "plan_main_ev_brokerage"/);
  assert.match(result.body.suggestion, /Current Finances id "acct_brokerage"/);
});
