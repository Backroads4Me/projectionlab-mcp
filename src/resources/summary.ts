import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { log } from "../logger.js";
import { redactSecrets } from "../redact.js";
import { buildSummary } from "../summary.js";

export function registerSummaryResource(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerResource(
    "summary",
    "projectionlab://summary",
    {
      title: "Current Finances Summary",
      description:
        "Current balances, current net worth, and plan inventory. Does not contain projected ending net worth or Chance of Success.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await bridge.exportData();
        const summary = buildSummary(data);
        return {
          contents: [
            {
              uri: uri.href,
              text: toJson(summary),
              mimeType: "application/json",
            },
          ],
        };
      } catch (err) {
        log.error("resource:summary", String(err));
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "Failed to build summary",
                // The message can echo request data, so scrub the Plugin API
                // key from it the way errorResult does.
                details: redactSecrets(
                  err instanceof Error ? err.message : String(err),
                ),
              }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );
}
