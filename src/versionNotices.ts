// Plain-language update notices for projectionlab_check_connection. Each
// rule says nothing whenever a needed comparison is unparsable or a version
// is unknown; being out of date is never reported as a connection failure.

import { MIN_EXTENSION_VERSION } from "./types/wire.js";
import { compareVersions } from "./versionCompare.js";

const SERVER_FIX =
  "To update it, fully quit and reopen the AI assistant's host so npx fetches the new release; " +
  "if the old version is still reported afterwards, set the server args in the host " +
  "configuration to -y projectionlab-mcp@latest.";

const EXTENSION_FIX =
  "The browser's extension store normally updates it on its own: MCP Bridge for ProjectionLab is on " +
  "the Chrome Web Store (https://chromewebstore.google.com/detail/mcp-bridge-for-projection/njgjmcihabchffonldcgfjiocjalpoaf) " +
  "and Firefox Add-ons (https://addons.mozilla.org/en-US/firefox/addon/mcp-bridge-for-projectionlab/). " +
  "Ask the user to check for updates on the browser's extensions page, or to install it from the " +
  "store above if it was never installed there. If an older unpacked or temporary copy was loaded manually, " +
  "ask the user to remove it from the extensions page and copy the token from ~/.projectionlab-mcp/ws-token " +
  "into the new extension's settings (browsers isolate settings by extension ID, so they do not transfer automatically).";

export interface VersionInfo {
  /** The server's own release. */
  server: string;
  /** Connected executor, "extension/<v>" or "bootstrap/<v>", or null. */
  executor: string | null;
  /** Newest release on npm, or null when unknown or the check is off. */
  latest: string | null;
}

export function versionNotices(info: VersionInfo): string[] {
  const notices: string[] = [];
  const serverOutOfDate =
    info.latest !== null && compareVersions(info.latest, info.server) === 1;

  if (serverOutOfDate) {
    notices.push(
      `The ProjectionLab MCP server is running version ${info.server}, but version ` +
        `${info.latest} is available on npm. ${SERVER_FIX}`,
    );
  }

  if (info.executor) {
    const slash = info.executor.lastIndexOf("/");
    const kind = slash === -1 ? "" : info.executor.slice(0, slash);
    const version = slash === -1 ? "" : info.executor.slice(slash + 1);
    if (kind === "extension") {
      const cmp = compareVersions(version, MIN_EXTENSION_VERSION);
      if (cmp === -1) {
        notices.push(
          `The ProjectionLab browser extension is version ${version}, older than the minimum ` +
            `required version (${MIN_EXTENSION_VERSION}). ${EXTENSION_FIX}`,
        );
      }
    } else if (kind === "bootstrap") {
      const cmp = compareVersions(version, info.server);
      if (cmp !== null && cmp !== 0) {
        notices.push(
          `The bootstrap snippet in the ProjectionLab tab is version ${version}, pasted from a ` +
            `different server release than the running server (${info.server}). Ask the user to ` +
            `reload the tab, then call projectionlab_get_bootstrap and paste the fresh snippet ` +
            `into the browser console.`,
        );
      }
    }
  }

  return notices;
}
