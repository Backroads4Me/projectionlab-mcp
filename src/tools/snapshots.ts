import { z } from "zod";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { log } from "../logger.js";
import { assertPlansUnchanged } from "../planVersion.js";
import { restoredSectionMatches } from "./restore.js";
import type { Snapshot } from "../types/projectionlab.js";

function getExportSection(
  data: Record<string, unknown>,
  section: string,
): unknown {
  return section === "currentFinances" ? data.today : data[section];
}

interface RollbackSelectorArgs {
  snapshotId?: string | null;
  nBack?: number | null;
  beforeTime?: string | null;
}

type RollbackSelector =
  | { kind: "snapshotId"; value: string }
  | { kind: "nBack"; value: number }
  | { kind: "beforeTime"; value: string };

const SELECTOR_KEYS = ["snapshotId", "nBack", "beforeTime"] as const;

const SELECTOR_HELP =
  "Supply exactly one of snapshotId (an exact ID from projectionlab_list_snapshots), " +
  "nBack (how many snapshots back, 1 being the most recent) or " +
  "beforeTime (an ISO 8601 time)";

function pickSelector(args: RollbackSelectorArgs): RollbackSelector {
  const supplied = SELECTOR_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );

  if (supplied.length !== 1) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      supplied.length === 0
        ? "No rollback snapshot selector supplied"
        : `Supply exactly one rollback snapshot selector, received ${supplied.join(" and ")}`,
      SELECTOR_HELP,
    );
  }

  // Exactly one key is present and is neither undefined nor null.
  return { kind: supplied[0], value: args[supplied[0]] } as RollbackSelector;
}

/**
 * Resolve a rollback selector to one snapshot.
 *
 * nBack and beforeTime rank snapshots newest first, the order
 * projectionlab_list_snapshots shows, and count every saved snapshot including
 * the rollback_pre_* snapshot a confirmed rollback itself writes. nBack: 1 is
 * therefore always the top of that list, which is the state saved just before
 * a confirmed rollback, so a rollback is undone by rolling back once more.
 */
async function resolveSnapshot(
  snapshots: SnapshotManager,
  args: RollbackSelectorArgs,
): Promise<Snapshot> {
  const selector = pickSelector(args);

  switch (selector.kind) {
    case "snapshotId":
      return snapshots.get(selector.value);

    case "nBack": {
      const nBack = selector.value;
      if (!Number.isInteger(nBack) || nBack < 1) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `nBack must be a positive integer with 1 as the most recent snapshot, received ${String(nBack)}`,
          SELECTOR_HELP,
        );
      }

      const list = await snapshots.list();
      if (nBack > list.length) {
        const existence =
          list.length === 0
            ? "no snapshots exist"
            : `only ${list.length} snapshot${list.length === 1 ? "" : "s"} exist${list.length === 1 ? "s" : ""}`;
        throw new ProjectionLabError(
          "SNAPSHOT_NOT_FOUND",
          `nBack ${nBack} is out of range; ${existence}`,
          "Use projectionlab_list_snapshots to see them, or a smaller nBack. " +
            "Snapshots are saved automatically before confirmed writes",
        );
      }

      return snapshots.get(list[nBack - 1].id);
    }

    case "beforeTime": {
      const cutoff = Date.parse(selector.value);
      if (Number.isNaN(cutoff)) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `beforeTime "${selector.value}" is not a readable time`,
          "Use an ISO 8601 time such as 2026-11-08T15:30:00Z",
        );
      }

      const list = await snapshots.list();
      const match = list.find(
        (entry) => Date.parse(entry.timestamp) < cutoff,
      );
      if (!match) {
        throw new ProjectionLabError(
          "SNAPSHOT_NOT_FOUND",
          list.length === 0
            ? "No snapshots exist, so nothing predates that beforeTime"
            : `No snapshot predates ${selector.value}; the oldest is ${list[list.length - 1].timestamp}`,
          "Use projectionlab_list_snapshots to see the saved snapshot times, or a later beforeTime",
        );
      }

      return snapshots.get(match.id);
    }
  }
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
        "beforeTime (the latest snapshot strictly before an ISO 8601 time). " +
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
            "ISO 8601 time; restores the latest snapshot taken strictly before it. " +
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
                  success: verified,
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
