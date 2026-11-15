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
import {
  listV5Accounts,
  v5ArchivedStub,
  type V5AccountEntry,
} from "../currentFinances.js";
import { exportSections } from "../layout.js";
import { planEventCounts, type PlanObj } from "../plans.js";

/** A ProjectionLab 5 account row: the stored `kind` and `type`, and its amount. */
interface V5AccountSummary extends AccountSummary {
  kind?: string;
  value?: number;
  purchasePrice?: number;
  securedByAssetId?: string;
}

/** What describe_schema returns for a ProjectionLab 5 export. */
interface V5SchemaDescription extends SchemaDescription {
  layout: "v5";
  accounts: V5AccountSummary[];
  /** Archived accounts, left out of `accounts`. */
  archivedAccounts: PlanObj[];
  /** `documents.accountHistory`, the v5 home of per-account history. */
  accountHistory: { accountCount: number; entryCount: number };
}

function extractV4Accounts(finances: unknown): AccountSummary[] {
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

function extractPlans(plans: unknown[]): PlanSummary[] {
  return plans.map((plan) => {
    const obj = plan as Record<string, unknown>;
    return {
      id: String(obj.id ?? ""),
      name: String(obj.name ?? "unnamed"),
      ...obj,
    };
  });
}

/**
 * A ProjectionLab 5 account row. A real asset reports its `value` and an
 * account or debt its `balance`; a debt's loan is its own row, linked to the
 * asset it secures by `securedByAssetId`. The v5 `type` is kept as stored.
 */
function v5AccountRow(entry: V5AccountEntry): V5AccountSummary {
  const row: V5AccountSummary = {
    id: entry.id,
    name: entry.name,
    type: entry.type ?? "unknown",
  };
  if (entry.kind !== undefined) row.kind = entry.kind;
  const stored = entry.account;
  if (entry.kind === "real-asset") {
    row.value = Number(stored.value ?? 0);
    if (stored.purchasePrice !== undefined) {
      row.purchasePrice = Number(stored.purchasePrice);
    }
  } else if (entry.kind === "account" || entry.kind === "debt") {
    row.balance = Number(stored.balance ?? 0);
  }
  if (entry.kind === "debt" && typeof stored.securedByAssetId === "string") {
    row.securedByAssetId = stored.securedByAssetId;
  }
  return row;
}

/**
 * Accounts and archived accounts of a ProjectionLab 5 Current Finances
 * document. Archived accounts are listed apart, not among `accounts`.
 */
function extractV5Accounts(finances: unknown): {
  accounts: V5AccountSummary[];
  archivedAccounts: PlanObj[];
} {
  const entries = listV5Accounts(finances);
  return {
    accounts: entries.filter((entry) => !entry.archived).map(v5AccountRow),
    archivedAccounts: entries
      .filter((entry) => entry.archived)
      .map(v5ArchivedStub),
  };
}

/** `documents.accountHistory.<accountId>.<year>`: accounts and year entries. */
function accountHistoryCounts(accountHistory: unknown): {
  accountCount: number;
  entryCount: number;
} {
  const counts = { accountCount: 0, entryCount: 0 };
  if (!accountHistory || typeof accountHistory !== "object") return counts;
  for (const years of Object.values(accountHistory)) {
    if (!years || typeof years !== "object" || Array.isArray(years)) continue;
    counts.accountCount++;
    counts.entryCount += Object.values(years).filter(
      (entry) => entry && typeof entry === "object",
    ).length;
  }
  return counts;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  return value === null ? "null" : typeof value;
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
        "On ProjectionLab 5 the account rows carry the stored kind (account, debt, real-asset) and type, " +
        "a real asset reports value, a debt reports balance and securedByAssetId, archived accounts are " +
        "listed apart under archivedAccounts, the keys name each documents.* section, and accountHistory " +
        "counts the per-account history in documents.accountHistory (ProjectionLab 5 exports no progress section). " +
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
        const sections = exportSections(data);

        const topLevelKeys: Record<string, string> = Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, describeValue(value)]),
        );
        const plans = extractPlans(sections.plans).map((plan) => ({
          id: plan.id,
          name: plan.name,
          ...planEventCounts(plan),
        })) as PlanSummary[];

        if (sections.layout === "v5") {
          // Each v5 document is named under `documents.` so the keys an agent
          // reads match the paths it can ask for.
          const documents = (data as ExportedData).documents;
          if (documents && typeof documents === "object") {
            for (const [name, value] of Object.entries(documents)) {
              topLevelKeys[`documents.${name}`] = describeValue(value);
            }
          }
          const schema: V5SchemaDescription = {
            layout: "v5",
            topLevelKeys,
            ...extractV5Accounts(sections.currentFinances),
            plans,
            progressEntryCount: progressEntryCount(sections.progress),
            accountHistory: accountHistoryCounts(sections.accountHistory),
          };
          return {
            content: [{ type: "text", text: toJson(schema) }],
          };
        }

        const schema: SchemaDescription = {
          topLevelKeys,
          accounts: extractV4Accounts(sections.currentFinances),
          plans,
          progressEntryCount: progressEntryCount(sections.progress),
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
