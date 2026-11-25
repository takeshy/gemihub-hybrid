// Dedicated fictional-shop demo. No upstream credentials, data or endpoints.
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { address } from "./hybrid-neighborhood.mjs";
import { createTownMcpHandler } from "./town-mcp.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const site = resolve(root, "site");
const deployedOrigin = "https://gemihub-hybrid-2026.web.app";
const port = Number(process.env.PORT || 8088);
const publicOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (![deployedOrigin, "https://hybrid.gemihub.net"].includes(publicOrigin) && !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(publicOrigin))
  throw new Error("Only the dedicated hybrid demo origin or localhost is allowed.");
process.env.APP_ORIGIN = publicOrigin;
// Shop owners build and manage their shops on a separate host; the town keeps this one.
const builderOrigin = (() => {
  const url = new URL(publicOrigin);
  if (url.hostname !== "hybrid.gemihub.net" && url.hostname !== "localhost") return null;
  url.hostname = `shop.${url.hostname}`;
  return url.origin;
})();
process.env.AGENT_PARENT_URL = publicOrigin;
process.env.DEMO_MODE = "true";
process.env.GEMIHUB_HYBRID_DEMO = "true";
process.env.GEMIHUB_DEFAULT_LOCALE = "en";
process.env.NODE_ENV = "development";
const townEnabled = process.env.HYBRID_TOWN_ADMIN === "true";
if (process.env.PAYPAL_CLIENT_SECRET || process.env.GEMINI_API_KEY || (!townEnabled && process.env.GOOGLE_CLIENT_SECRET))
  throw new Error("Only Hybrid credentials explicitly enabled for town administration are supported.");
process.env.SESSION_SECRET ||= townEnabled ? "" : randomBytes(32).toString("hex");
const adminPath = "/judge/admin";
let town;
let publishedSite = site;
if (townEnabled) {
  const { hybridProject, initializeTown } = await import("./hybrid-town-admin.mjs");
  const credentials = JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS || "/data/google-runtime.json", "utf8"));
  if (process.env.GOOGLE_CLOUD_PROJECT !== hybridProject || credentials.project_id !== hybridProject ||
      !process.env.STOREFRONT_BUCKET?.startsWith(hybridProject + "-") || !process.env.FIRESTORE_DATABASE_ID ||
      !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.PARENT_ADMIN_EMAILS ||
      !process.env.VERTEX_MODEL || !process.env.ACCESS_PASSWORD ||
      [process.env.SESSION_SECRET, process.env.PARENT_AUTH_SECRET, process.env.PARENT_INTEGRATION_SECRET].some(value => (value?.length || 0) < 32))
    throw new Error("Hybrid town administration requires the dedicated runtime, mail, invitation and storage settings.");
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= "/data/google-runtime.json";
  process.env.PARENT_ORIGIN = publicOrigin;
  process.env.PARENT_DEMO_LOGIN_TOKEN = process.env.HYBRID_TOWN_JUDGE_UNTIL ? process.env.HYBRID_TOWN_JUDGE_INVITE || "" : "";
  process.env.PARENT_DEMO_LOGIN_UNTIL = process.env.HYBRID_TOWN_JUDGE_UNTIL || "";
  if (!builderOrigin) throw new Error("Hybrid town administration needs the shop builder host (shop.hybrid.gemihub.net or shop.localhost).");
  const data = resolve(process.env.HYBRID_DATA_DIR || "/data");
  publishedSite = await initializeTown({ root, data, origin: publicOrigin });
  town = { data };
}
process.chdir(resolve(root, "apps/shop"));
const { Store } = await import("../apps/shop/server/store.ts");
const { createApp } = await import("../apps/shop/server/app.ts");
const { seedRestaurantDemo } = await import("../apps/shop/scripts/seed-restaurant-demo.ts");
const { allowDemoShoppers, withOrigin } = await import("../apps/shop/server/auth.ts");
const store = new Store(":memory:");
await seedRestaurantDemo(store, undefined, undefined, address); allowDemoShoppers();
const backend = createApp(store);
await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
const backendPort = backend.address().port;
const demoSlugs = new Set((await store.list("shop")).map(shop => shop.slug));
if (town) {
  const { startTownAdmin } = await import("./hybrid-town-admin.mjs");
  town.store = new Store("firestore");
  town.shop = createApp(town.store);
  // Requests forwarded from the builder host run as that origin (sign-in, cookies, Origin checks, emails).
  const [handleShop] = town.shop.listeners("request");
  town.shop.removeAllListeners("request");
  town.shop.on("request", (req, res) => withOrigin(req.headers.host === new URL(builderOrigin).host ? builderOrigin : publicOrigin, () => handleShop(req, res)));
  await new Promise(resolve => town.shop.listen(0, "127.0.0.1", resolve));
  town.shopPort = town.shop.address().port;
  town.admin = await startTownAdmin({ origin: publicOrigin, shopOrigin: builderOrigin, data: town.data, shopPort: town.shopPort, townPort: port });
  town.adminPort = town.admin.address().port;
  process.env.PARENT_MAIL_URL = `http://127.0.0.1:${town.adminPort}/api/internal/mail`;
  // A shop that becomes public joins the town's shop list through the same private integration.
  process.env.PARENT_SHOPS_URL = `http://127.0.0.1:${town.adminPort}/api/internal/shops`;
}
const mime = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".txt": "text/plain", ".pdf": "application/pdf" };
const rewritten = new Set(["shop-registry.js", "agent-manifest.json", "reservation_finder.network.json", "reservation_finder.hocon"]);
const townMcp = createTownMcpHandler({ siteDir: publishedSite, factsDir: site, deployedOrigin, publicOrigin });
const townAssets = new Set(["index.html", "shops.json", "chat-documents.json", "links.json", ...rewritten,
  "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json", "bridge/agent-manifest.json", "bridge/action-bridge.html"]);
