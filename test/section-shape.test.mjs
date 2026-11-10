// sectionData must carry the section's container shape: an omitted value,
// null, a primitive, or the wrong container kind is refused in the dry run,
// before any snapshot or write.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = join(
  mkdtempSync(join(tmpdir(), "plmcp-section-shape-")),
  "snapshots",
);
process.env.LOG_LEVEL = "error";

const { registerUpdatePlanSectionTool } = await import(
  "../dist/tools/updatePlanSection.js"
);
const { SnapshotManager } = await import("../dist/snapshot.js");
const { sectionContainer } = await import("../dist/plans.js");

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
      milestones: [{ id: "m1", name: "Retire" }],
      variables: { inflation: 2.5 },
    },
  ];
}

function setupWith(plans) {
  const state = { plans: structuredClone(plans) };
  const bridge = {
    writes: [],
    async exportData() {
      return structuredClone(state);
    },
    async restorePlans(plans) {
      bridge.writes.push("plans");
      state.plans = structuredClone(plans);
    },
  };
  const server = fakeServer();
  registerUpdatePlanSectionTool(server, bridge, new SnapshotManager());
  return { server, bridge };
}

function setup() {
  return setupWith(samplePlans());
}

test("sectionContainer classifies containers", () => {
  assert.equal(sectionContainer([1]), "array");
  assert.equal(sectionContainer({ events: [] }), "events");
  assert.equal(sectionContainer({ inflation: 1 }), "object");
  assert.equal(sectionContainer({ events: "no" }), "object");
  for (const bad of [undefined, null, "text", 7, true]) {
    assert.equal(sectionContainer(bad), null, String(bad));
  }
});

const refusals = [
  ["omitted sectionData", { section: "income" }, "missing"],
  ["null sectionData", { section: "income", sectionData: null }, "null"],
  ["bare array for income", { section: "income", sectionData: [] }, "must be an object with an events array"],
  ["object for milestones", { section: "milestones", sectionData: { events: [] } }, "must be an array of events"],
  ["string sectionData", { section: "variables", sectionData: "flat" }, "a section is"],
  ["array for variables", { section: "variables", sectionData: [] }, "must be an object"],
];

for (const [label, extra, expected] of refusals) {
  test(`update_plan_section refuses ${label} in dry-run mode`, async () => {
    const { server, bridge } = setup();
    const result = await server.tools
      .get("projectionlab_update_plan_section")
      .handler({ planIdentifier: "Retire at 55", confirm: false, ...extra });
    assert.equal(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.error, "INVALID_INPUT");
    assert.match(output.message, new RegExp(expected));
    assert.deepEqual(bridge.writes, []);
  });
}

test("a well-shaped section still previews and confirms", async () => {
  const { server, bridge } = setup();
  const milestoneEvents = [{ name: "Retire" }, { name: "Medicare" }];

  const preview = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "milestones",
      sectionData: milestoneEvents,
      confirm: false,
    });
  assert.equal(preview.isError, undefined);
  const dry = JSON.parse(preview.content[0].text);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.diff.added, ["Medicare"]);

  const confirmed = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "milestones",
      sectionData: milestoneEvents,
      confirm: true,
    });
  assert.equal(confirmed.isError, undefined);
  const done = JSON.parse(confirmed.content[0].text);
  assert.equal(done.verified, true);
  assert.deepEqual(bridge.writes, ["plans"]);

  const income = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "income",
      sectionData: { events: [{ id: "i1", name: "Salary", amount: 1000 }] },
      confirm: true,
    });
  assert.equal(JSON.parse(income.content[0].text).verified, true);
});

test("a missing section accepts a plain object or array only", async () => {
  const { server, bridge } = setup();
  const result = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "montecarlo",
      sectionData: 42,
      confirm: false,
    });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /INVALID_INPUT/);
  assert.deepEqual(bridge.writes, []);

  const ok = await server.tools
    .get("projectionlab_update_plan_section")
    .handler({
      planIdentifier: "Retire at 55",
      section: "montecarlo",
      sectionData: { iterations: 100 },
      confirm: true,
    });
  assert.equal(JSON.parse(ok.content[0].text).verified, true);
});

function updateSection(server) {
  return server.tools.get("projectionlab_update_plan_section").handler;
}

test("an event section stored as {} accepts its proper events container", async () => {
  const { server, bridge } = setupWith([
    { id: "p1", name: "Sparse", income: {}, variables: { inflation: 2 } },
  ]);
  const replacement = { events: [{ name: "Salary", amount: 50000 }] };

  const preview = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "income",
    sectionData: replacement,
    confirm: false,
  });
  assert.equal(preview.isError, undefined);
  const dry = JSON.parse(preview.content[0].text);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.diff.added, ["Salary"]);

  const confirmed = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "income",
    sectionData: replacement,
    confirm: true,
  });
  assert.equal(confirmed.isError, undefined);
  assert.equal(JSON.parse(confirmed.content[0].text).verified, true);
  assert.deepEqual(bridge.writes, ["plans"]);
});

test("an event section missing from the plan accepts its events container", async () => {
  const { server, bridge } = setupWith([
    { id: "p1", name: "Sparse", variables: { inflation: 2 } },
  ]);
  const ok = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "income",
    sectionData: { events: [{ name: "Pension" }] },
    confirm: false,
  });
  assert.equal(ok.isError, undefined);

  const bad = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "income",
    sectionData: [],
    confirm: false,
  });
  assert.equal(bad.isError, true);
  assert.match(
    JSON.parse(bad.content[0].text).message,
    /must be an object with an events array/,
  );
  assert.deepEqual(bridge.writes, []);
});

test("a milestones section missing from the plan takes an array only", async () => {
  const { server, bridge } = setupWith([
    { id: "p1", name: "Sparse", variables: { inflation: 2 } },
  ]);
  const ok = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "milestones",
    sectionData: [{ name: "Retire" }],
    confirm: false,
  });
  assert.equal(ok.isError, undefined);

  const bad = await updateSection(server)({
    planIdentifier: "Sparse",
    section: "milestones",
    sectionData: { events: [] },
    confirm: false,
  });
  assert.equal(bad.isError, true);
  assert.match(
    JSON.parse(bad.content[0].text).message,
    /must be an array of events/,
  );
  assert.deepEqual(bridge.writes, []);
});

test("a section stored against the table accepts a replacement in the stored shape", async () => {
  const { server } = setupWith([
    { id: "p1", name: "Odd", milestones: { events: [{ name: "Retire" }] } },
  ]);
  const storedShape = await updateSection(server)({
    planIdentifier: "Odd",
    section: "milestones",
    sectionData: { events: [{ name: "Retire" }, { name: "Medicare" }] },
    confirm: false,
  });
  assert.equal(storedShape.isError, undefined);
  const dry = JSON.parse(storedShape.content[0].text);
  assert.deepEqual(dry.diff.added, ["Medicare"]);

  const confirmed = await updateSection(server)({
    planIdentifier: "Odd",
    section: "milestones",
    sectionData: { events: [{ name: "Retire" }, { name: "Medicare" }] },
    confirm: true,
  });
  assert.equal(confirmed.isError, undefined);
  assert.equal(JSON.parse(confirmed.content[0].text).verified, true);
});
