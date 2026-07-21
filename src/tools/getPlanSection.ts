import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import {
  PLAN_SECTIONS,
  eventLabel,
  findPlan,
  getEvents,
  planNotFoundError,
  requirePlans,
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
        "Use this for targeted analysis of a specific aspect of a plan.",
      inputSchema: {
        planIdentifier: z
          .string()
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SECTIONS)
          .describe("Which section of the plan to return"),
        eventIdentifier: z
          .string()
          .optional()
          .describe(
            "Return only the event whose name (case-insensitive, partial match) or ID matches. " +
              "Only valid for event-based sections (income, expenses, accounts, assets, milestones, priorities).",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Dot-path within the section to return, e.g. 'events[2].rothConversions'. " +
              "Applied after eventIdentifier if both are given (path is then relative to the event).",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, section, eventIdentifier, path }) => {
      try {
        const data = await bridge.exportData();
        const plans = requirePlans(data);
        const plan = findPlan(plans, planIdentifier);
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
          const lower = eventIdentifier.toLowerCase();
          const match = events.find((e) => {
            if (!e || typeof e !== "object") return false;
            const obj = e as PlanObj;
            return (
              String(obj.id ?? "") === eventIdentifier ||
              String(obj.name ?? "")
                .toLowerCase()
                .includes(lower)
            );
          });
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

        const output = {
          planName: plan.name,
          planId: plan.id,
          section,
          ...(eventIdentifier !== undefined ? { eventIdentifier } : {}),
          ...(path !== undefined ? { path } : {}),
          data: sectionData,
        };

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(toJson(output), `section-${section}`, {
                planName: plan.name,
                section,
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