function forward(req, res, port, target = publicOrigin) {
  const proxy = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method,
    headers: { ...req.headers, host: new URL(target).host } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Backend unavailable"); });
  res.once("close", () => proxy.destroy());
  req.pipe(proxy);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, publicOrigin);
    const path = url.pathname;
    if (path === "/healthz") { res.end("ok"); return; }
    if (builderOrigin && (req.headers.host || "").toLowerCase() === new URL(builderOrigin).host) {
      if (!town) { res.writeHead(503, { "Cache-Control": "no-store" }); res.end("Shop building is awaiting setup."); return; }
      return forward(req, res, town.shopPort, builderOrigin);
    }
    if (path === "/api/mcp") { await townMcp(req, res); return; }
    if (path === adminPath) { res.writeHead(308, { Location: adminPath + "/" }); res.end(); return; }
    if (path.startsWith(adminPath + "/")) {
      if (!town) { res.writeHead(503, { "Cache-Control": "no-store" }); res.end("Town administration is awaiting setup."); return; }
      if (path === adminPath + "/auth/demo" && req.method !== "POST") { res.writeHead(404); res.end(); return; }
      return forward(req, res, town.adminPort);
    }
    const storefront = /^\/(?:s|api\/public)\/([^/]+)/.exec(path);
    if (storefront) return forward(req, res, town && !demoSlugs.has(storefront[1]) ? town.shopPort : backendPort);
    if (/^\/api\/ai\/(?:config|session)$|^\/assets\/|^\/(?:storefront-login|live-audio)\.js$/.test(path)) return forward(req, res, backendPort);
    if (town) {
      const ownerLogin = /^\/(?:api\/(?:session|logout|access|owner-login(?:\/(?:info|verify))?)|auth\/(?:google(?:\/callback)?|complete))$/.test(path);
      // Earlier owner links (/?shop=...) now open the dashboard on the builder host.
      if (path === "/" && url.searchParams.has("shop") && !url.searchParams.has("guide") && ["GET", "HEAD"].includes(req.method)) {
        res.writeHead(308, { Location: new URL(url.pathname + url.search, builderOrigin).href, "Cache-Control": "no-store" }); res.end(); return;
      }
      const shopManagement = /^\/api\/(?:shops(?:\/|$)|(?:workspace|invitations|shop-reset|staff-login|legacy-notes)(?:\/|$))|^\/(?:publication-preview|staff-login)\/|^\/manual(?:\/|$)|^\/settings\/migration$/.test(path);
      // Storefront customers still sign in here; owner pages stay reachable for older links.
      if (ownerLogin || shopManagement) return forward(req, res, town.shopPort);
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const relative = decodeURIComponent(path === "/" ? "index.html" : path === "/judge" ? "judge.html" : path.slice(1));
    if (relative.split(/[\\/]/).some(part => part.startsWith(".") && part !== ".well-known") || /(?:llm-relay|ai-setup)\.js$/.test(relative)) {
      res.writeHead(404); res.end(); return;
    }
    const target = resolve(site, relative);
    if (!target.startsWith(site + sep)) { res.writeHead(404); res.end(); return; }
    const editable = town && (townAssets.has(relative) || /^(?:design-[a-f0-9]{20}\.css|page-images\/[a-f0-9]{64}\.webp|chat-document-files\/[a-f0-9-]{36}\.pdf)$/.test(relative));
    let bytes;
    if (editable) {
      try { bytes = await readFile(resolve(publishedSite, relative)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    bytes ||= await readFile(target);
    if (rewritten.has(relative) || relative === "shop-public-facts.json") bytes = Buffer.from(bytes.toString().replaceAll(deployedOrigin, publicOrigin));
    res.writeHead(200, { "Content-Type": `${mime[extname(target)] || "application/octet-stream"}; charset=utf-8`,
      ...(relative === "judge.html" ? { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } : {}),
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", ...(extname(target) === ".pdf" ? { "Content-Security-Policy": "sandbox" } : {}) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.listen(port, "0.0.0.0", () => console.log(`Gemihub Hybrid fictional-shop demo: ${publicOrigin}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close();
  town?.admin.close();
  town?.shop.close();
  backend.close(() => { void Promise.all([store.close(), town?.store.close()]).then(() => process.exit(0)); });
});
