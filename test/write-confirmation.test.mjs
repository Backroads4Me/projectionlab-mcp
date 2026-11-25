// Write confirmation through MCP form elicitation: the gate on its own, then
// write tools behind a real MCP client and server, so the SDK's own
// capability checks decide whether the prompt is sent.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-write-confirm-")), "snapshots");
process.env.LOG_LEVEL = "error";
process.env.TZ = "UTC";

const {
  CANCEL_RECORD_TTL_MS,
  PROMPT_TIMEOUT_MS,
  changeKey,
  clearCancelRecords,
  confirmWrite,
  formElicitationDeclared,
  setConfirmationClock,
} = await import("../dist/writeConfirmation.js");
const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");
const { registerUpdatePlanSettingsTool } = await import("../dist/tools/updatePlanSettings.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

// --- The gate on its own ---

/** A server whose client declares `caps` and answers prompts with `answer`. */
function fakeServer(caps, answer) {
  const prompts = [];
  return {
    prompts,
    server: {
      getClientCapabilities: () => caps,
      async elicitInput(params, options) {
        prompts.push({ params, options });
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(params) : answer;
      },
    },
  };
}

const ACCEPT = { action: "accept", content: { approve: true } };
const CANCEL = { action: "cancel" };
const request = (overrides = {}) => ({
  tool: "projectionlab_update_account",
  args: { accountId: "acct_brokerage", pathChanges: { balance: 55000 } },
  summary: "Current Finances account \"Brokerage\":\n- Balance: $50,000 → $55,000",
  mode: "auto",
  ...overrides,
});

function parse(outcome) {
  assert.equal(outcome.proceed, false);
  return JSON.parse(outcome.result.content[0].text);
}

test.beforeEach(() => {
  clearCancelRecords();
  setConfirmationClock(() => Date.now());
});

test("form elicitation is declared by a form key or a bare object, not by url alone", () => {
  assert.equal(formElicitationDeclared(fakeServer(undefined)), false);
  assert.equal(formElicitationDeclared(fakeServer({})), false);
  assert.equal(formElicitationDeclared(fakeServer({ elicitation: {} })), true);
  assert.equal(formElicitationDeclared(fakeServer({ elicitation: { form: {} } })), true);
  assert.equal(formElicitationDeclared(fakeServer({ elicitation: { form: {}, url: {} } })), true);
  assert.equal(formElicitationDeclared(fakeServer({ elicitation: { url: {} } })), false);
  // The tool tests' fake servers have no protocol connection.
  assert.equal(formElicitationDeclared({ registerTool() {} }), false);
});

test("a host without elicitation, or mode off, proceeds without a prompt", async () => {
  for (const [server, mode] of [
    [fakeServer({}), "auto"],
    [fakeServer({}), "required"],
    [fakeServer({ elicitation: {} }, ACCEPT), "off"],
    [{ registerTool() {} }, "auto"],
  ]) {
    assert.deepEqual(await confirmWrite(server, request({ mode })), { proceed: true, prompted: false });
    assert.equal(server.prompts?.length ?? 0, 0);
  }
});

test("an accepted prompt with approve on proceeds; the prompt carries the summary", async () => {
  const controller = new AbortController();
  const server = fakeServer({ elicitation: {} }, ACCEPT);
  const outcome = await confirmWrite(server, request({ signal: controller.signal }));
  assert.deepEqual(outcome, { proceed: true, prompted: true });
  assert.equal(server.prompts.length, 1);
  const { params, options } = server.prompts[0];
  assert.equal(params.mode, "form");
  assert.equal(params.message, request().summary);
  assert.deepEqual(params.requestedSchema.required, ["approve"]);
  assert.equal(params.requestedSchema.properties.approve.type, "boolean");
  assert.equal(params.requestedSchema.properties.approve.default, false);
  assert.equal(options.timeout, PROMPT_TIMEOUT_MS);
  assert.equal(options.signal, controller.signal);
});

test("a decline, or an accept with approve off, is declined and records nothing", async () => {
  for (const answer of [{ action: "decline" }, { action: "accept", content: { approve: false } }, { action: "accept", content: {} }]) {
    clearCancelRecords();
    const body = parse(await confirmWrite(fakeServer({ elicitation: {} }, answer), request()));
    assert.equal(body.success, false);
    assert.equal(body.outcome, "declined");
    assert.equal(body.summary, request().summary);
    assert.match(body.message, /declined/);
    assert.match(body.message, /Do not retry/);
    assert.doesNotMatch(body.message, /elicitationFallback/);

    // No record: the fallback still prompts.
    const server = fakeServer({ elicitation: {} }, ACCEPT);
    await confirmWrite(server, request({ fallback: "chat" }));
    assert.equal(server.prompts.length, 1);
  }
});

test("a dismissed or failed prompt is not confirmed and opens the chat fallback once", async () => {
  for (const answer of [CANCEL, new Error("Request timed out"), { action: "something-else" }]) {
    clearCancelRecords();
    const body = parse(await confirmWrite(fakeServer({ elicitation: {} }, answer), request()));
    assert.equal(body.success, false);
    assert.equal(body.outcome, "not_confirmed");
    assert.match(body.message, /elicitationFallback: "chat"/);

    const later = fakeServer({ elicitation: {} }, CANCEL);
    assert.deepEqual(await confirmWrite(later, request({ fallback: "chat" })), { proceed: true, prompted: false });
    assert.equal(later.prompts.length, 0);

    // The record is used up: the next fallback call prompts again.
    const again = fakeServer({ elicitation: {} }, ACCEPT);
    assert.deepEqual(await confirmWrite(again, request({ fallback: "chat" })), { proceed: true, prompted: true });
    assert.equal(again.prompts.length, 1);
  }
});

test("the fallback is tied to the same tool and arguments", async () => {
  await confirmWrite(fakeServer({ elicitation: {} }, CANCEL), request());

  const otherArgs = fakeServer({ elicitation: {} }, ACCEPT);
  await confirmWrite(
    otherArgs,
    request({ fallback: "chat", args: { accountId: "acct_brokerage", pathChanges: { balance: 99999 } } }),
  );
  assert.equal(otherArgs.prompts.length, 1);

  const otherTool = fakeServer({ elicitation: {} }, ACCEPT);
  await confirmWrite(otherTool, request({ fallback: "chat", tool: "projectionlab_restore_settings" }));
  assert.equal(otherTool.prompts.length, 1);

  const same = fakeServer({ elicitation: {} }, ACCEPT);
  await confirmWrite(same, request({ fallback: "chat" }));
  assert.equal(same.prompts.length, 0);
});

test("the change key ignores key order and the confirmation arguments", () => {
  const key = changeKey("t", { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } });
  assert.equal(key, changeKey("t", { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1, confirm: true }));
  assert.equal(key, changeKey("t", { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] }, elicitationFallback: "chat", force: undefined }));
  assert.notEqual(key, changeKey("t", { a: 1, b: { c: 2, d: [{ e: 3, f: 4 }, 1] } }));
  assert.notEqual(key, changeKey("u", { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }));
});

