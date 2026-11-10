// versionNotices turns the three version fields into plain sentences:
// each rule fires on its own inputs, stays quiet on unparsable versions,
// and rule 3 yields to rule 1.
//
// Run: node --test test/version-notices.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

const { versionNotices } = await import("../dist/versionNotices.js");

const CURRENT = "1.4.0";

test("nothing to say when everything is current or unknown", () => {
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: `extension/${CURRENT}`, latest: CURRENT }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: null, latest: null }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: `extension/${CURRENT}`, latest: null }),
    [],
  );
});

test("rule 1: npm has a newer server release", () => {
  const notices = versionNotices({ server: CURRENT, executor: null, latest: "1.5.0" });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /server is running version 1\.4\.0/);
  assert.match(notices[0], /1\.5\.0 is available on npm/);
  assert.match(notices[0], /quit and reopen/);
  assert.match(notices[0], /-y projectionlab-mcp@latest/);
});

test("rule 2: the extension lags the server", () => {
  const notices = versionNotices({ server: CURRENT, executor: "extension/1.3.0", latest: CURRENT });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /extension is version 1\.3\.0/);
  assert.match(notices[0], /older than the server \(1\.4\.0\)/);
  assert.match(notices[0], /releases\/latest/);
  assert.match(notices[0], /Settings are kept\./);
});

test("rule 3: the server lags the extension, unless npm is already newer", () => {
  const only = versionNotices({ server: CURRENT, executor: "extension/1.5.0", latest: CURRENT });
  assert.equal(only.length, 1);
  assert.match(only[0], /server is version 1\.4\.0/);
  assert.match(only[0], /older than the browser extension \(1\.5\.0\)/);
  assert.match(only[0], /-y projectionlab-mcp@latest/);

  const withNpmNewer = versionNotices({ server: CURRENT, executor: "extension/1.5.0", latest: "1.6.0" });
  assert.equal(withNpmNewer.length, 1, "rule 1 alone covers the server being behind");
  assert.match(withNpmNewer[0], /available on npm/);
});

test("rule 4: a bootstrap snippet from a different release", () => {
  const notices = versionNotices({ server: CURRENT, executor: "bootstrap/1.3.0", latest: null });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /bootstrap snippet/);
  assert.match(notices[0], /projectionlab_get_bootstrap/);

  const current = versionNotices({ server: CURRENT, executor: `bootstrap/${CURRENT}`, latest: null });
  assert.deepEqual(current, []);
});

test("unparsable versions say nothing", () => {
  assert.deepEqual(
    versionNotices({ server: "v1.0.0", executor: "extension/1.0.0", latest: "2.0.0" }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: "extension/beta", latest: null }),
    [],
  );
  const noSlash = versionNotices({ server: CURRENT, executor: "extension", latest: "2.0.0" });
  // The unparsable executor says nothing; rule 1 still applies.
  assert.equal(noSlash.length, 1);
  assert.match(noSlash[0], /available on npm/);
});
