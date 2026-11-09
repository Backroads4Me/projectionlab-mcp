import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { resolveSnapshot, type SnapshotManager } from "../snapshot.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { redactSecrets } from "../redact.js";
import {
  FIELD_CHANGE_CAP,
  createDiffBudget,
  diffSectionData,
  planKey,
} from "../diff.js";
import {
  PLAN_SECTIONS,
  findPlanIndex,
  planNotFoundError,
} from "../plans.js";
import type { Snapshot } from "../types/projectionlab.js";

/** The data areas a snapshot can hold and this tool knows how to compare. */
const COMPARED_SECTIONS: readonly string[] = [
  "plans",
  "currentFinances",
  "progress",
  "settings",
];

/** A snapshot stores Current Finances under its own key; the export uses `today`. */
function getSection(data: Record<string, unknown>, section: string): unknown {
  return section === "currentFinances" ? data.today : data[section];
}

function describeSnapshot(snapshot: Snapshot) {
  return {
    source: "snapshot" as const,
    snapshotId: snapshot.id,
    timestamp: snapshot.timestamp,
    operation: snapshot.operation,
    sections: snapshot.sections,
  };
}

function plansOf(...values: unknown[]): unknown[] {
  return values.flatMap((value) => (Array.isArray(value) ? value : []));
}

const selectorSchema = z
  .object({
    snapshotId: z
      .string()
      .optional()
      .describe(
        "Exact ID of a saved snapshot, from projectionlab_list_snapshots. Supply exactly one of snapshotId, nBack or beforeTime.",
      ),
    nBack: z
      .number()
      .optional()
      .describe(
        "How many snapshots back, a positive integer with 1 as the most recent, counted in the same newest-first order as projectionlab_list_snapshots. Supply exactly one of snapshotId, nBack or beforeTime.",
      ),
    beforeTime: z
      .string()
      .optional()
      .describe(
        "ISO 8601 time carrying an explicit Z or ±HH:MM offset, such as 2026-11-08T15:30:00Z; picks the latest snapshot taken strictly before it. Supply exactly one of snapshotId, nBack or beforeTime.",
      ),
  })
  .strict();

