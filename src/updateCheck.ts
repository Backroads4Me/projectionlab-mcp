// One request per server process asks the npm registry for the latest
// published version of this package, so check_connection can tell the user
// an update is available. The request carries no user data: no query string,
// no custom headers beyond Accept, nothing from config or the plan.
// PL_UPDATE_CHECK=false turns the lookup off entirely.

import { config } from "./config.js";
import { log } from "./logger.js";
import { compareVersions } from "./versionCompare.js";
import { VERSION } from "./version.js";

const REGISTRY_URL = "https://registry.npmjs.org/projectionlab-mcp/latest";
const DEFAULT_TIMEOUT_MS = 3000;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/**
 * Read the `version` field of the registry's latest-release document.
 * Any failure (offline, timeout, non-200, bad JSON, missing or unparsable
 * version) resolves to null; this never rejects.
 */
export async function fetchLatestVersion(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    if (typeof body?.version !== "string") return null;
    // Unparsable versions are as good as unknown.
    return compareVersions(body.version, "0.0.0") === null ? null : body.version;
  } catch (err) {
    log.debug("updateCheck", `update lookup failed: ${err}`);
    return null;
  }
}

export interface UpdateCheck {
  /** Start the lookup; without PL_UPDATE_CHECK=false and at most once. */
  start(fetchImpl?: FetchLike): void;
  /** The latest version found, or null while unknown or disabled. */
  latest(): string | null;
}

/** A fresh holder; the module-level one is what the server uses. */
export function createUpdateCheck(): UpdateCheck {
  let latest: string | null = null;
  let started = false;
  return {
    start(fetchImpl: FetchLike = fetch as unknown as FetchLike): void {
      if (started || !config.updateCheck) return;
      started = true;
      void fetchLatestVersion(fetchImpl).then((found) => {
        latest = found;
        if (found && compareVersions(found, VERSION) === 1) {
          log.info(
            "updateCheck",
            `projectionlab-mcp ${found} is available (running ${VERSION})`,
          );
        }
      });
    },
    latest(): string | null {
      return latest;
    },
  };
}

export const updateCheck = createUpdateCheck();
