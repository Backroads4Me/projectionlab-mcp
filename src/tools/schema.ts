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
import { planEventCounts } from "../plans.js";

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
        // A real-estate record holds its loan in `balance` and its market
        // value in `amount` (observed ProjectionLab storage), so label them
        // as separate named fields; a single `balance` would read as if the
        // loan were the property's value.
        if (section === "assets" && obj.type === "real-estate") {
          accounts.push({
            id: String(obj.id ?? ""),
            name: String(obj.name ?? "unknown"),
            type: "real-estate",
            marketValue: Number(obj.amount ?? 0),
            loanBalance: Number(obj.balance ?? 0),
          });
          continue;
        }
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

export function registerSchemaTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_describe_schema",
    {
      title: "Describe Schema",
      description:
        "Returns a lightweight summary of the ProjectionLab data structure without the full payload. " +
        "Includes top-level keys, account list (IDs, names, types, balances; real-estate rows report type \"real-estate\" with marketValue and loanBalance in place of balance), plans (IDs, names, and each plan's income, expense, and milestone event counts), " +
        "and the progress entry count. " +
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
          plans: extractPlans(data).map((plan) => ({
            id: plan.id,
            name: plan.name,
            ...planEventCounts(plan),
          })) as PlanSummary[],
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
