// The plain-language `summary` every write tool returns beside its JSON
// preview and its confirmed result, against a ProjectionLab 5 export.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-change-summary-")), "snapshots");
process.env.LOG_LEVEL = "error";
process.env.TZ = "UTC";

const {
  accountChangeSummary,
  capLines,
  fieldChangeLines,
  planSectionChangeSummary,
  restoreCurrentFinancesSummary,
  restorePlansSummary,
  SUMMARY_MAX_LINES,
} = await import("../dist/changeSummary.js");
const { registerUpdatePlanSettingsTool } = await import("../dist/tools/updatePlanSettings.js");
const { registerUpdatePlanSectionTool } = await import("../dist/tools/updatePlanSection.js");
const { registerClonePlanTool } = await import("../dist/tools/clonePlan.js");
const { registerDeletePlanTool } = await import("../dist/tools/deletePlan.js");
const { registerUpdatePlanEventTool } = await import("../dist/tools/updatePlanEvent.js");
const { registerUpdateAccountTool } = await import("../dist/tools/updateAccount.js");
const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

const SECRETS = ["test-api-key", "synthetic-plugin-key"];

/** A ProjectionLab 5 bridge whose plans writes replace its export's plans. */
function v5Bridge(state = v5Export()) {
  const writes = [];
  const applyPlans = (name) => async (...args) => {
    const plans = name === "restorePlans" ? args[0] : args[1];
    writes.push(name);
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
    restorePlans: applyPlans("restorePlans"),
    restorePlansIfUnchanged: applyPlans("restorePlansIfUnchanged"),
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
  let count = 0;
  return {
    async create() {
      count += 1;
      return { id: `snap-${count}` };
    },
    async get() {
      return structuredClone(held);
    },
    async list() {
      return held ? [structuredClone(held)] : [];
    },
  };
}

function tools(bridge, snapshots = snapshotStore()) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
  };
  for (const register of [
    registerUpdatePlanSettingsTool,
    registerUpdatePlanSectionTool,
    registerClonePlanTool,
    registerDeletePlanTool,
    registerUpdatePlanEventTool,
    registerUpdateAccountTool,
    registerRestoreTools,
    registerSnapshotTools,
  ]) {
    register(server, bridge, snapshots);
  }
  return async (name, input) => {
    const text = (await map.get(name)(input)).content[0].text;
    for (const secret of SECRETS) {
      assert.ok(!text.includes(secret), `${name} output carries a secret value`);
    }
    return JSON.parse(text);
  };
}

test("field lines use the data model's labels and units, and name absent and hidden values", () => {
  assert.deepEqual(
    fieldChangeLines("income", {
      amount: { before: 90000, after: 95000 },
      note: { before: "[ABSENT]", after: "Raise" },
      token: { before: "[REDACTED]", after: "[REDACTED]" },
    }),
    ["Amount: $90,000 → $95,000", "Note: not set → Raise", "Token: (hidden) → (hidden)"],
  );
  assert.deepEqual(fieldChangeLines("variables", { inflation: { before: 3, after: 2.5 } }), [
    "Inflation Rate: 3% → 2.5%",
  ]);
});

test("a field with no data-model entry shows its value plain, never with guessed units", () => {
  assert.deepEqual(fieldChangeLines("income", { mysteryNumber: { before: 1, after: 2 } }), [
    "Mystery number: 1 → 2",
  ]);
  assert.deepEqual(fieldChangeLines("income", { "points.0.rate": { before: 1, after: 2 } }), [
    "Points #1 rate: 1 → 2",
  ]);
});

test("summaries fold lines past the cap into one closing line", () => {
  const lines = Array.from({ length: SUMMARY_MAX_LINES + 3 }, (_, i) => `line ${i}`);
  const capped = capLines(lines);
  assert.equal(capped.length, SUMMARY_MAX_LINES + 1);
  assert.equal(capped.at(-1), "and 3 more changes");
  assert.deepEqual(capLines(["a"]), ["a"]);
});

test("update_plan_event returns the same summary in the dry run and the confirmed result", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge);
  const input = {
    planIdentifier: "plan_main",
    section: "income",
    eventIdentifier: "plan_main_ev_salary",
    patch: { amount: 95000 },
  };

  const dry = await call("projectionlab_update_plan_event", input);
  assert.equal(
    dry.summary,
    'Plan "Main Plan", income item "Salary":\n' +
      "- Amount: $90,000 → $95,000\n" +
      "A backup is taken first, so this can be undone.",
  );
  assert.deepEqual(bridge.writes, []);

  const done = await call("projectionlab_update_plan_event", { ...input, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.summary, dry.summary);
});

