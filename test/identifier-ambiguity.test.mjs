// A substring identifier that matches several plans or events is refused
// with the candidates named, in read tools and write tools alike; unique
// substrings and exact names still resolve.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-ambiguity-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { requirePlanIndex, requirePlan, requireEventIndex } = await import(
  "../dist/plans.js"
);
const { registerGetPlanTool } = await import("../dist/tools/getPlan.js");
const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);
const { SnapshotManager } = await import("../dist/snapshot.js");

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function plans() {
  return [
    { id: "p1", name: "Base", income: { events: [{ id: "i1", name: "Salary" }] } },
    {
      id: "p2",
      name: "Base - early retirement",
      income: { events: [{ id: "i2", name: "Salary" }] },
    },
    { id: "p3", name: "Work forever", income: { events: [] } },
  ];
}

test("a unique substring still resolves", () => {
  assert.equal(requirePlanIndex(plans(), "work"), 2);
  assert.equal(requirePlanIndex(plans(), "early retire"), 1);
  assert.equal(requirePlan(plans(), "WORK FOREVER").id, "p3");
});

test("an exact name wins over a longer name that contains it", () => {
  const list = [
    { id: "a", name: "Retire at 55" },
    { id: "b", name: "Retire at 55 copy" },
  ];
  assert.equal(requirePlanIndex(list, "Retire at 55"), 0);
  assert.equal(requirePlanIndex(list, "retire at 55"), 0);
  assert.equal(requirePlanIndex(list, "b"), 1);
});

test("an exact ID resolves even when a name also matches", () => {
  const list = [{ id: "x", name: "whatever" }, { id: "name", name: "name" }];
  assert.equal(requirePlanIndex(list, "name"), 1);
  assert.equal(requirePlanIndex(list, "x"), 0);
});

test("an ambiguous substring is refused naming both candidates", () => {
  assert.throws(
    () => requirePlanIndex(plans(), "bas"),
    (err) =>
      err.code === "INVALID_INPUT" &&
      /More than one plan matches "bas"/.test(err.message) &&
      /"Base" \(ID: p1\)/.test(err.suggestion) &&
      /"Base - early retirement" \(ID: p2\)/.test(err.suggestion) &&
      /exact name or one of the IDs/.test(err.suggestion),
  );
});

test("two items sharing an exact name are refused asking for the ID", () => {
  const list = [
    { id: "d1", name: "Twin" },
    { id: "d2", name: "twin" },
  ];
  assert.throws(
    () => requirePlanIndex(list, "Twin"),
    (err) =>
      err.code === "INVALID_INPUT" &&
      /"Twin" \(ID: d1\)/.test(err.suggestion) &&
      /"twin" \(ID: d2\)/.test(err.suggestion),
  );
});

test("requireEventIndex resolves uniquely and refuses ambiguity", () => {
  const events = [
    { id: "e1", name: "Groceries" },
    { id: "e2", name: "Groceries (travel)" },
    { id: "e3", name: "Rent" },
  ];
  assert.equal(requireEventIndex(events, "Rent"), 2);
  assert.equal(requireEventIndex(events, "Groceries"), 0);
  assert.equal(requireEventIndex(events, "e2"), 1);
  assert.equal(requireEventIndex(events, "nope"), -1);
  assert.throws(
    () => requireEventIndex(events, "grocer"),
    (err) =>
      err.code === "INVALID_INPUT" &&
      /More than one event matches "grocer"/.test(err.message) &&
      /"Groceries" \(ID: e1\)/.test(err.suggestion) &&
      /"Groceries \(travel\)" \(ID: e2\)/.test(err.suggestion),
  );
});

function registered() {
  const state = { plans: plans() };
  const bridge = {
    writes: [],
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(next) {
      bridge.writes.push("plans");
      state.plans = structuredClone(next);
    },
  };
  const server = fakeServer();
  registerGetPlanTool(server, bridge);
  registerUpdatePlanSectionTool(server, bridge, new SnapshotManager());
  return { server, bridge };
}

test("the read tool refuses an ambiguous identifier", async () => {
  const { server, bridge } = registered();
  const result = await server.tools
    .get("projectionlab_get_plan")
    .handler({ planIdentifier: "bas" });
  assert.equal(result.isError, true);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.error, "INVALID_INPUT");
  assert.match(output.message, /More than one plan matches "bas"/);
  assert.match(output.suggestion, /p1/);
  assert.match(output.suggestion, /p2/);
});

test("the write tool refuses an ambiguous identifier before anything else", async () => {
  const { server, bridge } = registered();
  const result = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "bas",
      section: "income",
      sectionData: { events: [] },
      confirm: false,
    });
  assert.equal(result.isError, true);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.error, "INVALID_INPUT");
  assert.match(output.message, /More than one plan matches "bas"/);
  assert.deepEqual(bridge.writes, []);
});
