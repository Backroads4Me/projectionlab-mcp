import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Bridge } from "./bridge.js";
import { config, type ElicitationMode } from "./config.js";
import { ProjectionLabError } from "./errors.js";
import { toJson } from "./json.js";
import { exportSections, sectionOf } from "./layout.js";
import { log } from "./logger.js";
import { planChanges, planConflictError } from "./planVersion.js";

/**
 * Write confirmation through MCP form elicitation. A write tool called with
 * `confirm: true` on a host that declares form elicitation asks the user
 * through the host's own prompt, with the change's plain-language summary,
 * before anything is written. A host that declares no elicitation keeps the
 * chat flow: the agent's `confirm: true` is the approval.
 */

/** How long the user has to answer a confirmation prompt. */
export const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a dismissed prompt keeps the chat fallback open for the same
 * change. */
export const CANCEL_RECORD_TTL_MS = 15 * 60 * 1000;

/** The optional argument every write tool accepts for the chat fallback. */
export const elicitationFallbackArg = z
  .enum(["chat"])
  .optional()
  .describe(
    'Only after a result with outcome "not_confirmed": "chat" when the user approved the same change in chat. Ignored otherwise.',
  );

/** The form schema: one boolean the user sets to approve. */
const APPROVAL_SCHEMA = {
  type: "object" as const,
  properties: {
    approve: {
      type: "boolean" as const,
      title: "Apply this change?",
      default: false,
    },
  },
  required: ["approve"],
};

let now: () => number = () => Date.now();

/** Replaces the clock the cancel records use, for tests. */
export function setConfirmationClock(clock: () => number): void {
  now = clock;
}

/** Changes whose prompt was dismissed or unavailable, by change key, with
 * the time each record expires. */
const cancelRecords = new Map<string, number>();

/** Forgets every cancel record, for tests. */
export function clearCancelRecords(): void {
  cancelRecords.clear();
}

function recordCancel(key: string): void {
  const time = now();
  for (const [k, expires] of cancelRecords) {
    if (expires <= time) cancelRecords.delete(k);
  }
  cancelRecords.set(key, time + CANCEL_RECORD_TTL_MS);
}

/** True when a live record exists for `key`; the record is used up. */
function consumeCancel(key: string): boolean {
  const expires = cancelRecords.get(key);
  cancelRecords.delete(key);
  return expires !== undefined && expires > now();
}

/** JSON with object keys sorted, so equal arguments give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The key that ties a cancel record to one tool and its exact arguments,
 * leaving out the confirmation arguments themselves. */
export function changeKey(tool: string, args: Record<string, unknown>): string {
  const { confirm: _confirm, elicitationFallback: _fallback, ...change } = args;
  return createHash("sha256").update(`${tool}\n${canonical(change)}`).digest("hex");
}

/**
 * True when the connected client declares form elicitation. A bare
 * `elicitation: {}` declares form mode (MCP 2025-11-25, Elicitation:
 * Capabilities). A server object without a protocol connection, as in the
 * tool tests, declares nothing.
 */
export function formElicitationDeclared(server: McpServer): boolean {
  const caps = (
    server as { server?: { getClientCapabilities?: () => unknown } }
  ).server?.getClientCapabilities?.();
  if (!caps || typeof caps !== "object") return false;
  const elicitation = (caps as { elicitation?: unknown }).elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  return "form" in elicitation || !("url" in elicitation);
}

/** Whether write tools ask through a confirmation prompt on this host. */
export function promptsForWrites(
  server: McpServer,
  mode: ElicitationMode = config.elicitation,
): boolean {
  return mode !== "off" && formElicitationDeclared(server);
}

/** The dry-run field that tells the agent a prompt will ask the user, so it
 * does not ask in chat as well. Empty on hosts without the prompt. */
export function promptHint(server: McpServer): { confirmation?: string } {
  return promptsForWrites(server)
    ? {
        confirmation:
          "This host shows the user a confirmation prompt with this summary when you call again with confirm: true. Describe the change briefly and let the prompt ask; do not also ask in chat.",
      }
    : {};
}

export type ConfirmOutcome =
  | { proceed: true; prompted: boolean }
  | { proceed: false; result: CallToolResult };

