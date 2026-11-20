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
        "(account balances plus asset market values, minus debts and asset loans; not a " +
        "projected outcome), account breakdown by type (assets totaled at market value), " +
        "and each plan's name with its income, expense and milestone event counts. " +
        "On ProjectionLab 5 the account breakdown is keyed by the stored kind and type " +
        "(for example \"account:taxable\", \"real-asset:land\", \"debt:secured-loan\"), " +
        "real assets carry their equity after the debts that name them in securedByAssetId, " +
        "and archived accounts are listed apart and left out of every total. " +
        "It does not return ending net worth or " +
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
        layout: z
          .literal("v5")
          .optional()
          .describe("The export layout: always \"v5\", the ProjectionLab 5 export"),
        accountsByKind: z
          .record(z.string(), z.object({ count: z.number(), total: z.number() }))
          .optional()
          .describe(
            "ProjectionLab 5: unarchived accounts grouped by kind (account, real-asset, debt); debt totals are magnitudes",
          ),
        realAssets: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "ProjectionLab 5: each unarchived real asset with value, loanBalance, equity and the securedDebts that name it",
          ),
        archivedAccounts: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "ProjectionLab 5: archived accounts (id, name, kind, type, archivedOn), excluded from every total",
          ),
        unrecognizedAccounts: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            "ProjectionLab 5: unarchived accounts of an unrecognized kind, excluded from every total",
          ),
        household: z
          .object({
            partnerStatus: z.string().optional(),
            people: z.array(z.record(z.string(), z.unknown())),
          })
          .optional()
          .describe(
            "ProjectionLab 5: the people of household.people (me, spouse); an absent person is omitted",
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
          // SAFETY: a plain JSON object whose fields the outputSchema describes.
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
