import browser from "webextension-polyfill";
const elements = Object.fromEntries(["settings", "port", "token", "autoOpen", "status", "error", "saved"].map((id) => [id, document.getElementById(id)]));
function renderStatus(values) {
  elements.status.textContent = values.connectionStatus || "disconnected";
  elements.error.textContent = values.lastError || "";
}
async function load() {
  const values = await browser.storage.local.get({ port: 8788, token: "", autoOpen: true, connectionStatus: "disconnected", lastError: "" });
  elements.port.value = values.port;
  elements.token.value = values.token;
  elements.autoOpen.checked = values.autoOpen;
  renderStatus(values);
}
elements.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  await browser.storage.local.set({ port: Number(elements.port.value), token: elements.token.value.trim(), autoOpen: elements.autoOpen.checked });
  elements.saved.textContent = "Saved";
  setTimeout(() => { elements.saved.textContent = ""; }, 1500);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  renderStatus({ connectionStatus: changes.connectionStatus?.newValue || elements.status.textContent, lastError: changes.lastError ? changes.lastError.newValue : elements.error.textContent });
});
void load();
