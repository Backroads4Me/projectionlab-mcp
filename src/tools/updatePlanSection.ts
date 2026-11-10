import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import {
  ProjectionLabError,
  errorResult,
  redactedSecretsError,
} from "../errors.js";
import {
  assertPlanVersion,
  assertPlansUnchanged,
  planVersion,
} from "../planVersion.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import { redactSecrets, findRedactedSecretPaths } from "../redact.js";
import {
  PLAN_SECTIONS,
  diffFields,
  eventLabel,
  findPlanIndex,
  getEvents,
  keyEvents,
  planNotFoundError,
  requirePlans,
  verifySectionApplied,
  type PlanObj,
} from "../plans.js";

interface DiffResult {
  currentCount: number;
  newCount: number;
  added: string[];
  removed: string[];
  /** Events present in both but with field-level differences. */
  modified: { name: string; changes: Record<string, string> }[];
  unchanged: string[];
  /** Top-level field diff for non-event sections (variables, montecarlo, …). */
  fieldChanges?: Record<string, string>;
}

function isEventish(sectionData: unknown): boolean {
  if (Array.isArray(sectionData)) return true;
  return (
    !!sectionData &&
    typeof sectionData === "object" &&
    Array.isArray((sectionData as PlanObj).events)
  );
}

function diffSection(current: unknown, incoming: unknown): DiffResult {
  const currentEvents = getEvents(current);
  const newEvents = getEvents(incoming);
  const fieldChanges =
    !isEventish(current) && !isEventish(incoming)
      ? diffFields(current, incoming)
      : undefined;
  const currentByName = keyEvents(currentEvents);
  const newByName = keyEvents(newEvents);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: { name: string; changes: Record<string, string> }[] = [];
  const unchanged: string[] = [];

  for (const [key, { name, event }] of newByName) {
    const existing = currentByName.get(key)?.event;
    if (existing === undefined) {
      added.push(name);
      continue;
    }
    const changes = diffFields(existing, event);
    if (Object.keys(changes).length > 0) {
      modified.push({ name, changes });
    } else {
      unchanged.push(name);
    }
  }
  for (const [key, { name }] of currentByName) {
    if (!newByName.has(key)) removed.push(name);
  }

  return {
    currentCount: currentEvents.length,
    newCount: newEvents.length,
    added: added.sort(),
    removed: removed.sort(),
    modified,
    unchanged: unchanged.sort(),
    ...(fieldChanges && Object.keys(fieldChanges).length > 0
      ? { fieldChanges }
      : {}),
  };
}

/** The preview of a section change, with secret-named fields and the Plugin
 * API key scrubbed like every other plan read. */
function renderDiff(diff: DiffResult) {
  return redactSecrets({
    itemCount: `${diff.currentCount} → ${diff.newCount}`,
    added: diff.added.length > 0 ? diff.added : undefined,
    removed: diff.removed.length > 0 ? diff.removed : undefined,
    modified: diff.modified.length > 0 ? diff.modified : undefined,
    unchanged: diff.unchanged.length > 0 ? diff.unchanged : undefined,
    fieldChanges: diff.fieldChanges,
  }, { byName: true });
}

export function registerUpdatePlanSectionTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_update_plan_section",
    {
      title: "Update Plan Section",
      description:
        "Safely updates ONE section of ONE plan. Replaces the specified section " +
        "(e.g., income, expenses, accounts) while leaving all other sections and plans untouched. " +
        "When confirm is false (default), returns a dry-run diff (added/removed/modified events " +
        "with field-level changes) showing what would change. " +
        "When confirm is true, auto-snapshots all plans, rebuilds with the updated section, " +
        "and calls restorePlans. " +
        "Prefer projectionlab_update_plan_event when changing a single event - it is smaller and safer. " +
        "IMPORTANT: Always fetch fresh section data via projectionlab_get_plan_section before " +
        "constructing sectionData - never mutate from stale data. Pass the dry-run's planVersion " +
        "as expectedPlanVersion when confirming so a plan saved in the meantime is not overwritten.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SECTIONS)
          .describe("Which section of the plan to update"),
        sectionData: z
          .unknown()
          .describe(
            "Complete replacement data for the section. Must be the full section object, not a partial patch.",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run diff preview.",
          ),
        expectedPlanVersion: z
          .string()
          .optional()
          .describe(
            "planVersion from the dry-run. When set, the confirmed write is refused if the plan was saved in ProjectionLab after the preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      planIdentifier,
      section,
      sectionData,
      confirm,
      expectedPlanVersion,
    }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
            "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
          );
        }

        const redactedPaths = findRedactedSecretPaths(sectionData);
        if (redactedPaths.length > 0) {
          throw redactedSecretsError("sectionData", redactedPaths);
        }

        const data = await bridge.exportData({ fresh: true });
        const plans = requirePlans(data);

        const planIndex = findPlanIndex(plans, planIdentifier);
        if (planIndex === -1) throw planNotFoundError(plans, planIdentifier);

        const plan = plans[planIndex] as PlanObj;
        const currentSection = plan[section];
        const diff = diffSection(currentSection, sectionData);

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "updatePlanSection",
                  planName: plan.name,
                  planId: plan.id,
                  planVersion: planVersion(plan),
                  section,
                  diff: renderDiff(diff),
                  warning: `This will replace the "${section}" section of plan "${plan.name}". Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        assertPlanVersion(plan, expectedPlanVersion);

        // Snapshot all plans before mutation
        const snapshot = await snapshots.create("updatePlanSection", ["plans"], {
          plans,
        });

        // Rebuild plans array with the one section replaced
        const updatedPlan = { ...plan, [section]: sectionData };
        const updatedPlans = [...plans];
        updatedPlans[planIndex] = updatedPlan;

        await assertPlansUnchanged(bridge, plans);
        log.info(
          "updatePlanSection",
          `Updating "${section}" of plan "${plan.name}" (${diff.currentCount} → ${diff.newCount} items)`,
        );

        await bridge.restorePlans(updatedPlans);

        // Verify by re-reading; match by plan id since order may change.
        // Compares submitted content (not just counts) so a rejected,
        // transformed, or dropped write can't report false success.
        const verifyData = await bridge.exportData({ fresh: true });
        const verifiedPlan = (
          Array.isArray(verifyData.plans) ? verifyData.plans : []
        ).find(
          (p) => p && typeof p === "object" && (p as PlanObj).id === plan.id,
        ) as PlanObj | undefined;
        const check = verifiedPlan
          ? verifySectionApplied(sectionData, verifiedPlan[section])
          : { ok: false, reason: "plan not found after write" };

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                planName: plan.name,
                section,
                diff: renderDiff(diff),
                verified: check.ok,
                snapshotId: snapshot.id,
                message: check.ok
                  ? "Section updated and verified. Snapshot saved automatically."
                  : `Section update sent but could not be verified (${check.reason}) - check with projectionlab_get_plan_section. A snapshot was saved; roll back with projectionlab_rollback if needed.`,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
