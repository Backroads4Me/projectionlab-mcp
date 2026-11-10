import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import {
  resolveSnapshot,
  type SnapshotManager,
  type SnapshotSelectorArgs,
} from "../snapshot.js";
import { ProjectionLabError, errorResult } from "../errors.js";
import { toJson } from "../json.js";
import { textOrFile } from "../largeOutput.js";
import { redactSecrets } from "../redact.js";
import {
  FIELD_CHANGE_CAP,
  createDiffBudget,
  diffPlanPair,
  diffSectionData,
  planKey,
} from "../diff.js";
import {
  PLAN_SECTIONS,
  resolvePlanIndex,
  planNotFoundError,
  type PlanObj,
  type PlanSection,
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

/** Everything the tool accepts, before the mode check narrows it. */
interface DiffArgs {
  from?: SnapshotSelectorArgs;
  to?: SnapshotSelectorArgs;
  planIdentifier?: string;
  planA?: string;
  planB?: string;
  section?: PlanSection;
  pathsOnly?: boolean;
}

/**
 * The tool compares one data set at two points in time (`time`) or two
 * different plans side by side (`plans`). Which one is asked for decides which
 * arguments are required, and the two modes share no argument, so a mixed call
 * is refused with what to drop rather than guessed at.
 */
function requireMode(
  args: DiffArgs,
): { mode: "time" } | { mode: "plans"; planA: string; planB: string } {
  if (args.planA === undefined && args.planB === undefined) {
    if (args.from === undefined) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        "No from snapshot selector supplied",
        "Supply from with exactly one of snapshotId, nBack or beforeTime to compare a snapshot against another snapshot or the live data, or supply planA and planB together to compare two plans",
      );
    }
    return { mode: "time" };
  }
  if (args.planA === undefined || args.planB === undefined) {
    const missing = args.planA === undefined ? "planA" : "planB";
    throw new ProjectionLabError(
      "INVALID_INPUT",
      `planA and planB compare two plans together, and ${missing} is missing`,
      "Name both plans, or drop planA and planB to compare a snapshot against another snapshot or the live data",
    );
  }
  const { planA, planB } = args;
  for (const name of ["to", "planIdentifier"] as const) {
    if (args[name] !== undefined) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        `planA and planB compare two plans, and ${name} belongs to the points-in-time comparison`,
        `Drop ${name}. planA and planB read both plans from the live app, or from one snapshot with from. Compare points in time with from and to alone`,
      );
    }
  }
  return { mode: "plans", planA, planB };
}

/** A missing plan names the side it was asked for, so the fix is unambiguous. */
function planSideNotFoundError(
  plans: unknown[],
  identifier: string,
  side: "planA" | "planB",
): ProjectionLabError {
  const notFound = planNotFoundError(plans, identifier);
  const position = side === "planA" ? "first" : "second";
  return new ProjectionLabError(
    "INVALID_INPUT",
    `${notFound.message} for ${side}`,
    `${side}'s values are reported ${position} in each "A → B" pair. ${notFound.suggestion}`,
  );
}

/** A plan-to-plan request whose two plan identifiers are present. */
interface PairRequest {
  planA: string;
  planB: string;
  from?: SnapshotSelectorArgs;
  section?: PlanSection;
  pathsOnly?: boolean;
}

/** How a plan is named to the user: its name, falling back to its id. */
function planLabel(plan: unknown): string {
  const obj = (plan ?? {}) as PlanObj;
  return String(obj.name ?? obj.id ?? "unnamed");
}

