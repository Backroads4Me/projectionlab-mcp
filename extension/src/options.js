import browser from "webextension-polyfill";
import { RELEASES_URL, updateLineForVersions } from "./wire.js";
const elements = Object.fromEntries(["settings", "port", "token", "toggleToken", "autoOpen", "status", "hint", "error", "saved", "version", "update"].map((id) => [id, document.getElementById(id)]));

// Stored connectionStatus values, set by background.js: authed = token
// accepted by the server, connected = socket open and awaiting that answer.
const STATUS_TEXT = {
  authed: ["Connected", "Your AI assistant can reach ProjectionLab through this browser."],
  connected: ["Connecting…", "Reached the server; waiting for it to accept the token."],
  disconnected: ["Not connected", "Start your AI assistant (it runs the projectionlab-mcp server), and check that the port and token match. The extension retries on its own."],
};

let current = { connectionStatus: "disconnected", lastError: "" };
function renderUpdate(serverVersion) {
  const line = updateLineForVersions(browser.runtime.getManifest().version, serverVersion || "");
  elements.update.replaceChildren();
  if (!line) return;
  // Build the link with DOM calls; never innerHTML.
  const anchorText = "releases page";
  const anchorAt = line.indexOf(anchorText);
  if (anchorAt === -1) {
    elements.update.textContent = line;
    return;
  }
  const link = document.createElement("a");
  link.href = RELEASES_URL;
  link.textContent = anchorText;
  link.target = "_blank";
  link.rel = "noopener";
  elements.update.append(line.slice(0, anchorAt), link, line.slice(anchorAt + anchorText.length));
}
function renderStatus(values) {
  current = { ...current, ...values };
  const state = STATUS_TEXT[current.connectionStatus] ? current.connectionStatus : "disconnected";
  const [label, hint] = STATUS_TEXT[state];
  elements.status.dataset.state = state;
  elements.status.textContent = label;
  elements.hint.textContent = hint;
  elements.error.textContent = state === "authed" ? "" : current.lastError || "";
}
async function load() {
  elements.version.textContent = browser.runtime.getManifest().version;
  const values = await browser.storage.local.get({ port: 8788, token: "", autoOpen: true, connectionStatus: "disconnected", lastError: "", serverVersion: "" });
  elements.port.value = values.port;
  elements.token.value = values.token;
  elements.autoOpen.checked = values.autoOpen;
  renderStatus(values);
  renderUpdate(values.serverVersion);
}
elements.toggleToken.addEventListener("click", () => {
  const hidden = elements.token.type === "password";
  elements.token.type = hidden ? "text" : "password";
  elements.toggleToken.textContent = hidden ? "Hide" : "Show";
});
elements.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  await browser.storage.local.set({ port: Number(elements.port.value), token: elements.token.value.trim(), autoOpen: elements.autoOpen.checked });
  elements.saved.textContent = "Saved";
  setTimeout(() => { elements.saved.textContent = ""; }, 1500);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const update = {};
  if (changes.connectionStatus) update.connectionStatus = changes.connectionStatus.newValue;
  if (changes.lastError) update.lastError = changes.lastError.newValue;
  if (Object.keys(update).length) renderStatus(update);
  if (changes.serverVersion) renderUpdate(changes.serverVersion.newValue);
});
void load();
