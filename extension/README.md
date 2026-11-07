# ProjectionLab MCP Bridge extension

This unpacked Manifest V3 extension connects a normal ProjectionLab browser tab to the localhost WebSocket listener provided by `projectionlab-mcp`. It never stores or logs a ProjectionLab API key or exported financial data.

## Build and load

Requires Node.js 20 or newer.

```sh
cd extension
npm install
npm run build
```

In Chrome, Edge, or Brave, open the extensions page, enable Developer mode, choose **Load unpacked**, and select `extension/dist/chromium`. Click the extension's toolbar icon to open its options page, and enter the WebSocket port (8788 by default) and the shared token from `~/.projectionlab-mcp/ws-token`. The status advances from **Not connected** to **Connecting…** to **Connected** once the server accepts the token. While connected, the toolbar icon shows a green check; it shows no badge otherwise, since the server runs only while an MCP host does. Hover the icon for the current status.

Do not put the ProjectionLab Plugin API key in extension options. The MCP server owns it and sends it only as an in-memory request parameter.

## Loopback test

```sh
PL_API_KEY='your-plugin-api-key' node test/fake-server.mjs 8788 development-token
```

Configure that port and token, log in to ProjectionLab, and watch the harness print `describeApi` and `exportData` response frames. Printed exports are sensitive; use a trusted terminal. Stop and restart the harness to verify reconnection. A wrong token should produce an options-page authentication error without rapid retries.

## Browser compatibility

- Chromium 116+ is the primary target because WebSocket traffic extends an MV3 service worker's lifetime there. Chrome, Edge, and Brave use the same build.
- Firefox 128+ uses bundled `webextension-polyfill`. Load `extension/dist/firefox/manifest.json` from `about:debugging` as a temporary add-on. Firefox uses a non-persistent background script because it does not support `background.service_worker`; a 15-second Firefox-only alarm prevents the connected event page from being unloaded. Its manifest also opts out of Firefox's default insecure-request upgrade for the explicitly scoped `ws://127.0.0.1:*` loopback connection.
- Safari is not supported.

The manifest requests `tabs`, `scripting`, `storage`, and `alarms`, plus the `https://app.projectionlab.com/*` host permission. The alarm wakes a disconnected MV3 worker once per minute so it can reconnect when the MCP server starts later.
