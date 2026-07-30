import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import type {
  ExportedData,
  FinancialSummary,
  PlanSummary,
} from "../types/projectionlab.js";

function buildSummary(data: ExportedData): FinancialSummary {
  const finances = data.today as Record<string, unknown> | undefined;
  const accountsByType: Record<string, { count: number; total: number }> = {};
  let totalNetWorth = 0;

  if (finances && typeof finances === "object") {
    const sections = [
      "investmentAccounts",
      "savingsAccounts",
      "debts",
      "assets",
    ];

    for (const section of sections) {
      const items = (finances as Record<string, unknown>)[section];
      if (!Array.isArray(items)) continue;

      const group = { count: 0, total: 0 };
      for (const item of items) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const balance = Number(obj.balance ?? obj.value ?? 0);
          group.count++;
          group.total += balance;
          // Debts reduce net worth
          if (section === "debts") {
            totalNetWorth -= Math.abs(balance);
          } else {
            totalNetWorth += balance;
          }
        }
      }
      if (group.count > 0) {
        accountsByType[section] = group;
      }
    }
  }

  const countSection = (data: ExportedData, key: string): number => {
    const today = data.today as Record<string, unknown> | undefined;
    if (!today) return 0;
    const items = today[key];
    return Array.isArray(items) ? items.length : 0;
  };

  const PLAN_PARAMS = [
    "retirementAge",
    "endAge",
    "lifeExpectancy",
    "startAge",
    "currentAge",
    "withdrawalRate",
    "inflationRate",
  ];

  const plans: PlanSummary[] = Array.isArray(data.plans)
    ? data.plans.map((p) => {
        const obj = p as Record<string, unknown>;
        const summary: PlanSummary = {
          id: String(obj.id ?? ""),
          name: String(obj.name ?? "unnamed"),
        };
        for (const key of PLAN_PARAMS) {
          if (obj[key] !== undefined) {
            summary[key] = obj[key];
          }
        }
        return summary;
      })
    : [];

  return {
    scope: "currentFinances",
    projectedOutcomesAvailable: false,
    totalNetWorth,
    accountsByType,
    planCount: plans.length,
    plans,
    incomeCount: countSection(data, "incomes"),
    expenseCount: countSection(data, "expenses"),
    milestoneCount: countSection(data, "milestones"),
  };
}

export function registerSummaryTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_get_summary",
    {
      title: "Current Finances Summary",
      description:
        "Returns a compact inventory of CURRENT finances: net worth as of today " +
        "(sum of current balances, not a projected outcome), account breakdown " +
        "by type, counts, and plan names. It does not return ending net worth or " +
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
        plans: z.array(z.record(z.string(), z.unknown())),
        incomeCount: z.number(),
        expenseCount: z.number(),
        milestoneCount: z.number(),
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
