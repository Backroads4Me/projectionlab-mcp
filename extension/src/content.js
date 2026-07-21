import browser from "webextension-polyfill";

const nonce = crypto.randomUUID();
const requestType = `plmcp:${nonce}:request`;
const responseType = `plmcp:${nonce}:response`;
const pending = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== responseType) return;
  const resolve = pending.get(event.data.id);
  if (!resolve) return;
  pending.delete(event.data.id);
  resolve(event.data);
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "plmcp:prepare") return Promise.resolve({ nonce });
  if (message?.type !== "plmcp:execute") return undefined;
  return new Promise((resolve) => {
    pending.set(message.request.id, resolve);
    window.postMessage({ type: requestType, ...message.request }, "*");
  });
});
