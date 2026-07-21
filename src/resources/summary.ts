import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { log } from "../logger.js";

function buildSummary(data: Record<string, unknown>) {
  const finances = data.today as Record<string, unknown> | undefined;
  const accountsByType: Record<string, { count: number; total: number }> = {};
  let totalNetWorth = 0;

  if (finances && typeof finances === "object") {
    for (const section of [
      "investmentAccounts",
      "savingsAccounts",
      "debts",
      "assets",
    ]) {
      const items = (finances as Record<string, unknown>)[section];
      if (!Array.isArray(items)) continue;
      const group = { count: 0, total: 0 };
      for (const item of items) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const balance = Number(obj.balance ?? obj.value ?? 0);
          group.count++;
          group.total += balance;
          totalNetWorth += section === "debts" ? -Math.abs(balance) : balance;
        }
      }
      if (group.count > 0) accountsByType[section] = group;
    }
  }

  const plans = Array.isArray(data.plans)
    ? data.plans.map((p) => {
        const obj = p as Record<string, unknown>;
        return { id: String(obj.id ?? ""), name: String(obj.name ?? "unnamed") };
      })
    : [];

  return { totalNetWorth, accountsByType, planCount: plans.length, plans };
}

export function registerSummaryResource(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerResource(
    "summary",
    "projectionlab://summary",
    {
      title: "Financial Summary",
      description:
        "High-level financial snapshot: net worth, account breakdown, plan count. Refreshed on each access.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await bridge.exportData();
        const summary = buildSummary(data);
        return {
          contents: [
            {
              uri: uri.href,
              text: toJson(summary),
              mimeType: "application/json",
            },
          ],
        };
      } catch (err) {
        log.error("resource:summary", String(err));
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: "Failed to build summary",
                details: err instanceof Error ? err.message : String(err),
              }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );
}
