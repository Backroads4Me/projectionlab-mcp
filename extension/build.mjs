import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
// One version names a release of the server and the extension: the root
// package.json version, written into each built manifest.
const { version } = JSON.parse(await readFile("../package.json", "utf8"));
await rm("dist", { recursive: true, force: true });
await mkdir("dist/chromium", { recursive: true });
await mkdir("dist/firefox", { recursive: true });
for (const [browser, target] of [["chromium", "chrome116"], ["firefox", "firefox128"]]) {
  await build({ entryPoints: { background: "src/background.js", options: "src/options.js" }, bundle: true, outdir: `dist/${browser}`, format: "iife", target });
  await cp("src/options.html", `dist/${browser}/options.html`);
  await cp("src/icons", `dist/${browser}/icons`, { recursive: true });
}
for (const [source, browser] of [["manifest.json", "chromium"], ["manifest.firefox.json", "firefox"]]) {
  const manifest = JSON.parse(await readFile(source, "utf8"));
  await writeFile(`dist/${browser}/manifest.json`, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
}