test("a value equal to the Plugin API key shows as hidden in the summary", async () => {
  const call = tools(v5Bridge());
  const dry = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "income",
    eventIdentifier: "plan_main_ev_salary",
    patch: { name: "test-api-key" },
  });
  assert.match(dry.summary, /- Name: Salary → \(hidden\)/);
});

test("a patch that changes nothing says so", async () => {
  const call = tools(v5Bridge());
  const dry = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "income",
    eventIdentifier: "plan_main_ev_salary",
    patch: { amount: 90000 },
  });
  assert.equal(
    dry.summary,
    'Plan "Main Plan", income item "Salary": Nothing changes: every supplied value already matches.',
  );
});

test("update_account names the Current Finances record by its kind", async () => {
  const call = tools(v5Bridge());
  const account = await call("projectionlab_update_account", {
    accountId: "acct_brokerage",
    pathChanges: { balance: 55000 },
  });
  assert.match(account.summary, /^Current Finances account "Brokerage":\n- Balance: \$50,000 → \$55,000\n/);

  const debt = await call("projectionlab_update_account", {
    accountId: "debt_land_loan",
    pathChanges: { balance: 55000 },
  });
  assert.match(debt.summary, /^Current Finances debt "Land Loan":/);
});

test("update_plan_settings shows settings with their on-screen labels", async () => {
  const state = v5Export();
  state.documents.plans[0].variables = { inflation: 3 };
  const call = tools(v5Bridge(state));
  const dry = await call("projectionlab_update_plan_settings", {
    planIdentifier: "plan_main",
    section: "variables",
    changes: { inflation: 2.5 },
  });
  assert.match(dry.summary, /^Plan "Main Plan" settings, Variables:\n- Inflation Rate: 3% → 2\.5%\n/);
});

test("update_plan_section lists added, removed and changed items by name", async () => {
  const state = v5Export();
  const call = tools(v5Bridge(state));
  const expenses = structuredClone(state.documents.plans[0].expenses);
  expenses.events[0].amount = 45000;
  expenses.events.push({ ...expenses.events[0], id: "plan_main_ev_travel", name: "Travel" });
  const dry = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "expenses",
    sectionData: expenses,
  });
  assert.equal(
    dry.summary,
    'Plan "Main Plan", expenses section (1 → 2 items):\n' +
      '- Add "Travel"\n' +
      '- Change "Living": Amount\n' +
      "A backup is taken first, so this can be undone.",
  );
});

test("clone_plan and delete_plan describe the plan and its item counts", async () => {
  const call = tools(v5Bridge());
  const clone = await call("projectionlab_clone_plan", { planIdentifier: "plan_main", newName: "Copy" });
  assert.match(clone.summary, /^Add plan "Copy" as a copy of "Main Plan" \(income: 1, expenses: 1,/);

  const remove = await call("projectionlab_delete_plan", { planId: "plan_early" });
  assert.match(remove.summary, /^Delete plan "Retire Early" and everything in it \(/);
});

test("restore_plans names each plan it adds, removes or changes", async () => {
  const state = v5Export();
  const call = tools(v5Bridge(state));
  const dry = await call("projectionlab_restore_plans", { plans: [state.documents.plans[0]] });
  assert.equal(
    dry.summary,
    "Replace all plans (2 → 1):\n" +
      '- Remove plan "Retire Early"\n' +
      "- 1 other plan replaced, with the same name and item counts\n" +
      "A backup is taken first, so this can be undone.",
  );
});

test("restore_current_finances names the accounts it keeps", async () => {
  const call = tools(v5Bridge());
  const dry = await call("projectionlab_restore_current_finances", {
    currentFinances: { household: {}, accounts: {} },
  });
  assert.match(dry.summary, /- Replaced: Household, Accounts\n/);
  assert.match(dry.summary, /- Kept as they are \(not in the replacement\): "Brokerage", /);
});

test("rollback names the backup and the sections it restores", async () => {
  const held = {
    id: "snap-v5",
    timestamp: "2026-11-25T10:00:00.000Z",
    operation: "updatePlanEvent",
    sections: ["plans", "currentFinances"],
    layout: "v5",
    data: { plans: v5Export().documents.plans },
  };
  const call = tools(v5Bridge(), snapshotStore(held));
  const dry = await call("projectionlab_rollback", { snapshotId: "snap-v5" });
  assert.equal(
    dry.summary,
    "Restore the backup taken Nov 25, 2026, 10:00 AM UTC, before a plan item change:\n" +
      "- Restored: Plans\n" +
      "The current state is backed up first, so this rollback can itself be undone.",
  );
});

test("a start or end reads as the plan shows it, by milestone name", async () => {
  const call = tools(v5Bridge());
  const dry = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "expenses",
    eventIdentifier: "plan_main_ev_living",
    patch: { end: { type: "milestone", value: "plan_main_ms_retire" } },
  });
  assert.equal(
    dry.summary,
    'Plan "Main Plan", expenses item "Living":\n' +
      "- Ends: placeholder → Retirement\n" +
      "A backup is taken first, so this can be undone.",
  );
});

