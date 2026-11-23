// Dedicated fictional-shop demo. No upstream credentials, data or endpoints.
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createSampleShops } from "./sample-shops.mjs";
import { address } from "./hybrid-neighborhood.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const site = resolve(root, "site");
const deployedOrigin = "https://gemihub-hybrid-2026.web.app";
const port = Number(process.env.PORT || 8088);
const publicOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (![deployedOrigin, "https://hybrid.gemihub.net"].includes(publicOrigin) && !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(publicOrigin))
  throw new Error("Only the dedicated hybrid demo origin or localhost is allowed.");
process.env.APP_ORIGIN = publicOrigin;
process.env.AGENT_PARENT_URL = publicOrigin;
process.env.DEMO_MODE = "true";
process.env.GEMIHUB_HYBRID_DEMO = "true";
process.env.GEMIHUB_DEFAULT_LOCALE = "en";
process.env.NODE_ENV = "development";
process.env.SESSION_SECRET ||= randomBytes(32).toString("hex");
// This public demo exposes no owner/admin API, outbound mail or payment account.
if (process.env.GEMINI_API_KEY || process.env.PAYPAL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET)
  throw new Error("Do not provide upstream service credentials to the public hybrid demo.");
process.chdir(resolve(root, "apps/shop"));
const { Store } = await import("../apps/shop/server/store.ts");
const { createApp } = await import("../apps/shop/server/app.ts");
const { seedRestaurantDemo } = await import("../apps/shop/scripts/seed-restaurant-demo.ts");
const { allowDemoShoppers } = await import("../apps/shop/server/auth.ts");
const store = new Store(":memory:");
await seedRestaurantDemo(store, undefined, undefined, address); allowDemoShoppers();
const sampleShops = createSampleShops(store, publicOrigin);
const backend = createApp(store);
await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
const backendPort = backend.address().port;
const mime = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".txt": "text/plain" };
const rewritten = new Set(["shop-registry.js", "agent-manifest.json", "reservation_finder.network.json", "reservation_finder.hocon"]);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, publicOrigin).pathname;
    if (path === "/healthz") { res.end("ok"); return; }
    const sampleAccess = await sampleShops.route(req, res, path);
    if (sampleAccess === "handled") return;
    if (/^\/s\/|^\/api\/public\/|^\/api\/ai\/(?:config|session)$|^\/assets\//.test(path)) {
      const proxy = request({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: new URL(publicOrigin).host } }, response => {
        const headers = response.headers;
        if (sampleAccess === "private") {
          headers["cache-control"] = "private, no-store";
          headers.vary = [headers.vary, "Cookie"].filter(Boolean).join(", ");
          delete headers["access-control-allow-origin"];
        }
        res.writeHead(response.statusCode, headers); response.pipe(res);
      });
      proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Demo backend unavailable"); });
      res.once("close", () => proxy.destroy()); req.pipe(proxy); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const relative = decodeURIComponent(path === "/" ? "index.html" : path === "/judge" ? "judge.html" : path.slice(1));
    if (relative.split(/[\\/]/).some(part => part.startsWith(".") && part !== ".well-known") || /(?:llm-relay|ai-setup)\.js$/.test(relative)) {
      res.writeHead(404); res.end(); return;
    }
    const target = resolve(site, relative);
    if (!target.startsWith(site + sep)) { res.writeHead(404); res.end(); return; }
    let bytes = await readFile(target);
    if (rewritten.has(relative)) bytes = Buffer.from(bytes.toString().replaceAll(deployedOrigin, publicOrigin));
    res.writeHead(200, { "Content-Type": `${mime[extname(target)] || "application/octet-stream"}; charset=utf-8`,
      ...(relative === "judge.html" ? { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } : {}),
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.listen(port, "0.0.0.0", () => console.log(`Gemihub Hybrid fictional-shop demo: ${publicOrigin}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(); backend.close(() => { void store.close().then(() => process.exit(0)); });
});
