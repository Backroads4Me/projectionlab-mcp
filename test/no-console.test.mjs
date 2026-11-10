// The logger scrubs the Plugin API key from every line it writes. That holds
// only if nothing else writes to the process streams directly: the one
// permitted call outside the logger is the fatal handler in index.ts, and it
// scrubs the text itself. bootstrap.ts is exempt because its console.log
// calls are inside the browser-side snippet string, not server code.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_ENTRY = join(ROOT, "dist", "index.js");

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("only the logger and the fatal handler write to the console", () => {
  const exempt = new Set([join(ROOT, "src", "logger.ts"), join(ROOT, "src", "bootstrap.ts")]);
  const hits = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    if (exempt.has(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/console\.(log|error|warn|info|debug)\s*\(/.test(line)) {
        hits.push(`${file.replace(ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.equal(hits.length, 1, `expected exactly one console call outside logger.ts/bootstrap.ts, found:\n${hits.join("\n")}`);
  assert.match(hits[0], /^src\/index\.ts:\d+: console\.error\("Fatal error:", redactSecrets\(text\)\);$/);
});

test("a fatal startup failure prints the redacted stack and exits 1", async () => {
  // An unreadable HOME makes the token file creation throw inside main(),
  // which is the path the fatal handler exists for.
  const badHome = mkdtempSync(join(tmpdir(), "plmcp-fatal-home-"));
  chmodSync(badHome, 0o500); // readable, not writable: mkdir under it throws
  try {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        PATH: process.env.PATH,
        HOME: badHome,
        PL_API_KEY: "test-api-key",
        PL_UPDATE_CHECK: "false",
        LOG_LEVEL: "error",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    let stderrText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrText += chunk;
    });
    const exitCode = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not exit")), 15000);
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    child.stdin.end();
    assert.equal(exitCode, 1);
    assert.match(stderrText, /Fatal error:/);
    assert.match(stderrText, /Error/, "the error text (stack or message) is printed");
  } finally {
    chmodSync(badHome, 0o700);
  }
});
