// The update lookup asks the npm registry once per process for the latest
// published version. Every injected-fetch scenario covers a failure mode
// that must resolve to null; no test touches the network.
//
// Run: node --test test/update-check.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PL_UPDATE_CHECK = "true";
process.env.LOG_LEVEL = "info";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const { fetchLatestVersion, createUpdateCheck } = await import(
  pathToFileURL(join(root, "dist", "updateCheck.js")).href
);
const { VERSION } = await import(pathToFileURL(join(root, "dist", "version.js")).href);

function fakeResponse(body, ok = true) {
  return { ok, json: async () => body };
}

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

test("a healthy lookup reports the latest version and carries no user data", async () => {
  const calls = [];
  const latest = await fetchLatestVersion(async (url, init) => {
    calls.push({ url, init });
    return fakeResponse({ version: "99.0.0" });
  });
  assert.equal(latest, "99.0.0");
  assert.equal(calls[0].url, "https://registry.npmjs.org/projectionlab-mcp/latest");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("every lookup failure resolves to null", async () => {
  assert.equal(await fetchLatestVersion(async () => fakeResponse({}, false)), null);
  assert.equal(await fetchLatestVersion(async () => fakeResponse(null)), null);
  assert.equal(
    await fetchLatestVersion(async () => ({ ok: true, json: async () => ({ version: 7 }) })),
    null,
  );
  assert.equal(
    await fetchLatestVersion(async () => {
      throw new Error("offline");
    }),
    null,
  );
  assert.equal(
    await fetchLatestVersion(async () => fakeResponse({ version: "not-a-version" })),
    null,
  );
  assert.equal(
    await fetchLatestVersion(async () => {
      throw new SyntaxError("bad json");
    }),
    null,
  );
});

test("a hung fetch gives up at the timeout and resolves to null", async () => {
  const started = Date.now();
  const latest = await fetchLatestVersion(
    (url, init) =>
      new Promise((_, reject) => {
        // AbortSignal.timeout does not keep the event loop alive, and a real
        // fetch holds a socket open while it waits. The fake holds a timer
        // for the same reason, released when the abort arrives.
        const pending = setTimeout(() => {}, 10_000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(pending);
          reject(new Error("aborted"));
        });
      }),
    50,
  );
  assert.equal(latest, null);
  assert.ok(Date.now() - started < 2000, "must not wait longer than the timeout plus slack");
});

test("the holder looks up once and remembers the result", async () => {
  const calls = [];
  const check = createUpdateCheck();
  check.start(async () => {
    calls.push(1);
    return fakeResponse({ version: "99.0.0" });
  });
  check.start(async () => {
    calls.push(1);
    return fakeResponse({ version: "99.0.0" });
  });
  await settle();
  assert.equal(calls.length, 1, "one request per process");
  assert.equal(check.latest(), "99.0.0");
});

test("a newer release logs one line naming both versions; same or older logs nothing", async () => {
  const realError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const newer = createUpdateCheck();
    newer.start(async () => fakeResponse({ version: "99.0.0" }));
    await settle();
    assert.equal(
      lines.filter((l) => l.includes("is available")).length,
      1,
      lines.join("\n"),
    );
    assert.match(lines.join("\n"), /99\.0\.0/);
    assert.match(lines.join("\n"), new RegExp(VERSION.replace(/\./g, "\\.")));

    lines.length = 0;
    const same = createUpdateCheck();
    same.start(async () => fakeResponse({ version: VERSION }));
    await settle();
    const olderParts = VERSION.split(".").map(Number);
    olderParts[2] -= 1;
    const older = createUpdateCheck();
    older.start(async () => fakeResponse({ version: olderParts.join(".") }));
    await settle();
    assert.deepEqual(lines.filter((l) => l.includes("is available")), []);
  } finally {
    console.error = realError;
  }
});

test("PL_UPDATE_CHECK=false never calls fetch", async () => {
  const script = `
    process.env.LOG_LEVEL = "error";
    const { createUpdateCheck } = await import(${JSON.stringify(
      pathToFileURL(join(root, "dist", "updateCheck.js")).href,
    )});
    let calls = 0;
    const check = createUpdateCheck();
    check.start(async () => { calls++; return { ok: true, json: async () => ({ version: "99.0.0" }) }; });
    await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify({ calls, latest: check.latest() }));
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        PATH: process.env.PATH,
        HOME: mkdtempSync(join(tmpdir(), "plmcp-upd-home-")),
        PL_UPDATE_CHECK: "false",
      },
      encoding: "utf8",
    },
  );
  const reported = JSON.parse(out.trim().split("\n").pop());
  assert.equal(reported.calls, 0);
  assert.equal(reported.latest, null);
});
