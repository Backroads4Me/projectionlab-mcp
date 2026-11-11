// Plain-language update notices for projectionlab_check_connection. Each
// rule says nothing whenever a needed comparison is unparsable or a version
// is unknown; being out of date is never reported as a connection failure.

import { compareVersions } from "./versionCompare.js";

const SERVER_FIX =
  "To update it, fully quit and reopen the AI assistant's host so npx fetches the new release; " +
  "if the old version is still reported afterwards, set the server args in the host " +
  "configuration to -y projectionlab-mcp@latest.";

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
    const cmp = compareVersions(version, info.server);
    // The extension's release is deliberately not compared with the server's.
    // The bridge admits an executor only when its wire protocol matches (the
    // hello check in extensionBridge.ts, PROTOCOL_VERSION in types/wire.ts), so
    // a differing release number is not by itself a fault, and the browser's
    // store updates the extension on its own. A release that genuinely needs a
    // matching extension raises PROTOCOL_VERSION instead.
    if (kind === "extension" && cmp === 1 && !serverOutOfDate) {
      // Only worth saying when npm has nothing newer to offer as well.
      notices.push(
        `The ProjectionLab MCP server is version ${info.server}, older than the browser ` +
          `extension (${version}). ${SERVER_FIX}`,
      );
    } else if (kind === "bootstrap" && cmp !== null && cmp !== 0) {
      notices.push(
        `The bootstrap snippet in the ProjectionLab tab is version ${version}, pasted from a ` +
          `different server release than the running server (${info.server}). Ask the user to ` +
          `reload the tab, then call projectionlab_get_bootstrap and paste the fresh snippet ` +
          `into the browser console.`,
      );
    }
  }

  return notices;
}
