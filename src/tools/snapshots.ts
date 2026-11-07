import { z } from "zod";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";

function getExportSection(
  data: Record<string, unknown>,
  section: string,
): unknown {
  return section === "currentFinances" ? data.today : data[section];
}

export function registerSnapshotTools(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_list_snapshots",
    {
      title: "List Snapshots",
      description:
        "Returns a list of available data snapshots with timestamps, the operation that " +
        "triggered them, and which data sections were saved. Snapshots are created automatically " +
        "before any write operation.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const list = await snapshots.list();
        return {
          content: [{ type: "text", text: toJson(list) }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "projectionlab_rollback",
    {
      title: "Rollback to Snapshot",
      description:
        "Restores ProjectionLab data from a previously saved snapshot. " +
        "When confirm is false (default), shows what the rollback would restore. " +
        "When confirm is true, applies the rollback by calling the appropriate restore methods. " +
        "Use projectionlab_list_snapshots to find available snapshot IDs.",
      inputSchema: {
        snapshotId: z.string().describe("ID of the snapshot to restore from"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute rollback. Default false returns a preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ snapshotId, confirm }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
            "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
          );
        }

        const snapshot = await snapshots.get(snapshotId);

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    snapshotId: snapshot.id,
                    timestamp: snapshot.timestamp,
                    operation: snapshot.operation,
                    sections: snapshot.sections,
                    message:
                      "This will restore the data sections listed above. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        // Snapshot current state before rolling back
        const currentData = await bridge.exportData({ fresh: true });
        const sectionsToBackup: Record<string, unknown> = {};
        for (const section of snapshot.sections) {
          sectionsToBackup[section] = getExportSection(
            currentData as Record<string, unknown>,
            section,
          );
        }
        await snapshots.create(
          `rollback_pre_${snapshotId}`,
          snapshot.sections,
          sectionsToBackup,
        );

        // Apply the rollback
        for (const section of snapshot.sections) {
          const sectionData = snapshot.data[section];
          if (sectionData === undefined) continue;

          switch (section) {
            case "currentFinances":
              await bridge.restoreCurrentFinances(sectionData);
              break;
            case "plans":
              await bridge.restorePlans(sectionData as unknown[]);
              break;
            case "progress":
              await bridge.restoreProgress(sectionData);
              break;
            case "settings":
              await bridge.restoreSettings(sectionData);
              break;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  restoredSections: snapshot.sections,
                  fromSnapshot: snapshot.id,
                  message:
                    "Rollback complete. A pre-rollback snapshot was also saved. Use projectionlab_export_data to verify.",
                },
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
