import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release version from the package root's package.json, which npm always
 * ships. The browser extension's build takes the same version, so one number
 * names a release of both.
 */
export const VERSION: string = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
).version;
