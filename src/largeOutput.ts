import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { toJson } from "./json.js";
import { secureMkdir, secureWriteFile } from "./secureFs.js";
import { log } from "./logger.js";

export const FILE_THRESHOLD = 100_000;
export const EXPORT_DIR = join(homedir(), ".projectionlab-mcp", "exports");
const RETENTION_DAYS = 30;

/** Delete export files whose last modification is older than the retention
 * window. Only .json files this module writes are touched. */
async function prune(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await readdir(EXPORT_DIR);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(EXPORT_DIR, file);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) {
        await unlink(filePath);
        log.info("largeOutput", `Pruned expired export ${file}`);
      }
    } catch {
      // Skip unreadable files.
    }
  }
}

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

  // Prune expired exports in the background, the way snapshots do.
  prune().catch((err) => log.warn("largeOutput", `Prune failed: ${err}`));

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
