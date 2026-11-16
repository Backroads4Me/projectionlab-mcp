import type { Bridge, EditAccess } from "./bridge.js";
import { ProjectionLabError } from "./errors.js";

const SWITCH = "\"Enable agent plan edits\"";

/**
 * The READ_ONLY_MODE error for an executor whose edits are not enabled.
 * Writes are allowed only while the connected extension reports its
 * Enable agent plan edits switch on; the extension enforces the same switch
 * in the browser before it runs any write.
 */
export function editsDisabledError(access: Exclude<EditAccess, "enabled">): ProjectionLabError {
  if (access === "unsupported") {
    return new ProjectionLabError(
      "READ_ONLY_MODE",
      "Write operations are disabled: the connected browser executor has no plan-edits switch, so it can only read",
      "Writes need the current MCP Bridge for ProjectionLab browser extension with " +
        `${SWITCH} turned on in its options. The console bootstrap snippet and older extension ` +
        "releases can only read. Ask the user whether to install or update the extension.",
    );
  }
  return new ProjectionLabError(
    "READ_ONLY_MODE",
    "Write operations are disabled: agent plan edits are turned off in the browser extension",
    `Ask the user whether to allow edits. If they agree, they turn on ${SWITCH} in the ` +
      "MCP Bridge for ProjectionLab extension's options (click the extension's toolbar icon). " +
      "It takes effect at once, with no restart; then retry.",
  );
}

/**
 * Refuses the tool call unless the connected executor allows edits. Write
 * tools call this first, so a dry run reports the refusal before any preview,
 * read, or snapshot.
 */
export async function requireEditsEnabled(bridge: Bridge): Promise<void> {
  const access = await bridge.editAccess();
  if (access !== "enabled") throw editsDisabledError(access);
}
