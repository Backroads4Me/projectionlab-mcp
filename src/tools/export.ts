import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { redactSecrets } from "../redact.js";
import { textOrFile } from "../largeOutput.js";

export function registerExportTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_export_data",
    {
      title: "Export Data",
      description:
        "Export the complete current state from ProjectionLab (plans, current finances, " +
        "progress, settings) as a JSON object. This is the primary source of truth. " +
        "WARNING: the full export is very large; results over the inline limit are saved " +
        "to a file and a pointer is returned. " +
        "Prefer projectionlab_get_plan or projectionlab_get_plan_section for targeted access. " +
        "Write tools snapshot automatically, so a manual pre-write export is NOT required.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        // Exports are read-only artifacts (file + inline), never used to
        // restore, so redact aggressively (literal key + secret-named fields).
        const data = redactSecrets(await bridge.exportData(), { byName: true });
        const json = toJson(data);

        const planNames = Array.isArray(data.plans)
          ? data.plans.map((p) =>
              String((p as Record<string, unknown>).name ?? "unnamed"),
            )
          : [];

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(json, "export", { planNames }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
