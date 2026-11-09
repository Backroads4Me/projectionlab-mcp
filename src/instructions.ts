import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent guide shipped with the package (skills/projectionlab/SKILL.md). */
export const GUIDE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "projectionlab",
  "SKILL.md",
);

/** The guide's Markdown body, without its YAML frontmatter. */
export function readGuide(): string {
  const text = readFileSync(GUIDE_PATH, "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

/**
 * Sent to every MCP host in the initialize result. Hosts that surface server
 * instructions give these to the model; the full guide is the
 * `projectionlab://guide` resource and the bundled skill.
 */
export const SERVER_INSTRUCTIONS = `ProjectionLab MCP: reads and edits the user's ProjectionLab retirement plan through their logged-in browser tab.

- Call projectionlab_check_connection first in every session. If any check fails, read the resource projectionlab://guide and walk the user through the fix one step at a time.
- Writes are disabled unless the user sets PL_READ_ONLY=false. Every write tool is a dry run unless confirm: true is passed; describe the preview to the user in plain words (which plan, which item, the old and new value), never as JSON, and confirm only the specific change they approved. Confirmed changes are snapshotted and can be undone with projectionlab_rollback.
- Change the plan only when the user explicitly asks.
- Plan figures are private: never send them outside the conversation. Never reveal PL_API_KEY or the WebSocket token.
- The server reads plan definitions; projections and Chance of Success run only in the ProjectionLab UI.
- The tools read ProjectionLab's backup export: a field being present does not mean the app uses it, and a write that stored a value does not prove the app acts on it. Check a change's effect in the ProjectionLab UI.
- Provide information and education, not personalized financial advice.`;
