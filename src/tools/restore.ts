import { z } from "zod";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import {
  ProjectionLabError,
  errorResult,
  redactedSecretsError,
} from "../errors.js";
import { detectLayout, exportSections, sectionOf } from "../layout.js";
import { v5AccountsKept } from "../currentFinances.js";
import { log } from "../logger.js";
import { containsSubset } from "../plans.js";
import { findRedactedSecretPaths, keepStoredSecrets } from "../redact.js";
import { assertWritesSupported } from "./writeGuard.js";

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

/** Strip the `lastUpdated` stamp ProjectionLab sets when it saves a plan. */
function withoutPlanStamps(plans: unknown): unknown {
  if (!Array.isArray(plans)) return plans;
  return plans.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    const { lastUpdated: _stamp, ...rest } = p as Obj;
    return rest;
  });
}

/** Strip the top-level `lastUpdated` stamp ProjectionLab sets when it saves a document. */
function withoutStamp(document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const { lastUpdated: _stamp, ...rest } = document as Obj;
  return rest;
}

/**
 * True when a fresh export shows the restored `expected` data for `section`.
 * The app may add fields of its own and re-stamps `lastUpdated` on each saved
 * plan and on the Current Finances and Settings documents, so this checks that every
 * restored value other than those stamps is present rather than requiring
 * byte-for-byte equality.
 */
export function restoredSectionMatches(
  section: string,
  expected: unknown,
  actual: unknown,
): boolean {
  if (section === "plans") {
    return containsSubset(withoutPlanStamps(expected), actual);
  }
  if (section === "currentFinances" || section === "settings") {
    return containsSubset(withoutStamp(expected), actual);
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
    const fresh = await bridge.exportData({ fresh: true });
    const actual = sectionOf(fresh, section);
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
        "REPLACES the Current Finances state with the provided data. " +
        "On ProjectionLab 4 this is a FULL REPLACEMENT, not a patch - the entire current finances object is overwritten. " +
        "On ProjectionLab 5 every non-account field and each submitted account is replaced whole, but an " +
        "account missing from the submission is kept, not deleted; the preview lists those as keptAccounts. " +
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
        const redactedPaths = findRedactedSecretPaths(currentFinances);
        if (redactedPaths.length > 0) {
          throw redactedSecretsError("currentFinances", redactedPaths);
        }

        await assertWritesSupported(bridge, ["restoreCurrentFinances"]);
        const exportData = await bridge.exportData({ fresh: true });
        const layout = detectLayout(exportData);
        const stored = sectionOf(exportData, "currentFinances");
        const kept =
          layout === "v5" ? { keptAccounts: v5AccountsKept(currentFinances, stored) } : {};
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
                    ...kept,
                    warning:
                      layout === "v5"
                        ? "This will replace every Current Finances field and each submitted account. Accounts in keptAccounts are not in the submission and stay as they are. Set confirm=true to proceed."
                        : "This will REPLACE all Current Finances data. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        await snapshots.create("restoreCurrentFinances", ["currentFinances"], {
          currentFinances: stored,
        }, layout);

        await bridge.restoreCurrentFinances(currentFinances, layout);

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
                  ...kept,
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
        const redactedPaths = findRedactedSecretPaths(plans);
        if (redactedPaths.length > 0) {
          throw redactedSecretsError("plans", redactedPaths);
        }

        await assertWritesSupported(bridge, ["restorePlans"]);
        const exportData = await bridge.exportData({ fresh: true });
        const currentPlans = exportSections(exportData).plans;
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
          plans: sectionOf(exportData, "plans"),
        }, detectLayout(exportData));

        await bridge.restorePlansIfUnchanged(currentPlans, plans, detectLayout(exportData));

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
        "Use projectionlab_rollback with that snapshot to undo it; a manual export first is not needed. " +
        "Not available on ProjectionLab 5, which records Progress history by itself.",
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
        const redactedPaths = findRedactedSecretPaths(progress);
        if (redactedPaths.length > 0) {
          throw redactedSecretsError("progress", redactedPaths);
        }

        await assertWritesSupported(bridge, ["restoreProgress"]);
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
          progress: sectionOf(exportData, "progress"),
        }, detectLayout(exportData));

        await bridge.restoreProgress(progress, detectLayout(exportData));

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
        "A secret field that a read returned as [REDACTED], such as the Plugin API key, keeps its stored value; " +
        "leave it as [REDACTED]. A payload that leaves out a stored secret is refused, since the replacement would erase it. " +
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
    async ({ settings: submitted, confirm }) => {
      try {
        checkReadOnly();
        await assertWritesSupported(bridge, ["restoreSettings"]);

        // Settings hold the Plugin API key, which every read hides. Each
        // hidden secret takes its stored value, and a payload that leaves a
        // stored secret out is refused: the whole-document replace would
        // erase it, and an erased key disconnects this server.
        const exportData = await bridge.exportData({ fresh: true });
        const stored = sectionOf(exportData, "settings");
        const { value: settings, kept, unfilled, dropped } = keepStoredSecrets(submitted, stored);
        if (unfilled.length > 0) {
          throw redactedSecretsError("settings", unfilled);
        }
        if (dropped.length > 0) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `settings leaves out stored secret values at: ${dropped.join(", ")}`,
            "projectionlab_restore_settings replaces the whole settings document, so a secret left out is erased, and erasing the Plugin API key disconnects this server. " +
              "Include each of these fields as the [REDACTED] value the read returned; the stored value is kept. Nothing was written.",
          );
        }
        const keptSecrets = kept.length > 0 ? { keptSecrets: kept } : {};

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
                    ...keptSecrets,
                    warning:
                      "This will REPLACE all Settings. Set confirm=true to proceed.",
                  },
                ),
              },
            ],
          };
        }

        await snapshots.create("restoreSettings", ["settings"], {
          settings: stored,
        }, detectLayout(exportData));

        await bridge.restoreSettings(settings, detectLayout(exportData));

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
                  ...keptSecrets,
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
