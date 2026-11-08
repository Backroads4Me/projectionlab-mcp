# Privacy Policy: MCP Bridge for ProjectionLab

This policy covers the **MCP Bridge for ProjectionLab** browser extension
(Chrome Web Store and Firefox Add-ons) and the `projectionlab-mcp` server it
connects to. Both are open source at
<https://github.com/Backroads4Me/projectionlab-mcp>. The project is
independent and is not affiliated with or endorsed by ProjectionLab.

## Summary

- The extension sends data to one place: a server on your own computer, at
  `ws://127.0.0.1` (loopback), which you install and run yourself.
- The developer runs no servers and receives no data. There is no analytics,
  telemetry, advertising, tracking, or crash reporting.
- Nothing is sold, and nothing is shared with the developer or any third party.

## What the extension does

The extension relays requests between the `projectionlab-mcp` server running on
your computer and the ProjectionLab tab (`https://app.projectionlab.com`) in
which you are already signed in. For each request from the local server, it
calls ProjectionLab's Plugin API inside that tab and returns the result to the
local server.

## Data the extension handles

| Data | Where it comes from | Where it goes |
| --- | --- | --- |
| Your ProjectionLab data (plans, accounts, balances, income, expenses, and other details you entered in ProjectionLab) | ProjectionLab's Plugin API in your signed-in tab | The local server at `127.0.0.1` only |
| Your ProjectionLab Plugin API key | The local server, which reads it from your own configuration | Passed to the Plugin API in your ProjectionLab tab for each request. The extension never stores it. |
| The local server's port and shared token, and the auto-open setting | You enter them on the options page | Stored in the browser's extension storage on your computer. The token is sent only to the local server, to authenticate the connection. |
| Connection status and the last error message | The extension itself | Stored in the browser's extension storage, to show on the options page and toolbar icon |

The extension does not read your browsing history, does not access any site
other than `https://app.projectionlab.com`, and does not read the content of
ProjectionLab pages beyond the Plugin API results the local server asks for.

## Where your data goes after the local server

The `projectionlab-mcp` server passes ProjectionLab data to the AI assistant
(MCP host) that you connected it to, so the assistant can answer your
questions or make changes you request. If that assistant uses a cloud AI
model, the data reaches that model's provider, under that provider's privacy
policy and your agreement with them. You choose the assistant; this project
has no relationship with it and receives nothing from it.

The server also stores, on your computer only:

- pre-change snapshots of plan data, with secrets removed, so a change can be
  undone (`~/.projectionlab-mcp/snapshots` unless you set `PL_SNAPSHOT_DIR`);
- the shared token (`~/.projectionlab-mcp/ws-token`).

ProjectionLab itself handles your account and data under its own privacy
policy. The Plugin API calls the extension makes run in ProjectionLab's page,
under your own session.

## Retention and deletion

- Extension settings stay in your browser until you remove the extension,
  which deletes them.
- The server deletes snapshots older than 30 days. You can delete them, or the
  whole `~/.projectionlab-mcp/` folder, at any time.

## Permissions

- **Access to `https://app.projectionlab.com/*`**: to find your ProjectionLab
  tab and call its Plugin API.
- **`scripting`**: to run the Plugin API call inside that tab.
- **`storage`**: to remember the port, token, and settings.
- **`alarms`**: to retry the connection to the local server periodically.

## Children

The extension is not directed at children and collects nothing from anyone.

## Changes

Changes to this policy are published in this file, and its history is visible
in the repository.

## Contact

Open an issue at <https://github.com/Backroads4Me/projectionlab-mcp/issues>.
