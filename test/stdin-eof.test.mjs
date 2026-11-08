// When the MCP host closes stdin (a crashed or exited host), the server must
// exit and release the WebSocket port instead of lingering as an orphan that
// holds the port and keeps answering extension heartbeats. Port takeover by a
// second instance is covered by port-takeover.test.mjs; this covers the exit.
//
// Run: npm run build && node --test test/stdin-eof.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./helpers/free-port.mjs";

const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function canBind(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("server exits when the host closes stdin, releasing the WebSocket port", async () => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "plmcp-eof-home-"));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      PATH: process.env.PATH,
      HOME: home, // isolates ~/.projectionlab-mcp; nothing here reads the real one
      PL_API_KEY: "", // present but empty so dotenv files cannot fill it
      PL_WS_PORT: String(port),
      PL_WS_TOKEN: "eof-token",
      PL_SNAPSHOT_DIR: join(home, "snapshots"),
      LOG_LEVEL: "info",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.resume(); // stdout is the MCP channel; just drain it
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  try {
    // The listening log line proves the child holds the port without racing
    // our own bind probes against its startup.
    const listening = await waitFor(
      () => stderrText.includes(`Listening on ws://127.0.0.1:${port}`),
      10_000,
    );
    assert.ok(listening, `server never bound port ${port}; stderr:\n${stderrText}`);

    child.stdin.end(); // the host is gone

    const exited = await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      5_000,
    );
    assert.ok(
      exited,
      `server still running 5s after stdin EOF; stderr:\n${stderrText}`,
    );
    assert.equal(child.exitCode, 0, `unexpected exit code; stderr:\n${stderrText}`);

    const released = await waitFor(() => canBind(port), 5_000);
    assert.ok(released, `port ${port} still bound after the server exited`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
