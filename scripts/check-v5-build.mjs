#!/usr/bin/env node
// Re-checks the enforced ProjectionLab 5 value lists against a saved copy of
// the ProjectionLab web build. Contributor tool: not shipped in the package.
//
//   node scripts/check-v5-build.mjs fetch <dir>
//     Download the build ea.projectionlab.com serves now into <dir>: its
//     service worker, the chunk list the service worker precaches, and every
//     chunk under <dir>/assets.
//
//   node scripts/check-v5-build.mjs check <dir>
//     Compare the build in <dir> with the bindings recorded in
//     scripts/v5-build-bindings.json and the registry in dist/dataModel.js.
//
// The check reports:
// - an app version in the build other than DATA_MODEL_V5_PROJECTIONLAB_VERSION;
// - an enforced list with no recorded binding, or a binding with no enforced list;
// - a recorded binding whose arrays and code values do not add up to the list;
// - a recorded array the build no longer holds, with the build's nearest
//   arrays, which is where a new or removed option shows up;
// - a recorded code value the build no longer contains.
//
// Option arrays are `[{ name: "...", value: "..." }, ...]` literals; the yearly
// fee choices key their options by `type:`. An array is evidence for a field
// only when the app's code binds it to that field (the rule in the saved
// build's README), so a reported change is for a person to trace in the build
// before the registry or the bindings change.
//
// Requires a built dist/ (npm run build). Exits 1 when anything is reported,
// 0 when the build matches.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://ea.projectionlab.com";

