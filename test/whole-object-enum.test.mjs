// A whole-object or whole-array write carries every value under it, so the
// observed enum of a nested path is enforced inside the container as well as
// when the caller addresses that leaf. Only a leaf the write changes is
// checked, so a value the plan already stores outside the list rides through a
// whole-object write instead of blocking every other field beside it.
// The enforced entries here are `assets.yearlyChange.type` and
// `variables.alignment.type`, both evidence "observed".
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { z } from "zod";
import { asV5Export } from "./helpers/v5-envelope.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-whole-object-enum-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerUpdatePlanEventTool } = await import(
  "../dist/tools/updatePlanEvent.js"
);
const { registerUpdatePlanSettingsTool } = await import(
  "../dist/tools/updatePlanSettings.js"
);
const { SnapshotManager } = await import("../dist/snapshot.js");

/** A ProjectionLab 5 plan holding each container whose nested enums are observed. */
function planState() {
  return {
    plans: [
      {
        id: "plan-1",
        name: "Retire",
        lastUpdated: 100,
        variables: {
          assumptionsMode: "fixed",
          inflation: 3,
          alignment: { type: "calendar", month: 1 },
        },
        assets: {
          events: [
            {
              id: "asset-1",
              kind: "real-asset",
              type: "house",
              name: "House",
              value: 400_000,
              yearlyChange: { type: "appreciate", amount: 0.02 },
            },
          ],
        },
        milestones: [],
      },
    ],
  };
}

function fakeBridge(state) {
  const bridge = {
    state,
    writes: [],
    async apiContract() {
      return 2;
    },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      return asV5Export(structuredClone(state));
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      bridge.writes.push(structuredClone(plans));
      state.plans = structuredClone(plans);
    },
  };
  return bridge;
}

/**
 * Registers one write tool on a throwaway server and returns a caller that
 * validates through its schema, as an MCP client's call does.
 */
function toolCaller(register, toolName, bridge) {
  const tools = new Map();
  register(
    {
      registerTool: (name, definition, handler) =>
        tools.set(name, { definition, handler }),
    },
    bridge,
    new SnapshotManager(),
  );
  const { definition, handler } = tools.get(toolName);
  const schema = z.object(definition.inputSchema).strict();
  return async (args) =>
    JSON.parse((await handler(schema.parse(args))).content[0].text);
}

const eventCaller = (bridge) =>
  toolCaller(
    registerUpdatePlanEventTool,
    "projectionlab_update_plan_event",
    bridge,
  );

test("a whole yearlyChange object on an asset is checked leaf by leaf", async () => {
  const state = planState();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);
  const write = (yearlyChange) =>
    call({
      planIdentifier: "Retire",
      section: "assets",
      eventIdentifier: "House",
      pathChanges: { yearlyChange },
      confirm: true,
    });

  const refused = await write({ type: "fixed-rate", amount: 0.02 });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);
  assert.match(
    refused.message,
    /Allowed values: none, appreciate, depreciate, custom, match-inflation, inflation\+, inflation-\./,
  );
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].assets.events[0].yearlyChange.type,
    "appreciate",
    "the asset keeps the value it had before the refused write",
  );

  const done = await write({ type: "depreciate", amount: 0.02 });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(
    bridge.writes[0][0].assets.events[0].yearlyChange.type,
    "depreciate",
  );
});

test("a whole alignment object is checked one nested object down", async () => {
  const state = planState();
  const bridge = fakeBridge(state);
  const call = toolCaller(
    registerUpdatePlanSettingsTool,
    "projectionlab_update_plan_settings",
    bridge,
  );
  const write = (alignment) =>
    call({
      planIdentifier: "Retire",
      section: "variables",
      changes: { alignment },
      confirm: true,
    });

  const refused = await write({ type: "sideways", month: 1 });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"variables\.alignment\.type"/);
  assert.match(
    refused.message,
    /Allowed values: calendar, rolling, au-tax, uk-tax, custom\./,
  );
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].variables.alignment.type,
    "calendar",
    "the plan keeps its alignment until a valid value arrives",
  );

  const done = await write({ type: "rolling", month: 4 });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(bridge.writes[0][0].variables.alignment, {
    type: "rolling",
    month: 4,
  });
});

