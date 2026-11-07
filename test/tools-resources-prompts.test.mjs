// update_plan_section and clone_plan handlers, the four resources, and the
// four prompts, against an in-memory bridge that re-stamps saved plans the
// way ProjectionLab does.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-tools-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { config } = await import("../dist/config.js");
const { SnapshotManager } = await import("../dist/snapshot.js");
const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);
const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
const { registerPlanDataResource } = await import("../dist/resources/planData.js");
const { registerSummaryResource } = await import("../dist/resources/summary.js");
const { registerGuideResource } = await import("../dist/resources/guide.js");
const { registerKnowledgeResource } = await import("../dist/resources/knowledge.js");
const { registerPrompts } = await import("../dist/prompts/index.js");

function fakeServer() {
  const tools = new Map();
  const resources = new Map();
  const prompts = new Map();
  return {
    tools,
    resources,
    prompts,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
    registerResource(name, uri, meta, handler) {
      resources.set(uri, { name, meta, handler });
    },
    registerPrompt(name, definition, handler) {
      prompts.set(name, { definition, handler });
    },
  };
}

function samplePlans() {
  return [
    {
      id: "p1",
      name: "Retire at 55",
      lastUpdated: 100,
      income: { events: [{ id: "i1", name: "Salary", amount: 100000 }] },
      expenses: { events: [{ id: "e1", name: "Living", amount: 60000 }] },
      milestones: [{ id: "m1", name: "Retire" }],
    },
    {
      id: "p2",
      name: "Work forever",
      lastUpdated: 200,
      income: { events: [] },
      expenses: { events: [] },
      milestones: [],
    },
  ];
}

function fakeBridge(initial) {
  let stamp = 1000;
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: 0,
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes++;
      state.plans = structuredClone(plans).map((p) => ({ ...p, lastUpdated: ++stamp }));
    },
  };
  return bridge;
}

function setup(register) {
  const bridge = fakeBridge({ today: {}, plans: samplePlans() });
  const snapshots = new SnapshotManager();
  const server = fakeServer();
  register(server, bridge, snapshots);
  return { bridge, snapshots, server };
}

/** Simulate the user saving a plan in ProjectionLab just before the n-th read. */
function savePlanBeforeRead(bridge, n, planIndex) {
  const exportData = bridge.exportData;
  let reads = 0;
  bridge.exportData = async () => {
    reads++;
    if (reads === n) bridge.state.plans[planIndex].lastUpdated += 1;
    return exportData();
  };
}

const parse = (result) => JSON.parse(result.content[0].text);

// --- update_plan_section ---

const newIncome = {
  events: [
    { id: "i1", name: "Salary", amount: 110000 },
    { id: "i3", name: "Consulting", amount: 20000 },
  ],
};

const sectionArgs = (extra) => ({
  planIdentifier: "Retire",
  section: "income",
  sectionData: newIncome,
  ...extra,
});

test("update_plan_section dry run previews without writing", async () => {
  const { bridge, server } = setup(registerUpdatePlanSectionTool);
  const out = parse(
    await server.tools
      .get("projectionlab_update_plan_section")
      .handler(sectionArgs({ confirm: false })),
  );
  assert.equal(out.dryRun, true);
  assert.equal(out.planId, "p1");
  assert.equal(out.planVersion, "100");
  assert.equal(bridge.writes, 0);
});

test("update_plan_section confirmed write snapshots, replaces only that section, and verifies", async () => {
  const { bridge, snapshots, server } = setup(registerUpdatePlanSectionTool);
  const out = parse(
    await server.tools
      .get("projectionlab_update_plan_section")
      .handler(sectionArgs({ confirm: true, expectedPlanVersion: "100" })),
  );
  assert.equal(out.success, true);
  assert.equal(out.verified, true);
  assert.equal(bridge.writes, 1);
  assert.deepEqual(bridge.state.plans[0].income, newIncome);
  assert.deepEqual(bridge.state.plans[0].expenses, samplePlans()[0].expenses);
  assert.equal(bridge.state.plans[1].name, "Work forever");
  const list = await snapshots.list();
  assert.ok(list.some((s) => s.operation === "updatePlanSection"));
});

