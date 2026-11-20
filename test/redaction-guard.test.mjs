// A payload that still carries the [REDACTED] sentinel under a secret-named
// key came from a redacted read and is refused before anything reaches the
// executor, in dry runs as well as confirmed writes.

import assert from "node:assert/strict";
import test from "node:test";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asV5Export } from "./helpers/v5-envelope.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-redaction-guard-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);
const { SnapshotManager } = await import("../dist/snapshot.js");
const { findRedactedSecretPaths } = await import("../dist/redact.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function samplePlans() {
  return [
    {
      id: "p1",
      name: "Retire at 55",
      income: { events: [{ id: "i1", name: "Salary" }] },
    },
  ];
}

function fakeBridge(initial) {
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: [],
    async apiContract() { return 2; },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      return asV5Export(structuredClone(state));
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.plans = structuredClone(plans);
    },
    async restoreCurrentFinances(currentFinances) {
      bridge.writes.push("currentFinances");
      state.currentFinances = structuredClone(currentFinances);
    },
    async restoreSettings(settings) {
      bridge.writes.push("settings");
      state.settings = structuredClone(settings);
    },
  };
  return bridge;
}

function registered(bridge) {
  const server = fakeServer();
  const snapshots = new SnapshotManager();
  registerUpdatePlanSectionTool(server, bridge, snapshots);
  registerRestoreTools(server, bridge, snapshots);
  return server;
}

const sectionWithSentinel = () => ({
  events: [{ name: "Salary", details: { apiKey: "[REDACTED]" } }],
});

test("findRedactedSecretPaths names dot paths under secret-named keys", () => {
  assert.deepEqual(
    findRedactedSecretPaths({
      events: [{ name: "x", auth: { apiKey: "[REDACTED]" }, token: "[REDACTED]" }],
    }),
    ["events.0.auth.apiKey", "events.0.token"],
  );
  // The sentinel under an ordinary key is just text, and a real value under
  // a secret name is fine.
  assert.deepEqual(findRedactedSecretPaths({ name: "[REDACTED]", apiKey: "k" }), []);
  assert.deepEqual(findRedactedSecretPaths(undefined), []);
});

for (const confirm of [false, true]) {
  test(`update_plan_section refuses a sentinel payload in ${confirm ? "confirm" : "dry-run"} mode`, async () => {
    const bridge = fakeBridge({ plans: samplePlans() });
    const server = registered(bridge);
    const result = await server.tools
      .get("projectionlab_update_plan_section")
      .handler({
        planIdentifier: "Retire at 55",
        section: "income",
        sectionData: sectionWithSentinel(),
        confirm,
      });
    assert.equal(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.error, "INVALID_INPUT");
    assert.match(output.message, /events\.0\.details\.apiKey/);
    assert.match(output.suggestion, /projectionlab_update_plan_event/);
    assert.deepEqual(bridge.writes, []);
  });
}

test("update_plan_section accepts the same payload with a real value", async () => {
  const bridge = fakeBridge({ plans: samplePlans() });
  const server = registered(bridge);
  const sectionData = sectionWithSentinel();
  sectionData.events[0].details.apiKey = "sk-live-123";
  const result = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "income",
      sectionData,
      confirm: true,
    });
  assert.equal(result.isError, undefined);
  assert.deepEqual(bridge.writes, ["plans"]);
});

const restoreCases = [
  [
    "projectionlab_restore_current_finances",
    "currentFinances",
    { schema: 5, accounts: { a: { id: "a", kind: "account", credentials: { apiKey: "[REDACTED]" } } } },
  ],
  [
    "projectionlab_restore_plans",
    "plans",
    [{ id: "p1", name: "X", settings: { access_token: "[REDACTED]" } }],
  ],
  [
    "projectionlab_restore_settings",
    "settings",
    { plugin: { token: "[REDACTED]" } },
  ],
];

