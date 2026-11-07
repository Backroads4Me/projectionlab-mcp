// Config precedence and defaults. Each case loads dist/config.js in a fresh
// Node process with an isolated HOME, so the per-user env file is controlled.
//
// Run: npm run build && node --test test/config.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const configUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "config.js"),
).href;

/** Returns { apiKey, readOnly, wsPort } as seen by a fresh process. */
function loadConfig({ env = {}, userEnvFile } = {}) {
  const home = mkdtempSync(join(tmpdir(), "plmcp-home-"));
  if (userEnvFile !== undefined) {
    mkdirSync(join(home, ".projectionlab-mcp"));
    writeFileSync(join(home, ".projectionlab-mcp", ".env"), userEnvFile);
  }
  const childEnv = { PATH: process.env.PATH, HOME: home, ...env };
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { config } = await import(${JSON.stringify(configUrl)});
       console.log(JSON.stringify({ apiKey: config.apiKey ?? null, readOnly: config.readOnly, wsPort: config.wsPort }));`,
    ],
    { env: childEnv, encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

test("the per-user env file supplies settings", () => {
  const c = loadConfig({ userEnvFile: "PL_API_KEY=user-key\nPL_READ_ONLY=false\nPL_WS_PORT=9100\n" });
  assert.equal(c.apiKey, "user-key");
  assert.equal(c.readOnly, false);
  assert.equal(c.wsPort, 9100);
});

test("the host env block takes precedence over the per-user env file", () => {
  const c = loadConfig({
    env: { PL_API_KEY: "host-key", PL_READ_ONLY: "true" },
    userEnvFile: "PL_API_KEY=user-key\nPL_READ_ONLY=false\n",
  });
  assert.equal(c.apiKey, "host-key");
  assert.equal(c.readOnly, true);
});

test("a missing key leaves apiKey unset instead of failing startup", () => {
  const c = loadConfig({ env: { PL_API_KEY: "" } });
  assert.equal(c.apiKey, null);
});

test("writes stay disabled unless PL_READ_ONLY is exactly false", () => {
  for (const value of ["", "true", "yes", "0", " TRUE "]) {
    assert.equal(loadConfig({ env: { PL_READ_ONLY: value } }).readOnly, true, `PL_READ_ONLY=${JSON.stringify(value)}`);
  }
  for (const value of ["false", "FALSE", " false "]) {
    assert.equal(loadConfig({ env: { PL_READ_ONLY: value } }).readOnly, false, `PL_READ_ONLY=${JSON.stringify(value)}`);
  }
});