function refusal(outcome: "declined" | "not_confirmed", summary: string, message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: toJson({ success: false, confirmed: false, outcome, summary, message }),
      },
    ],
  };
}

/**
 * Asks the user to approve a write, when the host can ask. Call it after
 * the tool's own checks and before its snapshot and write.
 *
 * - No prompt on this host, or `PL_ELICITATION=off`: proceed, as the chat
 *   flow always has.
 * - `elicitationFallback: "chat"` after this exact change's prompt was
 *   dismissed or unavailable (and the mode is not `required`): proceed.
 * - Accepted with approve on: proceed.
 * - Declined, or accepted with approve off: refuse, outcome "declined".
 * - Dismissed, timed out, or failed: refuse, outcome "not_confirmed", and
 *   record the change so a chat approval can follow.
 */
export async function confirmWrite(
  server: McpServer,
  request: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    fallback?: "chat";
    signal?: AbortSignal;
    mode?: ElicitationMode;
  },
): Promise<ConfirmOutcome> {
  const mode = request.mode ?? config.elicitation;
  if (!promptsForWrites(server, mode)) return { proceed: true, prompted: false };

  const key = changeKey(request.tool, request.args);
  if (request.fallback === "chat" && mode !== "required" && consumeCancel(key)) {
    log.info("confirmWrite", `${request.tool}: approved in chat after the prompt was dismissed`);
    return { proceed: true, prompted: false };
  }

  let answer: { action: string; content?: Record<string, unknown> } | undefined;
  try {
    answer = await server.server.elicitInput(
      { mode: "form", message: request.summary, requestedSchema: APPROVAL_SCHEMA },
      { timeout: PROMPT_TIMEOUT_MS, signal: request.signal },
    );
  } catch (err) {
    log.warn(
      "confirmWrite",
      `${request.tool}: confirmation prompt failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (answer?.action === "accept" && answer.content?.approve === true) {
    return { proceed: true, prompted: true };
  }
  if (answer?.action === "accept" || answer?.action === "decline") {
    return {
      proceed: false,
      result: refusal(
        "declined",
        request.summary,
        "The user declined this change in the confirmation prompt. Nothing was written. Do not retry it unless the user asks again.",
      ),
    };
  }

  if (mode === "required") {
    return {
      proceed: false,
      result: refusal(
        "not_confirmed",
        request.summary,
        "Not confirmed: the confirmation prompt was dismissed or unavailable, and this server requires the prompt (PL_ELICITATION=required). Nothing was written. Ask the user to answer the prompt, then call again with confirm: true.",
      ),
    };
  }
  recordCancel(key);
  return {
    proceed: false,
    result: refusal(
      "not_confirmed",
      request.summary,
      'Not confirmed: the confirmation prompt was dismissed or unavailable. Nothing was written. Ask the user in chat; if they approve, call again with the same arguments, confirm: true and elicitationFallback: "chat".',
    ),
  };
}

/**
 * Refuses a write when a section it snapshots or merges from its earlier
 * read changed while the confirmation prompt was open, so no snapshot is
 * taken of data the user has since replaced. Plans refuse with
 * `PLAN_CONFLICT`, as the plans write itself would
 * (`Bridge.restorePlansIfUnchanged`); other sections with `DATA_CONFLICT`.
 */
export async function assertUnchangedDuringPrompt(
  bridge: Bridge,
  before: unknown,
  sections: readonly string[],
): Promise<void> {
  const after = await bridge.exportData({ fresh: true });
  if (sections.includes("plans")) {
    const changes = planChanges(exportSections(before).plans, exportSections(after).plans);
    if (changes.length > 0) throw planConflictError(changes);
  }
  const changed = sections.filter(
    (section) =>
      section !== "plans" &&
      canonical(sectionOf(before, section)) !== canonical(sectionOf(after, section)),
  );
  if (changed.length > 0) {
    throw new ProjectionLabError(
      "DATA_CONFLICT",
      `${changed.join(", ")} changed in ProjectionLab while the confirmation prompt was open. Nothing was written.`,
      "Re-run the tool without confirm to preview against the latest data, then confirm again",
    );
  }
}
