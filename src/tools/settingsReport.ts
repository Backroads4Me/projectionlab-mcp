import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { detectLayout } from "../layout.js";
import { PLAN_SETTING_SECTIONS } from "../planSettings.js";
import { planNotFoundError, requirePlans, resolvePlan } from "../plans.js";
import { renderSettingsReport } from "../settingsReport.js";

const PLAN_IDENTIFIER =
  "Plan name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID";

export function registerSettingsReportTool(server: McpServer, bridge: Bridge) {
  server.registerTool(
    "projectionlab_get_settings_report",
    {
      title: "Get Plan Settings Report",
      description:
        "Returns a human-readable markdown report of every stored plan setting (assumptions, " +
        "taxes and estate in variables; Chance of Success in montecarlo; the withdrawal " +
        "strategy), named by its ProjectionLab 5 on-screen label and grouped by where the " +
        "control is in the app, with values shown as the app shows them (percentages, " +
        "dollars, On/Off). Settings without a recorded label are listed by stored path. " +
        "Give comparePlanIdentifier to put a second plan in its own column with a Differs " +
        "marker and a count of differing settings. Use this when the user asks to see, " +
        "review or compare plan settings; use projectionlab_get_plan_settings for the " +
        "paths and types a write needs, and projectionlab_diff for events and accounts. " +
        "Present the report to the user as returned.",
      inputSchema: {
        planIdentifier: z.string().trim().min(1).describe(PLAN_IDENTIFIER),
        comparePlanIdentifier: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(`Second plan to compare against. ${PLAN_IDENTIFIER}`),
        section: z
          .enum(PLAN_SETTING_SECTIONS)
          .optional()
          .describe("Report only one settings section. Omit to report all of them."),
        differencesOnly: z
          .boolean()
          .optional()
          .describe(
            "With comparePlanIdentifier, list only the settings whose values differ. Ignored for a one-plan report.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ planIdentifier, comparePlanIdentifier, section, differencesOnly }) => {
      try {
        const data = await bridge.exportData();
        const plans = requirePlans(data);
        const resolve = (identifier: string) => {
          const plan = resolvePlan(plans, identifier);
          if (!plan) throw planNotFoundError(plans, identifier);
          return plan;
        };
        const first = resolve(planIdentifier);
        const selected = [first];
        if (comparePlanIdentifier !== undefined) {
          const second = resolve(comparePlanIdentifier);
          if (second === first) {
            throw new ProjectionLabError(
              "INVALID_INPUT",
              `"${planIdentifier}" and "${comparePlanIdentifier}" name the same plan.`,
              "Give comparePlanIdentifier a different plan, or omit it for a one-plan report.",
            );
          }
          selected.push(second);
        }
        const report = renderSettingsReport(selected, detectLayout(data), {
          section,
          differencesOnly,
        });
        return { content: [{ type: "text", text: report }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
