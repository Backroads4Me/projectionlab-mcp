import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import type {
  AccountSummary,
  ExportedData,
  PlanSummary,
  SchemaDescription,
} from "../types/projectionlab.js";

function extractAccounts(data: ExportedData): AccountSummary[] {
  const finances = data.today;
  if (!finances || typeof finances !== "object") return [];

  const accounts: AccountSummary[] = [];

  // ProjectionLab stores accounts in various arrays within the "today" section
  const sections = [
    "investmentAccounts",
    "savingsAccounts",
    "debts",
    "assets",
  ];

  for (const section of sections) {
    const items = (finances as Record<string, unknown>)[section];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        accounts.push({
          id: String(obj.id ?? ""),
          name: String(obj.name ?? "unknown"),
          type: section,
          balance: Number(obj.balance ?? obj.value ?? 0),
        });
      }
    }
  }

  return accounts;
}

function extractPlans(data: ExportedData): PlanSummary[] {
  if (!Array.isArray(data.plans)) return [];

  return data.plans.map((plan) => {
    const obj = plan as Record<string, unknown>;
    return {
      id: String(obj.id ?? ""),
      name: String(obj.name ?? "unnamed"),
      ...obj,
    };
  });
}

function countItems(data: ExportedData, section: string): number {
  const today = data.today as Record<string, unknown> | undefined;
  if (!today) return 0;
  const items = today[section];
  return Array.isArray(items) ? items.length : 0;
}

export function registerSchemaTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_describe_schema",
    {
      title: "Describe Schema",
      description:
        "Returns a lightweight summary of the ProjectionLab data structure without the full payload. " +
        "Includes top-level keys, account list (IDs, names, types, balances), plan names, " +
        "and counts of income sources, expenses, milestones, and progress entries. " +
        "Use this to understand the data model before crafting queries or mutations.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const data = await bridge.exportData();

        const topLevelKeysWithTypes = Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            Array.isArray(value)
              ? `array(${value.length})`
              : value === null
                ? "null"
                : typeof value,
          ]),
        );

        const schema: SchemaDescription = {
          topLevelKeys: topLevelKeysWithTypes,
          accounts: extractAccounts(data),
          plans: extractPlans(data).map(({ id, name }) => ({
            id,
            name,
          })) as PlanSummary[],
          incomeCount: countItems(data, "incomes"),
          expenseCount: countItems(data, "expenses"),
          milestoneCount: countItems(data, "milestones"),
          progressEntryCount: Array.isArray(data.progress)
            ? data.progress.length
            : 0,
        };

        return {
          content: [{ type: "text", text: toJson(schema) }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