/** A `yearlyChange.type` outside the observed list. */
const STORED_OUT_OF_LIST = "legacy-rate";

/**
 * The plan with an out-of-list value already stored where a whole-object
 * write carries it: the asset event's `yearlyChange.type`. A plan can hold
 * such a value from an older app version or an import, and the fields beside
 * it must stay writable.
 */
function planStateWithStoredOutliers() {
  const state = planState();
  state.plans[0].assets.events[0].yearlyChange = {
    type: STORED_OUT_OF_LIST,
    amount: 0.02,
  };
  return state;
}

const assetWrite = (call, pathChanges) =>
  call({
    planIdentifier: "Retire",
    section: "assets",
    eventIdentifier: "House",
    pathChanges,
    confirm: true,
  });

test("a whole yearlyChange object keeps a stored out-of-list type while another leaf changes", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const byPath = await assetWrite(call, {
    yearlyChange: { type: STORED_OUT_OF_LIST, amount: 0.05 },
  });
  assert.equal(byPath.success, true, JSON.stringify(byPath));
  assert.equal(byPath.verified, true, JSON.stringify(byPath));
  assert.deepEqual(bridge.writes[0][0].assets.events[0].yearlyChange, {
    type: STORED_OUT_OF_LIST,
    amount: 0.05,
  });

  // The legacy shallow patch reaches the same leaf through its own pre-check.
  const byPatch = await call({
    planIdentifier: "Retire",
    section: "assets",
    eventIdentifier: "House",
    patch: { yearlyChange: { type: STORED_OUT_OF_LIST, amount: 0.08 } },
    confirm: true,
  });
  assert.equal(byPatch.success, true, JSON.stringify(byPatch));
  assert.equal(byPatch.verified, true, JSON.stringify(byPatch));
  assert.deepEqual(bridge.writes[1][0].assets.events[0].yearlyChange, {
    type: STORED_OUT_OF_LIST,
    amount: 0.08,
  });
});

test("a directly addressed leaf that already holds the stored value is not refused", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const done = await assetWrite(call, { "yearlyChange.type": STORED_OUT_OF_LIST });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(bridge.writes, [], "nothing changed, so no mutation was sent");
});

test("a whole yearlyChange object that moves a stored out-of-list type is refused", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  // `amount` matches the stored object, so `type` is the only leaf at fault.
  const refused = await assetWrite(call, {
    yearlyChange: { type: "keep-up", amount: 0.02 },
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);
  assert.match(
    refused.message,
    /Allowed values: none, appreciate, depreciate, custom, match-inflation, inflation\+, inflation-\./,
  );
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].assets.events[0].yearlyChange.type,
    STORED_OUT_OF_LIST,
    "the refused write left the stored value in place",
  );
});

test("a whole yearlyChange object that moves a stored out-of-list type to an allowed value is accepted", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const done = await assetWrite(call, {
    yearlyChange: { type: "depreciate", amount: 0.02 },
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(
    bridge.writes[0][0].assets.events[0].yearlyChange.type,
    "depreciate",
  );
});

test("a refused second path applies neither path", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const refused = await assetWrite(call, {
    value: 410_000,
    yearlyChange: { type: "keep-up", amount: 0.02 },
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].assets.events[0].value,
    400_000,
    "the accepted first path was not applied either",
  );
});

test("a field the patch adds is checked leaf by leaf", async () => {
  const state = planState();
  // An asset that stores no yearlyChange yet, so the patch adds the field.
  state.plans[0].assets.events.push({
    id: "asset-bare",
    kind: "real-asset",
    type: "land",
    name: "Bare",
    value: 50_000,
  });
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);
  const patchYearlyChange = (type) =>
    call({
      planIdentifier: "Retire",
      section: "assets",
      eventIdentifier: "Bare",
      patch: { yearlyChange: { type, amount: 0.01 } },
    });

  const refused = await patchYearlyChange("sideways");
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);

  const accepted = await patchYearlyChange("appreciate");
  assert.equal(accepted.dryRun, true, JSON.stringify(accepted));
  assert.deepEqual(bridge.writes, []);
});
