import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/chromium", { recursive: true });
await mkdir("dist/firefox", { recursive: true });
for (const [browser, target] of [["chromium", "chrome116"], ["firefox", "firefox128"]]) {
  await build({ entryPoints: { background: "src/background.js", options: "src/options.js" }, bundle: true, outdir: `dist/${browser}`, format: "iife", target });
  await cp("src/options.html", `dist/${browser}/options.html`);
  await cp("src/icons", `dist/${browser}/icons`, { recursive: true });
}
await cp("manifest.json", "dist/chromium/manifest.json");
await cp("manifest.firefox.json", "dist/firefox/manifest.json");