for (const [tool, field, payload] of restoreCases) {
  for (const confirm of [false, true]) {
    test(`${tool} refuses a sentinel payload in ${confirm ? "confirm" : "dry-run"} mode`, async () => {
      const bridge = fakeBridge({ plans: [], settings: {} });
      const server = registered(bridge);
      const result = await server.tools
        .get(tool)
        .handler({ [field]: structuredClone(payload), confirm });
      assert.equal(result.isError, true);
      const output = JSON.parse(result.content[0].text);
      assert.equal(output.error, "INVALID_INPUT");
      assert.match(output.message, new RegExp(field === "plans" ? "0\\.settings\\.access_token" : "\\[REDACTED\\]|apiKey|password|token"));
      assert.match(output.message, new RegExp(field));
      assert.deepEqual(bridge.writes, []);
    });
  }

  test(`${tool} accepts the payload once the real value is supplied`, async () => {
    const bridge = fakeBridge({ plans: [], settings: {} });
    const server = registered(bridge);
    const real = structuredClone(payload);
    const secretPaths = findRedactedSecretPaths(real);
    assert.equal(secretPaths.length, 1);
    const parts = secretPaths[0].split(".");
    let node = real;
    for (const part of parts.slice(0, -1)) node = node[part];
    node[parts.at(-1)] = "real-value";
    const result = await server.tools
      .get(tool)
      .handler({ [field]: real, confirm: true });
    assert.equal(result.isError, undefined);
    assert.equal(bridge.writes.length, 1);
  });
}

// The path tools take whole-object values, which can carry a secret-named
// key a read returned as [REDACTED].

const { registerUpdatePlanEventTool } = await import(
  "../dist/tools/updatePlanEvent.js"
);
const { registerUpdatePlanSettingsTool } = await import(
  "../dist/tools/updatePlanSettings.js"
);
const { registerUpdateAccountTool } = await import(
  "../dist/tools/updateAccount.js"
);

function pathToolState() {
  return {
    plans: [
      {
        id: "p1",
        name: "Retire at 55",
        variables: { inflation: 3, link: { label: "x", token: "stored-token" } },
        income: {
          events: [
            { id: "i1", name: "Salary", details: { note: "a", apiKey: "stored-key" } },
          ],
        },
      },
    ],
    currentFinances: {
      schema: 5,
      accounts: {
        a1: { id: "a1", name: "Brokerage", kind: "account", credentials: { label: "x", password: "stored-pass" } },
      },
    },
  };
}

function pathToolsRegistered(bridge) {
  const server = fakeServer();
  const snapshots = new SnapshotManager();
  registerUpdatePlanEventTool(server, bridge, snapshots);
  registerUpdatePlanSettingsTool(server, bridge, snapshots);
  registerUpdateAccountTool(server, bridge, snapshots);
  return server;
}

const event = { planIdentifier: "Retire at 55", section: "income", eventIdentifier: "Salary" };
const settings = { planIdentifier: "Retire at 55", section: "variables" };
const pathToolCases = [
  ["projectionlab_update_plan_event", "pathChanges", event, { details: { note: "b", apiKey: "[REDACTED]" } }, "details.apiKey"],
  ["projectionlab_update_plan_event", "patch", event, { details: { note: "b", apiKey: "[REDACTED]" } }, "details.apiKey"],
  ["projectionlab_update_plan_settings", "changes", settings, { link: { label: "y", token: "[REDACTED]" } }, "link.token"],
  ["projectionlab_update_account", "pathChanges", { accountId: "a1" }, { credentials: { label: "y", password: "[REDACTED]" } }, "credentials.password"],
  ["projectionlab_update_account", "data", { accountId: "a1" }, { credentials: { label: "y", password: "[REDACTED]" } }, "credentials.password"],
];

for (const [tool, input, target, payload, secretPath] of pathToolCases) {
  for (const confirm of [false, true]) {
    test(`${tool} refuses a sentinel inside a whole-object ${input} value in ${confirm ? "confirm" : "dry-run"} mode`, async () => {
      const initial = pathToolState();
      const bridge = fakeBridge(initial);
      const server = pathToolsRegistered(bridge);
      const result = await server.tools
        .get(tool)
        .handler({ ...target, [input]: structuredClone(payload), force: false, confirm });
      assert.equal(result.isError, true);
      const output = JSON.parse(result.content[0].text);
      assert.equal(output.error, "INVALID_INPUT");
      assert.match(output.message, new RegExp(`^${input} contains redacted secret values at: ${secretPath.replace(".", "\\.")}$`));
      assert.deepEqual(bridge.writes, []);
      assert.deepEqual(bridge.state, initial);
    });
  }

  test(`${tool} previews the same ${input} value once the real secret is supplied`, async () => {
    const bridge = fakeBridge(pathToolState());
    const server = pathToolsRegistered(bridge);
    const real = structuredClone(payload);
    const [container, key] = secretPath.split(".");
    real[container][key] = "real-value";
    const result = await server.tools
      .get(tool)
      .handler({ ...target, [input]: real, force: false, confirm: false });
    assert.equal(result.isError, undefined, result.content[0].text);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.dryRun, true);
    assert.deepEqual(Object.keys(output.changes), [container]);
  });
}
