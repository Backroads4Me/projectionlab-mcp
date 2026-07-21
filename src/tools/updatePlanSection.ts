import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import {
  PLAN_SECTIONS,
  diffFields,
  eventLabel,
  findPlanIndex,
  getEvents,
  planNotFoundError,
  requirePlans,
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
  const currentByName = new Map(
    currentEvents.map((e) => [eventLabel(e), e] as const),
  );
  const newByName = new Map(newEvents.map((e) => [eventLabel(e), e] as const));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: { name: string; changes: Record<string, string> }[] = [];
  const unchanged: string[] = [];

  for (const [name, event] of newByName) {
    const existing = currentByName.get(name);
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
  for (const name of currentByName.keys()) {
    if (!newByName.has(name)) removed.push(name);
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

function renderDiff(diff: DiffResult) {
  return {
    itemCount: `${diff.currentCount} → ${diff.newCount}`,
    added: diff.added.length > 0 ? diff.added : undefined,
    removed: diff.removed.length > 0 ? diff.removed : undefined,
    modified: diff.modified.length > 0 ? diff.modified : undefined,
    unchanged: diff.unchanged.length > 0 ? diff.unchanged : undefined,
    fieldChanges: diff.fieldChanges,
  };
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
        "Prefer projectionlab_update_plan_event when changing a single event — it is smaller and safer. " +
        "IMPORTANT: Always fetch fresh section data via projectionlab_get_plan_section before " +
        "constructing sectionData — never mutate from stale data.",
      inputSchema: {
        planIdentifier: z
          .string()
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, section, sectionData, confirm }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (PL_READ_ONLY=true)",
            "Set PL_READ_ONLY=false to enable writes",
          );
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
                  section,
                  diff: renderDiff(diff),
                  warning: `This will replace the "${section}" section of plan "${plan.name}". Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        // Snapshot all plans before mutation
        await snapshots.create("updatePlanSection", ["plans"], {
          plans,
        });

        // Rebuild plans array with the one section replaced
        const updatedPlan = { ...plan, [section]: sectionData };
        const updatedPlans = [...plans];
        updatedPlans[planIndex] = updatedPlan;

        log.info(
          "updatePlanSection",
          `Updating "${section}" of plan "${plan.name}" (${diff.currentCount} → ${diff.newCount} items)`,
        );

        await bridge.restorePlans(updatedPlans);

        // Verify by re-reading; match by plan id since order may change
        const verifyData = await bridge.exportData({ fresh: true });
        const verifiedPlan = (
          Array.isArray(verifyData.plans) ? verifyData.plans : []
        ).find(
          (p) => p && typeof p === "object" && (p as PlanObj).id === plan.id,
        ) as PlanObj | undefined;
        const verified = verifiedPlan
          ? getEvents(verifiedPlan[section]).length ===
            getEvents(sectionData).length
          : false;

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                planName: plan.name,
                section,
                diff: renderDiff(diff),
                verified,
                message: verified
                  ? "Section updated and verified. Snapshot saved automatically."
                  : "Section update sent but verification count mismatch — check with projectionlab_get_plan_section.",
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