export function registerDiffTool(
  server: McpServer,
  bridge: Bridge,
  snapshots: SnapshotManager,
) {
  /** The plans a plan-to-plan comparison reads, and where they came from. */
  async function readPlansForPair(from?: SnapshotSelectorArgs): Promise<{
    plans: unknown[];
    readFrom: Record<string, unknown>;
  }> {
    if (from) {
      const snapshot = await resolveSnapshot(snapshots, from, "from snapshot");
      const stored = snapshot.data.plans;
      if (!Array.isArray(stored)) {
        throw new ProjectionLabError(
          "INVALID_INPUT",
          `The snapshot "${snapshot.id}" holds no plans data`,
          "Drop from to compare the plans in ProjectionLab now, or pick a snapshot whose sections include plans; projectionlab_list_snapshots shows what each snapshot holds",
        );
      }
      return { plans: stored, readFrom: describeSnapshot(snapshot) };
    }
    const live = await bridge.exportData({ fresh: true });
    const plans = Array.isArray(live.plans) ? live.plans : [];
    if (plans.length === 0) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        "No plans found in ProjectionLab",
        "Create the plans in ProjectionLab first, or name two saved plans with from",
      );
    }
    return {
      plans,
      readFrom: {
        source: "live" as const,
        readAt: new Date().toISOString(),
        note: "both plans read from ProjectionLab when this diff ran",
      },
    };
  }

  /** Compare two different plans field by field, planA's values reported first. */
  async function comparePlans(args: PairRequest) {
    const budget = createDiffBudget({
      pathsOnly: args.pathsOnly === true,
    });
    const { plans, readFrom } = await readPlansForPair(args.from);
    const indexA = resolvePlanIndex(plans, args.planA);
    if (indexA === -1) {
      throw planSideNotFoundError(plans, args.planA, "planA");
    }
    const indexB = resolvePlanIndex(plans, args.planB);
    if (indexB === -1) {
      throw planSideNotFoundError(plans, args.planB, "planB");
    }
    if (indexA === indexB) {
      throw new ProjectionLabError(
        "INVALID_INPUT",
        `planA and planB both name the same plan ("${planLabel(plans[indexA])}")`,
        "Name two different plans; projectionlab_describe_schema lists them by name and ID",
      );
    }

    const pair = diffPlanPair(
      plans[indexA] as PlanObj,
      plans[indexB] as PlanObj,
      budget,
      args.section,
    );
    const result = {
      mode: "plans" as const,
      planA: pair.a,
      planB: pair.b,
      readFrom,
      ...(args.section ? { section: args.section } : {}),
      ...(args.pathsOnly ? { pathsOnly: true } : {}),
      changed: pair.changed,
      ...(pair.changed
        ? {}
        : {
            message:
              "No differences in the fields compared. The plan's own id and name, each event's own id and random key, and the computed fields (lastUpdated, simKey, meta) are excluded, and a reference to another event of the same plan is compared by the event it names, so a plan rebuilt by hand reads as unchanged.",
          }),
      planSettings: pair.settings,
      ...(pair.sections ? { sections: pair.sections } : {}),
      ...(pair.changedSections
        ? { changedSections: pair.changedSections }
        : {}),
      fieldChangeCap: budget.fieldChangeCap,
      ...(budget.omittedFieldChanges > 0
        ? { omittedFieldChanges: budget.omittedFieldChanges }
        : {}),
      ...(budget.omittedEntries > 0
        ? { omittedEntries: budget.omittedEntries }
        : {}),
    };

    const json = toJson(redactSecrets(result, { byName: true }));
    // A spilled result keeps the facts that name the comparison; the
    // sections themselves stay in the file it points at.
    const { sections: _sections, ...summary } = result;
    return {
      content: [
        { type: "text" as const, text: await textOrFile(json, "diff", summary) },
      ],
    };
  }

  server.registerTool(
    "projectionlab_diff",
    {
      title: "Diff Snapshots Over Time, or Two Plans Against Each Other",
      description:
        "Reports field-level differences, read-only: it never writes and never " +
        "snapshots, so it works with PL_READ_ONLY=true. Two modes, told apart by the " +
        "arguments you supply. " +
        "Points in time: from is required and names a saved snapshot with exactly " +
        "one of snapshotId, nBack or beforeTime, resolved the way " +
        "projectionlab_rollback resolves them. " +
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
        "Two plans: planA and planB name two different plans and compare one against the " +
        "other, so a plan rebuilt by hand in the ProjectionLab UI can be checked against " +
        "the original. Both plans are read from the live app, or from one snapshot when " +
        "from is also given; planA and planB cannot be combined with to or planIdentifier. " +
        "Events match by name plus occurrence. The fields that say which plan an object is " +
        "(the plan's id and name, each event's own id) and the computed fields are left " +
        "out, as is each event's random key, which ProjectionLab assigns when the event is " +
        "created, so re-entering the same event does not read as a difference. A reference " +
        "from one event to another event of the same plan, such as a " +
        "milestone id in a start or end condition, is compared by the event it names, so " +
        "the same milestone still compares equal under the unrelated ids two plans store. " +
        "Each section reports onlyInA, onlyInB, different (each with \"path\": \"planA " +
        "value → planB value\") and sameCount; planSettings reports the plan's own fields " +
        "outside the sections. Use it to answer \"does the plan I rebuilt match the " +
        "original?\" " +
        "In either mode pathsOnly: true reports the paths that differ with no values, for " +
        "a comparison whose values are private. " +
        "Any value whose path names a credential (apiKey, token, password, ...) is reported as " +
        "[REDACTED] rather than shown, and a value longer than 200 characters is truncated with its " +
        "original length. Output is capped at " +
        `${FIELD_CHANGE_CAP} field changes, with omittedFieldChanges and per-entry ` +
        "omittedChanges counting the rest; a difference past the cap is still counted as changed.",
      inputSchema: {
        from: selectorSchema
          .optional()
          .describe(
            "The baseline side, whose values are reported as before: one saved snapshot, selected like projectionlab_rollback does. Required to compare points in time. With planA and planB it is optional and names the one snapshot both plans are read from.",
          ),
        to: selectorSchema
          .optional()
          .describe(
            "The side whose values are reported as after: another saved snapshot, or omit it to compare against the live data read from ProjectionLab now. Points-in-time mode only; never combine it with planA or planB.",
          ),
        planIdentifier: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Report one plan only: plan name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID. Points-in-time mode only; name the plans with planA and planB instead.",
          ),
        planA: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Compare two different plans instead of two points in time: the plan whose values are reported first, by plan name (case-insensitive; a partial match must identify exactly one plan) or exact plan ID. Supply planA and planB together, never with to or planIdentifier.",
          ),
        planB: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "The second plan of a plan-to-plan comparison, whose values are reported second in each \"A → B\" pair. Supply it together with planA.",
          ),
        section: z
          .enum(PLAN_SECTIONS)
          .optional()
          .describe(
            "Compare one plan section only, such as income or expenses. Plan settings outside the sections are still compared.",
          ),
        pathsOnly: z
          .boolean()
          .optional()
          .describe(
            "Report the paths that differ with no values, for a comparison whose values are private. Works in both modes.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const request = requireMode(args);
        if (request.mode === "plans") {
          return await comparePlans({
            planA: request.planA,
            planB: request.planB,
            from: args.from,
            section: args.section,
            pathsOnly: args.pathsOnly,
          });
        }
        // The points-in-time mode: one data set read at two moments.
        const { from = {}, to, planIdentifier, section } = args;
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
          const beforeIndex = resolvePlanIndex(olderPlans, planIdentifier);
          const afterIndex = resolvePlanIndex(newerPlans, planIdentifier);
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

        const budget = createDiffBudget({
          pathsOnly: args.pathsOnly === true,
        });
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

        const json = toJson(redactSecrets(result, { byName: true }));
        // A spilled result keeps the facts that name the comparison; the
        // sections themselves stay in the file it points at.
        const { sections: _sections, ...summary } = result;
        return {
          content: [
            { type: "text", text: await textOrFile(json, "diff", summary) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
