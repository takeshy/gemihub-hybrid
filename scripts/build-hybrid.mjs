import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({ absWorkingDir: root, entryPoints: ["hybrid/browser.js"], outfile: "site/hybrid.bundle.js",
  bundle: true, format: "esm", platform: "browser", target: "chrome139", minify: true, legalComments: "eof" });
await copyFile(new URL("../hybrid/style.css", import.meta.url), new URL("../site/hybrid.css", import.meta.url));
// The shop server serves the same artifacts from site/, without duplicating SDKs.
console.log("Built Firebase hybrid browser bundle.");
