// Snapshots keep the Plugin API key out of the files on disk as
// [[PL_API_KEY]] and put the configured key back on read, so a rollback
// restores the exact exported state. Reads that cannot restore the key, and
// pre-placeholder snapshots holding [REDACTED] in settings, are refused.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY = "pl-key-9f3a-test";
const HOME = mkdtempSync(join(tmpdir(), "plmcp-key-home-"));
const SNAPSHOT_DIR = join(HOME, "snapshots");

process.env.HOME = HOME;
process.env.PL_API_KEY = KEY;
process.env.PL_READ_ONLY = "false";
process.env.PL_SNAPSHOT_DIR = SNAPSHOT_DIR;
process.env.LOG_LEVEL = "error";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { registerSnapshotTools } = await import(
  pathToFileURL(join(root, "dist", "tools", "snapshots.js")).href
);
const { registerDiffTool } = await import(
  pathToFileURL(join(root, "dist", "tools", "diff.js")).href
);
const { SnapshotManager } = await import(
  pathToFileURL(join(root, "dist", "snapshot.js")).href
);

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

function fakeBridge(initial) {
  const state = structuredClone(initial);
  const bridge = {
    state,
    writes: [],
    payloads: [],
    async exportData() {
      return structuredClone(state);
    },
    async restoreSettings(settings) {
      bridge.writes.push("settings");
      bridge.payloads.push(structuredClone(settings));
      state.settings = structuredClone(settings);
    },
  };
  return bridge;
}

function exportedSettings() {
  return { plugin: { note: `the key is ${KEY}`, theme: "dark" } };
}

/** A snapshot of settings whose exported data embeds the API key. */
async function keySnapshot(bridge) {
  const snapshots = new SnapshotManager();
  const snapshot = await snapshots.create("restoreSettings", ["settings"], {
    settings: structuredClone(bridge.state.settings),
  });
  return { snapshots, snapshot };
}

test("the snapshot file holds the placeholder, never the key", async () => {
  const bridge = fakeBridge({ settings: exportedSettings() });
  const { snapshot } = await keySnapshot(bridge);
  const raw = readFileSync(join(SNAPSHOT_DIR, `${snapshot.id}.json`), "utf-8");
  assert.ok(!raw.includes(KEY), "snapshot file must not contain the key");
  assert.match(raw, /\[\[PL_API_KEY\]\]/);
});

test("rollback restores the real key and verifies", async () => {
  const bridge = fakeBridge({ settings: exportedSettings() });
  const { snapshots, snapshot } = await keySnapshot(bridge);
  // The live settings lose the key value before the rollback.
  bridge.state.settings.plugin.note = "wiped";

  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  const result = await server.tools
    .get("projectionlab_rollback")
    .handler({ snapshotId: snapshot.id, confirm: true });
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.verified, true);
  assert.equal(bridge.state.settings.plugin.note, `the key is ${KEY}`);
  // What the executor received carried the real key, not the placeholder.
  assert.ok(JSON.stringify(bridge.payloads.at(-1)).includes(KEY));
  assert.ok(!JSON.stringify(bridge.payloads.at(-1)).includes("[[PL_API_KEY]]"));
});

test("diffing a snapshot against unchanged live data reports no change", async () => {
  const bridge = fakeBridge({ settings: exportedSettings(), plans: [] });
  const { snapshots, snapshot } = await keySnapshot(bridge);

  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  const result = await server.tools
    .get("projectionlab_diff")
    .handler({ from: { snapshotId: snapshot.id } });
  assert.equal(result.isError, undefined);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.changed, false);
});

test("diff still reports a settings value that really changed", async () => {
  const bridge = fakeBridge({ settings: exportedSettings(), plans: [] });
  const { snapshots, snapshot } = await keySnapshot(bridge);
  bridge.state.settings.plugin.theme = "light";

  const server = fakeServer();
  registerDiffTool(server, bridge, snapshots);
  const output = JSON.parse(
    (await server.tools
      .get("projectionlab_diff")
      .handler({ from: { snapshotId: snapshot.id } })).content[0].text,
  );
  assert.equal(output.changed, true);
});

test("rollback refuses a placeholder snapshot when PL_API_KEY is unset", async () => {
  const bridge = fakeBridge({ settings: exportedSettings() });
  const { snapshot } = await keySnapshot(bridge);

  // config.apiKey freezes at import, so the missing-key case runs in a child.
  const childEnv = {
    PATH: process.env.PATH,
    HOME: mkdtempSync(join(tmpdir(), "plmcp-keyless-home-")),
    PL_API_KEY: "",
    PL_READ_ONLY: "false",
    PL_SNAPSHOT_DIR: SNAPSHOT_DIR,
    LOG_LEVEL: "error",
  };
  const script = `
    const { registerSnapshotTools } = await import(${JSON.stringify(pathToFileURL(join(root, "dist", "tools", "snapshots.js")).href)});
    const { SnapshotManager } = await import(${JSON.stringify(pathToFileURL(join(root, "dist", "snapshot.js")).href)});
    const state = { settings: {}, plans: [], today: {} };
    const writes = [];
    const bridge = {
      async exportData() { return structuredClone(state); },
      async restoreSettings(s) { writes.push(s); state.settings = s; },
    };
    const tools = new Map();
    registerSnapshotTools({ registerTool: (n, d, h) => tools.set(n, { definition: d, handler: h }) }, bridge, new SnapshotManager());
    const result = await tools.get("projectionlab_rollback").handler({ snapshotId: ${JSON.stringify(snapshot.id)}, confirm: true });
    console.log(JSON.stringify({ isError: result.isError === true, payload: JSON.parse(result.content[0].text), writes: writes.length }));
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: childEnv, encoding: "utf8" },
  );
  const reported = JSON.parse(out.trim().split("\n").pop());
  assert.equal(reported.isError, true);
  assert.equal(reported.payload.error, "API_KEY_MISSING");
  assert.equal(reported.writes, 0);
});

test("rollback refuses a pre-placeholder snapshot with [REDACTED] in settings", async () => {
  const bridge = fakeBridge({ settings: exportedSettings() });
  const snapshots = new SnapshotManager();
  // A snapshot written by 1.1.0 or earlier: value-only redaction stored the
  // sentinel where the key was.
  const legacy = await snapshots.create("restoreSettings", ["settings"], {
    settings: { plugin: { apiKey: "[REDACTED]" } },
  });

  const server = fakeServer();
  registerSnapshotTools(server, bridge, snapshots);
  const result = await server.tools
    .get("projectionlab_rollback")
    .handler({ snapshotId: legacy.id, confirm: true });
  assert.equal(result.isError, true);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.error, "INVALID_INPUT");
  assert.match(output.message, /\[REDACTED\]/);
  assert.deepEqual(bridge.writes, []);
});
