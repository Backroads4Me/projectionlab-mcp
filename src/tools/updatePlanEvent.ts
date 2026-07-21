import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import {
  diffFields,
  eventLabel,
  findPlanIndex,
  getEvents,
  planNotFoundError,
  requirePlans,
  type PlanObj,
} from "../plans.js";

// Only the event-based sections; variables/montecarlo/etc. go through
// projectionlab_update_plan_section.
const EVENT_SECTIONS = [
  "income",
  "expenses",
  "accounts",
  "assets",
  "milestones",
  "priorities",
] as const;

function findEventIndex(events: unknown[], identifier: string): number {
  const lower = identifier.toLowerCase();
  let exactName = -1;
  let partial = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== "object") continue;
    const obj = e as PlanObj;
    if (String(obj.id ?? "") === identifier) return i;
    const name = String(obj.name ?? "").toLowerCase();
    if (name === lower && exactName === -1) exactName = i;
    else if (name.includes(lower) && partial === -1) partial = i;
  }
  return exactName !== -1 ? exactName : partial;
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
        "within ONE plan. The patch is merged into the existing event server-side, so only the " +
        "changed fields need to be supplied — all sibling events and other fields are preserved " +
        "untouched. This is the PREFERRED write tool for single-event changes: much smaller and " +
        "safer than regenerating a whole section. " +
        "When confirm is false (default), returns a dry-run field-level diff. " +
        "When confirm is true, auto-snapshots all plans, applies the patch, and verifies.",
      inputSchema: {
        planIdentifier: z
          .string()
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(EVENT_SECTIONS)
          .describe("Which event-based section of the plan the event lives in"),
        eventIdentifier: z
          .string()
          .describe(
            "Event name (case-insensitive, exact match preferred over partial) or exact event ID",
          ),
        patch: z
          .record(z.string(), z.unknown())
          .describe(
            "Fields to change on the event, e.g. { amount: 5000 }. Merged shallowly into the existing event — nested objects supplied here replace the existing nested object wholesale.",
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
    async ({ planIdentifier, section, eventIdentifier, patch, confirm }) => {
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
        const patched = { ...event, ...patch };
        const changes = diffFields(event, patched);

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
                  changes,
                  warning:
                    Object.keys(changes).length === 0
                      ? "Patch matches the current event — nothing would change."
                      : `This will patch event "${eventLabel(event)}" in "${section}" of plan "${plan.name}". Set confirm=true to proceed.`,
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
          verified =
            !!verifiedEvent &&
            Object.entries(patch).every(
              ([key, expected]) =>
                JSON.stringify(verifiedEvent[key]) ===
                JSON.stringify(expected),
            );
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
                changes,
                verified,
                message: verified
                  ? "Event patched and verified. Snapshot saved automatically."
                  : "Patch sent but verification did not confirm all fields — check with projectionlab_get_plan_section.",
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