test("a cancel record expires after its time to live", async () => {
  let time = 1_000_000;
  setConfirmationClock(() => time);
  await confirmWrite(fakeServer({ elicitation: {} }, CANCEL), request());
  time += CANCEL_RECORD_TTL_MS;
  const server = fakeServer({ elicitation: {} }, ACCEPT);
  assert.deepEqual(await confirmWrite(server, request({ fallback: "chat" })), { proceed: true, prompted: true });
  assert.equal(server.prompts.length, 1);

  await confirmWrite(fakeServer({ elicitation: {} }, CANCEL), request());
  time += CANCEL_RECORD_TTL_MS - 1;
  const live = fakeServer({ elicitation: {} }, ACCEPT);
  assert.deepEqual(await confirmWrite(live, request({ fallback: "chat" })), { proceed: true, prompted: false });
});

test("required mode offers no fallback and ignores one", async () => {
  const body = parse(await confirmWrite(fakeServer({ elicitation: {} }, CANCEL), request({ mode: "required" })));
  assert.equal(body.outcome, "not_confirmed");
  assert.doesNotMatch(body.message, /elicitationFallback/);
  assert.match(body.message, /PL_ELICITATION=required/);

  // A record made in auto mode does not open the fallback in required mode.
  await confirmWrite(fakeServer({ elicitation: {} }, CANCEL), request());
  const server = fakeServer({ elicitation: {} }, CANCEL);
  const again = parse(await confirmWrite(server, request({ mode: "required", fallback: "chat" })));
  assert.equal(server.prompts.length, 1);
  assert.equal(again.outcome, "not_confirmed");
});

// --- Write tools behind a real MCP client and server ---

/** A ProjectionLab 5 bridge that applies each write to its export. */
function v5Bridge(state = v5Export()) {
  const writes = [];
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
    async restorePlansIfUnchanged(_expected, plans) {
      writes.push("restorePlansIfUnchanged");
      state.documents.plans = structuredClone(plans);
    },
    async updateAccount(accountId, data) {
      writes.push("updateAccount");
      Object.assign(state.documents.currentFinances.accounts[accountId], data);
    },
    async restoreCurrentFinances(currentFinances) {
      writes.push("restoreCurrentFinances");
      Object.assign(state.documents.currentFinances, structuredClone(currentFinances));
    },
    async restoreSettings(settings) {
      writes.push("restoreSettings");
      state.documents.settings = structuredClone(settings);
    },
  };
}

