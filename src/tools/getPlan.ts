import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import {
  findPlan,
  getEvents,
  planNotFoundError,
  requirePlans,
} from "../plans.js";

export function registerGetPlanTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_get_plan",
    {
      title: "Get Plan",
      description:
        "Returns a single plan by name or ID. Much smaller than export_data. " +
        "Use this for deep analysis of a specific plan; prefer " +
        "projectionlab_get_plan_section when only one aspect is needed. " +
        "Accepts a plan name (case-insensitive partial match) or exact plan ID.",
      inputSchema: {
        planIdentifier: z
          .string()
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier }) => {
      try {
        const data = await bridge.exportData();
        const plans = requirePlans(data);
        const plan = findPlan(plans, planIdentifier);
        if (!plan) throw planNotFoundError(plans, planIdentifier);

        const header = {
          name: plan.name,
          id: plan.id,
          milestoneCount: getEvents(plan.milestones).length,
          incomeEventCount: getEvents(plan.income).length,
          expenseEventCount: getEvents(plan.expenses).length,
          accountEventCount: getEvents(plan.accounts).length,
          assetEventCount: getEvents(plan.assets).length,
          sections: Object.keys(plan).sort(),
        };

        const output = `Plan summary: ${toJson(header)}\n\nFull plan data:\n${toJson(plan)}`;

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(output, "plan", { planSummary: header }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
