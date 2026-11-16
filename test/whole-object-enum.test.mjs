// A whole-object or whole-array write carries every value under it, so the
// observed enum of a nested path is enforced inside the container as well as
// when the caller addresses that leaf. Only a leaf the write changes is
// checked, so a value the plan already stores outside the list rides through a
// whole-object write instead of blocking every other field beside it.
// ProjectionLab 4 is where the enforced
// entries below an array path and below a second nested object live:
// `milestones.criteria.*.type`, `milestones.criteria.*.householdMemberId`, and
// `variables.bondSettings.location.type`, all evidence "observed".
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { contractOf } from "./helpers/contract.mjs";
import { z } from "zod";

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
const { registerUpdateAccountTool } = await import(
  "../dist/tools/updateAccount.js"
);

/** A v4 plan holding each container whose nested enums are observed. */
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
          bondSettings: {
            allocationType: "target",
            location: { type: "evenly", accountOrder: [] },
          },
        },
        assets: {
          events: [
            {
              id: "asset-1",
              name: "House",
              type: "real-estate",
              amount: 400_000,
              amountType: "today$",
              yearlyChange: { type: "appreciate", amount: 0.02 },
            },
          ],
        },
        milestones: [
          {
            id: "m1",
            name: "Retirement",
            criteria: [
              { type: "year", value: "2040-01-01", modifier: "include" },
            ],
          },
        ],
      },
    ],
    today: {
      savingsAccounts: [],
      investmentAccounts: [],
      debts: [],
      assets: [],
    },
  };
}

