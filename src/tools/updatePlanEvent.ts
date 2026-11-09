import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { assertPlansUnchanged } from "../planVersion.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import {
  applyExistingPathChanges,
  pathChangesApplied,
  type PathValueChange,
} from "../pathPatch.js";
import { redactSecrets } from "../redact.js";
import {
  diffFields,
  eventLabel,
  findEventIndex,
  findPlanIndex,
  getEvents,
  planNotFoundError,
  requirePlans,
  type PlanObj,
} from "../plans.js";

// Only event-based sections; configuration objects use
// projectionlab_update_plan_settings.
const EVENT_SECTIONS = [
  "income",
  "expenses",
  "accounts",
  "assets",
  "milestones",
  "priorities",
] as const;

const EVENT_FIELD_CONTEXT = {
  label: "event field",
  discoveryTool: "projectionlab_get_plan_section with listPaths=true",
  example: '{ "taxHandling.withholding": "auto" }',
} as const;

function assertMutableEventPath(path: string): void {
  if (path === "id" || path.startsWith("id.")) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "The event ID is immutable",
      "Use the ID only to select the event",
    );
  }
}

/** Rebuild a section with one event replaced, preserving its container shape. */
function replaceEvent(
  sectionData: unknown,
  eventIndex: number,
  newEvent: PlanObj,
): unknown {
  if (Array.isArray(sectionData)) {
    const copy = [...sectionData];
    copy[eventIndex] = newEvent;
    return copy;
  }
  const obj = sectionData as PlanObj;
  const events = [...(obj.events as unknown[])];
  events[eventIndex] = newEvent;
  return { ...obj, events };
}

export function registerUpdatePlanEventTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_update_plan_event",
    {
      title: "Update Plan Event",
      description:
        "Patches ONE event (income source, expense, account, asset, milestone, or priority) " +
        "within ONE plan. Use pathChanges for nested fields so nested siblings are preserved; " +
        "get valid paths from projectionlab_get_plan_section with eventIdentifier and listPaths=true. " +
        "See projectionlab://data-model for field units and allowed values. " +
        "The legacy patch input shallowly merges top-level fields and replaces any nested object " +
        "supplied there. Supply exactly one of patch or pathChanges. All sibling events are preserved. " +
        "This is the PREFERRED write tool for single-event changes: much smaller and " +
        "safer than regenerating a whole section. " +
        "When confirm is false (default), returns a dry-run field-level diff. " +
        "When confirm is true, auto-snapshots all plans, applies the patch, and verifies.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(EVENT_SECTIONS)
          .describe("Which event-based section of the plan the event lives in"),
        eventIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Event name (case-insensitive, exact match preferred over partial) or exact event ID",
          ),
        patch: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Top-level fields to change, e.g. { amount: 5000 }. Merged shallowly; a nested object replaces that complete nested object. Use pathChanges for nested fields.",
          ),
        pathChanges: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Preferred for nested fields. Dot-path to value map, e.g. { "taxHandling.withholding": "auto" }. Paths must exist and retain their current JSON types.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run field diff.",
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
      eventIdentifier,
      patch,
      pathChanges,
      confirm,
    }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
            "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
          );
        }

        if ((patch === undefined) === (pathChanges === undefined)) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "Supply exactly one of patch or pathChanges",
            "Use patch for top-level fields or pathChanges for nested dot paths",
          );
        }

        const data = await bridge.exportData({ fresh: true });
        const plans = requirePlans(data);

        const planIndex = findPlanIndex(plans, planIdentifier);
        if (planIndex === -1) throw planNotFoundError(plans, planIdentifier);
        const plan = plans[planIndex] as PlanObj;

        const sectionData = plan[section];
        const events = getEvents(sectionData);
        if (events.length === 0) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `Section "${section}" of plan "${plan.name}" has no events`,
            "Check the section name with projectionlab_get_plan_section",
          );
        }

        const eventIndex = findEventIndex(events, eventIdentifier);
        if (eventIndex === -1) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `No event matching "${eventIdentifier}" in section "${section}" of plan "${plan.name}"`,
            `Available events: ${events.map(eventLabel).sort().join(", ")}`,
          );
        }

        const event = events[eventIndex] as PlanObj;
        let patched: PlanObj;
        let changes: Record<string, string> | Record<string, PathValueChange>;
        let pathDiff: Record<string, PathValueChange> | undefined;
        if (pathChanges !== undefined) {
          for (const path of Object.keys(pathChanges)) {
            assertMutableEventPath(path);
          }
          const result = applyExistingPathChanges(
            event,
            pathChanges,
            EVENT_FIELD_CONTEXT,
            section,
          );
          patched = result.updated;
          changes = result.changes;
          pathDiff = result.changes;
        } else {
          for (const key of Object.keys(patch ?? {})) {
            assertMutableEventPath(key);
          }
          patched = { ...event, ...patch };
          changes = diffFields(event, patched);
        }
        const renderedChanges = redactSecrets(changes, { byName: true });

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "updatePlanEvent",
                  planName: plan.name,
                  planId: plan.id,
                  section,
                  event: eventLabel(event),
                  changes: renderedChanges,
                  warning:
                    Object.keys(changes).length === 0
                      ? "Patch matches the current event - nothing would change."
                      : `This will patch event "${eventLabel(event)}" in "${section}" of plan "${plan.name}". Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        if (Object.keys(changes).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  success: true,
                  planName: plan.name,
                  section,
                  event: eventLabel(event),
                  changes: renderedChanges,
                  verified: true,
                  message:
                    "The supplied values already match the event; no mutation was sent.",
                }),
              },
            ],
          };
        }

        await snapshots.create("updatePlanEvent", ["plans"], { plans });

        const updatedPlan = {
          ...plan,
          [section]: replaceEvent(sectionData, eventIndex, patched),
        };
        const updatedPlans = [...plans];
        updatedPlans[planIndex] = updatedPlan;

        await assertPlansUnchanged(bridge, plans);
        log.info(
          "updatePlanEvent",
          `Patching event "${eventLabel(event)}" in "${section}" of plan "${plan.name}" (${Object.keys(changes).length} fields)`,
        );

        await bridge.restorePlans(updatedPlans);

        // Verify the patched fields on a fresh read
        let verified = false;
        const verifyData = await bridge.exportData({ fresh: true });
        const verifiedPlan = (
          Array.isArray(verifyData.plans) ? verifyData.plans : []
        ).find(
          (p) => p && typeof p === "object" && (p as PlanObj).id === plan.id,
        ) as PlanObj | undefined;
        if (verifiedPlan) {
          const verifiedEvents = getEvents(verifiedPlan[section]);
          const verifiedEvent = verifiedEvents.find(
            (e) =>
              e &&
              typeof e === "object" &&
              ((event.id !== undefined &&
                (e as PlanObj).id === event.id) ||
                eventLabel(e) === eventLabel(patched)),
          ) as PlanObj | undefined;
          if (verifiedEvent) {
            verified =
              pathDiff !== undefined
                ? pathChangesApplied(
                    verifiedEvent,
                    pathDiff,
                    EVENT_FIELD_CONTEXT,
                  )
                : Object.entries(patch ?? {}).every(
                    ([key, expected]) =>
                      JSON.stringify(verifiedEvent[key]) ===
                      JSON.stringify(expected),
                  );
          }
        }

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                planName: plan.name,
                section,
                event: eventLabel(patched),
                changes: renderedChanges,
                verified,
                message: verified
                  ? "Event patched and verified. Snapshot saved automatically."
                  : "Patch sent but verification did not confirm all fields - check with projectionlab_get_plan_section.",
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
