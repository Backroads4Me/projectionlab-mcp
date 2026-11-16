// Settings writes on a ProjectionLab 5 account (Plugin API contract 2). The
// fake bridge applies restoreSettings the way ProjectionLab 5 does: the
// submission replaces the whole settings document, and the app re-stamps the
// document's `lastUpdated`. Reads hide the Plugin API key in settings as
// [REDACTED]; restore_settings writes the stored key back in its place.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5Export } from "./fixtures/v5-export.mjs";

process.env.PL_API_KEY = "test-api-key";
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-v5-settings-writes-")), "snapshots");
process.env.LOG_LEVEL = "error";

const { registerRestoreTools } = await import("../dist/tools/restore.js");
const { registerSnapshotTools } = await import("../dist/tools/snapshots.js");

/** A v5 export whose settings carry a `lastUpdated` stamp, as live ones do. */
function stampedExport() {
  const state = v5Export();
  state.documents.settings.lastUpdated = 1_700_000_000_000;
  return state;
}

/** A ProjectionLab 5 bridge that applies settings writes to its export. */
function v5Bridge(state = stampedExport()) {
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
    async restoreSettings(submitted, layout) {
      writes.push({ name: "restoreSettings", submitted: structuredClone(submitted), layout });
      const next = structuredClone(submitted);
      next.lastUpdated = (state.documents.settings.lastUpdated ?? 0) + 1;
      state.documents.settings = next;
    },
    updateAccount: refuse("updateAccount"),
    restoreCurrentFinances: refuse("restoreCurrentFinances"),
    restorePlans: refuse("restorePlans"),
    restorePlansIfUnchanged: refuse("restorePlansIfUnchanged"),
    restoreProgress: refuse("restoreProgress"),
  };
}

/** A snapshot store that serves back what it saved, newest first. */
function snapshotStore() {
  const created = [];
  return {
    created,
    async create(operation, sections, data, layout) {
      const snapshot = {
        id: `snap-${created.length + 1}`,
        timestamp: new Date(created.length).toISOString(),
        operation,
        sections,
        layout,
        data: structuredClone(data),
      };
      created.push(snapshot);
      return snapshot;
    },
    async get(id) {
      const found = created.find((s) => s.id === id);
      if (!found) throw new Error(`no snapshot ${id}`);
      return structuredClone(found);
    },
    async list() {
      return created.map((s) => structuredClone(s)).reverse();
    },
  };
}

function tools(bridge, snapshots) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
  };
  registerRestoreTools(server, bridge, snapshots);
  registerSnapshotTools(server, bridge, snapshots);
  return async (name, input) => JSON.parse((await map.get(name)(input)).content[0].text);
}

const STORED_KEY = v5Export().documents.settings.plugins.apiKey;

/** The settings document as a read returns it, Plugin API key hidden, with one change. */
function changedSettings() {
  const settings = stampedExport().documents.settings;
  settings.plugins.apiKey = "[REDACTED]";
  settings.plan.alignment = { type: "rolling" };
  return settings;
}

test("restore_settings on v5 previews, then replaces the settings and verifies despite the re-stamp", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const settings = changedSettings();

  const dry = await call("projectionlab_restore_settings", { settings });
  assert.equal(dry.dryRun, true, JSON.stringify(dry));
  assert.deepEqual(dry.topLevelKeys, Object.keys(settings));
  assert.deepEqual(dry.keptSecrets, ["plugins.apiKey"]);
  assert.doesNotMatch(JSON.stringify(dry), new RegExp(STORED_KEY));
  assert.deepEqual(bridge.writes, []);
  assert.deepEqual(snapshots.created, []);

  const done = await call("projectionlab_restore_settings", { settings, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(done.keptSecrets, ["plugins.apiKey"]);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(STORED_KEY));

  assert.equal(snapshots.created.length, 1);
  assert.equal(snapshots.created[0].layout, "v5");
  assert.deepEqual(snapshots.created[0].sections, ["settings"]);
  assert.deepEqual(snapshots.created[0].data.settings, stampedExport().documents.settings);

  const written = structuredClone(settings);
  written.plugins.apiKey = STORED_KEY;
  assert.deepEqual(bridge.writes, [{ name: "restoreSettings", submitted: written, layout: "v5" }]);
  assert.equal(bridge.state.documents.settings.plugins.apiKey, STORED_KEY);
  assert.deepEqual(bridge.state.documents.settings.plan.alignment, { type: "rolling" });
  assert.notEqual(bridge.state.documents.settings.lastUpdated, settings.lastUpdated);
});

