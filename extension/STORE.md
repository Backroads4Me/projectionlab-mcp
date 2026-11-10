# Store listing: MCP Bridge for ProjectionLab

This file is the material for listing the extension on the Chrome Web Store
(CWS) and Firefox Add-ons (AMO): listing text, permission justifications,
data-use answers, assets to capture, and AMO source-review instructions. The
privacy policy is [`PRIVACY.md`](../PRIVACY.md) at the repository root.

Policy references, as of November 2026:

- CWS: [Program policies](https://developer.chrome.com/docs/webstore/program-policies/policies),
  [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
  [User data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
  [Images](https://developer.chrome.com/docs/webstore/images).
- AMO: [Add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/),
  [Built-in data collection consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/),
  [Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).

## Listing text

**Name:** MCP Bridge for ProjectionLab

**Short description** (manifest `description`; CWS shows it as the summary,
132-character limit; AMO summary, 250-character limit):

> Connects ProjectionLab's Plugin API to a local projectionlab-mcp server.

**Long description** (CWS "Description", AMO "Description"):

> Let your AI assistant read and safely edit your ProjectionLab retirement plan.
>
> MCP Bridge for ProjectionLab connects the ProjectionLab tab you are signed in to
> with projectionlab-mcp, an open-source Model Context Protocol (MCP) server
> that runs on your own computer. Any MCP-compatible assistant, such as Claude
> Desktop, Claude Code, or another MCP host, can then use ProjectionLab's
> official Plugin API through your browser to answer questions about your
> plans and make changes you ask for.
>
> How it works:
> - You install and run the projectionlab-mcp server (`npx -y projectionlab-mcp`).
> - The extension connects to it at 127.0.0.1 only, using a shared token you
>   copy from `~/.projectionlab-mcp/ws-token` into the extension's options.
> - For each request from the server, the extension calls ProjectionLab's
>   Plugin API in your ProjectionLab tab and returns the result to the server.
>
> Safety:
> - Plan changes are dry runs until you confirm them, and the server snapshots
>   your data first so a change can be rolled back.
> - The extension talks only to app.projectionlab.com and to the server on
>   your own computer. It has no analytics or tracking, and the developer
>   receives none of your data.
> - Your ProjectionLab Plugin API key stays in the server's configuration. The
>   extension never stores it.
>
> Quick setup: ask your AI assistant to "install projectionlab-mcp from
> github.com/Backroads4Me/projectionlab-mcp" and it can walk you through the rest.
>
> Requirements: a ProjectionLab account with Plugin API access, Node.js 20 or
> newer, and an MCP-compatible AI assistant. Setup guide:
> https://github.com/Backroads4Me/projectionlab-mcp#readme
>
> This is an independent open-source project. It is not affiliated with or
> endorsed by ProjectionLab.

**Homepage / support URLs:**

- Homepage: <https://github.com/Backroads4Me/projectionlab-mcp>
- Support: <https://github.com/Backroads4Me/projectionlab-mcp/issues>
- Privacy policy: <https://github.com/Backroads4Me/projectionlab-mcp/blob/main/PRIVACY.md>
  (resolves once this branch is merged to `main`)

**Category:**

- CWS: **Developer Tools** (alternative: Productivity > Tools).
- AMO: **Other**. AMO has no developer-tools or finance category that fits
  better; **Web Development** is the alternative.

**License (AMO):** MIT.

**Language:** English.

## Single purpose (CWS)

> The extension has one purpose: to relay requests between the user's
> locally running projectionlab-mcp server and the ProjectionLab web app tab
> the user is signed in to, so the user's AI assistant can read and edit
> their ProjectionLab data through ProjectionLab's Plugin API.

## Permission justifications

Each answer goes in the CWS "Privacy practices" tab. AMO reviewers read the
same text from the "Notes to reviewer" field.

| Permission | Justification |
| --- | --- |
| `scripting` | Runs ProjectionLab's Plugin API call (`window.projectionlabPluginAPI`) in the page's main world of the user's ProjectionLab tab and returns the result. The injected function is bundled in the extension (`src/page-main.js`); no code is fetched or evaluated. |
| `storage` | Saves the user's settings (local server port, shared token, auto-open option), the connection status shown on the options page, the connected server's version shown there when it differs from the extension's, and a random installation id and save time the extension uses to decide when to connect or ask to become the active browser. Stored locally only. |
| `alarms` | Wakes the background worker periodically to reconnect to the local server, which runs only while the user's AI assistant is running. |
| Host permission `https://app.projectionlab.com/*` | Finds the user's ProjectionLab tab (or opens one) and injects the Plugin API call into it. No other site is accessed. |

The extension does not request `tabs`: the host permission is enough to query
ProjectionLab tabs by URL, and `tabs.create` needs no permission.

## Remote code

**CWS answer: "No, I am not using remote code."**

All JavaScript is bundled in the package. There is no `eval`, `new Function`,
remote `<script>`, or fetched module. The local server sends data only: the
name of a Plugin API method and its arguments, which the bundled function in
`src/page-main.js` looks up on `window.projectionlabPluginAPI` and calls. A
method name that is not a function on that object is refused.

## Data use and privacy

What the code does, verified against `src/background.js`, `src/options.js`,
`src/page-main.js`, and the built bundles:

- The only network connection is `new WebSocket("ws://127.0.0.1:<port>")`,
  where only the port is configurable. The host is fixed to loopback.
- The only page the extension opens or touches is `https://app.projectionlab.com/`.
- There is no `fetch`, `XMLHttpRequest`, `sendBeacon`, analytics, or remote
  logging. The options page links to GitHub only when the user clicks.
- `storage.local` holds `port`, `token`, `autoOpen`, `connectionStatus`,
  `lastError`, `serverVersion` (the connected server's release, shown on the
  options page when it differs from the extension's), `instanceId` (a random
  id generated on first use that identifies this installation to the local
  server, sent only to `127.0.0.1`), and `connectRequestedAt` (the time of
  the last options-page Save, so the extension can ask to become the active
  browser). The ProjectionLab Plugin API key arrives from the local server as
  a request argument and is never stored.

The data that passes through the extension is the user's ProjectionLab data,
which is financial, and it goes to the local server. The server hands it to
the AI assistant the user chose, which may send it to a cloud model provider.
The disclosures below declare this rather than claiming that nothing is
handled: both stores count data that leaves the extension, even for a local
process, and CWS requires disclosure for locally handled data too.

### CWS "Data usage" form

Check these data types:

- [x] **Financial and payment information**: ProjectionLab plan data
  (accounts, balances, income, expenses) relayed to the user's local server.
- [x] **Authentication information**: the shared token for the local server,
  stored locally; the Plugin API key passed through to ProjectionLab's page.
- [x] **Website content**: Plugin API results read from the ProjectionLab tab.

Leave unchecked: personally identifiable information, health information,
personal communications, location, web history, user activity.

Certify all three statements:

- [x] I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

Privacy policy URL: the `PRIVACY.md` link above.

### AMO data collection (`data_collection_permissions`)

`manifest.firefox.json` declares:

```json
"data_collection_permissions": { "required": ["financialAndPaymentInfo", "websiteContent"] }
```

Mozilla's policy counts data "handled outside of the add-on or the local
browser" and applies it explicitly to data sent to a native application on
the same machine; the local MCP server is the same case. `required` fits
because relaying this data is the extension's only function. Firefox shows
these types in the install prompt (Firefox 140 and newer, hence
`strict_min_version: 140.0`).

The privacy policy goes in AMO's "Privacy Policy" field as text or a link.

## Assets to capture

Icons ship in the package at `src/icons/`: 16, 32, 48, and 128 px PNGs. The
128 px icon is also the CWS store icon and the AMO icon.

| Asset | Store | Size | Required |
| --- | --- | --- | --- |
| Store icon | CWS | 128x128 PNG (in the package) | Yes |
| Screenshots | CWS | 1280x800 (preferred) or 640x400, square corners, no padding; 1 to 5 | At least 1 |
| Small promo tile | CWS | 440x280 | No, but listings without it rank lower |
| Marquee promo tile | CWS | 1400x560 | No; only for featuring |
| Screenshots | AMO | PNG or JPG; AMO displays them at 1280x800, aspect ratio 1.6:1 | Recommended |

Screenshots to capture, at 1280x800:

1. The options page showing **Connected**, with port and token filled in (use
   a dummy token).
2. The options page showing **Not connected** and the setup hint, for a new
   user's first view.
3. The toolbar with the green check badge, next to a ProjectionLab tab.
4. An AI assistant answering a question about a plan with the extension
   connected (use a demo plan, not real finances).
5. A dry-run plan change followed by the confirmed change in ProjectionLab
   (demo data).

Do not show real financial data, a real Plugin API key, or a real token.

## AMO source code submission

The add-on is bundled with esbuild, so AMO requires the source and build
instructions. Upload the whole repository at the release tag, not only
`extension/`: `build.mjs` reads the version from the root `package.json`.

Create the source archive from a clean checkout:

```bash
git archive --format=zip -o projectionlab-mcp-source-<version>.zip v<version>
```

### Build instructions for reviewers

Paste this into AMO's "Notes to reviewer":

> Build environment: Linux (Ubuntu 24.04 or similar), Node.js 20.20.2 and
> npm 10.8.2, plus the `zip` command. Other recent Node versions produce the
> same files.
>
> ```
> cd extension
> npm ci
> npm run build
> npm run package
> ```
>
> `npm run build` writes the unpacked add-on to `extension/dist/firefox/`;
> `npm run package` zips it as
> `extension/dist/projectionlab-mcp-firefox-<version>.zip`. The submitted file
> is that zip. Dependencies are pinned in `extension/package-lock.json`:
> esbuild 0.25.12 (bundler) and webextension-polyfill 0.12.0 (the only
> runtime dependency). Sources are `extension/src/`; `build.mjs` bundles
> `background.js` and `options.js` (no minification) and copies
> `options.html`, the icons, and `manifest.firefox.json` (with the version
> from the root `package.json`).
>
> To test without a ProjectionLab account: run
> `node extension/test/fake-server.mjs 8788 test-token`, load the add-on, open
> its options (click the toolbar icon), enter port 8788 and token
> `test-token`, and save. The status changes to "Connected", and the harness
> sends two requests. Without an open ProjectionLab tab, the extension opens
> app.projectionlab.com in a background tab. The Plugin API appears only
> after sign-in, so without an account the harness prints the extension's
> `API_NOT_AVAILABLE` error responses after about 15 seconds.

### Reproducibility check

Rebuilding v1.0.0 from `git archive v1.0.0` with `npm ci && npm run build &&
npm run package` gives extracted file trees identical to the zips attached to
the v1.0.0 GitHub Release, which CI built with Node 20.20.2 and npm 10.8.2.
The local rebuild used Node 24.15.0 and npm 11.17.0. The zip files themselves
differ only in the per-entry timestamps `zip` records, so compare extracted
contents, not zip hashes:

```bash
mkdir a b
unzip -q projectionlab-mcp-firefox-<version>.zip -d a     # submitted zip
unzip -q extension/dist/projectionlab-mcp-firefox-<version>.zip -d b  # rebuilt
diff -r a b && echo identical
```

## Submission checklist

1. Cut a release that contains these manifest changes; the v1.0.0 zips request
   `tabs` and lack `data_collection_permissions`, so they are not
   submittable.
2. **CWS**: in the Developer Dashboard, add a new item, upload
   `projectionlab-mcp-chromium-<version>.zip`, and fill the Store listing and
   Privacy practices tabs from this file. Choose visibility (public or
   unlisted) and submit for review.
3. **AMO**: at <https://addons.mozilla.org/developers/>, submit a new add-on
   "On this site", upload `projectionlab-mcp-firefox-<version>.zip`, select
   Firefox desktop only (see below), answer "Yes" to source code, upload the
   source archive, paste the reviewer notes, and fill the listing from this
   file.

Firefox for Android: the add-on targets desktop. `addons-linter` reports one
warning, `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`, because
`data_collection_permissions` needs Firefox for Android 142. Leave Android
unchecked at upload; the warning does not block submission.

## Proposal: automated store uploads (not implemented)

A workflow could publish to both stores on a GitHub Release. It is not in
`.github/workflows/` because adding it would publish on the next release
without a separate approval; add it only when ready. Each store keeps its own
review, so the first listing on each store must still be created by hand.

Secrets it would need (repository settings, not created here):

- `CWS_PUBLISHER_ID`, `CWS_ITEM_ID`, and `CWS_SERVICE_ACCOUNT_JSON`: the
  Chrome Web Store API v2 (current since October 2025) supports a Google
  Cloud service account registered in the CWS dashboard.
- `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`: AMO API credentials, read by
  `web-ext` as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.

Sketch, as a second job in `extension-release.yml` after the zips are built:

```yaml
  stores:
    needs: extension
    runs-on: ubuntu-latest
    environment: store-release   # require manual approval in repo settings
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20.20.2 }
      - run: npm ci && npm run build && npm run package
        working-directory: extension
      - run: git archive --format=zip -o source.zip "$GITHUB_REF_NAME"
      - name: Firefox (AMO, listed channel, with source)
        working-directory: extension
        run: >
          npx --yes web-ext@8 sign --channel=listed
          --source-dir=dist/firefox
          --upload-source-code=../source.zip
          --approval-timeout=0
        env:
          WEB_EXT_API_KEY: ${{ secrets.AMO_JWT_ISSUER }}
          WEB_EXT_API_SECRET: ${{ secrets.AMO_JWT_SECRET }}
      - name: Chrome Web Store (API v2 upload, then publish)
        run: |
          # Exchange the service account for an access token with scope
          # https://www.googleapis.com/auth/chromewebstore (for example with
          # google-github-actions/auth), then:
          #   POST https://chromewebstore.googleapis.com/upload/v2/publishers/$CWS_PUBLISHER_ID/items/$CWS_ITEM_ID:upload
          #   POST https://chromewebstore.googleapis.com/v2/publishers/$CWS_PUBLISHER_ID/items/$CWS_ITEM_ID:publish
          echo "fill in once the CWS item exists"
```

Tradeoffs: a GitHub `environment` with required reviewers keeps a human gate
on each store upload; without it, any published GitHub Release would ship to
both stores. Verify the CWS v2 request bodies and `web-ext` flags against
their current docs when implementing.
