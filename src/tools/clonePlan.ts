import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import type { SnapshotManager } from "../snapshot.js";
import { buildPlanClone, verifyPlanClone } from "../clonePlan.js";
import { requireEditsEnabled } from "../editAccess.js";
import { currentFinancesProblems } from "../currentFinances.js";
import { errorResult } from "../errors.js";
import { log } from "../logger.js";
import { toJson } from "../json.js";
import {
  resolvePlanIndex,
  getEvents,
  planNotFoundError,
  requirePlans,
  type PlanObj,
} from "../plans.js";
import { exportSections } from "../layout.js";
import { assertWritesSupported } from "./writeGuard.js";
import { clonePlanSummary } from "../changeSummary.js";
import {
  assertUnchangedDuringPrompt,
  confirmWrite,
  elicitationFallbackArg,
  promptHint,
} from "../writeConfirmation.js";

export function registerClonePlanTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_clone_plan",
    {
      title: "Clone Plan",
      description:
        "Copies one plan to a new plan with a new name, for what-if scenarios. Every existing " +
        "plan is left as it is; the copy is appended. Event ids are kept, as ProjectionLab's own " +
        "plan duplication does, so references between events, milestones and accounts stay intact. " +
        "When confirm is false (default), returns a dry-run preview. When confirm is true, " +
        "auto-snapshots all plans, appends the copy, and verifies the other plans are " +
        "unchanged and that no Current Finances balance moved. " +
        "Edit the copy afterwards with projectionlab_update_plan_event or " +
        "projectionlab_update_plan_settings. projectionlab_rollback on the snapshot removes the copy.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan to copy: name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID",
          ),
        newName: z
          .string()
          .describe(
            "Name for the new plan. Must not match an existing plan name (case-insensitive).",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to execute. Default false returns a dry-run preview.",
          ),
        elicitationFallback: elicitationFallbackArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, newName, confirm, elicitationFallback }, extra) => {
      try {
        await requireEditsEnabled(bridge);

        await assertWritesSupported(bridge, ["restorePlans"]);
        const data = await bridge.exportData({ fresh: true });
        const plans = requirePlans(data);
        const sourceIndex = resolvePlanIndex(plans, planIdentifier);
        if (sourceIndex === -1) throw planNotFoundError(plans, planIdentifier);
        const source = plans[sourceIndex] as PlanObj;
        const clone = buildPlanClone(source, plans, newName);

        const preview = {
          sourcePlan: { name: source.name, id: source.id },
          newPlan: { name: clone.name, id: clone.id },
          planCount: `${plans.length} → ${plans.length + 1}`,
          eventCounts: {
            income: getEvents(source.income).length,
            expenses: getEvents(source.expenses).length,
            accounts: getEvents(source.accounts).length,
            assets: getEvents(source.assets).length,
            milestones: getEvents(source.milestones).length,
            priorities: getEvents(source.priorities).length,
          },
        };

        const summary = clonePlanSummary({
          sourceName: source.name,
          newName: clone.name,
          counts: preview.eventCounts,
        });

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: toJson({
                  dryRun: true,
                  operation: "clonePlan",
                  ...preview,
                  summary,
                  ...promptHint(server),
                  note: "The new plan id is assigned again when confirmed.",
                  warning: `This will add plan "${String(clone.name)}" as a copy of "${String(source.name)}". Set confirm=true to proceed.`,
                }),
              },
            ],
          };
        }

        const gate = await confirmWrite(server, {
          tool: "projectionlab_clone_plan",
          args: { planIdentifier, newName },
          summary,
          fallback: elicitationFallback,
          signal: extra?.signal,
        });
        if (!gate.proceed) return gate.result;
        // The snapshot comes from the read before the prompt.
        if (gate.prompted) await assertUnchangedDuringPrompt(bridge, data, ["plans"]);

        const snapshot = await snapshots.create("clonePlan", ["plans"], {
          plans,
        });
        log.info(
          "clonePlan",
          `Copying plan "${String(source.name)}" to "${String(clone.name)}"`,
        );
        await bridge.restorePlansIfUnchanged(plans, [...plans, clone]);

        const verifyData = await bridge.exportData({ fresh: true });
        const after = exportSections(verifyData).plans;
        const planProblems = verifyPlanClone(plans, after, clone);
        const financeProblems = currentFinancesProblems(
          exportSections(data).currentFinances,
          exportSections(verifyData).currentFinances,
        );
        const problems = [...planProblems, ...financeProblems];
        const verified = problems.length === 0;

        let message =
          "Plan copied and verified. Snapshot saved; projectionlab_rollback with this snapshotId removes the copy.";
        if (!verified) {
          message =
            planProblems.length > 0
              ? `Copy sent but verification found problems. Check the plans in ProjectionLab; projectionlab_rollback with snapshotId ${snapshot.id} restores the previous plans.`
              : "Copy landed, but Current Finances changed while the write was in flight. Cloning a plan does not write Current Finances, so this may be an edit made in ProjectionLab. The snapshot holds plans only, so rolling it back removes the copy and restores nothing else.";
        }

        return {
          content: [
            {
              type: "text",
              text: toJson({
                success: true,
                ...preview,
                summary,
                verified,
                ...(verified ? {} : { verificationProblems: problems }),
                snapshotId: snapshot.id,
                message,
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
