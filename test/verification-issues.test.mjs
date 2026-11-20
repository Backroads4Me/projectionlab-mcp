// Per-path verification detail on the write tools. A confirmed write that the
// fresh read does not carry back fails verification and names each path that
// did not land, with its expected value, its stored value and a reason of
// absent, shape or value. Only a fresh read that throws reports a verification
// that could not run. Every name, id and figure here is invented.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { asV5Export } from "./helpers/v5-envelope.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-verification-issues-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerUpdateAccountTool } = await import(
  "../dist/tools/updateAccount.js"
);
const { registerUpdatePlanSettingsTool } = await import(
  "../dist/tools/updatePlanSettings.js"
);
const { registerUpdatePlanEventTool } = await import(
  "../dist/tools/updatePlanEvent.js"
);

/** A snapshot store that records every create. */
function snapshotStore() {
  const created = [];
  return {
    created,
    async create(operation, sections, data) {
      const snapshot = {
        id: `snap-${created.length + 1}`,
        timestamp: new Date(created.length).toISOString(),
        operation,
        sections,
        data: structuredClone(data),
      };
      created.push(snapshot);
      return snapshot;
    },
  };
}

/** Register one write tool and call it as its JSON reply. */
function caller(register, bridge, snapshots) {
  const map = new Map();
  register(
    {
      registerTool(name, _definition, handler) {
        map.set(name, handler);
      },
    },
    bridge,
    snapshots,
  );
  return async (name, input) =>
    JSON.parse((await map.get(name)(input)).content[0].text);
}

/** The issue fields as they arrive through JSON, which drops an absent `stored`. */
const issueFields = (issue) => [issue.path, issue.expected, issue.reason];
const byPath = (issues) =>
  [...issues].sort((a, b) => a.path.localeCompare(b.path)).map(issueFields);

/**
 * A ProjectionLab 5 bridge that applies each updateAccount to its export and
 * refuses every other write, so a test sees exactly one write path.
 */
function financesBridge(state = v5Export()) {
  const writes = [];
  const refuse = (name) => async () => {
    throw new Error(`${name} must not be called`);
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
    async updateAccount(accountId, data, force) {
      writes.push({
        name: "updateAccount",
        accountId,
        data: structuredClone(data),
        force,
      });
      const account = state.documents.currentFinances.accounts[accountId];
      if (!account) throw new Error(`No account matches id "${accountId}".`);
      Object.assign(account, structuredClone(data));
    },
    restorePlans: refuse("restorePlans"),
    restorePlansIfUnchanged: refuse("restorePlansIfUnchanged"),
    restoreCurrentFinances: refuse("restoreCurrentFinances"),
    restoreSettings: refuse("restoreSettings"),
  };
}

/** Serve the export, then answer every later read with `replay` applied. */
function replayLaterReads(bridge, replay) {
  let reads = 0;
  const readExport = bridge.exportData.bind(bridge);
  bridge.exportData = async (options) => {
    reads += 1;
    if (reads > 1) {
      const replayed = await replay(reads);
      if (replayed === "throw") throw new Error("the page stopped answering");
      const data = await readExport(options);
      replayed(data);
      return data;
    }
    return readExport(options);
  };
}

const callAccount = (bridge, snapshots) =>
  caller(registerUpdateAccountTool, bridge, snapshots);

test("update_account fails verification when the fresh read lost the account", async () => {
  const bridge = financesBridge();
  // The write lands, and the read that follows no longer holds the account.
  replayLaterReads(bridge, () => (data) => {
    delete data.documents.currentFinances.accounts.acct_brokerage;
  });
  const snapshots = snapshotStore();
  const done = await callAccount(bridge, snapshots)(
    "projectionlab_update_account",
    {
      accountId: "acct_brokerage",
      data: { balance: 55_000, costBasis: 41_000 },
      confirm: true,
    },
  );

  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, false, JSON.stringify(done));
  assert.deepEqual(byPath(done.verificationIssues), [
    ["balance", 55_000, "absent"],
    ["costBasis", 41_000, "absent"],
  ]);
  assert.ok(
    done.verificationIssues.every((issue) => !("stored" in issue)),
    "an absent path stores nothing",
  );
  assert.match(done.message, /balance/);
  assert.match(done.message, /costBasis/);
  assert.doesNotMatch(done.message, /could not run/);
  assert.equal(done.snapshotId, snapshots.created[0].id);
});

test("update_account reports a verification that could not run only when the read throws", async () => {
  const bridge = financesBridge();
  replayLaterReads(bridge, () => "throw");
  const snapshots = snapshotStore();
  const done = await callAccount(bridge, snapshots)(
    "projectionlab_update_account",
    {
      accountId: "acct_brokerage",
      data: { balance: 55_000 },
      confirm: true,
    },
  );

  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, undefined, JSON.stringify(done));
  assert.equal(done.verificationIssues, undefined);
  assert.match(done.message, /could not run/);
  assert.equal(done.snapshotId, snapshots.created[0].id);
});

/**
 * A bridge whose plans write stores what `keep` says the app
 * kept. Once the write has gone in, `dropPlan` removes the plan from every
 * read, so the tool verifies against a plan that is no longer there.
 */
