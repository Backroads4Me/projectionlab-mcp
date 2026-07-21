import { mkdir, writeFile, chmod } from "node:fs/promises";

// Snapshots and exports can contain complete financial state (balances,
// accounts, debts, income). Keep them owner-only rather than trusting the
// process umask.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Create a directory owner-only. `recursive` mkdir only applies the mode to
 * directories it creates, so also chmod the leaf to correct a pre-existing
 * directory that was created with looser permissions.
 */
export async function secureMkdir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(dir, DIR_MODE);
  } catch {
    // Best effort (e.g. not the owner); the mkdir mode still applies to new dirs.
  }
}

/** Write a file owner-only (0600). */
export async function secureWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  await writeFile(filePath, data, { mode: FILE_MODE });
}
