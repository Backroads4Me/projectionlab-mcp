// update_plan_section and clone_plan handlers, the four resources, and the
// four prompts, against an in-memory bridge that re-stamps saved plans the
// way ProjectionLab does.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
const { registerConnectionTool } = await import("../dist/tools/connection.js");
const { registerPlanDataResource } = await import("../dist/resources/planData.js");
const { registerSummaryResource } = await import("../dist/resources/summary.js");
const { registerGuideResource } = await import("../dist/resources/guide.js");
const { registerKnowledgeResource } = await import("../dist/resources/knowledge.js");
const { registerPrompts } = await import("../dist/prompts/index.js");
const { updateCheck } = await import("../dist/updateCheck.js");
const { VERSION } = await import("../dist/version.js");
const { z } = await import("zod");

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

function setup(register, initial = { today: {}, plans: samplePlans() }) {
  const bridge = fakeBridge(initial);
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

test("update_plan_section previews redact secret-named fields and the API key", async () => {
  const plans = samplePlans();
  plans[0].income.events[0].auth_token = "old-secret";
  plans[0].income.events[0].note = "uses test-api-key";
  const { server } = setup(registerUpdatePlanSectionTool, { today: {}, plans });
  const out = parse(
    await server.tools.get("projectionlab_update_plan_section").handler(
      sectionArgs({
        confirm: false,
        sectionData: {
          events: [{ id: "i1", name: "Salary", amount: 100000, auth_token: "new-secret", note: "now test-api-key" }],
        },
      }),
    ),
  );
  const text = JSON.stringify(out);
  assert.equal(text.includes("old-secret"), false);
  assert.equal(text.includes("new-secret"), false);
  assert.equal(text.includes("test-api-key"), false);
  assert.deepEqual(out.diff.modified, [
    {
      name: "Salary",
      changes: { auth_token: "[REDACTED]", note: '"uses [REDACTED]" → "now [REDACTED]"' },
    },
  ]);
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
  assert.ok(
    list.some((s) => s.operation === "updatePlanSection" && s.id === out.snapshotId),
  );
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

test("check_connection reports whether writes are enabled", async () => {
  const server = fakeServer();
  const status = {
    browser: true,
    pageLoaded: true,
    apiAvailable: true,
    apiKeyValid: true,
    errors: [],
  };
  registerConnectionTool(server, { checkConnection: async () => ({ ...status }) });
  const { handler } = server.tools.get("projectionlab_check_connection");
  try {
    for (const readOnly of [true, false]) {
      config.readOnly = readOnly;
      const result = await handler({});
      assert.deepEqual(result.structuredContent, {
        ...status,
        writesEnabled: !readOnly,
        versions: { server: VERSION, executor: null, latest: updateCheck.latest() },
        notices: [],
      });
      assert.equal(JSON.parse(result.content[0].text).writesEnabled, !readOnly);
    }
  } finally {
    config.readOnly = false;
  }
});

test("check_connection carries versions and notices, and validates against its outputSchema", async () => {
  // One injected lookup primes the process-wide holder; no test hits the network.
  updateCheck.start(async () => ({
    ok: true,
    json: async () => ({ version: "99.0.0" }),
  }));
  await new Promise((r) => setTimeout(r, 0));

  const server = fakeServer();
  registerConnectionTool(server, {
    checkConnection: async () => ({
      browser: true,
      pageLoaded: true,
      apiAvailable: true,
      apiKeyValid: true,
      executor: "extension/0.0.1",
      errors: [],
    }),
  });
  const { definition, handler } = server.tools.get("projectionlab_check_connection");
  const result = await handler({});
  assert.deepEqual(result.structuredContent.versions, {
    server: VERSION,
    executor: "extension/0.0.1",
    latest: "99.0.0",
  });
  // Rule 1 (npm newer) and rule 2 (extension older than MIN_EXTENSION_VERSION) fire.
  assert.equal(result.structuredContent.notices.length, 2);
  assert.match(result.structuredContent.notices[0], /available on npm/);
  assert.match(result.structuredContent.notices[1], /older than the minimum required version/);
  z.object(definition.outputSchema).parse(result.structuredContent);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
    "the JSON text mirrors structuredContent",
  );
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

const cloneArgs = { planIdentifier: "Retire", newName: "Retire at 57", confirm: true };

test("clone_plan verifies originals the app re-stamped and left otherwise intact", async () => {
  // The fake bridge re-stamps every plan on restore, as ProjectionLab may.
  const plans = samplePlans().map((p, i) => ({ ...p, simKey: i + 1 }));
  const { server } = setup(registerClonePlanTool, {
    today: { savingsAccounts: [{ id: "s1", name: "Emergency", balance: 25000 }] },
    plans,
  });
  const out = parse(
    await server.tools.get("projectionlab_clone_plan").handler(cloneArgs),
  );
  assert.equal(out.verified, true, JSON.stringify(out.verificationProblems));
});

test("clone_plan reports a Current Finances balance the write moved", async () => {
  const { bridge, server } = setup(registerClonePlanTool, {
    today: { savingsAccounts: [{ id: "s1", name: "Emergency", balance: 25000 }] },
    plans: samplePlans(),
  });
  const restorePlans = bridge.restorePlans;
  bridge.restorePlans = async (plans) => {
    await restorePlans(plans);
    bridge.state.today.savingsAccounts[0].balance = 1;
  };
  const out = parse(
    await server.tools.get("projectionlab_clone_plan").handler(cloneArgs),
  );
  assert.equal(out.success, true);
  assert.equal(out.verified, false);
  assert.ok(
    out.verificationProblems.some((p) =>
      p.includes(
        "Current Finances savingsAccounts s1 balance changed from 25000 to 1",
      ),
    ),
    JSON.stringify(out.verificationProblems),
  );
  // The snapshot holds plans only, so a Current Finances problem must not
  // point the agent at a rollback that restores nothing.
  assert.match(out.message, /may be an edit made in ProjectionLab/);
  assert.doesNotMatch(out.message, /projectionlab_rollback/);
});

test("clone_plan reports a pre-existing plan that lost its simKey", async () => {
  const plans = samplePlans().map((p, i) => ({ ...p, simKey: i + 1 }));
  const { bridge, server } = setup(registerClonePlanTool, {
    today: {},
    plans,
  });
  const restorePlans = bridge.restorePlans;
  bridge.restorePlans = async (incoming) => {
    await restorePlans(incoming);
    delete bridge.state.plans[0].simKey;
  };
  const out = parse(
    await server.tools.get("projectionlab_clone_plan").handler(cloneArgs),
  );
  assert.equal(out.verified, false);
  assert.ok(
    out.verificationProblems.some((p) =>
      p.includes("original plan p1 lost its simKey"),
    ),
    JSON.stringify(out.verificationProblems),
  );
  assert.match(out.message, /projectionlab_rollback/);
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

test("resource error details never leak the API key", async () => {
  const leaking = {
    async exportData() {
      throw new Error(`executor failed for key ${config.apiKey}`);
    },
  };
  const server = fakeServer();
  registerPlanDataResource(server, leaking);
  registerSummaryResource(server, leaking);

  // The failure is also logged; capture stderr lines to check them too.
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let planData;
  let summary;
  try {
    planData = JSON.parse(await readResource(server, "projectionlab://plan-data"));
    summary = JSON.parse(await readResource(server, "projectionlab://summary"));
  } finally {
    console.error = realError;
  }

  assert.equal(planData.error, "Failed to export data");
  assert.equal(planData.details.includes("test-api-key"), false);
  assert.match(planData.details, /\[REDACTED\]/);

  assert.equal(summary.error, "Failed to build summary");
  assert.equal(summary.details.includes("test-api-key"), false);
  assert.match(summary.details, /\[REDACTED\]/);

  assert.equal(logged.length, 2);
  for (const line of logged) {
    assert.equal(line.includes("test-api-key"), false, line);
    assert.match(line, /executor failed for key \[REDACTED\]/);
  }
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

// Every tool name registered in src/tools, so a prompt can name any real tool
// and no other.
const TOOL_SUFFIXES = new Set(
  readdirSync(new URL("../src/tools/", import.meta.url))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [
      ...readFileSync(new URL(`../src/tools/${file}`, import.meta.url), "utf8")
        .matchAll(/registerTool\(\s*"projectionlab_([a-z_]+)"/g),
    ])
    .map(([, suffix]) => suffix),
);

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
