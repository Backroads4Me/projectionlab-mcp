/**
 * Plan event fields that ProjectionLab 5 copies from the item an event links
 * to, so a value written to them in a plan does not stay.
 *
 * Source: the plan reconciliation in ProjectionLab's shipped web build,
 * version DATA_MODEL_V5_PROJECTIONLAB_VERSION (`src/dataModel.ts`). Each time
 * a plan is saved or opened, ProjectionLab copies these fields onto every
 * linked event from its Current Finances account or asset, skipping a field
 * only when the event lists its path in `_meta.overriddenFields`. A plan
 * write that changes one of them is reverted by the next read. Live writes
 * on ProjectionLab 5.0.0 confirm this for an account event's type, name,
 * icon, balance, liquidity, owner, hidden and withdrawal terms, an asset
 * event's name, value and hidden, and a priority's owner and icon.
 *
 * - An account event links by `accountId` to a Current Finances account or
 *   debt.
 * - An asset event links by `assetId` to a Current Finances real asset.
 * - A priority with `accountId` takes `owner` and `icon` from the account it
 *   routes to; a transfer priority takes only `owner`.
 *
 * The baseline plan (`settings.plan.baselineId`) keeps no overrides:
 * ProjectionLab deletes `_meta.overriddenFields` from its events.
 *
 * ProjectionLab 4 plans have no such links.
 */

import type { ExportLayout } from "./layout.js";
import type { PlanObj } from "./plans.js";
import { ProjectionLabError } from "./errors.js";

/** Account event fields copied from the linked Current Finances account. */
export const ACCOUNT_EVENT_LINKED_FIELDS: readonly string[] = [
  "type",
  "subtype",
  "name",
  "icon",
  "balance",
  "costBasis",
  "liquidity",
  "investable",
  "owner",
  "recipient",
  "notes",
  "hidden",
  "originalOwnerBirth",
  "originalOwnerDeath",
  "EWAge",
  "hasEWPenalty",
  "EWPenaltyRate",
  "withdrawContribsFree",
];

/** Asset event fields copied from the linked Current Finances real asset. */
export const ASSET_EVENT_LINKED_FIELDS: readonly string[] = [
  "name",
  "type",
  "subtype",
  "owner",
  "purchasePrice",
  "value",
  "liquidity",
  "investable",
  "initialBuildingValue",
  "initialBuildingValueType",
  "loans",
  "notes",
  "hidden",
  "icon",
];

/** Priority fields copied from the account the priority routes to. */
export const PRIORITY_LINKED_FIELDS: readonly string[] = ["owner", "icon"];

/** Transfer priority fields copied from the transfer's source account. */
export const TRANSFER_PRIORITY_LINKED_FIELDS: readonly string[] = ["owner"];

export interface EventLink {
  /** The event field holding the link: accountId or assetId. */
  linkKey: "accountId" | "assetId";
  /** The id the event links to. */
  linkId: string;
  /** What the event links to, for messages. */
  target: "Current Finances account" | "Current Finances asset" | "account the priority routes to";
  /** Top-level fields ProjectionLab copies onto the event. */
  fields: readonly string[];
}

