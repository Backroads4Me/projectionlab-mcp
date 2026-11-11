# Setting up ProjectionLab MCP: instructions for AI assistants

This file is for the AI agent doing the install. A person reading it can skip
it: the [README](https://github.com/Backroads4Me/projectionlab-mcp#readme) has
the steps for people.

You are setting this up for a **non-technical user**. Explain each thing you need from them in plain language, one step at a time, and never ask them to do something you can do yourself.

**1. Get the user's Plugin API key.** Ask them to open ProjectionLab → Account Settings → Plugins, enable plugins, and copy their **Plugin API Key**. Do **not** invent one, and never print, log, or commit it.

**2. Store the key.** Write it to `~/.projectionlab-mcp/.env` as the line `PL_API_KEY=...` and make the file readable only by the user (`chmod 600`). Every MCP host on the machine reads this file, so the key lives in one place. Do not repeat the key back to the user. Writes stay disabled by default; do not set `PL_READ_ONLY=false` until the user has seen the tool working and explicitly asks.

**3. Register the server with the user's MCP host.** The server runs with `npx`, which needs Node.js 20 or newer:
```json
{
  "mcpServers": {
    "projectionlab": {
      "command": "npx",
      "args": ["-y", "projectionlab-mcp"]
    }
  }
}
```
The config location varies by host; see [Adding the server to your MCP host](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/REFERENCE.md#adding-the-server-to-your-mcp-host) for common ones. Have the user restart the host so it starts the server. On first start the server creates the browser connection token at `~/.projectionlab-mcp/ws-token`.

**4. Connect the browser.** The server reaches ProjectionLab through the user's own browser. Pick the path that fits:

- **Recommended: the browser extension** (persists across restarts, and the store keeps it updated). Have the user add **MCP Bridge for ProjectionLab** from their browser's store. Opening the page is yours to do; clicking the install button is theirs:
  - **Chrome / Edge / Brave:** the [Chrome Web Store listing](https://chromewebstore.google.com/detail/mcp-bridge-for-projection/njgjmcihabchffonldcgfjiocjalpoaf) → **Add to Chrome**. Edge asks once whether to allow extensions from other stores.
  - **Firefox (140+):** the [Firefox Add-ons listing](https://addons.mozilla.org/en-US/firefox/addon/mcp-bridge-for-projectionlab/) → **Install Add-on**.
  Then have them open the extension's **options page** (click its toolbar icon) and enter the WebSocket **port** (default `8788`) and the **shared token** from `~/.projectionlab-mcp/ws-token`.
  Chrome and Firefox are tested with this server; Edge and Brave run the same
  builds and are unverified, so steer the user to Chrome or Firefox when they
  have a choice, and treat a Brave or Edge report as unverified until reproduced.

- **Quick alternative: no install.** Call the `projectionlab_get_bootstrap` tool, then have the user paste the returned snippet into their ProjectionLab tab's developer console (F12 → Console). It works the same way but must be re-pasted if they reload the page. Good for a first test drive.

**5. Verify.** Have the user open [ProjectionLab](https://app.projectionlab.com), log in, and confirm plugins are enabled. Then call `projectionlab_check_connection`; it should report all checks passing. Do this before any other tool call.

**6. Enabling changes (writes).** Leave everything read-only until the user explicitly asks to make changes. When they do: set `PL_READ_ONLY=false` in `~/.projectionlab-mcp/.env` or the host's `env` block, restart the host, and confirm with `projectionlab_check_connection` that `writesEnabled` is `true`. Every write tool still previews unless called with `confirm: true`: show the user each preview and confirm only the change they approve. Every confirmed change is snapshotted first so it can be rolled back. Tell the user this before the first change.