function fakeBridge(state) {
  const bridge = {
    state,
    writes: [],
    async apiContract() {
      return contractOf(state);
    },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      return structuredClone(state);
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      bridge.writes.push(structuredClone(plans));
      state.plans = structuredClone(plans);
    },
    async updateAccount(accountId, data) {
      bridge.writes.push(structuredClone(data));
      for (const collection of Object.values(state.today)) {
        const account = collection.find((item) => item.id === accountId);
        if (account) Object.assign(account, structuredClone(data));
      }
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

test("a whole yearlyChange object on a v4 asset is checked leaf by leaf", async () => {
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
    /Allowed values: inflation\+, inflation-, depreciate, appreciate\./,
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

test("a whole criteria array is checked element by element", async () => {
  const state = planState();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);
  const write = (criteria) =>
    call({
      planIdentifier: "Retire",
      section: "milestones",
      eventIdentifier: "Retirement",
      pathChanges: { criteria },
      confirm: true,
    });

  // `criteria.0.type` sits two segments below the changed path, inside the
  // object the array element holds.
  const refusedType = await write([
    { type: "someday", value: "2040-01-01", modifier: "include" },
  ]);
  assert.equal(refusedType.error, "INVALID_INPUT", JSON.stringify(refusedType));
  assert.match(refusedType.message, /"milestones\.criteria\.0\.type"/);
  assert.match(
    refusedType.message,
    /Allowed values: date, year, milestone, netWorth, totalDebt, age\./,
  );

  // The other enforced entry under the same array path.
  const refusedMember = await write([
    { type: "age", age: 65, householdMemberId: "partner", modifier: "include" },
  ]);
  assert.equal(refusedMember.error, "INVALID_INPUT", JSON.stringify(refusedMember));
  assert.match(
    refusedMember.message,
    /"milestones\.criteria\.0\.householdMemberId"/,
  );
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(state.plans[0].milestones[0].criteria, [
    { type: "year", value: "2040-01-01", modifier: "include" },
  ]);

  const done = await write([
    { type: "age", age: 65, householdMemberId: "me", modifier: "include" },
  ]);
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(bridge.writes[0][0].milestones[0].criteria, [
    { type: "age", age: 65, householdMemberId: "me", modifier: "include" },
  ]);
});

test("a whole bondSettings object is checked two nested objects down", async () => {
  // `bondSettings.location.type` is three segments below the scope, so a
  // one-level walk would miss it.
  const state = planState();
  const bridge = fakeBridge(state);
  const call = toolCaller(
    registerUpdatePlanSettingsTool,
    "projectionlab_update_plan_settings",
    bridge,
  );
  const write = (bondSettings) =>
    call({
      planIdentifier: "Retire",
      section: "variables",
      changes: { bondSettings },
      confirm: true,
    });

  const refused = await write({
    allocationType: "target",
    location: { type: "sideways", accountOrder: [] },
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"variables\.bondSettings\.location\.type"/);
  assert.match(refused.message, /Allowed values: evenly, account-order\./);
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].variables.bondSettings.location.type,
    "evenly",
    "the plan keeps its placement until a valid value arrives",
  );

  const done = await write({
    allocationType: "target",
    location: { type: "account-order", accountOrder: ["acct-1"] },
  });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(bridge.writes[0][0].variables.bondSettings.location, {
    type: "account-order",
    accountOrder: ["acct-1"],
  });
});

/** A `yearlyChange.type` the ProjectionLab 4 registry never observed. */
const STORED_OUT_OF_LIST = "match-inflation";

/**
 * The v4 plan with each out-of-list value already stored where a whole-object
 * write carries it: the asset event's and a Current Finances real asset's
 * `yearlyChange.type`. A plan can hold such a value from an older app version
 * or an import, and the fields beside it must stay writable.
 */
function planStateWithStoredOutliers() {
  const state = planState();
  state.plans[0].assets.events[0].yearlyChange = {
    type: STORED_OUT_OF_LIST,
    amount: 0.02,
  };
  state.today.assets = [
    {
      id: "real-1",
      name: "Boat",
      yearlyChange: { type: STORED_OUT_OF_LIST, amount: 0.02 },
    },
  ];
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
    /Allowed values: inflation\+, inflation-, depreciate, appreciate\./,
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

test("a whole nested object on a Current Finances asset keeps its stored out-of-list value", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = toolCaller(
    registerUpdateAccountTool,
    "projectionlab_update_account",
    bridge,
  );
  const write = (yearlyChange) =>
    call({ accountId: "real-1", pathChanges: { yearlyChange }, confirm: true });

  const done = await write({ type: STORED_OUT_OF_LIST, amount: 0.05 });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(state.today.assets[0].yearlyChange, {
    type: STORED_OUT_OF_LIST,
    amount: 0.05,
  });

  const refused = await write({ type: "keep-up", amount: 0.05 });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);
  assert.equal(
    state.today.assets[0].yearlyChange.amount,
    0.05,
    "the refused write left the account alone",
  );
});

test("a new criteria element holding an out-of-list value is refused", async () => {
  const state = planState();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const refused = await call({
    planIdentifier: "Retire",
    section: "milestones",
    eventIdentifier: "Retirement",
    pathChanges: {
      criteria: [
        // The stored element, unchanged, riding along with the new one.
        { type: "year", value: "2040-01-01", modifier: "include" },
        { type: "someday", value: "2045-01-01", modifier: "include" },
      ],
    },
    confirm: true,
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"milestones\.criteria\.1\.type"/);
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(state.plans[0].milestones[0].criteria, [
    { type: "year", value: "2040-01-01", modifier: "include" },
  ]);
});

test("a refused second path applies neither path", async () => {
  const state = planStateWithStoredOutliers();
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);

  const refused = await assetWrite(call, {
    amount: 410_000,
    yearlyChange: { type: "keep-up", amount: 0.02 },
  });
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"assets\.yearlyChange\.type"/);
  assert.deepEqual(bridge.writes, []);
  assert.equal(
    state.plans[0].assets.events[0].amount,
    400_000,
    "the accepted first path was not applied either",
  );
});

test("a field the patch adds is checked leaf by leaf, inside an array too", async () => {
  const state = planState();
  // A milestone that stores no criteria yet, so the patch adds the field.
  state.plans[0].milestones.push({ id: "ms-bare", name: "Bare" });
  const bridge = fakeBridge(state);
  const call = eventCaller(bridge);
  const patchCriteria = (type) =>
    call({
      planIdentifier: "Retire",
      section: "milestones",
      eventIdentifier: "Bare",
      patch: { criteria: [{ type, value: "2045-01-01" }] },
    });

  const refused = await patchCriteria("someday");
  assert.equal(refused.error, "INVALID_INPUT", JSON.stringify(refused));
  assert.match(refused.message, /"milestones\.criteria\.0\.type"/);

  const accepted = await patchCriteria("year");
  assert.equal(accepted.dryRun, true, JSON.stringify(accepted));
  assert.deepEqual(bridge.writes, []);
});
