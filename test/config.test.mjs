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

/** Returns { apiKey, readOnly, wsPort, logLevel, appUrl } as seen by a fresh process. */
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
       console.log(JSON.stringify({ apiKey: config.apiKey ?? null, readOnly: config.readOnly, wsPort: config.wsPort, logLevel: config.logLevel, appUrl: config.appUrl }));`,
    ],
    { env: childEnv, encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

/** The stderr text when a fresh process refuses to start with these env vars. */
function startupError(env) {
  try {
    loadConfig({ env });
  } catch (err) {
    return String(err.stderr ?? err);
  }
  throw new Error(`expected startup to fail with ${JSON.stringify(env)}`);
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

test("PL_WS_PORT must be all digits and within 1 to 65535", () => {
  assert.equal(loadConfig({ env: { PL_WS_PORT: "9100" } }).wsPort, 9100);
  assert.equal(loadConfig({ env: { PL_WS_PORT: " 80 " } }).wsPort, 80);
  for (const bad of ["8788abc", "0", "65536", "-1", "eighty", "8.5", " "]) {
    assert.match(
      startupError({ PL_WS_PORT: bad }),
      /PL_WS_PORT/,
      `PL_WS_PORT=${JSON.stringify(bad)} must fail startup`,
    );
  }
});

test("LOG_LEVEL falls back to info unless it is one of the four levels", () => {
  assert.equal(loadConfig({}).logLevel, "info");
  for (const level of ["error", "warn", "info", "debug"]) {
    assert.equal(loadConfig({ env: { LOG_LEVEL: level } }).logLevel, level);
  }
  assert.equal(loadConfig({ env: { LOG_LEVEL: "verbose" } }).logLevel, "info");
  assert.equal(loadConfig({ env: { LOG_LEVEL: "DEBUG" } }).logLevel, "info");
});

test("PL_APP_URL must parse as a URL", () => {
  assert.equal(
    loadConfig({ env: { PL_APP_URL: "https://pl.example:8443/app" } }).appUrl,
    "https://pl.example:8443/app",
  );
  assert.equal(loadConfig({}).appUrl, "https://app.projectionlab.com");
  assert.match(startupError({ PL_APP_URL: "app.projectionlab.com" }), /PL_APP_URL/);
  assert.match(startupError({ PL_APP_URL: "not a url" }), /PL_APP_URL/);
});
