import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import {
  currentFinanceAccountNotFoundError,
  findCurrentFinanceEntry,
  requireCurrentFinances,
} from "../currentFinances.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import { listAddressableValues } from "../pathPatch.js";
import { redactSecrets } from "../redact.js";
import {
  activePlanOf,
  assetEventFor,
  buildRealEstateBlock,
  withRealEstateBlocks,
} from "../realEstate.js";

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
        "amount, loanBalance is the remaining loan balance (never the property's value), and " +
        "netEquity is marketValue minus loanBalance. The block adds loan terms (apr, " +
        "interestType, monthlyPayment, compounding) and carrying costs (propertyTax, insurance, " +
        "maintenance, monthlyHOA, appreciation) where present, from the active plan's asset " +
        "event when one exists (source \"active-plan-event\", plus overriddenFields) and from " +
        "the Current Finances record otherwise (source \"today-record\"). Only the amount and " +
        "balance labels are verified; the other labels name stored fields whose UI meaning is " +
        "not yet confirmed. Raw fields are kept unchanged alongside the block.",
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
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, listPaths }) => {
      try {
        const data = await bridge.exportData();
        const today = requireCurrentFinances(data.today);

        if (listPaths && accountId === undefined) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "listPaths requires accountId",
            "Supply the exact account ID returned by projectionlab_get_current_finances",
          );
        }

        let output: unknown = withRealEstateBlocks(today, data.plans);
        let suffix = "all";
        if (accountId !== undefined) {
          const entry = findCurrentFinanceEntry(today, accountId);
          if (!entry) {
            throw currentFinanceAccountNotFoundError(today, accountId);
          }
          const realEstate =
            !listPaths && entry.collection === "assets"
              ? buildRealEstateBlock(
                  entry.account,
                  assetEventFor(activePlanOf(data.plans), entry.account.id),
                )
              : null;
          output = {
            accountId,
            accountName: entry.account.name,
            collection: entry.collection,
            ...(listPaths ? { listPaths: true } : {}),
            data: listPaths
              ? listAddressableValues(entry.account)
              : {
                  ...entry.account,
                  ...(realEstate ? { realEstate } : {}),
                },
          };
          suffix = accountId;
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
