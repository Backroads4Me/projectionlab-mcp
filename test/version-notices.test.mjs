// versionNotices turns the three version fields into plain sentences: each
// rule fires on its own inputs and stays quiet on unparsable versions.
// The server and extension versions are decoupled: the extension says nothing
// as long as it meets or exceeds MIN_EXTENSION_VERSION.
//
// Run: node --test test/version-notices.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

const { versionNotices } = await import("../dist/versionNotices.js");
const { MIN_EXTENSION_VERSION } = await import("../dist/types/wire.js");

const CURRENT = "1.4.0";

test("nothing to say when everything is current or unknown", () => {
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: `extension/${MIN_EXTENSION_VERSION}`, latest: CURRENT }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: null, latest: null }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: `extension/${MIN_EXTENSION_VERSION}`, latest: null }),
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

test("an extension at or above MIN_EXTENSION_VERSION says nothing", () => {
  // Same as MIN
  assert.deepEqual(
    versionNotices({ server: CURRENT, executor: `extension/${MIN_EXTENSION_VERSION}`, latest: CURRENT }),
    [],
  );
  // Higher than MIN, even if server is higher or lower
  assert.deepEqual(
    versionNotices({ server: "2.0.0", executor: "extension/1.2.1", latest: "2.0.0" }),
    [],
  );
  assert.deepEqual(
    versionNotices({ server: "1.1.0", executor: "extension/1.2.1", latest: "1.1.0" }),
    [],
  );
});

test("rule 2: extension older than MIN_EXTENSION_VERSION emits update notice", () => {
  const notices = versionNotices({ server: CURRENT, executor: "extension/1.0.1", latest: CURRENT });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /extension is version 1\.0\.1/);
  assert.match(notices[0], new RegExp(`older than the minimum required version \\(${MIN_EXTENSION_VERSION}\\)`));
  assert.match(notices[0], /Chrome Web Store/);
  assert.match(notices[0], /Firefox Add-ons/);
  assert.match(notices[0], /check for updates/);
  assert.match(notices[0], /ws-token/);
});

test("npm newer and extension older both speak", () => {
  const notices = versionNotices({ server: CURRENT, executor: "extension/1.0.1", latest: "1.5.0" });
  assert.equal(notices.length, 2);
  assert.match(notices[0], /available on npm/);
  assert.match(notices[1], /older than the minimum required version/);
});

test("rule 3: a bootstrap snippet from a different release", () => {
  const notices = versionNotices({ server: CURRENT, executor: "bootstrap/1.3.0", latest: null });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /bootstrap snippet/);
  assert.match(notices[0], /projectionlab_get_bootstrap/);

  const current = versionNotices({ server: CURRENT, executor: `bootstrap/${CURRENT}`, latest: null });
  assert.deepEqual(current, []);
});

test("unparsable versions say nothing", () => {
  assert.deepEqual(
    versionNotices({ server: "v1.0.0", executor: `extension/${MIN_EXTENSION_VERSION}`, latest: "2.0.0" }),
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