function snapshotStore(held) {
  const created = [];
  return {
    created,
    async create(operation) {
      created.push(operation);
      return { id: `snap-${created.length}` };
    },
    async get() {
      return structuredClone(held);
    },
    async list() {
      return held ? [structuredClone(held)] : [];
    },
  };
}

/**
 * Connects a real client to a server carrying the write tools. With
 * `onPrompt`, the client declares bare `elicitation: {}` and answers each
 * prompt with it; without, the client declares no elicitation.
 */
async function connect(bridge, { onPrompt, snapshots = snapshotStore() } = {}) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  for (const register of [
    registerUpdateAccountTool,
    registerUpdatePlanSettingsTool,
    registerRestoreTools,
    registerSnapshotTools,
  ]) {
    register(server, bridge, snapshots);
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const prompts = [];
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    onPrompt ? { capabilities: { elicitation: {} } } : {},
  );
  if (onPrompt) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params);
      return onPrompt(req.params);
    });
  }
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  };
  return { call, prompts, snapshots };
}

const ACCOUNT_CHANGE = { accountId: "acct_brokerage", pathChanges: { balance: 55000 } };

test("a bare elicitation capability reaches the prompt, and an accepted prompt writes", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const { call, prompts, snapshots } = await connect(bridge, { onPrompt: () => ACCEPT });

  const dry = await call("projectionlab_update_account", ACCOUNT_CHANGE);
  assert.equal(dry.dryRun, true);
  assert.match(dry.confirmation, /confirmation prompt/);
  assert.equal(prompts.length, 0, "a dry run never prompts");

  const done = await call("projectionlab_update_account", { ...ACCOUNT_CHANGE, confirm: true });
  assert.equal(done.success, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message, dry.summary);
  assert.deepEqual(bridge.writes, ["updateAccount"]);
  assert.deepEqual(snapshots.created, ["updateAccount"]);
  assert.equal(bridge.state.documents.currentFinances.accounts.acct_brokerage.balance, 55000);
});

test("a host without elicitation writes on confirm: true alone, with no confirmation field", async () => {
  const bridge = v5Bridge();
  const { call } = await connect(bridge);
  const dry = await call("projectionlab_update_account", ACCOUNT_CHANGE);
  assert.equal(dry.confirmation, undefined);
  const done = await call("projectionlab_update_account", { ...ACCOUNT_CHANGE, confirm: true });
  assert.equal(done.success, true);
  assert.deepEqual(bridge.writes, ["updateAccount"]);
});

