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
        // An asset record holds its loan in `balance` and its market value in
        // `amount` (observed ProjectionLab storage, the same reading as
        // src/summary.ts), so label them as separate named fields; a single
        // `balance` would read as if the loan were the asset's value.
        if (section === "assets") {
          accounts.push({
            id: String(obj.id ?? ""),
            name: String(obj.name ?? "unknown"),
            type: obj.type === "real-estate" ? "real-estate" : section,
            marketValue: Number(obj.amount ?? obj.value ?? 0),
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

// ProjectionLab exports progress tracking as `{ data: [...] }` (observed in
// ProjectionLab 4.6.0 exports); a bare array is counted too.
function progressEntryCount(progress: unknown): number {
  if (Array.isArray(progress)) return progress.length;
  if (progress && typeof progress === "object") {
    const entries = (progress as Record<string, unknown>).data;
    if (Array.isArray(entries)) return entries.length;
  }
  return 0;
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
        "Includes top-level keys, account list (IDs, names, types, balances; asset rows report marketValue and loanBalance in place of balance, with type \"real-estate\" for real estate), plans (IDs, names, and each plan's income, expense, and milestone event counts), " +
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
          progressEntryCount: progressEntryCount(data.progress),
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
