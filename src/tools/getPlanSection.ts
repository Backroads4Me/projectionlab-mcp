import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { detectLayout, exportSections } from "../layout.js";
import { baselinePlanId, eventLink, linkedPathsChanged } from "../linkedFields.js";
import { annotateAddressableValues } from "../dataModel.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import { listAddressableValues } from "../pathPatch.js";
import { redactSecrets } from "../redact.js";
import {
  PLAN_SECTIONS,
  eventLabel,
  resolveEventIndex,
  resolvePlan,
  getEvents,
  planNotFoundError,
  requirePlans,
  resolveLinkedEventIndex,
  type PlanObj,
} from "../plans.js";

/** Resolve a dot-path like "events[3].rothConversions" or "events.3.name". */
function resolvePath(root: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p.length > 0);
  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      current = (current as PlanObj)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function registerGetPlanSectionTool(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerTool(
    "projectionlab_get_plan_section",
    {
      title: "Get Plan Section",
      description:
        "Returns a specific section of a plan (e.g., just milestones, income, expenses, " +
        "accounts, variables, etc.). Much smaller than a full plan export. " +
        "Narrow further with eventIdentifier (single event by name/ID) or path " +
        "(dot-path within the section, e.g. 'events[2].rothConversions'). " +
        "Set listPaths=true to flatten the selected object into discrete, typed dot paths " +
        "that can be used with projectionlab_update_plan_event pathChanges. " +
        "Use this for targeted analysis of a specific aspect of a plan.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SECTIONS)
          .describe("Which section of the plan to return"),
        eventIdentifier: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Return only the event whose name (case-insensitive; a partial match must identify exactly one event) or ID matches. " +
              "On ProjectionLab 5 the ID of the Current Finances account or asset an account, asset or priority event links to also matches. " +
              "Only valid for event-based sections (income, expenses, accounts, assets, milestones, priorities).",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Dot-path within the section to return, e.g. 'events[2].rothConversions'. " +
              "Applied after eventIdentifier if both are given (path is then relative to the event).",
          ),
        listPaths: z
          .boolean()
          .default(false)
          .describe(
            "Flatten the selected object into addressable leaf paths with current values and JSON types. Arrays remain intact. On one ProjectionLab 5 event linked to Current Finances, paths marked syncedFrom take their value from the linked item, and plan writes to them are refused.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, section, eventIdentifier, path, listPaths }) => {
      try {
        const data = await bridge.exportData();
        const plans = requirePlans(data);
        const plan = resolvePlan(plans, planIdentifier);
        if (!plan) throw planNotFoundError(plans, planIdentifier);

        let sectionData = plan[section];
        if (sectionData === undefined) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `Section "${section}" not found in plan "${plan.name}"`,
            `Available sections: ${Object.keys(plan).sort().join(", ")}`,
          );
        }

        if (eventIdentifier !== undefined) {
          const events = getEvents(sectionData);
          let index = resolveEventIndex(events, eventIdentifier);
          // A ProjectionLab 5 event names its Current Finances account or
          // asset by accountId/assetId, so that id selects the event too.
          if (index === -1 && detectLayout(data) === "v5") {
            index = resolveLinkedEventIndex(events, eventIdentifier);
          }
          const match = index === -1 ? undefined : events[index];
          if (!match) {
            throw new ProjectionLabError(
              "INVALID_INPUT",
              `No event matching "${eventIdentifier}" in section "${section}" of plan "${plan.name}"`,
              `Available events: ${events.map(eventLabel).sort().join(", ") || "(none)"}`,
            );
          }
          sectionData = match;
        }

        if (path !== undefined) {
          const resolved = resolvePath(sectionData, path);
          if (resolved === undefined) {
            throw new ProjectionLabError(
              "INVALID_INPUT",
              `Path "${path}" not found in section "${section}" of plan "${plan.name}"`,
              "Fetch the section without a path to inspect its structure",
            );
          }
          sectionData = resolved;
        }

        if (listPaths) {
          const listed = annotateAddressableValues(
            section,
            listAddressableValues(sectionData),
            detectLayout(data),
          );
          // On one linked event, mark the paths ProjectionLab copies from the
          // item the event links to; plan writes to them are refused.
          const link =
            eventIdentifier !== undefined && path === undefined
              ? eventLink(section, sectionData, detectLayout(data))
              : undefined;
          if (link) {
            const isBaseline =
              plan.id === baselinePlanId(exportSections(data).settings);
            const event = sectionData as PlanObj;
            sectionData = listed.map((entry) =>
              linkedPathsChanged(event, link, [entry.path], isBaseline).length > 0
                ? { ...entry, syncedFrom: link.target }
                : entry,
            );
          } else {
            sectionData = listed;
          }
        }

        const output = {
          planName: plan.name,
          planId: plan.id,
          section,
          ...(eventIdentifier !== undefined ? { eventIdentifier } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(listPaths ? { listPaths: true } : {}),
          data: sectionData,
        };

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(
                toJson(redactSecrets(output, { byName: true })),
                `section-${section}`,
                {
                  planName: plan.name,
                  section,
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
