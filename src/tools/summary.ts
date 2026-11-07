import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { buildSummary } from "../summary.js";

export function registerSummaryTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_get_summary",
    {
      title: "Current Finances Summary",
      description:
        "Returns a compact inventory of CURRENT finances: net worth as of today " +
        "(sum of current balances, not a projected outcome), account breakdown " +
        "by type, and each plan's name with its income, expense and milestone event counts. It does not return ending net worth or " +
        "Chance of Success and must not be used to judge a plan change's impact.",
      outputSchema: {
        scope: z.literal("currentFinances"),
        projectedOutcomesAvailable: z.literal(false),
        totalNetWorth: z
          .number()
          .describe(
            "Current-finances net worth from today's balances; not projected ending net worth",
          ),
        accountsByType: z.record(
          z.string(),
          z.object({ count: z.number(), total: z.number() }),
        ),
        planCount: z.number(),
        plans: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            "Each plan's id, name, and incomeCount, expenseCount and milestoneCount",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await bridge.exportData();
        const summary = buildSummary(data);
        return {
          content: [{ type: "text", text: toJson(summary) }],
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
