import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { requireEditsEnabled } from "../editAccess.js";
import {
  currentFinanceAccountNotFoundError,
  findCurrentFinanceEntry,
  findV5Account,
  requireCurrentFinances,
} from "../currentFinances.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import {
  applyExistingPathChanges,
  findPathChangeMismatches,
  type PathChangeMismatch,
  type PathValueChange,
} from "../pathPatch.js";
import type { PlanObj } from "../plans.js";
import { isSecretFieldName, redactSecrets } from "../redact.js";
import { exportSections, type ExportLayout } from "../layout.js";
import { assertWritesSupported } from "./writeGuard.js";

const ACCOUNT_FIELD_CONTEXT = {
  label: "Current Finances account field",
  discoveryTool:
    "projectionlab_get_current_finances with accountId and listPaths=true",
  example: '{ "balance": 50000 }',
} as const;

const UNSAFE_NEW_FIELDS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "id",
]);

/**
 * The account a patch targets. A ProjectionLab 4 account sits in one of the
 * `today` collection arrays; a ProjectionLab 5 account is a record of
 * `currentFinances.accounts`, keyed by its id and narrowed by `kind`.
 */
interface AccountTarget {
  account: PlanObj;
  /** The id the Plugin API's updateAccount looks the account up by. */
  writeId: string;
  /** The data-model group the account's fields belong to. */
  scope: string;
  /** Where the account sits, as reported to the caller. */
  location: { collection: string } | { kind: string | undefined };
}

function findAccount(
  finances: unknown,
  accountId: string,
  layout: ExportLayout,
): AccountTarget | undefined {
  if (layout === "v5") {
    const entry = findV5Account(finances, accountId);
    return entry && {
      account: entry.account,
      writeId: entry.key,
      scope: "accounts",
      location: { kind: entry.kind },
    };
  }
  const entry = findCurrentFinanceEntry(finances, accountId);
  return entry && {
    account: entry.account,
    writeId: accountId,
    scope: entry.collection,
    location: { collection: entry.collection },
  };
}

function assertMutablePath(path: string): void {
  if (path === "id" || path.startsWith("id.")) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "The Current Finances account ID is immutable",
      "Use the ID only to select the account",
    );
  }
}

function applyAccountChanges(
  account: PlanObj,
  incoming: Record<string, unknown>,
  force: boolean,
  scope: string,
  layout: ExportLayout,
): {
  updated: PlanObj;
  changes: Record<string, PathValueChange>;
} {
  if (Object.keys(incoming).length === 0) {
    throw new ProjectionLabError(
      "INVALID_INPUT",
      "At least one Current Finances account field change is required",
      `Supply changes such as ${ACCOUNT_FIELD_CONTEXT.example}`,
    );
  }

  for (const path of Object.keys(incoming)) assertMutablePath(path);
  if (!force) {
    return applyExistingPathChanges(
      account,
      incoming,
      ACCOUNT_FIELD_CONTEXT,
      scope,
      layout,
    );
  }

  const existing: Record<string, unknown> = {};
  const additions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(account, key)) {
      existing[key] = value;
      continue;
    }
    if (
      key.length === 0 ||
      key.includes(".") ||
      UNSAFE_NEW_FIELDS.has(key) ||
      isSecretFieldName(key)
    ) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        `Invalid new Current Finances account field "${key}"`,
        "force=true only permits safe top-level properties",
      );
    }
    additions[key] = value;
  }

  let updated = account;
  let changes: Record<string, PathValueChange> = {};
  if (Object.keys(existing).length > 0) {
    const result = applyExistingPathChanges(
      account,
      existing,
      ACCOUNT_FIELD_CONTEXT,
      scope,
      layout,
    );
    updated = result.updated;
    changes = result.changes;
  }
  for (const [key, value] of Object.entries(additions)) {
    updated = { ...updated, [key]: value };
    changes[key] = { before: "[ABSENT]", after: value };
  }
  return { updated, changes };
}

function topLevelPatch(
  updated: PlanObj,
  changes: Record<string, PathValueChange>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const path of Object.keys(changes)) {
    const root = path.split(".")[0];
    patch[root] = updated[root];
  }
  return patch;
}

