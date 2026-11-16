// scripts/check-v5-build.mjs against synthetic builds: a build holding every
// recorded binding passes, and a changed option array, a missing code value,
// or another app version is reported with exit code 1.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/check-v5-build.mjs", import.meta.url).pathname;
const { bindings } = JSON.parse(
  readFileSync(new URL("../scripts/v5-build-bindings.json", import.meta.url), "utf8"),
);

const literal = (values) =>
  `[${values.map((v) => `{name:${JSON.stringify(v)},value:${JSON.stringify(v)}}`).join(",")}]`;

function build({ version = "5.0.0", edit = (arrays) => arrays, codeValues = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plmcp-build-"));
  mkdirSync(join(dir, "assets"));
  const arrays = edit(Object.values(bindings).flatMap((b) => b.arrays));
  const code = codeValues
    ? Object.values(bindings).flatMap((b) => (b.codeValues ?? []).map((v) => JSON.stringify(v)))
    : [];
  const source =
    `var a="${version}",b={currentFinances:4,plan:4,settings:4};` +
    arrays.map((values, i) => `const o${i}=${literal(values)};`).join("") +
    `const extra=[${code.join(",")}];`;
  writeFileSync(join(dir, "assets", "chunk.js"), source);
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [SCRIPT, "check", dir], { encoding: "utf8" });
}

test("a build holding every recorded binding passes", () => {
  const result = run(build());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Every enforced list matches the build/);
});

test("an option the build adds to a bound array is reported", () => {
  const result = run(
    build({
      edit: (arrays) =>
        arrays.map((values) =>
          values.includes("compound") ? [...values, "continuous"] : values,
        ),
    }),
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /assets\.interestType: the build no longer holds \["simple", "compound"\]; nearest: \["simple", "compound", "continuous"\]/,
  );
});

test("a code value the build no longer contains is reported", () => {
  const result = run(build({ codeValues: false }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /priorities\.desiredContribution: the build no longer contains "%-balance"/);
});

test("a build of another ProjectionLab version is reported", () => {
  const result = run(build({ version: "5.1.0" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /app version in the build is 5\.1\.0; the registry records 5\.0\.0/);
});
