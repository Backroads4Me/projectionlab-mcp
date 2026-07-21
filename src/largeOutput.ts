import { join } from "node:path";
import { homedir } from "node:os";
import { toJson } from "./json.js";
import { secureMkdir, secureWriteFile } from "./secureFs.js";
import { log } from "./logger.js";

export const FILE_THRESHOLD = 100_000;
export const EXPORT_DIR = join(homedir(), ".projectionlab-mcp", "exports");

/**
 * Returns the text as-is when small enough; otherwise writes it to a file
 * and returns a pointer message so MCP clients don't truncate mid-JSON.
 */
export async function textOrFile(
  text: string,
  label: string,
  summary: Record<string, unknown> = {},
): Promise<string> {
  if (text.length <= FILE_THRESHOLD) return text;

  await secureMkdir(EXPORT_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(EXPORT_DIR, `${label}-${timestamp}.json`);
  await secureWriteFile(filePath, text);
  log.info("largeOutput", `Wrote ${text.length} chars to ${filePath}`);

  return toJson(
    {
      truncated: true,
      reason: `Result is ${text.length} chars, larger than the ${FILE_THRESHOLD} char inline limit`,
      filePath,
      hint: "Read the file with offset/limit or jq for the parts you need",
      ...summary,
    },
  );
}
