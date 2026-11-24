import { access, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { applyPublishedDesign } from "../admin/site-design.mjs";
import { createAdminServer } from "../admin/server.mjs";
import { buildSite } from "./build.mjs";

export const adminPath = "/judge/admin";
export const hybridProject = "gemihub-hybrid-2026";

export async function initializeTown({ root, data, origin }) {
  const site = resolve(data, "site");
  await mkdir(site, { recursive: true });
  await mkdir(resolve(data, "admin"), { recursive: true });
  for (const name of ["src", "vendor", "site/runtime"]) {
    try { await symlink(resolve(root, name), resolve(data, name), "dir"); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await copyFile(resolve(root, "site/index.html"), resolve(site, "index.html"));
  const registry = resolve(site, "shops.json");
  try { await access(registry); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const seeded = await readFile(resolve(root, "site/shops.json"), "utf8");
    await writeFile(registry, seeded.replaceAll("https://gemihub-hybrid-2026.web.app", origin), { flag: "wx" });
  }
  await buildSite({ root: pathToFileURL(data + "/"), production: origin.startsWith("https:"), stdio: "pipe" });
  await applyPublishedDesign({ root: data, sourceRoot: root });
  return site;
}

export async function startTownAdmin({ origin, data, shopPort, env = process.env, auth }) {
  const publicUrl = new URL("/?guide=1", origin);
  const server = createAdminServer({
    root: data, production: origin.startsWith("https:"), publicOrigin: origin, basePath: adminPath, locale: "en",
    enableSiteEditor: false,
    finderUrl: publicUrl.href, shopOrigin: origin, integrationSecret: env.PARENT_INTEGRATION_SECRET,
    geminiApiKey: env.HYBRID_TOWN_GEMINI_API_KEY || "",
    ...(auth && { auth }),
    fetch: (input, options) => {
      const url = new URL(input);
      if (url.origin !== origin || url.pathname !== "/api/platform/invitations") return fetch(input, options);
      return new Promise((resolve, reject) => {
        const invitation = request({
          hostname: "127.0.0.1", port: shopPort, path: url.pathname, method: options.method,
          signal: options.signal, headers: { ...options.headers, Host: url.host },
        }, response => resolve(new Response(Readable.toWeb(response), {
          status: response.statusCode,
        })));
        invitation.once("error", reject);
        invitation.end(options.body);
      });
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}