test("restore_settings names a kept secret in words and never shows its value", async () => {
  const call = tools(v5Bridge());
  const dry = await call("projectionlab_restore_settings", {
    settings: { plugins: { enabled: true, apiKey: "[REDACTED]" } },
  });
  assert.match(dry.summary, /- Replaced: Plugins\n/);
  assert.match(dry.summary, /- Kept from the current settings \(hidden values\): Plugins api key\n/);
});

test("no summary line shows a dotted path or a camelCase code", async () => {
  const state = v5Export();
  const call = tools(v5Bridge(state));
  const held = {
    id: "snap-v5",
    timestamp: "2026-11-25T10:00:00.000Z",
    operation: "updatePlanSettings",
    sections: ["plans", "currentFinances"],
    layout: "v5",
    data: { plans: v5Export().documents.plans },
  };
  state.documents.plans[0].variables = { inflation: 3 };
  const expenses = structuredClone(state.documents.plans[0].expenses);
  expenses.events[0].amount = 45000;
  const summaries = [
    (await call("projectionlab_update_plan_event", {
      planIdentifier: "plan_main",
      section: "expenses",
      eventIdentifier: "plan_main_ev_living",
      patch: { end: { type: "keyword", value: "endOfPlan" } },
    })).summary,
    (await call("projectionlab_update_account", {
      accountId: "acct_brokerage",
      pathChanges: { balance: 55000 },
    })).summary,
    (await call("projectionlab_update_plan_settings", {
      planIdentifier: "plan_main",
      section: "variables",
      changes: { inflation: 2.5 },
    })).summary,
    (await call("projectionlab_update_plan_section", {
      planIdentifier: "plan_main",
      section: "expenses",
      sectionData: expenses,
    })).summary,
    (await call("projectionlab_clone_plan", { planIdentifier: "plan_main", newName: "Copy" })).summary,
    (await call("projectionlab_delete_plan", { planId: "plan_early" })).summary,
    (await call("projectionlab_restore_plans", { plans: [state.documents.plans[0]] })).summary,
    (await call("projectionlab_restore_current_finances", {
      currentFinances: { household: {}, accounts: {} },
    })).summary,
    (await call("projectionlab_update_plan_event", {
      planIdentifier: "plan_main",
      section: "income",
      eventIdentifier: "plan_main_ev_salary",
      pathChanges: { amount: 91000 },
    })).summary,
    (await call("projectionlab_restore_settings", {
      settings: { plugins: { enabled: true, apiKey: "[REDACTED]" } },
    })).summary,
    (await tools(v5Bridge(), snapshotStore(held))("projectionlab_rollback", { snapshotId: "snap-v5" }))
      .summary,
  ];
  for (const summary of summaries) {
    assert.doesNotMatch(summary, /\b[a-z]+\.[a-z]/, summary);
    assert.doesNotMatch(summary, /\b[a-z]+[A-Z][a-z]/, summary);
    assert.doesNotMatch(summary, /snap-/, summary);
  }
});

test("null reads as not set, and a long value is cut to the diff's bound", () => {
  assert.deepEqual(fieldChangeLines("income", { note: { before: null, after: "Raise" } }), [
    "Note: not set → Raise",
  ]);
  const [line] = fieldChangeLines("income", { note: { before: "a", after: "x".repeat(300) } });
  assert.match(line, /^Note: a → x{200}… \(300 characters\)$/);
});

