import { planEventCounts } from "./plans.js";
import type {
  ExportedData,
  FinancialSummary,
  PlanSummary,
} from "./types/projectionlab.js";

/**
 * Current Finances totals and the plan inventory, shared by the
 * projectionlab_get_summary tool and the projectionlab://summary resource.
 * Totals come from today's balances, never from projected outcomes.
 */
export function buildSummary(data: ExportedData): FinancialSummary {
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
          ...planEventCounts(obj),
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
  };
}
