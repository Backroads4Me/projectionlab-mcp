// Produces store-ready zip artifacts from the built dist/ folders.
//   dist/projectionlab-mcp-chromium-<version>.zip  -> Chrome Web Store / Edge
//   dist/projectionlab-mcp-firefox-<version>.zip   -> Firefox AMO
// Run `npm run build` first. Then: node scripts/package.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

for (const browser of ["chromium", "firefox"]) {
  const src = join(root, "dist", browser);
  if (!existsSync(src)) {
    console.error(`Missing ${src} — run "npm run build" first.`);
    process.exit(1);
  }
  const zip = join(root, "dist", `projectionlab-mcp-${browser}-${version}.zip`);
  rmSync(zip, { force: true });
  // -r recurse, -X strip extra file attrs, run from inside the folder so paths
  // are relative to the extension root (manifest.json at top level).
  execFileSync("zip", ["-rX", zip, "."], { cwd: src, stdio: "inherit" });
  console.log(`wrote ${zip}`);
}
