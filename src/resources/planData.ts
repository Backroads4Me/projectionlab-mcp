import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { redactSecrets } from "../redact.js";
import { log } from "../logger.js";

export function registerPlanDataResource(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerResource(
    "plan-data",
    "projectionlab://plan-data",
    {
      title: "ProjectionLab Plan Data",
      description:
        "Full export of all ProjectionLab data (plans, finances, progress, settings). Refreshed on each access.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = redactSecrets(await bridge.exportData(), { byName: true });
        return {
          contents: [
            {
              uri: uri.href,
              text: toJson(data),
              mimeType: "application/json",
            },
          ],
        };
      } catch (err) {
        log.error("resource:plan-data", String(err));
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "Failed to export data",
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