export function registerUpdateAccountTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_update_account",
    {
      title: "Update Current Finances Account",
      description:
        "Safely patches one existing account, debt, or real asset in Current Finances. " +
        "Use pathChanges for nested fields so siblings are preserved; discover valid paths with " +
        "projectionlab_get_current_finances using accountId and listPaths=true, and see " +
        "projectionlab://data-model for field units and allowed values. The legacy data " +
        "input shallowly patches top-level fields. Supply exactly one patch mode. Dry runs validate " +
        "the account and return before/after values as a field-level safety diff, not a plan-impact measure. " +
        "Confirmed changes snapshot Current Finances, " +
        "send only changed top-level fields, and verify every requested path.",
      inputSchema: {
        accountId: z.string().describe("The exact account ID to update"),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Legacy top-level field patch, e.g. { balance: 50000 }. Existing fields retain their JSON type.",
          ),
        pathChanges: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Preferred nested patch, e.g. { "allocation.stocks": 0.7 }. Every path must already exist and retain its JSON type.',
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            "With data only, allow safe new top-level properties. Default false.",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a validated dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, data, pathChanges, force, confirm }) => {
      try {
        await requireEditsEnabled(bridge);
        if ((data === undefined) === (pathChanges === undefined)) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "Supply exactly one of data or pathChanges",
            "Use data for top-level fields or pathChanges for nested dot paths",
          );
        }
        if (pathChanges !== undefined && force) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            "force=true is only valid with the top-level data patch",
            "Nested pathChanges must address existing fields",
          );
        }

        await assertWritesSupported(bridge, ["updateAccount"]);
        const exportData = await bridge.exportData({ fresh: true });
        const { layout, currentFinances } = exportSections(exportData);
        const finances = requireCurrentFinances(currentFinances);
        const entry = findAccount(finances, accountId, layout);
        if (!entry) {
          throw currentFinanceAccountNotFoundError(finances, accountId);
        }

        const result =
          pathChanges !== undefined
            ? (() => {
                for (const path of Object.keys(pathChanges)) {
                  assertMutablePath(path);
                }
                return applyExistingPathChanges(
                  entry.account,
                  pathChanges,
                  ACCOUNT_FIELD_CONTEXT,
                  entry.scope,
                  layout,
                );
              })()
            : applyAccountChanges(entry.account, data ?? {}, force, entry.scope, layout);
        const renderedChanges = redactSecrets(result.changes, {
          byName: true,
        });

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "updateAccount",
                  accountId,
                  accountName: entry.account.name,
                  ...entry.location,
                  changes: renderedChanges,
                  warning:
                    Object.keys(result.changes).length === 0
                      ? "All supplied values already match the account - nothing would change."
                      : `This will patch ${Object.keys(result.changes).length} field(s). Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        if (Object.keys(result.changes).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  success: true,
                  accountId,
                  accountName: entry.account.name,
                  changes: renderedChanges,
                  verified: true,
                  message:
                    "All supplied values already match the account; no mutation was sent.",
                }),
              },
            ],
          };
        }

        const snapshot = await snapshots.create("updateAccount", ["currentFinances"], {
          currentFinances: finances,
        }, layout);

        const patch = topLevelPatch(result.updated, result.changes);
        log.info(
          "updateAccount",
          `Patching ${Object.keys(result.changes).length} field(s) on Current Finances account "${accountId}"`,
        );
        await bridge.updateAccount(entry.writeId, patch, force || undefined, layout);

        // A fresh read that no longer holds the account is a failed
        // verification, not one that could not run: with no account to look
        // in, the mismatch walk reports one absent issue per changed path.
        let verified: boolean | undefined;
        let verificationIssues: PathChangeMismatch[] = [];
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const freshData = await bridge.exportData({ fresh: true });
          const fresh = exportSections(freshData);
          const verifiedEntry = findAccount(
            fresh.currentFinances,
            accountId,
            fresh.layout,
          );
          verificationIssues = findPathChangeMismatches(
            verifiedEntry?.account,
            result.changes,
            ACCOUNT_FIELD_CONTEXT,
          );
          verified = verificationIssues.length === 0;
        } catch (err) {
          log.warn("updateAccount", `Post-write verification failed: ${err}`);
        }

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                accountId,
                accountName: entry.account.name,
                ...entry.location,
                changes: renderedChanges,
                verified,
                ...(verified === false
                  ? {
                      verificationIssues: redactSecrets(verificationIssues, {
                        byName: true,
                      }),
                    }
                  : {}),
                snapshotId: snapshot.id,
                message:
                  verified === true
                    ? "Account patched and verified. Snapshot saved automatically."
                    : verified === false
                      ? `Account update was sent but these fields did not verify: ${verificationIssues
                          .map((issue) => issue.path)
                          .join(", ")}. A snapshot was saved; inspect Current Finances and roll back if needed.`
                      : "Account update was sent but verification could not run. A snapshot was saved; inspect Current Finances and roll back if needed.",
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
