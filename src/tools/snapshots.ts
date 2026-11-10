import { z } from "zod";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { resolveSnapshot, type SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { REDACTED, hasApiKeyPlaceholder } from "../redact.js";
import { log } from "../logger.js";
import { assertPlansUnchanged } from "../planVersion.js";
import { restoredSectionMatches } from "./restore.js";

function getExportSection(
  data: Record<string, unknown>,
  section: string,
): unknown {
  return section === "currentFinances" ? data.today : data[section];
}

/** True when any string inside `value` contains `needle`. */
function containsText(value: unknown, needle: string): boolean {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): boolean => {
    if (typeof v === "string") return v.includes(needle);
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return false;
      seen.add(v as object);
      return Object.values(v as Record<string, unknown>).some(walk);
    }
    return false;
  };
  return walk(value);
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
        "Choose the snapshot with exactly one of snapshotId (an exact ID), " +
        "nBack (how many snapshots back, 1 being the most recent) or " +
        "beforeTime (the latest snapshot strictly before an ISO 8601 time " +
        "carrying an explicit Z or ±HH:MM offset). " +
        "nBack and beforeTime rank snapshots newest first, the order " +
        "projectionlab_list_snapshots shows, and count every saved snapshot " +
        "including the pre-rollback snapshot a confirmed rollback writes, so " +
        "nBack 1 is the top of that list. " +
        "When confirm is false (default), shows the resolved snapshot and what " +
        "the rollback would restore. " +
        "When confirm is true, applies the rollback by calling the appropriate restore methods. " +
        "Use projectionlab_list_snapshots to find available snapshot IDs.",
      inputSchema: {
        snapshotId: z
          .string()
          .optional()
          .describe(
            "Exact ID of the snapshot to restore. Supply exactly one of snapshotId, nBack or beforeTime.",
          ),
        nBack: z
          .number()
          .optional()
          .describe(
            "How many snapshots back to restore, a positive integer with 1 as the most recent. " +
              "Counts every saved snapshot, including the pre-rollback snapshot a confirmed rollback writes, " +
              "in the same newest-first order as projectionlab_list_snapshots. " +
              "Supply exactly one of snapshotId, nBack or beforeTime.",
          ),
        beforeTime: z
          .string()
          .optional()
          .describe(
            "ISO 8601 time carrying an explicit Z or ±HH:MM offset, such as 2026-11-08T15:30:00Z or " +
              "2026-11-08T15:30:00+02:00; restores the latest snapshot taken strictly before it. " +
              "Times without an offset and bare dates are refused because their instant is ambiguous. " +
              "Supply exactly one of snapshotId, nBack or beforeTime.",
          ),
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
    async ({ snapshotId, nBack, beforeTime, confirm }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
            "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
          );
        }

        const snapshot = await resolveSnapshot(snapshots, {
          snapshotId,
          nBack,
          beforeTime,
        });

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

        // A placeholder that SnapshotManager.get could not restore means no
        // PL_API_KEY is configured; writing it would store the placeholder.
        if (hasApiKeyPlaceholder(snapshot.data)) {
          throw new ProjectionLabError(
            "API_KEY_MISSING",
            `Snapshot ${snapshot.id} holds the Plugin API key placeholder and PL_API_KEY is not set, so the real key cannot be restored`,
            "Set PL_API_KEY to the Plugin API key the exported state carried, then roll back again",
          );
        }
        // Snapshots written before the placeholder existed hold [REDACTED]
        // where the key was; restoring that settings data would store the
        // sentinel as if it were the value.
        if (containsText(snapshot.data.settings, REDACTED)) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `Snapshot ${snapshot.id} holds the ${REDACTED} marker inside its settings data, which would be restored in place of the Plugin API key`,
            "Roll back to a snapshot created by the current server version, or replace settings with projectionlab_restore_settings using values typed in full",
          );
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
          `rollback_pre_${snapshot.id}`,
          snapshot.sections,
          sectionsToBackup,
        );

        // restorePlans replaces every plan, so refuse when a plan was saved
        // in ProjectionLab since the read above.
        if (
          snapshot.sections.includes("plans") &&
          snapshot.data.plans !== undefined
        ) {
          const currentPlans = (currentData as Record<string, unknown>).plans;
          await assertPlansUnchanged(
            bridge,
            Array.isArray(currentPlans) ? currentPlans : [],
          );
        }

        // Apply the rollback
        const restoredSections: string[] = [];
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
            default:
              continue;
          }
          restoredSections.push(section);
        }

        // Re-read and confirm each restored section landed.
        let unverifiedSections: string[] = restoredSections;
        try {
          await new Promise((r) => setTimeout(r, 1000));
          const fresh = (await bridge.exportData({ fresh: true })) as Record<
            string,
            unknown
          >;
          unverifiedSections = restoredSections.filter(
            (section) =>
              !restoredSectionMatches(
                section,
                snapshot.data[section],
                getExportSection(fresh, section),
              ),
          );
        } catch (err) {
          log.warn("rollback", `Post-write verification failed: ${err}`);
        }
        const verified = unverifiedSections.length === 0;

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  // true means the write was accepted; `verified` says
                  // whether the re-read matched.
                  success: true,
                  verified,
                  restoredSections,
                  ...(verified ? {} : { unverifiedSections }),
                  fromSnapshot: snapshot.id,
                  message: verified
                    ? "Rollback complete and verified. A pre-rollback snapshot was also saved."
                    : "Rollback was written but the re-read did not match the snapshot for the sections in unverifiedSections. A pre-rollback snapshot was saved; check the data in ProjectionLab.",
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