test("a declined prompt writes nothing and takes no snapshot", async () => {
  clearCancelRecords();
  const state = v5Export();
  state.documents.plans[0].variables = { inflation: 3 };
  const bridge = v5Bridge(state);
  const { call, snapshots } = await connect(bridge, { onPrompt: () => ({ action: "decline" }) });
  const result = await call("projectionlab_update_plan_settings", {
    planIdentifier: bridge.state.documents.plans[0].name,
    section: "variables",
    changes: { inflation: 4 },
    confirm: true,
  });
  assert.equal(result.success, false);
  assert.equal(result.outcome, "declined");
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("a dismissed prompt writes nothing; the chat fallback then writes without a second prompt", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const { call, prompts } = await connect(bridge, { onPrompt: () => CANCEL });
  const first = await call("projectionlab_update_account", { ...ACCOUNT_CHANGE, confirm: true });
  assert.equal(first.outcome, "not_confirmed");
  assert.deepEqual(bridge.writes, []);

  const second = await call("projectionlab_update_account", {
    ...ACCOUNT_CHANGE,
    confirm: true,
    elicitationFallback: "chat",
  });
  assert.equal(second.success, true);
  assert.equal(prompts.length, 1);
  assert.deepEqual(bridge.writes, ["updateAccount"]);
});

test("Current Finances changed while the prompt was open refuses with DATA_CONFLICT", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const { call, snapshots } = await connect(bridge, {
    onPrompt: () => {
      bridge.state.documents.currentFinances.accounts.acct_brokerage.name = "Renamed in the app";
      return ACCEPT;
    },
  });
  const result = await call("projectionlab_update_account", { ...ACCOUNT_CHANGE, confirm: true });
  assert.equal(result.error, "DATA_CONFLICT");
  assert.match(result.message, /currentFinances changed/);
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("Settings changed while the prompt was open refuses restore_settings with DATA_CONFLICT", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const settings = structuredClone(bridge.state.documents.settings);
  const { call } = await connect(bridge, {
    onPrompt: () => {
      bridge.state.documents.settings.changedInTheApp = true;
      return ACCEPT;
    },
  });
  const result = await call("projectionlab_restore_settings", { settings, confirm: true });
  assert.equal(result.error, "DATA_CONFLICT");
  assert.deepEqual(bridge.writes, []);
});

test("rollback refuses with DATA_CONFLICT when a restored non-plan section changed during the prompt", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const held = {
    id: "snap-held",
    timestamp: "2026-11-25T10:00:00.000Z",
    operation: "updateAccount",
    sections: ["currentFinances"],
    layout: "v5",
    data: { currentFinances: structuredClone(bridge.state.documents.currentFinances) },
  };
  const { call, snapshots } = await connect(bridge, {
    snapshots: snapshotStore(held),
    onPrompt: () => {
      bridge.state.documents.currentFinances.accounts.acct_brokerage.balance = 1;
      return ACCEPT;
    },
  });
  const result = await call("projectionlab_rollback", { snapshotId: "snap-held", confirm: true });
  assert.equal(result.error, "DATA_CONFLICT");
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("every write tool takes an optional elicitationFallback and no new required argument", async () => {
  const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
  const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
  const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
  const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
  const server = new McpServer({ name: "test", version: "0.0.0" });
  for (const register of [
    registerUpdateAccountTool,
    registerUpdatePlanSettingsTool,
    registerUpdatePlanEventTool,
    registerUpdatePlanSectionTool,
    registerClonePlanTool,
    registerDeletePlanTool,
    registerRestoreTools,
    registerSnapshotTools,
  ]) {
    register(server, v5Bridge(), snapshotStore());
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const writeTools = (await client.listTools()).tools.filter((tool) => tool.annotations?.readOnlyHint === false);
  assert.deepEqual(writeTools.map((tool) => tool.name).sort(), [
    "projectionlab_clone_plan",
    "projectionlab_delete_plan",
    "projectionlab_restore_current_finances",
    "projectionlab_restore_plans",
    "projectionlab_restore_settings",
    "projectionlab_rollback",
    "projectionlab_update_account",
    "projectionlab_update_plan_event",
    "projectionlab_update_plan_section",
    "projectionlab_update_plan_settings",
  ]);
  for (const tool of writeTools) {
    assert.deepEqual(tool.inputSchema.properties.elicitationFallback?.enum, ["chat"], tool.name);
    assert.ok(!(tool.inputSchema.required ?? []).includes("elicitationFallback"), tool.name);
    assert.ok(!(tool.inputSchema.required ?? []).includes("confirm"), tool.name);
  }
});

test("a plan saved while the prompt was open refuses with PLAN_CONFLICT before the snapshot", async () => {
  clearCancelRecords();
  const state = v5Export();
  state.documents.plans[0].variables = { inflation: 3 };
  const bridge = v5Bridge(state);
  const { call, snapshots } = await connect(bridge, {
    onPrompt: () => {
      bridge.state.documents.plans[0].lastUpdated = 9_999_999_999_999;
      return ACCEPT;
    },
  });
  const result = await call("projectionlab_update_plan_settings", {
    planIdentifier: state.documents.plans[0].name,
    section: "variables",
    changes: { inflation: 4 },
    confirm: true,
  });
  assert.equal(result.error, "PLAN_CONFLICT");
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("rollback refuses with PLAN_CONFLICT before its pre-rollback snapshot when a plan was saved during the prompt", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  const held = {
    id: "snap-held",
    timestamp: "2026-11-25T10:00:00.000Z",
    operation: "updatePlanSettings",
    sections: ["plans"],
    layout: "v5",
    data: { plans: structuredClone(bridge.state.documents.plans) },
  };
  const { call, snapshots } = await connect(bridge, {
    snapshots: snapshotStore(held),
    onPrompt: () => {
      bridge.state.documents.plans[0].lastUpdated = 9_999_999_999_999;
      return ACCEPT;
    },
  });
  const result = await call("projectionlab_rollback", { snapshotId: "snap-held", confirm: true });
  assert.equal(result.error, "PLAN_CONFLICT");
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);
});

test("with the edits switch off, a confirmed write is refused before any prompt", async () => {
  clearCancelRecords();
  const bridge = v5Bridge();
  bridge.editAccess = async () => "disabled";
  const { call, prompts } = await connect(bridge, { onPrompt: () => ACCEPT });
  const result = await call("projectionlab_update_account", { ...ACCOUNT_CHANGE, confirm: true });
  assert.equal(result.error, "READ_ONLY_MODE");
  assert.equal(prompts.length, 0);
  assert.deepEqual(bridge.writes, []);
});
