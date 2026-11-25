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
  const linkType = process.platform === "win32" ? "junction" : "dir";
  for (const name of ["src", "vendor", "site/runtime"]) {
    try { await symlink(resolve(root, name), resolve(data, name), linkType); }
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

// Sends a request to a server in this process, keeping the public Host it was addressed to.
function localFetch(port, url, options = {}) {
  return new Promise((resolve, reject) => {
    const local = request({
      hostname: "127.0.0.1", port, path: url.pathname + url.search, method: options.method || "GET",
      signal: options.signal, headers: { ...Object.fromEntries(new Headers(options.headers || {})), Host: url.host },
    }, response => resolve(new Response([204, 304].includes(response.statusCode) ? null : Readable.toWeb(response), {
      status: response.statusCode,
      headers: Object.entries(response.headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, String(item)])),
    })));
    local.once("error", reject);
    local.end(options.body);
  });
}

export async function startTownAdmin({ origin, shopOrigin = origin, data, shopPort, townPort, env = process.env, auth }) {
  const publicUrl = new URL("/?guide=1", origin);
  const server = createAdminServer({
    root: data, production: origin.startsWith("https:"), publicOrigin: origin, basePath: adminPath, locale: "en",
    enableSiteEditor: false,
    finderUrl: publicUrl.href, shopOrigin, integrationSecret: env.PARENT_INTEGRATION_SECRET,
    geminiApiKey: env.HYBRID_TOWN_GEMINI_API_KEY || "",
    ...(auth && { auth }),
    fetch: (input, options = {}) => {
      const url = new URL(input);
      if (url.origin === new URL(shopOrigin).origin && url.pathname === "/api/platform/invitations") return localFetch(shopPort, url, options);
      // Listing a newly public shop reads its storefront; the town server answers it inside this container.
      if (townPort && url.origin === new URL(origin).origin && url.pathname.startsWith("/s/")) return localFetch(townPort, url, options);
      return fetch(input, options);
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}