test("update_plan_section refuses a stale expectedPlanVersion", async () => {
  const { bridge, server } = setup(registerUpdatePlanSectionTool);
  const result = await server.tools
    .get("projectionlab_update_plan_section")
    .handler(sectionArgs({ confirm: true, expectedPlanVersion: "99" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLAN_CONFLICT/);
  assert.equal(bridge.writes, 0);
});

test("update_plan_section refuses when a plan is saved before the write", async () => {
  const { bridge, server } = setup(registerUpdatePlanSectionTool);
  savePlanBeforeRead(bridge, 2, 1);
  const result = await server.tools
    .get("projectionlab_update_plan_section")
    .handler(sectionArgs({ confirm: true }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLAN_CONFLICT/);
  assert.equal(bridge.writes, 0);
});

test("update_plan_section reports unverified when the app drops an event", async () => {
  const { bridge, server } = setup(registerUpdatePlanSectionTool);
  const restore = bridge.restorePlans;
  bridge.restorePlans = async (plans) => {
    await restore(plans);
    bridge.state.plans[0].income.events.pop();
  };
  const out = parse(
    await server.tools
      .get("projectionlab_update_plan_section")
      .handler(sectionArgs({ confirm: true })),
  );
  assert.equal(out.verified, false);
});

test("write tools refuse in read-only mode", async () => {
  const { bridge, server } = setup((s, b, snaps) => {
    registerUpdatePlanSectionTool(s, b, snaps);
    registerClonePlanTool(s, b, snaps);
  });
  config.readOnly = true;
  try {
    for (const [name, args] of [
      ["projectionlab_update_plan_section", sectionArgs({ confirm: true })],
      ["projectionlab_clone_plan", { planIdentifier: "Retire", newName: "Copy", confirm: true }],
    ]) {
      const result = await server.tools.get(name).handler(args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /READ_ONLY_MODE/, name);
    }
    assert.equal(bridge.writes, 0);
  } finally {
    config.readOnly = false;
  }
});

// --- clone_plan ---

test("clone_plan dry run previews the copy without writing", async () => {
  const { bridge, server } = setup(registerClonePlanTool);
  const out = parse(
    await server.tools
      .get("projectionlab_clone_plan")
      .handler({ planIdentifier: "Retire", newName: "Retire at 57", confirm: false }),
  );
  assert.equal(out.dryRun, true);
  assert.equal(out.sourcePlan.id, "p1");
  assert.equal(out.newPlan.name, "Retire at 57");
  assert.equal(out.eventCounts.income, 1);
  assert.equal(bridge.writes, 0);
});

test("clone_plan confirmed adds a verified copy and keeps the originals", async () => {
  const { bridge, snapshots, server } = setup(registerClonePlanTool);
  const out = parse(
    await server.tools
      .get("projectionlab_clone_plan")
      .handler({ planIdentifier: "Retire", newName: "Retire at 57", confirm: true }),
  );
  assert.equal(out.success, true);
  assert.equal(out.verified, true, JSON.stringify(out.verificationProblems));
  assert.equal(bridge.state.plans.length, 3);
  const copy = bridge.state.plans[2];
  assert.equal(copy.name, "Retire at 57");
  assert.notEqual(copy.id, "p1");
  assert.deepEqual(copy.income.events.map((e) => e.name), ["Salary"]);
  assert.equal(bridge.state.plans[0].name, "Retire at 55");
  assert.ok((await snapshots.list()).some((s) => s.id === out.snapshotId));
});

test("clone_plan refuses when a plan is saved before the write", async () => {
  const { bridge, server } = setup(registerClonePlanTool);
  savePlanBeforeRead(bridge, 2, 0);
  const result = await server.tools
    .get("projectionlab_clone_plan")
    .handler({ planIdentifier: "Retire", newName: "Copy", confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLAN_CONFLICT/);
  assert.equal(bridge.writes, 0);
});

// --- resources ---

async function readResource(server, uri) {
  const { handler } = server.resources.get(uri);
  const result = await handler(new URL(uri));
  return result.contents[0].text;
}

test("plan-data resource redacts the API key and secret-named fields", async () => {
  const server = fakeServer();
  registerPlanDataResource(
    server,
    fakeBridge({
      today: { note: "key is test-api-key", authToken: "abc123" },
      plans: samplePlans(),
    }),
  );
  const text = await readResource(server, "projectionlab://plan-data");
  assert.equal(text.includes("test-api-key"), false);
  assert.equal(text.includes("abc123"), false);
  assert.match(text, /Retire at 55/);
});

test("summary resource reports the same per-plan counts as the tool", async () => {
  const server = fakeServer();
  registerSummaryResource(
    server,
    fakeBridge({ today: { savingsAccounts: [{ balance: 500 }] }, plans: samplePlans() }),
  );
  const summary = JSON.parse(await readResource(server, "projectionlab://summary"));
  assert.equal(summary.scope, "currentFinances");
  assert.equal(summary.totalNetWorth, 500);
  assert.deepEqual(
    summary.plans.map(({ id, incomeCount, expenseCount, milestoneCount }) => ({
      id,
      incomeCount,
      expenseCount,
      milestoneCount,
    })),
    [
      { id: "p1", incomeCount: 1, expenseCount: 1, milestoneCount: 1 },
      { id: "p2", incomeCount: 0, expenseCount: 0, milestoneCount: 0 },
    ],
  );
});

test("guide resource serves SKILL.md without its frontmatter", async () => {
  const server = fakeServer();
  registerGuideResource(server);
  const text = await readResource(server, "projectionlab://guide");
  assert.equal(text.startsWith("---"), false);
  assert.equal(/^name: projectionlab$/m.test(text), false);
  assert.match(text, /^# ProjectionLab MCP/m);
  assert.match(text, /projectionlab_check_connection/);
});

test("knowledge resource is served as text", async () => {
  const server = fakeServer();
  registerKnowledgeResource(server);
  const text = await readResource(server, "projectionlab://knowledge");
  assert.ok(text.length > 1000);
});

// --- prompts ---

const TOOL_SUFFIXES = new Set([
  "check_connection", "get_bootstrap", "describe_plugin_api", "export_data",
  "describe_schema", "get_summary", "get_plan", "get_plan_section",
  "get_plan_settings", "get_current_finances", "update_account",
  "update_plan_section", "update_plan_event", "update_plan_settings",
  "clone_plan", "restore_current_finances", "restore_plans",
  "restore_progress", "restore_settings", "list_snapshots", "rollback",
]);

test("all four prompts register and name only real tools", async () => {
  const server = fakeServer();
  registerPrompts(server, fakeBridge({ plans: [] }));
  assert.deepEqual([...server.prompts.keys()].sort(), [
    "analyze-plan",
    "compare-plans",
    "optimize-tax",
    "review-assumptions",
  ]);
  for (const [name, { handler }] of server.prompts) {
    const args = name === "compare-plans" ? { plan1: "A", plan2: "B" } : { planName: "A" };
    const { messages } = await handler(args);
    const text = messages.map((m) => m.content.text).join("\n");
    for (const [, tool] of text.matchAll(/projectionlab_([a-z_]+)/g)) {
      assert.ok(TOOL_SUFFIXES.has(tool), `${name} names unknown tool projectionlab_${tool}`);
    }
  }
});

test("prompt tool calls carry the plan name as valid JSON arguments", async () => {
  const server = fakeServer();
  registerPrompts(server, fakeBridge({ plans: [] }));
  const planName = 'My "Early" Plan';
  for (const name of ["optimize-tax", "review-assumptions"]) {
    const { messages } = await server.prompts.get(name).handler({ planName });
    const text = messages[0].content.text;
    const calls = [...text.matchAll(/projectionlab_get_plan_section (\{.*\})/g)];
    assert.ok(calls.length >= 4, name);
    for (const [, json] of calls) {
      const args = JSON.parse(json);
      assert.equal(args.planIdentifier, planName);
      assert.equal(typeof args.section, "string");
    }
  }
});
