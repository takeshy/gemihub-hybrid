import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseHocon } from "../site/runtime/hocon.js";
import { validateShops } from "./shops.mjs";

export async function buildSite({ root = new URL("../", import.meta.url), check = false, production = false, stdio = "inherit" } = {}) {
  const json = async path => JSON.parse(await readFile(new URL(path, root), "utf8"));
  const shops = validateShops(await json("site/shops.json"), { production });
  const partners = shops.filter(shop => shop.networkUrl);
  const upstream = await json("vendor/upstream.json");
  async function hashRuntime(dir, prefix = "", actual = {}) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await hashRuntime(path, prefix + entry.name + "/", actual);
      else actual[prefix + entry.name] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    return actual;
  }
  for (const path of ["site/runtime/", "vendor/agentify-website/runtime/"]) {
    const actual = await hashRuntime(new URL(path, root));
    if (Object.keys(actual).length !== Object.keys(upstream.runtimeSha256).length || Object.entries(actual).some(([file, hash]) => hash !== upstream.runtimeSha256[file])) throw new Error(`公式 ${path} が変更されています。固定版を無改変で使用してください。`);
  }

  const network = parseHocon(await readFile(new URL("src/reservation_finder.hocon", root), "utf8"));
  network.link_labels = Object.fromEntries(partners.map(shop => [shop.networkUrl, shop.name]));
  network.tools[0].tools = ["condition_checker", ...partners.map(shop => shop.networkUrl)];
  network.tools[0].instructions = network.tools[0].instructions.replace("{partner_rules}", partners.map(shop => `- ${shop.name}: ${shop.networkTool} で公開情報を確認。予約対応の有無は登録情報を読む。`).join("\n") + "\n{partner_rules}");
  const manifest = await json("src/agent-manifest.json");
  manifest.allowed_peers = [...new Set(partners.map(shop => new URL(shop.networkUrl).origin))];
  const serialize = value => JSON.stringify(value, null, 2) + "\n";
  const pageOrigins = [...new Set(shops.map(shop => new URL(shop.pageUrl).origin))];
  const csp = `default-src 'self'; script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-src 'self' https://maps.google.com https://www.google.com ${pageOrigins.join(" ")}; worker-src 'self' blob:; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; form-action 'self'`;
  const publicPaths = ["agent-manifest.json", "reservation_finder.network.json", "links.json", "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json"];
  const headers = publicPaths.map(path => `/${path}\n  Access-Control-Allow-Origin: *\n`).join("\n") + `\n/chat-documents.json\n  Cache-Control: no-store\n\n/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n\n/\n  Content-Security-Policy: ${csp}\n\n/index.html\n  Content-Security-Policy: ${csp}\n\n/runtime/sandbox-worker.js\n  Content-Security-Policy: default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'\n`;
  const outputs = {
    "site/shop-registry.js": "// Generated from shops.json by scripts/build.mjs. Do not edit.\nexport const shops = " + serialize(shops).trimEnd() + ";\n",
    "site/reservation_finder.hocon": "// Generated from src/reservation_finder.hocon and shops.json. Do not edit.\n" + serialize(network),
    "site/agent-manifest.json": serialize(manifest),
    "site/links.json": serialize({ version: 1, networks: { reservation_finder: {} } }),
    "site/_headers": headers,
  };
  for (const [path, value] of Object.entries(outputs)) {
    if (check) {
      if (await readFile(new URL(path, root), "utf8").catch(() => null) !== value) throw new Error(`${path} is out of date. Run npm run build.`);
    } else await writeFile(new URL(path, root), value);
  }
  const run = spawnSync(process.execPath, ["vendor/agentify-website/scripts/build_network.mjs", "site/reservation_finder.hocon", "--manifest", "site/agent-manifest.json", ...(check ? ["--check"] : [])], { cwd: fileURLToPath(root), stdio, encoding: "utf8", timeout: 60000 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error([run.stdout, run.stderr].filter(Boolean).join("\n").trim() || `ビルドに失敗しました (exit ${run.status})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--production"].includes(arg))) throw new Error("Usage: node scripts/build.mjs [--check] [--production]");
  await buildSite({ check: args.includes("--check"), production: args.includes("--production") });
}