test("a kind inherited from Object.prototype falls back to account", () => {
  assert.match(
    accountChangeSummary({ accountName: "Cash", kind: "constructor", changes: { balance: { before: 1, after: 2 } } }),
    /^Current Finances account "Cash":/,
  );
});

test("section counts agree in number, and long name lists fold", () => {
  const fieldChanges = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, {}]));
  const summary = planSectionChangeSummary({
    planName: "Main Plan",
    section: "expenses",
    currentCount: 3,
    newCount: 1,
    removed: ["A", "B"],
    modified: [{ name: "Living", changes: fieldChanges }],
  });
  assert.match(summary, /\(3 → 1 item\):/);
  assert.match(summary, /- Change "Living": Field0, .*Field7, and 2 more fields\n/);
});

test("a settings-shaped section replacement shows no item count", async () => {
  const state = v5Export();
  state.documents.plans[0].variables = { inflation: 3 };
  const call = tools(v5Bridge(state));
  const dry = await call("projectionlab_update_plan_section", {
    planIdentifier: "plan_main",
    section: "variables",
    sectionData: { inflation: 2.5 },
  });
  assert.equal(
    dry.summary,
    'Plan "Main Plan", variables section:\n' +
      "- Change Inflation Rate\n" +
      "A backup is taken first, so this can be undone.",
  );
});

test("a timing change the words do not show stays as its field change", async () => {
  const state = v5Export();
  state.documents.plans[0].income.events[0].start = { type: "age", value: 65, modifier: 0 };
  const call = tools(v5Bridge(state));
  const dry = await call("projectionlab_update_plan_event", {
    planIdentifier: "plan_main",
    section: "income",
    eventIdentifier: "plan_main_ev_salary",
    pathChanges: { "start.modifier": 1 },
  });
  assert.doesNotMatch(dry.summary, /Starts:/);
  assert.match(dry.summary, /modifier.*: 0 → 1\n/i);
});

test("kept accounts past the bound fold into a count of accounts", () => {
  const keptAccounts = Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, name: `Account ${i}` }));
  const summary = restoreCurrentFinancesSummary({ topLevelKeys: ["accounts"], keptAccounts });
  assert.match(summary, /"Account 9", and 3 more accounts\n/);
});

test("a changed plan with no listed differences reads as replaced", () => {
  const summary = restorePlansSummary({
    currentCount: 1,
    incomingCount: 1,
    planDiff: [{ name: "Main Plan", status: "modified" }],
  });
  assert.match(summary, /- Replace plan "Main Plan"\n/);
});

test("every write tool's confirmed result carries its dry-run summary", async () => {
  const state = v5Export();
  state.documents.plans[0].variables = { inflation: 3 };
  const expenses = structuredClone(state.documents.plans[0].expenses);
  expenses.events[0].amount = 45000;
  const held = {
    id: "snap-v5",
    timestamp: "2026-11-25T10:00:00.000Z",
    operation: "updatePlanEvent",
    sections: ["plans"],
    layout: "v5",
    data: { plans: v5Export().documents.plans },
  };
  const cases = [
    ["projectionlab_update_account", { accountId: "acct_brokerage", pathChanges: { balance: 55000 } }],
    ["projectionlab_update_plan_settings", { planIdentifier: "plan_main", section: "variables", changes: { inflation: 2.5 } }],
    ["projectionlab_update_plan_section", { planIdentifier: "plan_main", section: "expenses", sectionData: expenses }],
    ["projectionlab_clone_plan", { planIdentifier: "plan_main", newName: "Copy" }],
    ["projectionlab_delete_plan", { planId: "plan_early" }],
    ["projectionlab_restore_plans", { plans: structuredClone(state.documents.plans) }],
    ["projectionlab_restore_current_finances", { currentFinances: structuredClone(state.documents.currentFinances) }],
    ["projectionlab_rollback", { snapshotId: "snap-v5" }],
  ];
  for (const [name, input] of cases) {
    const bridge = v5Bridge(structuredClone(state));
    const call = tools(bridge, snapshotStore(held));
    const dry = await call(name, input);
    assert.equal(typeof dry.summary, "string", `${name}: ${JSON.stringify(dry)}`);
    assert.deepEqual(bridge.writes, [], name);
    const done = await call(name, { ...input, confirm: true });
    assert.ok(!done.error, `${name}: ${JSON.stringify(done)}`);
    assert.equal(done.summary, dry.summary, name);
    assert.ok(bridge.writes.length > 0, name);
  }
});
