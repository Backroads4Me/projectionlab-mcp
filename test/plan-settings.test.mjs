import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-settings-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const {
  applyPlanSettingChanges,
  listPlanSettings,
  planSettingChangesApplied,
} = await import("../dist/planSettings.js");
const { registerGetPlanSettingsTool } = await import(
  "../dist/tools/getPlanSettings.js"
);
const { registerUpdatePlanSettingsTool } = await import(
  "../dist/tools/updatePlanSettings.js"
);
const { config } = await import("../dist/config.js");

test("settings inventory flattens nested objects and preserves arrays", () => {
  const settings = listPlanSettings({
    inflation: 0.03,
    estate: { enabled: true, strategy: { mode: "fixed" } },
    drawdownOrder: ["taxable", "ira"],
  });

  assert.deepEqual(settings, [
    {
      path: "drawdownOrder",
      type: "array",
      value: ["taxable", "ira"],
    },
    { path: "estate.enabled", type: "boolean", value: true },
    { path: "estate.strategy.mode", type: "string", value: "fixed" },
    { path: "inflation", type: "number", value: 0.03 },
  ]);
});

test("variables inventory exposes advanced-rate control points without losing the atomic schedule", () => {
  const schedule = [
    { year: 2026, rate: 0.05 },
    { year: 2035, rate: 0.04 },
  ];
  const settings = listPlanSettings(
    {
      investmentReturnCustom: schedule,
      drawdownOrder: ["taxable", "ira"],
    },
    "variables",
  );

  assert.deepEqual(settings, [
    {
      path: "drawdownOrder",
      type: "array",
      value: ["taxable", "ira"],
    },
    {
      path: "investmentReturnCustom",
      type: "array",
      value: schedule,
    },
    {
      path: "investmentReturnCustom.0.rate",
      type: "number",
      value: 0.05,
    },
    {
      path: "investmentReturnCustom.0.year",
      type: "number",
      value: 2026,
    },
    {
      path: "investmentReturnCustom.1.rate",
      type: "number",
      value: 0.04,
    },
    {
      path: "investmentReturnCustom.1.year",
      type: "number",
      value: 2035,
    },
  ]);
});

test("settings inventory redacts secret-named fields and blocks their mutation", () => {
  const settings = listPlanSettings({
    integration: { authToken: "sensitive" },
  });
  assert.deepEqual(settings, [
    {
      path: "integration.authToken",
      type: "string",
      value: "[REDACTED]",
      redacted: true,
    },
  ]);
  assert.throws(
    () =>
      applyPlanSettingChanges(
        { integration: { authToken: "sensitive" } },
        { "integration.authToken": "replacement" },
      ),
    /Invalid plan setting path/,
  );
});

test("path patches are immutable and preserve sibling settings", () => {
  const original = {
    inflation: 0.03,
    estate: { enabled: false, beneficiary: "family" },
  };
  const result = applyPlanSettingChanges(original, {
    inflation: 0.025,
    "estate.enabled": true,
  });

  assert.deepEqual(result.updated, {
    inflation: 0.025,
    estate: { enabled: true, beneficiary: "family" },
  });
  assert.deepEqual(original, {
    inflation: 0.03,
    estate: { enabled: false, beneficiary: "family" },
  });
  assert.deepEqual(result.changes, {
    inflation: { before: 0.03, after: 0.025 },
    "estate.enabled": { before: false, after: true },
  });
  assert.equal(
    planSettingChangesApplied(result.updated, result.changes),
    true,
  );
});

test("path patches update one array control point and preserve schedule siblings", () => {
  const original = {
    investmentReturnCustom: [
      { year: 2026, rate: 0.05 },
      { year: 2035, rate: 0.04 },
    ],
  };
  const result = applyPlanSettingChanges(original, {
    "investmentReturnCustom.1.rate": 0.045,
  });

  assert.deepEqual(result.updated, {
    investmentReturnCustom: [
      { year: 2026, rate: 0.05 },
      { year: 2035, rate: 0.045 },
    ],
  });
  assert.deepEqual(original.investmentReturnCustom[1], {
    year: 2035,
    rate: 0.04,
  });
  assert.equal(
    planSettingChangesApplied(result.updated, result.changes),
    true,
  );
});

