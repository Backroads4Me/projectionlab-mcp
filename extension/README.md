# MCP Bridge for ProjectionLab extension

This Manifest V3 extension connects a normal ProjectionLab browser tab to the localhost WebSocket listener provided by `projectionlab-mcp`. It never stores or logs a ProjectionLab API key or exported financial data.

## Install

Most people install from their browser's store. The store keeps the extension
up to date, and an installed copy survives a browser restart:

- **Chrome, Edge, or Brave:** [Chrome Web Store](https://chromewebstore.google.com/detail/mcp-bridge-for-projection/njgjmcihabchffonldcgfjiocjalpoaf), then **Add to Chrome**. Edge asks once whether to allow extensions from other stores.
- **Firefox 140+:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/mcp-bridge-for-projectionlab/), then **Install Add-on**.

Then open the options page (click the toolbar icon) and enter the WebSocket
port and the shared token, as described below. Install from one source only:
an unpacked copy alongside a store copy gives the browser two extensions
competing for the server's single connection, and the loser stands by.

## Build and load (development)

Requires Node.js 20 or newer.

```sh
cd extension
npm install
npm run build
```

In Chrome, Edge, or Brave, open the extensions page, enable Developer mode, choose **Load unpacked**, and select `extension/dist/chromium`. Click the extension's toolbar icon to open its options page, and enter the WebSocket port (8788 by default) and the shared token from `~/.projectionlab-mcp/ws-token`. The status advances from **Not connected** to **Connecting…** to **Connected** once the server accepts the token. While connected, the toolbar icon shows a green check; it shows no badge otherwise, since the server runs only while an MCP host does. Hover the icon for the current status.

Do not put the ProjectionLab Plugin API key in extension options. The MCP server owns it and sends it only as an in-memory request parameter.

The extension has no version of its own: the build writes the version from the repository's root `package.json` into each built manifest, so a release's server and extension share one number.

## Loopback test

```sh
PL_API_KEY='your-plugin-api-key' node test/fake-server.mjs 8788 development-token
```

Configure that port and token, log in to ProjectionLab, and watch the harness print `describeApi` and `exportData` response frames. Printed exports are sensitive; use a trusted terminal. Stop and restart the harness to verify reconnection. A wrong token should produce an options-page authentication error without rapid retries.

## Browser compatibility

- Chromium 116+ is the primary target because WebSocket traffic extends an MV3 service worker's lifetime there. Chrome, Edge, and Brave use the same build: Chrome is tested, Edge and Brave are unverified.
- Firefox 140+ (tested) uses bundled `webextension-polyfill`. Load `extension/dist/firefox/manifest.json` from `about:debugging` as a temporary add-on. Firefox uses a non-persistent background script because it does not support `background.service_worker`; a 15-second Firefox-only alarm prevents the connected event page from being unloaded. Its manifest also opts out of Firefox's default insecure-request upgrade for the explicitly scoped `ws://127.0.0.1:*` loopback connection.
- Safari is not supported.

The manifest requests `scripting`, `storage`, and `alarms`, plus the `https://app.projectionlab.com/*` host permission. The alarm wakes a disconnected MV3 worker once per minute so it can reconnect when the MCP server starts later. When another browser holds the server's single executor slot, this one shows **Standing by** and retries at least 30 seconds apart, connecting on its own when that browser goes away; pressing Save on the options page takes the slot over deliberately.

The privacy policy is [`PRIVACY.md`](../PRIVACY.md).
