import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { requireEditsEnabled } from "../editAccess.js";
import { errorResult, redactedSecretsError } from "../errors.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import { findRedactedSecretPaths, redactSecrets } from "../redact.js";
import {
  PLAN_SETTING_CONTEXT,
  PLAN_SETTING_SECTIONS,
  applyPlanSettingChanges,
} from "../planSettings.js";
import { findPathChangeMismatches } from "../pathPatch.js";
import {
  resolvePlanIndex,
  planNotFoundError,
  requirePlans,
  type PlanObj,
} from "../plans.js";
import { exportSections } from "../layout.js";
import { assertWritesSupported } from "./writeGuard.js";

export function registerUpdatePlanSettingsTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_update_plan_settings",
    {
      title: "Update Plan Settings",
      description:
        "Safely patches discrete existing settings in ONE configuration section of ONE plan. " +
        "Paths come from projectionlab_get_plan_settings and may address nested fields, such as " +
        '"estate.enabled". Sibling values are preserved server-side. Unknown paths and JSON type ' +
        "changes are rejected, and values outside an observed field's allowed values are refused; " +
        "see projectionlab://data-model for units and allowed values. When confirm is false (default), returns a dry-run diff. When " +
        "confirm is true, auto-snapshots all plans, restores the patched plan, and verifies each value.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SETTING_SECTIONS)
          .describe("The configuration section containing the settings"),
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            'Dot-path to value map, e.g. { "inflation": 3, "estate.enabled": true }. Every path must already exist and retain its current JSON type. Rates use the scale of the current value: most are percentage points (inflation 3 means 3%), some are fractions (taxStrategy.bracketRate 0.22 means 22%).',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, section, changes: incoming, confirm }) => {
      try {
        await requireEditsEnabled(bridge);

        // A whole-object value can carry a secret-named key a read returned
        // as [REDACTED]; storing it would replace the real value.
        const redactedPaths = findRedactedSecretPaths(incoming);
        if (redactedPaths.length > 0) {
          throw redactedSecretsError("changes", redactedPaths);
        }

        await assertWritesSupported(bridge, ["restorePlans"]);
        const data = await bridge.exportData({ fresh: true });
        const plans = requirePlans(data);
        const planIndex = resolvePlanIndex(plans, planIdentifier);
        if (planIndex === -1) throw planNotFoundError(plans, planIdentifier);
        const plan = plans[planIndex] as PlanObj;
        const { updated, changes } = applyPlanSettingChanges(
          plan[section],
          incoming,
          section,
        );

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "updatePlanSettings",
                  planName: plan.name,
                  planId: plan.id,
                  section,
                  changes: redactSecrets(changes, { byName: true }),
                  warning:
                    Object.keys(changes).length === 0
                      ? "All supplied values already match the plan - nothing would change."
                      : `This will patch ${Object.keys(changes).length} setting(s) in "${section}" of plan "${plan.name}". Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        if (Object.keys(changes).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  success: true,
                  planName: plan.name,
                  section,
                  changes: redactSecrets(changes, { byName: true }),
                  verified: true,
                  message: "All supplied values already match the plan; no mutation was sent.",
                }),
              },
            ],
          };
        }

        const snapshot = await snapshots.create("updatePlanSettings", ["plans"], {
          plans,
        });

        const updatedPlans = [...plans];
        updatedPlans[planIndex] = { ...plan, [section]: updated };
        log.info(
          "updatePlanSettings",
          `Patching ${Object.keys(changes).length} setting(s) in "${section}" of plan "${plan.name}"`,
        );
        await bridge.restorePlansIfUnchanged(plans, updatedPlans);

        const verifyData = await bridge.exportData({ fresh: true });
        const verifiedPlan = (
          exportSections(verifyData).plans
        ).find(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as PlanObj).id === plan.id,
        ) as PlanObj | undefined;
        // A plan the fresh read no longer carries fails verification: with no
        // section to look in, the mismatch walk reports one absent issue per
        // changed setting.
        const verificationIssues = findPathChangeMismatches(
          verifiedPlan?.[section],
          changes,
          PLAN_SETTING_CONTEXT,
        );
        const verified = verificationIssues.length === 0;

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                planName: plan.name,
                section,
                changes: redactSecrets(changes, { byName: true }),
                verified,
                ...(verified
                  ? {}
                  : {
                      verificationIssues: redactSecrets(verificationIssues, {
                        byName: true,
                      }),
                    }),
                snapshotId: snapshot.id,
                message: verified
                  ? "Plan settings patched and verified. Snapshot saved automatically."
                  : `Plan settings update was sent but these settings did not verify: ${verificationIssues
                      .map((issue) => issue.path)
                      .join(", ")}. A snapshot was saved; inspect the plan settings and roll back if needed.`,
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
