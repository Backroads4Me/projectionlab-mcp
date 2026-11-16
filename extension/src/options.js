import browser from "webextension-polyfill";
import { EARLY_ACCESS_URL_PATTERN, updateLineForVersions } from "./wire.js";
const elements = Object.fromEntries(["settings", "port", "token", "toggleToken", "autoOpen", "status", "hint", "error", "saved", "version", "update", "allowEdits", "editsState", "eaStatus", "eaToggle"].map((id) => [id, document.getElementById(id)]));
const EARLY_ACCESS = { origins: [EARLY_ACCESS_URL_PATTERN] };

// Stored connectionStatus values, set by background.js: authed = token
// accepted by the server, connected = socket open and awaiting that answer,
// standby = the server holds another executor and this one retries slowly.
const STATUS_TEXT = {
  authed: ["Connected", "Your AI assistant can reach ProjectionLab through this browser."],
  connected: ["Connecting…", "Reached the server; waiting for it to accept the token."],
  standby: ["Standing by", "Another browser is connected to the server. This one connects on its own when that one disconnects. Press Save to use this browser now."],
  disconnected: ["Not connected", "Start your AI assistant (it runs the projectionlab-mcp server), and check that the port and token match. The extension retries on its own."],
};

function renderEdits(allowEdits) {
  elements.allowEdits.checked = allowEdits === true;
  elements.editsState.textContent = allowEdits === true ? "Edits are on." : "Edits are off. Your assistant can only read.";
}

let current = { connectionStatus: "disconnected", lastError: "", serverVersion: "", minExtensionVersion: "" };
function renderUpdate(minExtensionVersion) {
  const line = updateLineForVersions(browser.runtime.getManifest().version, minExtensionVersion || "");
  elements.update.textContent = line;
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
  const values = await browser.storage.local.get({
    port: 8788,
    token: "",
    autoOpen: true,
    connectionStatus: "disconnected",
    lastError: "",
    serverVersion: "",
    minExtensionVersion: "",
    allowEdits: false,
  });
  elements.port.value = values.port;
  elements.token.value = values.token;
  elements.autoOpen.checked = values.autoOpen;
  renderStatus(values);
  renderUpdate(values.minExtensionVersion);
  renderEdits(values.allowEdits);
  await renderEarlyAccess();
}
// Saved on its own, apart from Save, so turning edits on or off never
// reconnects and takes effect at once; background.js reports the change.
elements.allowEdits.addEventListener("change", () => {
  void browser.storage.local.set({ allowEdits: elements.allowEdits.checked });
});
elements.toggleToken.addEventListener("click", () => {
  const hidden = elements.token.type === "password";
  elements.token.type = hidden ? "text" : "password";
  elements.toggleToken.textContent = hidden ? "Hide" : "Show";
});
elements.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  await browser.storage.local.set({ port: Number(elements.port.value), token: elements.token.value.trim(), autoOpen: elements.autoOpen.checked, connectRequestedAt: Date.now() });
  elements.saved.textContent = "Saved";
  setTimeout(() => { elements.saved.textContent = ""; }, 1500);
});
async function renderEarlyAccess() {
  const granted = await browser.permissions.contains(EARLY_ACCESS);
  elements.eaToggle.dataset.granted = String(granted);
  elements.eaToggle.textContent = granted ? "Remove access to ea.projectionlab.com" : "Allow ea.projectionlab.com";
  elements.eaStatus.textContent = granted
    ? "Allowed: the extension can use an open ea.projectionlab.com tab."
    : "Not allowed: the extension uses app.projectionlab.com only.";
}
// permissions.request must be the handler's first call, with no await before
// it: browsers grant it only while the click's user gesture is still active.
elements.eaToggle.addEventListener("click", () => {
  const change = elements.eaToggle.dataset.granted === "true"
    ? browser.permissions.remove(EARLY_ACCESS)
    : browser.permissions.request(EARLY_ACCESS);
  change.then(renderEarlyAccess, (error) => {
    elements.eaStatus.textContent = `Could not change access: ${error instanceof Error ? error.message : String(error)}`;
  });
});
// The user can also grant or revoke site access from the browser's own menus.
browser.permissions.onAdded.addListener(() => void renderEarlyAccess());
browser.permissions.onRemoved.addListener(() => void renderEarlyAccess());
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const update = {};
  if (changes.connectionStatus) update.connectionStatus = changes.connectionStatus.newValue;
  if (changes.lastError) update.lastError = changes.lastError.newValue;
  if (Object.keys(update).length) renderStatus(update);
  if (changes.minExtensionVersion) renderUpdate(changes.minExtensionVersion.newValue);
  if (changes.allowEdits) renderEdits(changes.allowEdits.newValue);
});
void load();
