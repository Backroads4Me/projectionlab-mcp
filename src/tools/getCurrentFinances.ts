import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { annotateAddressableValues } from "../dataModel.js";
import {
  currentFinanceAccountNotFoundError,
  findCurrentFinanceEntry,
  findV5Account,
  listV5Accounts,
  requireCurrentFinances,
  withoutArchivedAccounts,
} from "../currentFinances.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import { listAddressableValues } from "../pathPatch.js";
import { redactSecrets } from "../redact.js";
import { exportSections } from "../layout.js";
import type { PlanObj } from "../plans.js";
import {
  buildRealAssetBlock,
  buildRealEstateBlock,
  withRealAssetBlocks,
  withRealEstateBlocks,
} from "../realEstate.js";

/** One ProjectionLab 4 account, addressed by exact id. */
function v4AccountOutput(
  today: PlanObj,
  accountId: string,
  listPaths: boolean,
): PlanObj {
  const entry = findCurrentFinanceEntry(today, accountId);
  if (!entry) {
    throw currentFinanceAccountNotFoundError(today, accountId);
  }
  const realEstate =
    !listPaths && entry.collection === "assets"
      ? buildRealEstateBlock(entry.account)
      : null;
  return {
    accountId,
    accountName: entry.account.name,
    collection: entry.collection,
    ...(listPaths ? { listPaths: true } : {}),
    data: listPaths
      ? annotateAddressableValues(
          entry.collection,
          listAddressableValues(entry.account),
        )
      : {
          ...entry.account,
          ...(realEstate ? { realEstate } : {}),
        },
  };
}

/**
 * One ProjectionLab 5 account, addressed by exact id. An archived account is
 * returned and flagged. The v4 data model annotations do not describe v5
 * fields, so listed paths carry none.
 */
function v5AccountOutput(
  today: PlanObj,
  accountId: string,
  listPaths: boolean,
): PlanObj {
  const entry = findV5Account(today, accountId);
  if (!entry) {
    throw currentFinanceAccountNotFoundError(today, accountId);
  }
  const realAsset = !listPaths
    ? buildRealAssetBlock(entry, listV5Accounts(today))
    : null;
  return {
    accountId,
    accountName: entry.account.name,
    collection: "accounts",
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    ...(entry.archived ? { archived: true } : {}),
    ...(listPaths ? { listPaths: true } : {}),
    data: listPaths
      ? listAddressableValues(entry.account)
      : {
          ...entry.account,
          ...(realAsset ? { realAsset } : {}),
        },
  };
}

export function registerGetCurrentFinancesTool(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerTool(
    "projectionlab_get_current_finances",
    {
      title: "Get Current Finances",
      description:
        "Returns just the Current Finances section (account balances, debts, real estate) " +
        "without plan data. Narrow to one existing account by exact ID, and set listPaths=true " +
        "to discover typed dot paths for projectionlab_update_account pathChanges. " +
        "Real-estate assets (assets entries with type \"real-estate\") carry a realEstate block " +
        "that labels the fields ProjectionLab stores confusingly: marketValue is the stored " +
        "amount, loanBalance is the remaining loan balance (never the property's value; an " +
        "absent balance reads as 0), and netEquity is marketValue minus loanBalance, an " +
        "arithmetic on stored fields and not ProjectionLab's own net-worth figure, which can " +
        "depend on excludeLoanFromLNW. The block also carries paymentMethod, classification and " +
        "excludeLoanFromLNW where present, loan terms (apr, interestType, monthlyPayment, " +
        "compounding) when paymentMethod is \"financed\", and carrying costs (propertyTax, " +
        "insurance, maintenance, monthlyHOA, appreciation) where present. Values come from the " +
        "Current Finances record only, never from plan-modeled asset events. Only the amount " +
        "and balance labels are verified; the other labels name stored fields whose UI meaning " +
        "is not yet confirmed. Raw fields are kept unchanged alongside the block. " +
        "On ProjectionLab 5, accounts are records in `accounts` keyed by id and narrowed by " +
        "kind (account, debt, real-asset), with their v5 type strings kept as stored. Each " +
        "real-asset record carries a realAsset block: value, purchasePrice, loanBalance " +
        "(the balances of the unarchived debts whose securedByAssetId names it), equity " +
        "(value minus loanBalance) and securedDebts; a debt without securedByAssetId is " +
        "tied to no asset. Archived accounts (archivedOn) are left out of `accounts` and " +
        "listed under archivedAccounts unless includeArchived is true.",
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe("Return only the existing account with this exact ID"),
        listPaths: z
          .boolean()
          .default(false)
          .describe(
            "With accountId, flatten the account into typed, addressable dot paths. Arrays remain intact.",
          ),
        includeArchived: z
          .boolean()
          .default(false)
          .describe(
            "ProjectionLab 5: keep archived accounts in the whole-section listing; by default they are listed apart under archivedAccounts. An exact accountId always returns its account, archived or not.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, listPaths, includeArchived }) => {
      try {
        const data = await bridge.exportData();
        const sections = exportSections(data);
        const today = requireCurrentFinances(sections.currentFinances);

        if (listPaths && accountId === undefined) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "listPaths requires accountId",
            "Supply the exact account ID returned by projectionlab_get_current_finances",
          );
        }

        let output: unknown;
        let suffix = "all";
        if (accountId !== undefined) {
          output =
            sections.layout === "v5"
              ? v5AccountOutput(today, accountId, listPaths)
              : v4AccountOutput(today, accountId, listPaths);
          suffix = accountId;
        } else if (sections.layout === "v5") {
          const withBlocks = withRealAssetBlocks(today);
          output = includeArchived
            ? withBlocks
            : withoutArchivedAccounts(withBlocks);
        } else {
          output = withRealEstateBlocks(today);
        }

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(
                toJson(redactSecrets(output, { byName: true })),
                "current-finances",
                { account: suffix },
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