function planBridge({ keep, dropPlan = false } = {}) {
  const state = {
    plans: [
      {
        id: "plan_synth",
        name: "synth",
        lastUpdated: 1,
        variables: {
          inflation: 3,
          estate: { enabled: false, beneficiary: "family" },
        },
      },
    ],
  };
  const actions = [];
  const bridge = {
    state,
    actions,
    async apiContract() {
      return 2;
    },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      const data = structuredClone(state);
      if (dropPlan && actions.includes("restore")) data.plans = [];
      return asV5Export(data);
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      actions.push("restore");
      state.plans = structuredClone(plans);
      if (keep) keep(state.plans[0]);
    },
    async restoreCurrentFinances() {
      throw new Error("restoreCurrentFinances must not be called");
    },
  };
  return bridge;
}

const SETTINGS_CALL = {
  planIdentifier: "plan_synth",
  section: "variables",
  confirm: true,
};

const callSettings = (bridge, snapshots) =>
  caller(registerUpdatePlanSettingsTool, bridge, snapshots);

test("update_plan_settings verifies a whole object the app stored in its own key order", async () => {
  // ProjectionLab rewrites objects as it saves them: it emits keys in its own
  // order and fills in a default the caller never sent.
  const bridge = planBridge({
    keep: (plan) => {
      plan.variables.estate = {
        beneficiary: "family",
        enabled: true,
        appraisalYear: 2026,
      };
    },
  });
  const done = await callSettings(bridge, snapshotStore())(
    "projectionlab_update_plan_settings",
    {
      ...SETTINGS_CALL,
      changes: { estate: { enabled: true, beneficiary: "family" } },
    },
  );

  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(done.verificationIssues, undefined);
  assert.match(done.message, /verified/);
});

test("update_plan_settings names the path of a setting the app kept at its old value", async () => {
  const bridge = planBridge({
    keep: (plan) => {
      plan.variables.inflation = 3;
    },
  });
  const done = await callSettings(bridge, snapshotStore())(
    "projectionlab_update_plan_settings",
    { ...SETTINGS_CALL, changes: { inflation: 2.5 } },
  );

  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, false, JSON.stringify(done));
  assert.deepEqual(byPath(done.verificationIssues), [
    ["inflation", 2.5, "value"],
  ]);
  assert.equal(done.verificationIssues[0].stored, 3);
  assert.match(done.message, /inflation/);
  assert.doesNotMatch(done.message, /could not run/);
});

test("update_plan_settings fails verification when the fresh read lost the plan", async () => {
  const bridge = planBridge({ dropPlan: true });
  const snapshots = snapshotStore();
  const done = await callSettings(bridge, snapshots)(
    "projectionlab_update_plan_settings",
    {
      ...SETTINGS_CALL,
      changes: { inflation: 2.5, "estate.enabled": true },
    },
  );

  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, false, JSON.stringify(done));
  assert.deepEqual(byPath(done.verificationIssues), [
    ["estate.enabled", true, "absent"],
    ["inflation", 2.5, "absent"],
  ]);
  assert.match(done.message, /inflation/);
  assert.match(done.message, /estate\.enabled/);
  assert.doesNotMatch(done.message, /could not run/);
  assert.equal(done.snapshotId, snapshots.created[0].id);
});

/**
 * A bridge holding one plan with one income event. After the write, the
 * fresh read can lose the event (`drop: "event"`) or the whole plan
 * (`drop: "plan"`).
 */
function eventBridge({ drop } = {}) {
  const state = {
    plans: [
      {
        id: "plan_synth",
        name: "synth",
        lastUpdated: 1,
        income: {
          events: [
            {
              id: "income_synth",
              name: "Synthetic wage",
              amount: 1000,
              taxHandling: { type: "wage", withholding: { rate: 0.1 } },
            },
          ],
        },
      },
    ],
  };
  const actions = [];
  return {
    state,
    actions,
    async apiContract() {
      return 2;
    },
    async editAccess() {
      return "enabled";
    },
    async exportData() {
      const data = structuredClone(state);
      if (actions.includes("restore")) {
        if (drop === "plan") data.plans = [];
        if (drop === "event") data.plans[0].income.events = [];
      }
      return asV5Export(data);
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      actions.push("restore");
      state.plans = structuredClone(plans);
    },
    async restoreCurrentFinances() {
      throw new Error("restoreCurrentFinances must not be called");
    },
  };
}

const EVENT_CALL = {
  planIdentifier: "plan_synth",
  section: "income",
  eventIdentifier: "income_synth",
  pathChanges: { amount: 2000, "taxHandling.withholding.rate": 0.2 },
  confirm: true,
};

for (const drop of ["event", "plan"]) {
  test(`update_plan_event fails verification when the fresh read lost the ${drop}`, async () => {
    const snapshots = snapshotStore();
    const done = await caller(
      registerUpdatePlanEventTool,
      eventBridge({ drop }),
      snapshots,
    )("projectionlab_update_plan_event", EVENT_CALL);

    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(done.verified, false, JSON.stringify(done));
    assert.deepEqual(byPath(done.verificationIssues), [
      ["amount", 2000, "absent"],
      ["taxHandling.withholding.rate", 0.2, "absent"],
    ]);
    assert.match(done.message, /amount/);
    assert.match(done.message, /taxHandling\.withholding\.rate/);
    assert.equal(done.snapshotId, snapshots.created[0].id);
  });
}