test("restore_settings on v5 reports a settings change that did not land as unverified", async () => {
  const bridge = v5Bridge();
  bridge.restoreSettings = async (submitted, layout) => {
    bridge.writes.push({ name: "restoreSettings", submitted: structuredClone(submitted), layout });
  };
  const call = tools(bridge, snapshotStore());
  const done = await call("projectionlab_restore_settings", { settings: changedSettings(), confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, false, JSON.stringify(done));
});

test("rollback undoes a v5 settings change exactly", async () => {
  const bridge = v5Bridge();
  const snapshots = snapshotStore();
  const call = tools(bridge, snapshots);
  const changed = await call("projectionlab_restore_settings", { settings: changedSettings(), confirm: true });
  assert.equal(changed.verified, true, JSON.stringify(changed));
  const snapshotId = snapshots.created[0].id;

  const preview = await call("projectionlab_rollback", { snapshotId });
  assert.equal(preview.dryRun, true, JSON.stringify(preview));
  assert.deepEqual(preview.sections, ["settings"]);

  const done = await call("projectionlab_rollback", { snapshotId, confirm: true });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.deepEqual(done.restoredSections, ["settings"]);
  assert.equal(bridge.writes.at(-1).name, "restoreSettings");
  assert.equal(bridge.writes.at(-1).layout, "v5");
  const { lastUpdated: _restamped, ...restored } = bridge.state.documents.settings;
  const { lastUpdated: _original, ...original } = stampedExport().documents.settings;
  assert.deepEqual(restored, original);
});

for (const [label, drop] of [
  ["the Plugin API key", (settings) => delete settings.plugins.apiKey],
  ["the whole plugins object", (settings) => delete settings.plugins],
]) {
  for (const confirm of [false, true]) {
    test(`restore_settings refuses a payload that leaves out ${label} (confirm: ${confirm})`, async () => {
      const bridge = v5Bridge();
      const snapshots = snapshotStore();
      const call = tools(bridge, snapshots);
      const settings = changedSettings();
      drop(settings);
      const result = await call("projectionlab_restore_settings", { settings, confirm });
      assert.equal(result.error, "INVALID_INPUT", JSON.stringify(result));
      assert.match(result.message, /plugins\.apiKey/);
      assert.match(result.suggestion, /Nothing was written/);
      assert.deepEqual(bridge.writes, []);
      assert.deepEqual(snapshots.created, []);
    });
  }
}

test("restore_settings refuses a hidden secret with no stored value to keep", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const settings = changedSettings();
  settings.plugins.token = "[REDACTED]";
  const result = await call("projectionlab_restore_settings", { settings, confirm: true });
  assert.equal(result.error, "INVALID_INPUT", JSON.stringify(result));
  assert.match(result.message, /plugins\.token/);
  assert.deepEqual(bridge.writes, []);
});

test("restore_settings writes a secret the caller supplies as given", async () => {
  const bridge = v5Bridge();
  const call = tools(bridge, snapshotStore());
  const settings = changedSettings();
  settings.plugins.apiKey = "replacement-plugin-key";
  const done = await call("projectionlab_restore_settings", { settings, confirm: true });
  assert.equal(done.verified, true, JSON.stringify(done));
  assert.equal(done.keptSecrets, undefined);
  assert.equal(bridge.state.documents.settings.plugins.apiKey, "replacement-plugin-key");
});
