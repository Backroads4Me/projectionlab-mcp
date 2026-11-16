// waitForTabLoad: a tab the extension opens is used only once its page has
// loaded, never while it still shows the initial about:blank document.
import assert from "node:assert/strict";
import test from "node:test";
import { waitForTabLoad } from "../src/wire.js";

/** A browser.tabs stand-in whose events the test fires by hand. */
function fakeTabs(initial = { status: "loading", url: "about:blank" }) {
  const event = () => {
    const listeners = new Set();
    return {
      listeners,
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
    };
  };
  return { onUpdated: event(), onRemoved: event(), get: async () => initial };
}

const settled = (promise) => Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 20))]);

test("resolves when the tab completes loading its page", async () => {
  const tabs = fakeTabs();
  const wait = waitForTabLoad(tabs, 7, 1_000);
  tabs.onUpdated.fire(7, { status: "complete" }, { id: 7, status: "complete", url: "https://app.projectionlab.com/" });
  assert.equal(await settled(wait), "resolved");
  assert.equal(tabs.onUpdated.listeners.size, 0);
  assert.equal(tabs.onRemoved.listeners.size, 0);
});

test("ignores other tabs, loading updates, and a complete about:blank", async () => {
  const tabs = fakeTabs();
  const wait = waitForTabLoad(tabs, 7, 1_000);
  tabs.onUpdated.fire(8, { status: "complete" }, { id: 8, status: "complete", url: "https://app.projectionlab.com/" });
  tabs.onUpdated.fire(7, { status: "loading" }, { id: 7, status: "loading", url: "https://app.projectionlab.com/" });
  tabs.onUpdated.fire(7, { status: "complete" }, { id: 7, status: "complete", url: "about:blank" });
  assert.equal(await settled(wait), "pending");
  tabs.onRemoved.fire(7);
  await assert.rejects(wait);
});

test("a complete tab whose URL is hidden counts as loaded", async () => {
  const tabs = fakeTabs();
  const wait = waitForTabLoad(tabs, 7, 1_000);
  tabs.onUpdated.fire(7, { status: "complete" }, { id: 7, status: "complete" });
  assert.equal(await settled(wait), "resolved");
});

test("resolves at once when the tab had already loaded", async () => {
  const tabs = fakeTabs({ id: 7, status: "complete", url: "https://app.projectionlab.com/" });
  assert.equal(await settled(waitForTabLoad(tabs, 7, 1_000)), "resolved");
});

test("rejects when the tab closes before it loads", async () => {
  const tabs = fakeTabs();
  const wait = waitForTabLoad(tabs, 7, 1_000);
  tabs.onRemoved.fire(7);
  await assert.rejects(wait, /closed before it finished loading\.$/);
  assert.equal(tabs.onUpdated.listeners.size, 0);
});

test("rejects after the timeout", async () => {
  const tabs = fakeTabs();
  await assert.rejects(waitForTabLoad(tabs, 7, 30), /did not finish loading within 0\.03 seconds\.$/);
  assert.equal(tabs.onRemoved.listeners.size, 0);
});