export function registerDiffTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  server.registerTool(
    "projectionlab_diff",
    {
      title: "Diff Snapshot Against Snapshot or Live Data",
      description:
        "Reports field-level differences between two points in time, read-only: it never " +
        "writes and never snapshots, so it works with PL_READ_ONLY=true. " +
        "from is required and names a saved snapshot with exactly one of snapshotId, nBack or " +
        "beforeTime, resolved the way projectionlab_rollback resolves them. " +
        "to is optional: another snapshot selector, or omitted to compare against the data in " +
        "ProjectionLab right now. " +
        "Only the data sections the from snapshot holds are compared, and when to is a snapshot, " +
        "only the sections both hold; comparedSections says which. " +
        "For plans it reports plans added, removed and changed, and within a changed plan the " +
        "events added, removed and modified per section, each modification as " +
        "\"path\": \"before → after\" dot paths you can read back with projectionlab_get_plan_section " +
        "or patch with projectionlab_update_plan_event. " +
        "Computed plan fields (lastUpdated, simKey, meta) are left out, so a plan ProjectionLab " +
        "merely re-saved reads as unchanged. " +
        "For Current Finances it reports rows added, removed and modified by id within each " +
        "collection. " +
        "Use it to confirm a write landed as intended, to explain to the user what changed, or to " +
        "see what projectionlab_rollback would undo before rolling back. " +
        "Narrow the output with planIdentifier (plan name or ID) and section. " +
        "Secret-looking fields are redacted, and output is capped at " +
        `${FIELD_CHANGE_CAP} field changes with omittedFieldChanges counting the rest.`,
      inputSchema: {
        from: selectorSchema.describe(
          "The baseline side, whose values are reported as before: one saved snapshot, selected like projectionlab_rollback does.",
        ),
        to: selectorSchema
          .optional()
          .describe(
            "The side whose values are reported as after: another saved snapshot, or omit it to compare against the live data read from ProjectionLab now.",
          ),
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Report one plan only: plan name (case-insensitive, partial match) or exact plan ID.",
          ),
        section: z
          .enum(PLAN_SECTIONS)
          .optional()
          .describe(
            "Compare one plan section only, such as income or expenses. Plan settings outside the sections are still compared.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ from, to, planIdentifier, section }) => {
      try {
        const fromSnapshot = await resolveSnapshot(
          snapshots,
          from,
          "from snapshot",
        );
        const toSnapshot = to
          ? await resolveSnapshot(snapshots, to, "to snapshot")
          : null;

        // Against the live data every section the from snapshot holds is
        // available; against another snapshot, only the sections both hold.
        const comparedSections = fromSnapshot.sections.filter(
          (name) =>
            COMPARED_SECTIONS.includes(name) &&
            (toSnapshot === null || toSnapshot.sections.includes(name)),
        );

        const notCompared: { section: string; reason: string }[] = [];
        const mentioned = new Set([
          ...fromSnapshot.sections,
          ...(toSnapshot ? toSnapshot.sections : []),
        ]);
        for (const name of [...mentioned].sort()) {
          if (comparedSections.includes(name)) continue;
          if (!COMPARED_SECTIONS.includes(name)) {
            notCompared.push({
              section: name,
              reason: "this tool does not compare that section",
            });
          } else if (!fromSnapshot.sections.includes(name)) {
            notCompared.push({
              section: name,
              reason: "the from snapshot does not hold it",
            });
          } else {
            notCompared.push({
              section: name,
              reason: "the to snapshot does not hold it",
            });
          }
        }

        if (comparedSections.length === 0) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            toSnapshot
              ? `The two snapshots share no comparable data section; from holds [${fromSnapshot.sections.join(", ")}] and to holds [${toSnapshot.sections.join(", ")}]`
              : `The from snapshot holds no comparable data section: [${fromSnapshot.sections.join(", ")}]`,
            "Compare a snapshot whose sections overlap, or diff against the live data by omitting to. Snapshots record the sections they saved; projectionlab_list_snapshots shows them",
          );
        }

        // `to` is either a snapshot or the live export; one reader covers both.
        const live = toSnapshot ? null : await bridge.exportData({ fresh: true });
        const newerValue = (name: string): unknown =>
          toSnapshot ? toSnapshot.data[name] : getSection(live ?? {}, name);

        // A section one side carries no data for is not a difference, it is
        // nothing to compare: rollback skips such a section rather than
        // restoring nothing, so diffing it would report every field as
        // "(absent)" and describe a change no rollback would make.
        const compared: {
          section: string;
          before: unknown;
          after: unknown;
        }[] = [];
        for (const name of comparedSections) {
          const before = fromSnapshot.data[name];
          const after = newerValue(name);
          if (before === undefined) {
            notCompared.push({
              section: name,
              reason: "the from snapshot holds no data for it",
            });
            continue;
          }
          if (after === undefined) {
            notCompared.push({
              section: name,
              reason: toSnapshot
                ? "the to snapshot holds no data for it"
                : "the live export returned no such section",
            });
            continue;
          }
          compared.push({ section: name, before, after });
        }

        if (compared.length === 0) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `Both sides list [${comparedSections.join(", ")}] but no section carries data on both sides`,
            "Confirm what the snapshot saved with projectionlab_list_snapshots and read the current data with projectionlab_export_data",
          );
        }

        const wantsPlans = compared.some((entry) => entry.section === "plans");
        if (section && !wantsPlans) {
          throw new ProjectionLabError(
            "INVALID_INPUT",
            `section "${section}" narrows the plans comparison, but no plans data is being compared`,
            `Drop section, or pick a snapshot whose sections include plans; projectionlab_list_snapshots shows what each snapshot holds`,
          );
        }

        const newerPlans = wantsPlans ? plansOf(newerValue("plans")) : [];

        let planOnlyKey: string | undefined;
        if (planIdentifier) {
          if (!wantsPlans) {
            throw new ProjectionLabError(
              "INVALID_INPUT",
              `planIdentifier "${planIdentifier}" narrows the plans comparison, but no plans data is being compared`,
              "Drop planIdentifier, or pick a snapshot whose sections include plans; projectionlab_list_snapshots shows what each snapshot holds",
            );
          }
          const olderPlans = plansOf(fromSnapshot.data.plans);
          const beforeIndex = findPlanIndex(olderPlans, planIdentifier);
          const afterIndex = findPlanIndex(newerPlans, planIdentifier);
          const match =
            beforeIndex !== -1
              ? olderPlans[beforeIndex]
              : afterIndex !== -1
                ? newerPlans[afterIndex]
                : undefined;
          if (match === undefined) {
            const byKey = new Map(
              plansOf(fromSnapshot.data.plans, newerPlans).map((plan) => [
                planKey(plan),
                plan,
              ]),
            );
            throw planNotFoundError([...byKey.values()], planIdentifier);
          }
          planOnlyKey = planKey(match);
        }

        const budget = createDiffBudget();
        const sections: Record<string, unknown> = {};
        let changed = false;
        for (const entry of compared) {
          const payload = diffSectionData(
            entry.section,
            entry.before,
            entry.after,
            budget,
            {
              planSection:
                entry.section === "plans" ? section : undefined,
              planOnlyKey:
                entry.section === "plans" ? planOnlyKey : undefined,
            },
          );
          sections[entry.section] = payload;
          if (payload.changed) changed = true;
        }

        const result = {
          from: describeSnapshot(fromSnapshot),
          to: toSnapshot
            ? describeSnapshot(toSnapshot)
            : {
                source: "live" as const,
                readAt: new Date().toISOString(),
                note: "read from ProjectionLab when this diff ran",
              },
          comparedSections: compared.map((entry) => entry.section),
          ...(notCompared.length > 0 ? { notCompared } : {}),
          ...(planIdentifier ? { planIdentifier } : {}),
          ...(section ? { section } : {}),
          changed,
          ...(changed
            ? {}
            : {
                message:
                  "No differences in the compared sections. Computed plan fields (lastUpdated, simKey, meta) are excluded, so a plan ProjectionLab only re-saved reads as unchanged.",
              }),
          sections,
          fieldChangeCap: budget.fieldChangeCap,
          ...(budget.omittedFieldChanges > 0
            ? { omittedFieldChanges: budget.omittedFieldChanges }
            : {}),
          ...(budget.omittedEntries > 0
            ? { omittedEntries: budget.omittedEntries }
            : {}),
        };

        return {
          content: [
            {
              type: "text",
              text: toJson(redactSecrets(result, { byName: true })),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
