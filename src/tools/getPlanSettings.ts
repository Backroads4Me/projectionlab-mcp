import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { annotateAddressableValues } from "../dataModel.js";
import { errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import { redactSecrets } from "../redact.js";
import {
  PLAN_SETTING_SECTIONS,
  listPlanSettings,
} from "../planSettings.js";
import {
  findPlan,
  planNotFoundError,
  requirePlans,
} from "../plans.js";

export function registerGetPlanSettingsTool(
  server: McpServer,
  bridge: Bridge,
) {
  server.registerTool(
    "projectionlab_get_plan_settings",
    {
      title: "Get Plan Settings",
      description:
        "Lists discrete, path-addressable configuration values for one plan. " +
        "Covers general assumptions and tax controls (variables), Chance of Success " +
        "configuration (the montecarlo section; trials over historical market periods, " +
        "with randomized sampling as an option), and withdrawal strategy settings (a " +
        "compare mode that replaces most other plan events while it is enabled). " +
        "Nested objects are flattened to dot paths while " +
        "ordered arrays remain intact. Advanced rate schedules also expose indexed control-point " +
        "fields so one year or rate can be patched without replacing the schedule. Use the returned " +
        "paths and JSON types with " +
        "projectionlab_update_plan_settings.",
      inputSchema: {
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Plan name (case-insensitive, partial match) or exact plan ID",
          ),
        section: z
          .enum(PLAN_SETTING_SECTIONS)
          .optional()
          .describe(
            "Return only one settings section. Omit to return all supported settings sections.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, section }) => {
      try {
        const data = await bridge.exportData();
        const plans = requirePlans(data);
        const plan = findPlan(plans, planIdentifier);
        if (!plan) throw planNotFoundError(plans, planIdentifier);

        const selected = section ? [section] : PLAN_SETTING_SECTIONS;
        const sections = selected.map((name) => {
          const settings = annotateAddressableValues(
            name,
            listPlanSettings(plan[name], name),
          );
          return {
            section: name,
            settingCount: settings.length,
            settings,
          };
        });
        const output = {
          planName: plan.name,
          planId: plan.id,
          mutableWith: "projectionlab_update_plan_settings",
          sections,
        };

        return {
          content: [
            {
              type: "text",
              text: await textOrFile(
                toJson(redactSecrets(output, { byName: true })),
                "plan-settings",
                {
                  planName: plan.name,
                  section: section ?? "all",
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
