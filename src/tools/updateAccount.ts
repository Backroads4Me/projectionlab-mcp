import { z } from "zod";
import { toJson } from "../json.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { log } from "../logger.js";

function getAllCurrentAccounts(
  today: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!today) return [];

  return [
    ...((today.investmentAccounts ?? []) as Record<string, unknown>[]),
    ...((today.savingsAccounts ?? []) as Record<string, unknown>[]),
    ...((today.debts ?? []) as Record<string, unknown>[]),
    ...((today.assets ?? []) as Record<string, unknown>[]),
  ];
}

export function registerUpdateAccountTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_update_account",
    {
      title: "Update Account",
      description:
        "Updates a single account in Current Finances with new field values. " +
        "When confirm is false (default), returns a dry-run preview of what would change WITHOUT modifying anything. " +
        "When confirm is true, applies the update after auto-snapshotting current state. " +
        "IMPORTANT: Always call projectionlab_export_data first to verify the accountId and current values.",
      inputSchema: {
        accountId: z.string().describe("The account ID to update"),
        data: z
          .record(z.string(), z.unknown())
          .describe("Object of fields to update (e.g. { balance: 50000 })"),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Allow assignment of new properties to the account. Default false.",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute the update. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, data, force, confirm }) => {
      try {
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (PL_READ_ONLY=true)",
            "Set PL_READ_ONLY=false to enable writes",
          );
        }

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson(
                  {
                    dryRun: true,
                    accountId,
                    fieldsToUpdate: data,
                    message:
                      "This is a preview. Set confirm=true to apply this update.",
                  },
                ),
              },
            ],
          };
        }

        // Snapshot before mutating
        const exportData = await bridge.exportData({ fresh: true });
        await snapshots.create("updateAccount", ["currentFinances"], {
          currentFinances: exportData.today,
        });

        await bridge.updateAccount(accountId, data, force || undefined);

        // Post-write verification
        let verification: Record<string, { expected: unknown; actual: unknown; match: boolean }> | undefined;
        try {
          await new Promise((r) => setTimeout(r, 1000));
          const freshData = await bridge.exportData({ fresh: true });
          const today = freshData.today as Record<string, unknown> | undefined;
          const accounts = getAllCurrentAccounts(today);
          const account = accounts.find((a) => a.id === accountId);
          if (account) {
            verification = {};
            for (const [key, expected] of Object.entries(data)) {
              const actual = account[key];
              verification[key] = {
                expected,
                actual,
                match: JSON.stringify(actual) === JSON.stringify(expected),
              };
            }
          }
        } catch (err) {
          log.warn("updateAccount", `Post-write verification failed: ${err}`);
        }

        const allMatch = verification
          ? Object.values(verification).every((v) => v.match)
          : undefined;

        return {
          content: [
            {
              type: "text",
              text: toJson(
                {
                  success: true,
                  accountId,
                  updatedFields: data,
                  verified: allMatch,
                  verification,
                  message: allMatch
                    ? "Account updated and verified. Snapshot saved automatically."
                    : allMatch === false
                      ? "Account update sent but some fields did not verify — check with projectionlab_get_current_finances."
                      : "Account updated. Snapshot saved. Could not verify — check with projectionlab_get_current_finances.",
                },
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
