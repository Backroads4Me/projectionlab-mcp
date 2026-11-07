// The generated WebSocket token lives at ~/.projectionlab-mcp/ws-token
// regardless of PL_SNAPSHOT_DIR, and is kept owner-only.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "plmcp-token-home-"));
process.env.HOME = home;
process.env.PL_API_KEY = "test-api-key";
process.env.PL_WS_PORT = "18791";
delete process.env.PL_WS_TOKEN;
process.env.PL_SNAPSHOT_DIR = join(mkdtempSync(join(tmpdir(), "plmcp-elsewhere-")), "snaps");
process.env.LOG_LEVEL = "error";

const { ExtensionBridge } = await import("../dist/extensionBridge.js");

const dir = join(home, ".projectionlab-mcp");
const file = join(dir, "ws-token");
const mode = (p) => statSync(p).mode & 0o777;

test("token is created owner-only under the user config folder", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes only");
  const bridge = new ExtensionBridge();
  try {
    assert.match(readFileSync(file, "utf8").trim(), /^[A-Za-z0-9_-]{32}$/);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(file), 0o600);
  } finally {
    await bridge.close();
  }
});

test("an existing loose token keeps its value and is tightened", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes only");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "existing-token\n", { mode: 0o644 });
  const bridge = new ExtensionBridge();
  try {
    assert.equal(readFileSync(file, "utf8").trim(), "existing-token");
    assert.equal(mode(file), 0o600);
  } finally {
    await bridge.close();
  }
});
