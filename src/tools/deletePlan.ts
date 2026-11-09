import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { config } from "../config.js";
import { selectPlanForDeletion, verifyPlanDeletion, withoutPlan } from "../deletePlan.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { log } from "../logger.js";
import { assertPlansUnchanged } from "../planVersion.js";
import { toJson } from "../json.js";
import { getEvents, requirePlans, type PlanObj } from "../plans.js";

export function registerDeletePlanTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_delete_plan",
    {
      title: "Delete Plan",
      description:
        "Permanently removes one plan by exact plan ID; names are never matched, so get the ID " +
        "from projectionlab_describe_schema first. Refuses the last remaining plan. " +
        "When confirm is false (default), returns a dry-run preview. When confirm is true, " +
        "auto-snapshots all plans, writes the remaining plans, and verifies the deleted plan is " +
        "gone while every other plan is unchanged. projectionlab_rollback on the snapshot " +
        "restores the deleted plan.",
      inputSchema: {
        planId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Exact plan ID only (from projectionlab_describe_schema). Names are not accepted for deletion.",
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
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ planId, confirm }) => {
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
        const target = selectPlanForDeletion(plans, planId);

        const preview = {
          plan: { name: target.name, id: target.id },
          planCount: `${plans.length} → ${plans.length - 1}`,
          eventCounts: {
            income: getEvents(target.income).length,
            expenses: getEvents(target.expenses).length,
            accounts: getEvents(target.accounts).length,
            assets: getEvents(target.assets).length,
            milestones: getEvents(target.milestones).length,
            priorities: getEvents(target.priorities).length,
          },
        };

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "deletePlan",
                  ...preview,
                  warning: `This will delete plan "${String(target.name)}" and all of its events. Set confirm=true to proceed. The plans are snapshotted first, so projectionlab_rollback can restore the plan.`,
                }),
              },
            ],
          };
        }

        const snapshot = await snapshots.create("deletePlan", ["plans"], {
          plans,
        });
        await assertPlansUnchanged(bridge, plans);

        log.info("deletePlan", `Deleting plan "${String(target.name)}"`);
        await bridge.restorePlans(withoutPlan(plans, String(target.id)));

        const verifyData = await bridge.exportData({ fresh: true });
        const after = Array.isArray(verifyData.plans) ? verifyData.plans : [];
        const problems = verifyPlanDeletion(plans, after, String(target.id));
        const verified = problems.length === 0;

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                ...preview,
                verified,
                ...(verified ? {} : { verificationProblems: problems }),
                snapshotId: snapshot.id,
                message: verified
                  ? "Plan deleted and verified. Snapshot saved; projectionlab_rollback with this snapshotId restores the plan."
                  : `Delete sent but verification found problems. Check the plans in ProjectionLab; projectionlab_rollback with snapshotId ${snapshot.id} restores the previous plans.`,
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
