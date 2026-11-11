import assert from "node:assert/strict";
import test from "node:test";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-event-paths-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerGetPlanSectionTool } = await import(
  "../dist/tools/getPlanSection.js"
);
const { registerUpdatePlanEventTool } = await import(
  "../dist/tools/updatePlanEvent.js"
);

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

function initialState() {
  return {
    plans: [
      {
        id: "plan-codex",
        name: "codex",
        income: {
          events: [
            {
              id: "income-1",
              name: "Salary",
              amount: 100000,
              taxHandling: {
                type: "wage",
                withholding: { mode: "fixed", rate: 0.1 },
              },
            },
          ],
        },
      },
    ],
  };
}

test("get plan section lists typed paths for one event", async () => {
  const server = fakeServer();
  const bridge = {
    async exportData() {
      return initialState();
    },
  };
  registerGetPlanSectionTool(server, bridge);

  const output = resultJson(
    await server.handlers.get("projectionlab_get_plan_section")({
      planIdentifier: "codex",
      section: "income",
      eventIdentifier: "Salary",
      listPaths: true,
    }),
  );
  assert.equal(output.planName, "codex");
  assert.equal(output.listPaths, true);
  assert.deepEqual(
    output.data.find((item) => item.path === "taxHandling.withholding.rate"),
    {
      path: "taxHandling.withholding.rate",
      type: "number",
      value: 0.1,
    },
  );
});

test("event path changes preserve nested siblings, snapshot, and verify", async () => {
  const server = fakeServer();
  let state = initialState();
  const actions = [];
  const bridge = {
    async exportData() {
      return state;
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      actions.push("restore");
      state = { plans };
    },
  };
  const snapshots = {
    async create(operation, sections, data) {
      actions.push("snapshot");
      assert.equal(operation, "updatePlanEvent");
      assert.deepEqual(sections, ["plans"]);
      assert.equal(
        data.plans[0].income.events[0].taxHandling.withholding.rate,
        0.1,
      );
      return { id: "snap-event" };
    },
  };
  registerUpdatePlanEventTool(server, bridge, snapshots);
  const handler = server.handlers.get("projectionlab_update_plan_event");

  const dryRun = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "income",
      eventIdentifier: "Salary",
      pathChanges: { "taxHandling.withholding.rate": 0.2 },
      confirm: false,
    }),
  );
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.changes, {
    "taxHandling.withholding.rate": { before: 0.1, after: 0.2 },
  });
  assert.deepEqual(actions, []);
  assert.equal(
    state.plans[0].income.events[0].taxHandling.withholding.rate,
    0.1,
  );

  const executed = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "income",
      eventIdentifier: "Salary",
      pathChanges: { "taxHandling.withholding.rate": 0.2 },
      confirm: true,
    }),
  );
  assert.deepEqual(actions, ["snapshot", "restore"]);
  assert.equal(executed.verified, true);
  assert.equal(executed.snapshotId, "snap-event");
  assert.deepEqual(
    state.plans[0].income.events[0].taxHandling,
    {
      type: "wage",
      withholding: { mode: "fixed", rate: 0.2 },
    },
  );

  actions.length = 0;
  const noOp = resultJson(
    await handler({
      planIdentifier: "codex",
      section: "income",
      eventIdentifier: "Salary",
      pathChanges: { "taxHandling.withholding.rate": 0.2 },
      confirm: true,
    }),
  );
  assert.equal(noOp.verified, true);
  assert.deepEqual(actions, []);
});

test("event update requires exactly one patch mode before reading", async () => {
  const server = fakeServer();
  let bridgeCalled = false;
  const bridge = {
    async exportData() {
      bridgeCalled = true;
      return initialState();
    },
  };
  registerUpdatePlanEventTool(server, bridge, { create: async () => {} });
  const handler = server.handlers.get("projectionlab_update_plan_event");

  for (const input of [
    {},
    { patch: { amount: 1 }, pathChanges: { amount: 1 } },
  ]) {
    const result = await handler({
      planIdentifier: "codex",
      section: "income",
      eventIdentifier: "Salary",
      confirm: false,
      ...input,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).message, /exactly one/);
  }
  assert.equal(bridgeCalled, false);
});
