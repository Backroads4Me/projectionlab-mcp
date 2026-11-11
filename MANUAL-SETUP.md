# Manual setup

The [README](README.md) has the easy way: paste one prompt into your AI
assistant and it does these steps with you. Follow this page to set things up
yourself instead.

You need **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)) and
Chrome or Firefox 140 or newer; both are tested with this server. Edge and
Brave run the same builds as Chrome and Firefox and are unverified.

**1. Turn on plugins and copy your API key.** In
[ProjectionLab](https://app.projectionlab.com), open **Account Settings →
Plugins**, turn plugins on, and copy your **Plugin API Key**.

**2. Save the key.** Create the file `~/.projectionlab-mcp/.env` containing
the line below, and make it readable only by you (`chmod 600` on macOS and
Linux). Every assistant on your computer reads the key from this file.

```
PL_API_KEY=your-plugin-api-key
```

**3. Add the server to your assistant.** Register this MCP server with your
assistant, for example in Claude Desktop's `claude_desktop_config.json`:

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

For Claude Code and other assistants, see
[Adding the server to your MCP host](REFERENCE.md#adding-the-server-to-your-mcp-host).

**4. Restart your assistant.** It starts the server, which creates the browser
connection token on first start at `~/.projectionlab-mcp/ws-token`.

**5. Install the browser extension.** Add **MCP Bridge for ProjectionLab**
from your browser's store. There is nothing to download, and the store keeps
the extension up to date.

- **Chrome, Edge, or Brave:** open the
  [Chrome Web Store listing](https://chromewebstore.google.com/detail/mcp-bridge-for-projectionl/njgjmcihabchffonldcgfjiocjalpoaf)
  and choose **Add to Chrome**. Edge asks once whether to allow extensions
  from other stores.
- **Firefox:** open the
  [Firefox Add-ons listing](https://addons.mozilla.org/en-US/firefox/addon/mcp-bridge-for-projectionlab/)
  and choose **Install Add-on**.

Then click the extension's toolbar icon to open its options page and enter
port `8788` and the token from `~/.projectionlab-mcp/ws-token`.

**6. Check the connection.** Open ProjectionLab in that browser and log in.
Then ask your assistant to run `projectionlab_check_connection`. When every
check passes, ask it about your plan.

The server starts in read-only mode. To let the assistant make changes, add
`PL_READ_ONLY=false` to `~/.projectionlab-mcp/.env` and restart your
assistant. Every setting is listed in the
[technical reference](REFERENCE.md#environment-variables).
