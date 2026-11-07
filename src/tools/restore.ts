import { z } from "zod";
import { assertPlansUnchanged } from "../planVersion.js";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { log } from "../logger.js";
import { containsSubset } from "../plans.js";

type Obj = Record<string, unknown>;

function checkReadOnly() {
  if (config.readOnly) {
    throw new ProjectionLabError(
      "READ_ONLY_MODE",
      "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
      "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
    );
  }
}

function getExportSection(
  data: Record<string, unknown>,
  section: string,
): unknown {
  return section === "currentFinances" ? data.today : data[section];
}

/** Strip the `lastUpdated` stamp ProjectionLab sets when it saves a plan. */
function withoutPlanStamps(plans: unknown): unknown {
  if (!Array.isArray(plans)) return plans;
  return plans.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    const { lastUpdated: _stamp, ...rest } = p as Obj;
    return rest;
  });
}

/**
 * True when a fresh export shows the restored `expected` data for `section`.
 * The app may add fields of its own and re-stamps each saved plan's
 * `lastUpdated`, so this checks that every restored value is present rather
 * than requiring byte-for-byte equality.
 */
export function restoredSectionMatches(
  section: string,
  expected: unknown,
  actual: unknown,
): boolean {
  if (section === "plans") {
    return containsSubset(withoutPlanStamps(expected), actual);
  }
  return containsSubset(expected, actual);
}

async function verify(
  bridge: Bridge,
  section: string,
  expected: unknown,
): Promise<{ verified: boolean; detail?: string }> {
  try {
    await new Promise((r) => setTimeout(r, 1000));
    const fresh = (await bridge.exportData({ fresh: true })) as Record<
      string,
      unknown
    >;
    const actual = getExportSection(fresh, section);
    if (actual === undefined) {
      return {
        verified: false,
        detail: `Section "${section}" not found after restore`,
      };
    }
    if (restoredSectionMatches(section, expected, actual)) {
      return { verified: true };
    }
    return {
      verified: false,
      detail: `Section "${section}" did not match the requested restore payload`,
    };
  } catch (err) {
    log.warn("restore", `Post-write verification failed: ${err}`);
    return { verified: false, detail: "Verification re-read failed" };
  }
}

// --- Plan diff helpers for enhanced dry-run ---

function planName(plan: Obj): string {
  return String(plan.name ?? plan.id ?? "unnamed");
}

function countEvents(plan: Obj, section: string): number {
  const data = plan[section];
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const events = (data as Obj).events;
    if (Array.isArray(events)) return events.length;
  }
  return 0;
}

interface PlanDiffEntry {
  name: string;
  status: "unchanged" | "modified" | "added" | "removed";
  changes?: Record<string, string>;
}

function diffPlans(current: unknown[], incoming: Obj[]): PlanDiffEntry[] {
  const currentMap = new Map<string, Obj>();
  for (const p of current) {
    if (p && typeof p === "object") {
      const obj = p as Obj;
      const id = String(obj.id ?? "");
      if (id) currentMap.set(id, obj);
    }
  }

  const incomingMap = new Map<string, Obj>();
  for (const p of incoming) {
    const id = String(p.id ?? "");
    if (id) incomingMap.set(id, p);
  }

  const result: PlanDiffEntry[] = [];

  // Check incoming plans against current
  for (const [id, inPlan] of incomingMap) {
    const curPlan = currentMap.get(id);
    if (!curPlan) {
      result.push({ name: planName(inPlan), status: "added" });
      continue;
    }

    const changes: Record<string, string> = {};
    const sections = ["milestones", "income", "expenses", "accounts", "assets", "priorities"];
    for (const sec of sections) {
      const curCount = countEvents(curPlan, sec);
      const newCount = countEvents(inPlan, sec);
      if (curCount !== newCount) {
        changes[sec] = `${curCount} → ${newCount} events`;
      }
    }

    // Check simple scalar fields
    const scalars = ["name", "retirementAge", "lifeExpectancy"];
    for (const key of scalars) {
      if (
        curPlan[key] !== undefined &&
        inPlan[key] !== undefined &&
        JSON.stringify(curPlan[key]) !== JSON.stringify(inPlan[key])
      ) {
        changes[key] = `${JSON.stringify(curPlan[key])} → ${JSON.stringify(inPlan[key])}`;
      }
    }

    if (Object.keys(changes).length > 0) {
      result.push({ name: planName(inPlan), status: "modified", changes });
    } else {
      result.push({ name: planName(inPlan), status: "unchanged" });
    }
  }

  // Check for removed plans
  for (const [id, curPlan] of currentMap) {
    if (!incomingMap.has(id)) {
      result.push({ name: planName(curPlan), status: "removed" });
    }
  }

  return result;
}

