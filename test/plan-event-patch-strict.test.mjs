// The legacy patch input of projectionlab_update_plan_event is validated
// like pathChanges: existing fields keep their JSON type, secret-named and
// unsafe keys are refused, and new fields are allowed only as plain names.

import assert from "node:assert/strict";
import test from "node:test";
import { restorePlansIfUnchanged } from "./helpers/checked-restore.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-patch-strict-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

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

function initialState() {
  return {
    plans: [
      {
        id: "plan-1",
        name: "main",
        income: {
          events: [
            {
              id: "income-1",
              name: "Salary",
              amount: 100000,
              apiKey: "old-secret",
              taxHandling: { type: "wage", withholding: { mode: "fixed", rate: 0.1 } },
            },
          ],
        },
      },
    ],
  };
}

function setup() {
  let state = initialState();
  const actions = [];
  const bridge = {
    async exportData() {
      return structuredClone(state);
    },
    restorePlansIfUnchanged,
    async restorePlans(plans) {
      actions.push("restore");
      state = { plans: structuredClone(plans) };
    },
  };
  const snapshots = {
    async create() {
      actions.push("snapshot");
      return { id: "snap-1" };
    },
  };
  const server = fakeServer();
  registerUpdatePlanEventTool(server, bridge, snapshots);
  const handler = server.handlers.get("projectionlab_update_plan_event");
  const call = async (patch, confirm = false) => {
    const result = await handler({
      planIdentifier: "plan-1",
      section: "income",
      eventIdentifier: "Salary",
      patch,
      confirm,
    });
    return result;
  };
  return { server, actions, call, currentEvent: () => structuredClone(state).plans[0].income.events[0] };
}

const refusals = [
  ["wrong JSON type on an existing field", { amount: "100000" }, /expects number, received string/],
  ["a dotted new field", { "taxHandling.mode": "x" }, /Invalid new event field "taxHandling\.mode"/],
  ["a new secret-named field", { token: "abc" }, /Invalid new event field "token"/],
  ["rewriting the id", { id: "other" }, /ID is immutable/],
  ["a prototype key", { ["__proto__"]: 1 }, /Invalid new event field "__proto__"/],
  ["an existing secret-named field", { apiKey: "x" }, /Invalid event field path "apiKey"/],
];

for (const [label, patch, expected] of refusals) {
  test(`patch refuses ${label}`, async () => {
    const { call, actions } = setup();
    const result = await call(patch);
    assert.equal(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.error, "INVALID_INPUT");
    assert.match(output.message, expected);
    assert.deepEqual(actions, []);
  });
}

test("patch previews and writes a valid field change", async () => {
  const { call, actions, currentEvent } = setup();
  const dry = JSON.parse((await call({ amount: 90000 })).content[0].text);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.changes, { amount: { before: 100000, after: 90000 } });
  assert.deepEqual(actions, []);

  const done = JSON.parse((await call({ amount: 90000 }, true)).content[0].text);
  assert.equal(done.success, true);
  assert.equal(done.verified, true);
  assert.deepEqual(actions, ["snapshot", "restore"]);
  assert.equal(currentEvent().amount, 90000);
});

test("patch adds a safe new top-level field and verifies it", async () => {
  const { call, actions, currentEvent } = setup();
  const dry = JSON.parse((await call({ sideGig: 500 })).content[0].text);
  assert.deepEqual(dry.changes, { sideGig: { before: "[ABSENT]", after: 500 } });

  const done = JSON.parse((await call({ sideGig: 500 }, true)).content[0].text);
  assert.equal(done.verified, true);
  assert.deepEqual(actions, ["snapshot", "restore"]);
  assert.equal(currentEvent().sideGig, 500);
});

test("patch replaces a whole nested object keeping siblings of the event", async () => {
  const { call, currentEvent } = setup();
  const done = JSON.parse(
    (
      await call(
        { taxHandling: { type: "wage", withholding: { mode: "fixed", rate: 0.2 } } },
        true,
      )
    ).content[0].text,
  );
  assert.equal(done.verified, true);
  const event = currentEvent();
  assert.equal(event.taxHandling.withholding.rate, 0.2);
  assert.equal(event.amount, 100000);
});
