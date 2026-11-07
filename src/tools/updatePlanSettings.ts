import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { assertPlansUnchanged } from "../planVersion.js";
import { toJson } from "../json.js";
import { log } from "../logger.js";
import { redactSecrets } from "../redact.js";
import {
  PLAN_SETTING_SECTIONS,
  applyPlanSettingChanges,
  planSettingChangesApplied,
} from "../planSettings.js";
import {
  findPlanIndex,
  planNotFoundError,
  requirePlans,
  type PlanObj,
} from "../plans.js";

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
        "changes are rejected. When confirm is false (default), returns a dry-run diff. When " +
        "confirm is true, auto-snapshots all plans, restores the patched plan, and verifies each value.",
      inputSchema: {
        planIdentifier: z
          .string()
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SETTING_SECTIONS)
          .describe("The configuration section containing the settings"),
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            'Dot-path to value map, e.g. { "inflation": 0.03, "estate.enabled": true }. Every path must already exist and retain its current JSON type.',
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
        if (config.readOnly) {
          throw new ProjectionLabError(
            "READ_ONLY_MODE",
            "Write operations are disabled (read-only mode; PL_READ_ONLY is not \"false\")",
            "Ask the user whether to enable writes: set PL_READ_ONLY=false in the MCP host env block or ~/.projectionlab-mcp/.env, then restart the server",
          );
        }

        const data = await bridge.exportData({ fresh: true });
        const plans = requirePlans(data);
        const planIndex = findPlanIndex(plans, planIdentifier);
        if (planIndex === -1) throw planNotFoundError(plans, planIdentifier);
        const plan = plans[planIndex] as PlanObj;
        const { updated, changes } = applyPlanSettingChanges(
          plan[section],
          incoming,
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

        await snapshots.create("updatePlanSettings", ["plans"], { plans });

        const updatedPlans = [...plans];
        updatedPlans[planIndex] = { ...plan, [section]: updated };
        log.info(
          "updatePlanSettings",
          `Patching ${Object.keys(changes).length} setting(s) in "${section}" of plan "${plan.name}"`,
        );
        await assertPlansUnchanged(bridge, plans);
        await bridge.restorePlans(updatedPlans);

        const verifyData = await bridge.exportData({ fresh: true });
        const verifiedPlan = (
          Array.isArray(verifyData.plans) ? verifyData.plans : []
        ).find(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as PlanObj).id === plan.id,
        ) as PlanObj | undefined;
        const verified =
          !!verifiedPlan &&
          planSettingChangesApplied(verifiedPlan[section], changes);

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
                message: verified
                  ? "Plan settings patched and verified. Snapshot saved automatically."
                  : "Plan settings update was sent but verification did not confirm every value. A snapshot was saved; inspect the plan settings and roll back if needed.",
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