export function registerRestoreTools(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  // --- Restore Current Finances ---
  server.registerTool(
    "projectionlab_restore_current_finances",
    {
      title: "Restore Current Finances",
      description:
        "REPLACES the entire Current Finances state with the provided data. " +
        "This is a FULL REPLACEMENT, not a patch - the entire current finances object is overwritten. " +
        "When confirm is false (default), returns a dry-run preview WITHOUT modifying anything. " +
        "When confirm is true, auto-snapshots current state then applies the replacement. " +
        "Use projectionlab_rollback with that snapshot to undo it; a manual export first is not needed.",
      inputSchema: {
        currentFinances: z
          .record(z.string(), z.unknown())
          .describe("Complete Current Finances object to replace with"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ currentFinances, confirm }) => {
      try {
        checkReadOnly();

        if (!confirm) {
          const topKeys = Object.keys(currentFinances);
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    operation: "restoreCurrentFinances",
                    topLevelKeys: topKeys,
                    warning:
                      "This will REPLACE all Current Finances data. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        const exportData = await bridge.exportData({ fresh: true });
        await snapshots.create("restoreCurrentFinances", ["currentFinances"], {
          currentFinances: exportData.today,
        });

        await bridge.restoreCurrentFinances(currentFinances);

        const { verified, detail } = await verify(
          bridge,
          "currentFinances",
          currentFinances,
        );

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  verified,
                  ...(detail ? { verificationDetail: detail } : {}),
                  message: verified
                    ? "Current Finances replaced and verified. Snapshot saved."
                    : "Current Finances replaced. Snapshot saved. Verification inconclusive - check with projectionlab_get_current_finances.",
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

  // --- Restore Plans ---
  server.registerTool(
    "projectionlab_restore_plans",
    {
      title: "Restore Plans",
      description:
        "REPLACES ALL plans with the provided array. " +
        "This is a FULL REPLACEMENT - every existing plan is overwritten. " +
        "When confirm is false (default), returns a detailed dry-run diff showing plans " +
        "added/removed/modified with per-section event count changes. " +
        "When confirm is true, auto-snapshots current plans then applies the replacement. " +
        "Use projectionlab_rollback with that snapshot to undo it; a manual export first is not needed.",
      inputSchema: {
        plans: z
          .array(z.record(z.string(), z.unknown()))
          .describe("Complete array of plan objects to replace with"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ plans, confirm }) => {
      try {
        checkReadOnly();

        const exportData = await bridge.exportData({ fresh: true });
        const currentPlans = Array.isArray(exportData.plans) ? exportData.plans : [];
        const diff = diffPlans(currentPlans, plans);

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    operation: "restorePlans",
                    currentPlanCount: currentPlans.length,
                    incomingPlanCount: plans.length,
                    planDiff: diff,
                    warning:
                      "This will REPLACE ALL plans. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        await snapshots.create("restorePlans", ["plans"], {
          plans: exportData.plans,
        });

        await assertPlansUnchanged(bridge, currentPlans);
        await bridge.restorePlans(plans);

        const { verified, detail } = await verify(bridge, "plans", plans);

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  verified,
                  ...(detail ? { verificationDetail: detail } : {}),
                  planDiff: diff,
                  message: verified
                    ? "All plans replaced and verified. Snapshot saved."
                    : "All plans replaced. Snapshot saved. Verification inconclusive - check with projectionlab_describe_schema.",
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

  // --- Restore Progress ---
  server.registerTool(
    "projectionlab_restore_progress",
    {
      title: "Restore Progress",
      description:
        "REPLACES the Progress state with the provided data. " +
        "This is a FULL REPLACEMENT, not a patch. " +
        "When confirm is false (default), returns a dry-run preview. " +
        "When confirm is true, auto-snapshots then applies the replacement. " +
        "Use projectionlab_rollback with that snapshot to undo it; a manual export first is not needed.",
      inputSchema: {
        progress: z
          .unknown()
          .describe("Complete progress object to replace with"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ progress, confirm }) => {
      try {
        checkReadOnly();

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    operation: "restoreProgress",
                    warning:
                      "This will REPLACE all Progress data. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        const exportData = await bridge.exportData({ fresh: true });
        await snapshots.create("restoreProgress", ["progress"], {
          progress: exportData.progress,
        });

        await bridge.restoreProgress(progress);

        const { verified, detail } = await verify(bridge, "progress", progress);

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  verified,
                  ...(detail ? { verificationDetail: detail } : {}),
                  message: verified
                    ? "Progress replaced and verified. Snapshot saved."
                    : "Progress replaced. Snapshot saved. Verification inconclusive.",
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

  // --- Restore Settings ---
  server.registerTool(
    "projectionlab_restore_settings",
    {
      title: "Restore Settings",
      description:
        "REPLACES the Settings state with the provided data. " +
        "This is a FULL REPLACEMENT, not a patch. " +
        "When confirm is false (default), returns a dry-run preview. " +
        "When confirm is true, auto-snapshots then applies the replacement. " +
        "Use projectionlab_rollback with that snapshot to undo it; a manual export first is not needed.",
      inputSchema: {
        settings: z
          .record(z.string(), z.unknown())
          .describe("Complete settings object to replace with"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ settings, confirm }) => {
      try {
        checkReadOnly();

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    operation: "restoreSettings",
                    topLevelKeys: Object.keys(settings),
                    warning:
                      "This will REPLACE all Settings. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        const exportData = await bridge.exportData({ fresh: true });
        await snapshots.create("restoreSettings", ["settings"], {
          settings: exportData.settings,
        });

        await bridge.restoreSettings(settings);

        const { verified, detail } = await verify(bridge, "settings", settings);

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  verified,
                  ...(detail ? { verificationDetail: detail } : {}),
                  message: verified
                    ? "Settings replaced and verified. Snapshot saved."
                    : "Settings replaced. Snapshot saved. Verification inconclusive.",
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