test("path patches reject unknown, unsafe, empty, and type-changing input", () => {
  assert.throws(
    () => applyPlanSettingChanges({ inflation: 0.03 }, { inflaton: 0.04 }),
    /Unknown plan setting path/,
  );
  assert.throws(
    () =>
      applyPlanSettingChanges(
        { estate: { enabled: true } },
        { "__proto__.enabled": false },
      ),
    /Invalid plan setting path/,
  );
  assert.throws(
    () => applyPlanSettingChanges({ inflation: 0.03 }, {}),
    /At least one/,
  );
  assert.throws(
    () => applyPlanSettingChanges({ inflation: 0.03 }, { inflation: "3%" }),
    /expects number/,
  );
  assert.throws(
    () =>
      applyPlanSettingChanges(
        { estate: { enabled: true } },
        { estate: { enabled: false }, "estate.enabled": false },
      ),
    /Overlapping plan setting paths/,
  );
});

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
}

function resultJson(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("get settings tool returns supported sections as addressable values", async () => {
  const server = fakeServer();
  const bridge = {
    async exportData() {
      return {
        plans: [
          {
            id: "plan-codex",
            name: "codex",
            variables: { inflation: 0.03 },
            montecarlo: { iterations: 1000 },
            withdrawalStrategy: { enabled: true },
          },
        ],
      };
    },
  };
  registerGetPlanSettingsTool(server, bridge);

  const result = await server.handlers.get("projectionlab_get_plan_settings")({
    planIdentifier: "codex",
    section: "variables",
  });
  const output = resultJson(result);
  assert.equal(output.planName, "codex");
  assert.equal(output.sections[0].section, "variables");
  assert.deepEqual(output.sections[0].settings, [
    { path: "inflation", type: "number", value: 0.03 },
  ]);
});

test("update settings tool dry-runs, snapshots before mutation, and verifies", async () => {
  const server = fakeServer();
  let state = {
    plans: [
      {
        id: "plan-codex",
        name: "codex",
        variables: {
          inflation: 0.03,
          estate: { enabled: false, beneficiary: "family" },
        },
      },
    ],
  };
  const actions = [];
  const bridge = {
    async exportData() {
      return state;
    },
    async restorePlans(plans) {
      actions.push("restore");
      state = { plans };
    },
  };
  const snapshots = {
    async create(operation, sections, data) {
      actions.push("snapshot");
      assert.equal(operation, "updatePlanSettings");
      assert.deepEqual(sections, ["plans"]);
      assert.equal(data.plans[0].variables.inflation, 0.03);
    },
  };
  registerUpdatePlanSettingsTool(server, bridge, snapshots);
  const handler = server.handlers.get("projectionlab_update_plan_settings");

  const dryRun = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "variables",
      changes: { inflation: 0.025, "estate.enabled": true },
      confirm: false,
    }),
  );
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(actions, []);
  assert.equal(state.plans[0].variables.inflation, 0.03);

  const executed = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "variables",
      changes: { inflation: 0.025, "estate.enabled": true },
      confirm: true,
    }),
  );
  assert.deepEqual(actions, ["snapshot", "restore"]);
  assert.equal(executed.verified, true);
  assert.deepEqual(state.plans[0].variables, {
    inflation: 0.025,
    estate: { enabled: true, beneficiary: "family" },
  });

  actions.length = 0;
  const noOp = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "variables",
      changes: { inflation: 0.025 },
      confirm: true,
    }),
  );
  assert.equal(noOp.verified, true);
  assert.deepEqual(actions, []);
});

test("update settings tool respects PL_READ_ONLY before reading or writing", async () => {
  const server = fakeServer();
  let bridgeCalled = false;
  const bridge = {
    async exportData() {
      bridgeCalled = true;
      throw new Error("must not read");
    },
    async restorePlans() {
      bridgeCalled = true;
      throw new Error("must not restore");
    },
  };
  let snapshotCalled = false;
  const snapshots = {
    async create() {
      snapshotCalled = true;
    },
  };
  registerUpdatePlanSettingsTool(server, bridge, snapshots);

  config.readOnly = true;
  try {
    const result = await server.handlers.get(
      "projectionlab_update_plan_settings",
    )({
      planIdentifier: "codex",
      section: "variables",
      changes: { inflation: 0.025 },
      confirm: true,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "READ_ONLY_MODE");
    assert.equal(bridgeCalled, false);
    assert.equal(snapshotCalled, false);
  } finally {
    config.readOnly = false;
  }
});