async function fetchBuild(dir) {
  const assets = join(dir, "assets");
  mkdirSync(assets, { recursive: true });
  const swResponse = await fetch(`${ORIGIN}/service-worker.js`);
  if (!swResponse.ok) throw new Error(`service-worker.js: HTTP ${swResponse.status}`);
  const sw = await swResponse.text();
  writeFileSync(join(dir, "service-worker.js"), sw);
  writeFileSync(
    join(dir, "headers.txt"),
    [...swResponse.headers].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n",
  );
  const urls = [...new Set([...sw.matchAll(/"url":"([^"]+\.js)"/g)].map((m) => m[1]))].sort();
  writeFileSync(join(dir, "js_urls.txt"), urls.join("\n") + "\n");
  let next = 0;
  let failed = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      const response = await fetch(new URL(url, `${ORIGIN}/`));
      if (!response.ok) {
        failed++;
        console.error(`${url}: HTTP ${response.status}`);
        continue;
      }
      writeFileSync(join(assets, basename(url)), await response.text());
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  console.log(`Fetched ${urls.length - failed} of ${urls.length} chunks into ${assets}`);
  if (failed) process.exitCode = 1;
}

function readChunks(dir) {
  const assets = join(dir, "assets");
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => readFileSync(join(assets, name), "utf8"));
}

// The app's own version: the constant the export-schema table is keyed by,
// `var x="5.0.0",y={currentFinances:4,...}` in the 5.0.0 build.
function buildVersion(chunks) {
  for (const source of chunks) {
    const match = source.match(/="(\d+\.\d+\.\d+)",\w+=\{currentFinances:/);
    if (match) return match[1];
  }
  return null;
}

// The array literal enclosing position `at`, or null.
function enclosingArray(source, at) {
  let depth = 0;
  let start = -1;
  for (let j = at; j >= Math.max(0, at - 20000); j--) {
    const c = source[j];
    if (c === "]" || c === "}" || c === ")") depth++;
    else if (c === "{" || c === "(") {
      if (depth === 0) continue;
      depth--;
    } else if (c === "[") {
      if (depth === 0) {
        start = j;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  let d = 0;
  for (let j = start; j < Math.min(source.length, start + 40000); j++) {
    const c = source[j];
    if (c === "[" || c === "{" || c === "(") d++;
    else if (c === "]" || c === "}" || c === ")") {
      d--;
      if (d === 0) return source.slice(start, j + 1);
    }
  }
  return null;
}

// Every option array in the build holding one of `values`.
function optionArrays(chunks, values) {
  const found = new Map();
  for (const source of chunks) {
    for (const value of values) {
      for (const key of ["value", "type"]) {
        const needle = `${key}:${JSON.stringify(value)}`;
        let i = -1;
        while ((i = source.indexOf(needle, i + 1)) !== -1) {
          const literal = enclosingArray(source, i);
          if (!literal || !literal.startsWith("[{")) continue;
          const options = [
            ...literal.matchAll(new RegExp(`(?:^|[{,])${key}:"([^"]*)"`, "g")),
          ].map((m) => m[1]);
          if (options.length < 2) continue;
          found.set(`${key}:${options.join("|")}`, options);
        }
      }
    }
  }
  return [...found.values()];
}

const sameSet = (a, b) =>
  new Set(a).size === new Set(b).size && a.every((v) => b.includes(v));

function overlap(a, b) {
  const shared = new Set(a.filter((v) => b.includes(v))).size;
  return shared / new Set([...a, ...b]).size;
}

async function enforcedLists() {
  let dataModel;
  try {
    dataModel = await import(new URL("../dist/dataModel.js", import.meta.url));
  } catch {
    throw new Error("dist/dataModel.js is missing: run npm run build first");
  }
  const lists = new Map();
  for (const group of dataModel.getDataModelGroups("v5")) {
    for (const [path, field] of Object.entries(group.fields)) {
      if (field.evidence === "observed" && field.allowedValues?.length) {
        lists.set(`${group.scope}.${path}`, field.allowedValues);
      }
    }
  }
  return { version: dataModel.DATA_MODEL_V5_PROJECTIONLAB_VERSION, lists };
}

const show = (values) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

async function check(dir) {
  const { version, lists } = await enforcedLists();
  const bindingsFile = fileURLToPath(new URL("./v5-build-bindings.json", import.meta.url));
  const { projectionLabVersion, bindings } = JSON.parse(readFileSync(bindingsFile, "utf8"));
  const chunks = readChunks(dir);
  const found = buildVersion(chunks);
  const problems = [];

  if (found !== version) {
    problems.push(`app version in the build is ${found ?? "not found"}; the registry records ${version}`);
  }
  if (projectionLabVersion !== version) {
    problems.push(`v5-build-bindings.json records ${projectionLabVersion}; the registry records ${version}`);
  }
  for (const name of Object.keys(bindings)) {
    if (!lists.has(name)) problems.push(`${name}: recorded binding, but no enforced list`);
  }
  for (const [name, values] of lists) {
    const binding = bindings[name];
    if (!binding) {
      problems.push(`${name} ${show(values)}: enforced, but no binding is recorded`);
      continue;
    }
    const codeValues = binding.codeValues ?? [];
    const recorded = [...binding.arrays.flat(), ...codeValues];
    if (!sameSet([...new Set(recorded)], [...values])) {
      problems.push(`${name}: the list is ${show(values)}, the binding adds up to ${show([...new Set(recorded)])}`);
    }
    const arrays = optionArrays(chunks, values);
    for (const expected of binding.arrays) {
      if (arrays.some((options) => sameSet(options, expected))) continue;
      const nearest = arrays
        .map((options) => ({ options, score: overlap(options, expected) }))
        .filter(({ score }) => score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ options }) => show(options));
      problems.push(
        `${name}: the build no longer holds ${show(expected)}` +
          (nearest.length ? `; nearest: ${nearest.join(" ")}` : "; no similar array"),
      );
    }
    for (const value of codeValues) {
      if (!chunks.some((source) => source.includes(JSON.stringify(value)))) {
        problems.push(`${name}: the build no longer contains ${JSON.stringify(value)}`);
      }
    }
  }

  console.log(`Build: ${dir}`);
  console.log(`App version: ${found ?? "not found"}; ${lists.size} enforced lists checked`);
  if (problems.length === 0) {
    console.log("Every enforced list matches the build.");
    return;
  }
  for (const problem of problems) console.log(`- ${problem}`);
  process.exitCode = 1;
}

const [command, dir, ...rest] = process.argv.slice(2);
try {
  if (command === "fetch" && dir) await fetchBuild(dir);
  else if (command === "check" && dir && rest.length === 0) await check(dir);
  else {
    console.error(
      "usage: check-v5-build.mjs fetch <dir> | check <dir>",
    );
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
