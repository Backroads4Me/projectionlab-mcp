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
        "to discover typed dot paths for projectionlab_update_account pathChanges.",
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

        let output: unknown = today;
        let suffix = "all";
        if (accountId !== undefined) {
          const entry = findCurrentFinanceEntry(today, accountId);
          if (!entry) {
            throw currentFinanceAccountNotFoundError(today, accountId);
          }
          output = {
            accountId,
            accountName: entry.account.name,
            collection: entry.collection,
            ...(listPaths ? { listPaths: true } : {}),
            data: listPaths
              ? listAddressableValues(entry.account)
              : entry.account,
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
