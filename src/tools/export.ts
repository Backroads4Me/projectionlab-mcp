import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { redactSecrets } from "../redact.js";
import { secureMkdir, secureWriteFile } from "../secureFs.js";
import { log } from "../logger.js";

const FILE_THRESHOLD = 100_000;
const EXPORT_DIR = join(homedir(), ".projectionlab-mcp", "exports");

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

        if (json.length > FILE_THRESHOLD) {
          await secureMkdir(EXPORT_DIR);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filePath = join(EXPORT_DIR, `export-${timestamp}.json`);
          await secureWriteFile(filePath, json);
          log.info("export", `Wrote ${json.length} chars to ${filePath}`);

          const planNames = Array.isArray(data.plans)
            ? data.plans.map((p) =>
                String((p as Record<string, unknown>).name ?? "unnamed"),
              )
            : [];

          return {
            content: [
              {
                type: "text",
                text: toJson({
                  exportSaved: true,
                  filePath,
                  sizeChars: json.length,
                  planNames,
                  hint: "Full export saved to file. Use projectionlab_get_plan or projectionlab_get_plan_section for targeted access. In Claude Code, use the Read tool to read the file if needed.",
                }),
              },
            ],
          };
        }

        return {
          content: [{ type: "text", text: json }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