function linkValue(event: PlanObj, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The link a plan event carries on ProjectionLab 5, or undefined. */
export function eventLink(
  section: string,
  event: unknown,
  layout: ExportLayout,
): EventLink | undefined {
  if (layout !== "v5" || !event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const obj = event as PlanObj;
  if (section === "accounts") {
    const linkId = linkValue(obj, "accountId");
    return linkId
      ? { linkKey: "accountId", linkId, target: "Current Finances account", fields: ACCOUNT_EVENT_LINKED_FIELDS }
      : undefined;
  }
  if (section === "assets") {
    const linkId = linkValue(obj, "assetId");
    return linkId
      ? { linkKey: "assetId", linkId, target: "Current Finances asset", fields: ASSET_EVENT_LINKED_FIELDS }
      : undefined;
  }
  if (section === "priorities") {
    const linkId = linkValue(obj, "accountId");
    if (!linkId) return undefined;
    const transfer = obj.type === "transfer" || obj.goalIntent === "transfer";
    return {
      linkKey: "accountId",
      linkId,
      target: "account the priority routes to",
      fields: transfer ? TRANSFER_PRIORITY_LINKED_FIELDS : PRIORITY_LINKED_FIELDS,
    };
  }
  return undefined;
}

/** The linked field a dot path falls under, or undefined. */
export function linkedFieldOf(
  path: string,
  fields: readonly string[],
): string | undefined {
  return fields.find((field) => path === field || path.startsWith(`${field}.`));
}

/** Whether the event keeps its own value for a field (a plan override). */
export function isOverridden(event: PlanObj, field: string): boolean {
  const meta = event._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const overridden = (meta as PlanObj).overriddenFields;
  if (!overridden || typeof overridden !== "object" || Array.isArray(overridden)) {
    return false;
  }
  return (overridden as PlanObj)[field] === true;
}

/** The baseline plan id a ProjectionLab 5 export names, or undefined. */
export function baselinePlanId(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const plan = (settings as PlanObj).plan;
  if (!plan || typeof plan !== "object") return undefined;
  const id = (plan as PlanObj).baselineId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The changed paths ProjectionLab would overwrite: those under a linked field
 * the event does not override. On the baseline plan no override counts.
 */
export function linkedPathsChanged(
  event: PlanObj,
  link: EventLink,
  changedPaths: readonly string[],
  isBaseline: boolean,
): string[] {
  return changedPaths.filter((path) => {
    const field = linkedFieldOf(path, link.fields);
    if (field === undefined) return false;
    return isBaseline || !isOverridden(event, field);
  });
}

/**
 * The Current Finances id and record behind a link. A priority links to the
 * plan's account event, so its id is that event's accountId.
 */
export function linkedRecord(
  link: EventLink,
  plan: PlanObj,
  currentFinances: unknown,
): { id?: string; record?: PlanObj } {
  let id: string | undefined = link.linkId;
  if (link.target === "account the priority routes to") {
    const accountEvents = (plan.accounts as PlanObj | undefined)?.events;
    const routed = Array.isArray(accountEvents)
      ? (accountEvents.find(
          (e) => e && typeof e === "object" && (e as PlanObj).id === link.linkId,
        ) as PlanObj | undefined)
      : undefined;
    id = routed ? linkValue(routed, "accountId") : undefined;
  }
  if (id === undefined) return {};
  const accounts = (currentFinances as PlanObj | undefined)?.accounts;
  const record =
    accounts && typeof accounts === "object" && !Array.isArray(accounts)
      ? ((accounts as PlanObj)[id] as PlanObj | undefined)
      : undefined;
  return record && typeof record === "object" ? { id, record } : { id };
}

/**
 * The refusal for a plan write to fields ProjectionLab copies from a link.
 * A field the Current Finances record holds is changed there with
 * projectionlab_update_account; one it lacks takes the account type's default,
 * which the user changes on the account in ProjectionLab.
 */
export function linkedFieldsError(
  eventName: string,
  link: EventLink,
  paths: readonly string[],
  linked: { id?: string; record?: PlanObj },
): ProjectionLabError {
  const where =
    link.target === "account the priority routes to"
      ? `the account it routes to (plan account event "${link.linkId}")`
      : `its ${link.target} (${link.linkKey} "${link.linkId}")`;
  const held = paths.filter((path) => {
    const field = linkedFieldOf(path, link.fields);
    return (
      field !== undefined &&
      linked.record !== undefined &&
      Object.prototype.hasOwnProperty.call(linked.record, field)
    );
  });
  const missing = paths.filter((path) => !held.includes(path));
  const steps: string[] = [];
  if (held.length > 0) {
    steps.push(
      `Change ${held.join(", ")} with projectionlab_update_account on Current Finances id "${linked.id}"; every plan linked to it takes the new value`,
    );
  }
  if (missing.length > 0) {
    steps.push(
      linked.record === undefined
        ? `Change ${missing.join(", ")} on the linked item in ProjectionLab; the export holds no Current Finances record for it`
        : `The Current Finances record holds no ${missing.join(", ")}, so ProjectionLab fills ${missing.length === 1 ? "it" : "them"} from the account type's default; ask the user to change ${missing.length === 1 ? "it" : "them"} on the account in ProjectionLab`,
    );
  }
  return new ProjectionLabError(
    "INVALID_INPUT",
    `Event "${eventName}" takes ${paths.join(", ")} from ${where}; ProjectionLab overwrites a value written to it in the plan`,
    steps.join(". "),
  );
}
