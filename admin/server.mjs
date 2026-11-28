import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveShop } from "../scripts/resolve-shop.mjs";
import { createShopStore } from "./store.mjs";
import { suggestCuisine } from "../scripts/suggest-cuisine.mjs";
import { createGoogleAuth, trustedIntegration } from "./google-auth.mjs";
import { createSiteEditor } from "./site-editor-store.mjs";
import { createSiteDesignGenerator } from "./site-editor-ai.mjs";
import { createSiteImages } from "./site-images.mjs";
import { createSiteCapture } from "./site-capture.mjs";
import { createChatDocuments, createDocumentImporter } from "./chat-documents.mjs";
import { translateAdminMessage } from "./i18n.js";
import { localizeAdminHtml } from "./localize-html.mjs";

async function body(req, limit = 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    const error = new Error("JSONで送信してください"); error.status = 415; throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const error = new Error("送信内容が大きすぎます"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("JSONを読み込めませんでした"); }
}

export function createAdminServer({ root = process.env.PARENT_ROOT || fileURLToPath(new URL("../", import.meta.url)), production = false, store = createShopStore({ root, production }), resolver = resolveShop, geminiApiKey = process.env.GEMINI_API_KEY || "", cuisineSuggester = suggestCuisine, basePath = "", locale = "ja", enableSiteEditor = true, auth = createGoogleAuth({ root, basePath }), integrationSecret = process.env.PARENT_INTEGRATION_SECRET || "", shopOrigin = process.env.SHOP_ADMIN_ORIGIN || "http://127.0.0.1:3000", publicOrigin = process.env.PARENT_ORIGIN?.startsWith("https://") ? process.env.PARENT_ORIGIN : "", finderUrl = process.env.AGENT_PARENT_URL || "http://localhost:8090", fetch: fetchImpl = globalThis.fetch, capture = createSiteCapture() } = {}) {
  const external = publicOrigin ? new URL(publicOrigin) : null;
  if (external && (external.origin !== publicOrigin || (external.protocol !== "https:" &&
      !(external.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(external.hostname)))))
    throw new Error("公開管理画面のURLはHTTPSのオリジンを指定してください");
  if (basePath && !/^\/(?:[a-z0-9-]+\/)*[a-z0-9-]+$/.test(basePath)) throw new Error("Invalid admin base path");
  const siteEditor = enableSiteEditor ? createSiteEditor({ root, configured: !!geminiApiKey, generate: createSiteDesignGenerator({ apiKey: geminiApiKey, fetch: fetchImpl, locale }) }) : null;
  const siteImages = enableSiteEditor ? createSiteImages({ root }) : null;
  const chatDocuments = createChatDocuments({ root });
  const importDocument = createDocumentImporter({ apiKey: geminiApiKey, fetch: fetchImpl });
  const publicPage = new URL(finderUrl);
  if (publicPage.username || publicPage.password || (publicPage.protocol !== "https:" && !(publicPage.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicPage.hostname)))) throw new Error("お店さがしの公開URLを確認してください");
  const industryLabels = locale === "en"
    ? { restaurant: "Restaurant", other: "Shop", nail: "Nail salon", hair: "Hair salon" }
    : { restaurant: "飲食店", other: "お店", nail: "ネイルサロン", hair: "美容室" };
  // A town shop that has just become public joins the shop list. Only its own storefront under the
  // town's origin is accepted; the existing entry for the same page is refreshed instead of duplicated.
  // Only the town's own storefront pages (/s/<slug>) can be listed or removed through the integration.
  function townShopPage(input) {
    let page;
    try { page = new URL(String(input?.pageUrl || "")); } catch { page = null; }
    if (!page || page.origin !== publicPage.origin || !/^\/s\/[a-z0-9][a-z0-9-]{0,79}$/.test(page.pathname) || page.search || page.hash) {
      const error = new Error("店舗ページのURLが不正です"); error.status = 400; throw error;
    }
    return { page, sameShop: shop => { try { return new URL(shop.pageUrl).origin === page.origin && new URL(shop.pageUrl).pathname.replace(/\/(?:reserve)?$/, "") === page.pathname; } catch { return false; } } };
  }
  async function removeClosedShop(input) {
    const { sameShop } = townShopPage(input);
    const current = await store.get();
    const existing = current.shops.find(sameShop);
    if (!existing) return { ok: true, removed: false };
    await store.delete(existing.id, current.revision);
    return { ok: true, id: existing.id, removed: true };
  }
  async function listPublishedShop(input) {
    const { page, sameShop } = townShopPage(input);
    const current = await store.get();
    const existing = current.shops.find(sameShop);
    const options = { shops: current.shops, editingId: existing?.id, discovery: true, production, fetch: fetchImpl,
      ...(geminiApiKey ? { suggestCuisine: details => cuisineSuggester(details, { apiKey: geminiApiKey }) } : {}) };
    let resolved = await resolver(page.href, options);
    if (resolved.choices) resolved = await resolver(page.href, { ...options, networkIndex: 0 });
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
    const industry = Object.hasOwn(industryLabels, input.industry) ? input.industry : existing?.industry;
    const shop = { ...resolved.shop, ...(industry ? { industry } : {}), name: resolved.shop.name || name || (locale === "en" ? "New shop" : "新しいお店"),
      area: resolved.shop.area || (locale === "en" ? "Not specified" : "未設定"),
      cuisine: resolved.shop.cuisine || industryLabels[industry] || industryLabels.other };
    const shops = existing ? current.shops.map(item => item.id === existing.id ? shop : item) : [...current.shops, shop];
    await store.save(shops, { [shop.id]: resolved.cache }, current.revision);
    return { ok: true, id: shop.id, added: !existing };
  }
  // Town shops listed before the registry kept a business type get it from their own public
  // facts.json. Only a missing industry is filled in; operator edits and other fields stay as they are.
  async function backfillIndustries() {
    const current = await store.get();
    const slugOf = shop => {
      try {
        const page = new URL(shop.pageUrl);
        return page.origin === publicPage.origin ? page.pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{0,79})\/?(?:reserve)?$/)?.[1] : undefined;
      } catch { return undefined; }
    };
    const found = new Map();
    for (const shop of current.shops.filter(shop => !shop.industry && slugOf(shop))) {
      try {
        const response = await fetchImpl(new URL(`/s/${slugOf(shop)}/agent/facts.json`, publicPage.origin),
          { redirect: "error", signal: AbortSignal.timeout(10000) });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const facts = await response.json();
        if (Object.hasOwn(industryLabels, facts?.industry)) found.set(shop.id, facts.industry);
      } catch { /* An unreachable shop keeps LocalBusiness until its next listing. */ }
    }
    if (!found.size) return { updated: [] };
    const latest = await store.get();
    const updated = latest.shops.filter(shop => !shop.industry && found.has(shop.id)).map(shop => shop.id);
    if (!updated.length) return { updated };
    await store.save(latest.shops.map(shop => updated.includes(shop.id) ? { ...shop, industry: found.get(shop.id) } : shop), {}, latest.revision);
    return { updated };
  }
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      req.resume();
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      if (locale === "en" && data && typeof data === "object" && !Array.isArray(data)) {
        data = { ...data };
        for (const key of ["error", "message", "setupMessage", "warning"]) {
          if (typeof data[key] === "string") data[key] = translateAdminMessage(locale, data[key]);
        }
      }
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Language", locale);
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      // Private server-to-server mail uses its shared secret independently of browser hosts/origins.
      if (req.method === "POST" && req.url === "/api/internal/mail") {
        if (!trustedIntegration(req, integrationSecret) || !auth) return send(403, { error: "メールの依頼元を確認できません" });
        const message = await body(req, 15 * 1024 * 1024);
        await auth.mail(message, message.senderEmail);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && (req.url === "/api/internal/shops" || req.url === "/api/internal/shops/remove")) {
        if (!trustedIntegration(req, integrationSecret)) return send(403, { error: "店舗アプリからの依頼か確認できません" });
        const input = await body(req, 4000);
        return send(200, req.url.endsWith("/remove") ? await removeClosedShop(input) : await listPublishedShop(input));
      }
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ["127.0.0.1", "localhost"] : [])];
      if (external ? req.headers.host !== external.host : !hosts.includes(req.headers.host)) return send(403, { error: "管理画面のURLからアクセスしてください" });
      const origin = external?.origin || `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(403, { error: "接続先が不正です" });
      if (!url.pathname.startsWith(`${basePath}/`)) return send(404, { error: "見つかりません" });
      url.pathname = url.pathname.slice(basePath.length);
      if (!siteEditor && url.pathname === "/page-editor" && ["GET", "HEAD"].includes(req.method)) {
        res.writeHead(302, { Location: `${basePath}/` }); res.end(); return;
      }
      if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin) return send(403, { error: "管理画面と同じOriginから操作してください" });
      const oauthReturn = req.method === "GET" && ["/auth/google/callback", "/auth/demo"].includes(url.pathname);
      const pageNavigation = req.method === "GET" && url.pathname === "/" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
      if (req.headers["sec-fetch-site"] === "cross-site" && !oauthReturn && !pageNavigation) return send(403, { error: "別サイトからはアクセスできません" });
      if (auth && req.method === "GET" && url.pathname === "/auth/google") return await auth.begin(res, origin);
      if (auth && req.method === "GET" && url.pathname === "/auth/google/callback") return await auth.callback(req, res, url, origin);
      if (auth?.demo && req.method === "GET" && url.pathname === "/auth/demo") return await auth.demo(res, url, origin);
      if (auth?.demo && basePath && req.method === "POST" && url.pathname === "/auth/demo") {
        const input = await body(req, 1024);
        return await auth.demo(res, url, origin, input?.invite ?? "");
      }
      const user = auth ? await auth.session(req) : { email: "test-operator@example.com" };
      if (req.method === "GET" && url.pathname === "/api/session") return send(200, auth ? auth.status(user) : { user, configured: true });
      if (req.method === "POST" && url.pathname === "/api/logout") { if (auth) await auth.logout(req, res, origin); return send(200, { ok: true }); }
      if (url.pathname.startsWith("/api/") && !user) return send(401, { error: "運営者としてGoogleにログインしてください" });
      if (req.method === "GET" && url.pathname === "/api/chat-documents")
        return send(200, { ...await chatDocuments.get(), pdfImportAvailable: !!geminiApiKey });
      if (req.method === "POST" && url.pathname === "/api/chat-documents/import") return send(200, await importDocument(await body(req, 8 * 1024 * 1024)));
      if (req.method === "PUT" && url.pathname === "/api/chat-documents") return send(200, await chatDocuments.save(await body(req, 8 * 1024 * 1024)));
      const documentMatch = url.pathname.match(/^\/api\/chat-documents\/([a-f0-9-]{36})$/);
      if (req.method === "DELETE" && documentMatch) return send(200, await chatDocuments.delete(documentMatch[1], req.headers["if-match"]));
      if (req.method === "GET" && url.pathname === "/api/site") {
        const editor = siteEditor ? await siteEditor.get() : { editorAvailable: false };
        return send(200, { ...editor, publicUrl: publicPage.href });
      }
      if (!siteEditor && url.pathname.startsWith("/api/site/")) return send(404, { error: "見つかりません" });
      if (req.method === "GET" && url.pathname === "/api/site/images") return send(200, await siteImages.list());
      const imageMatch = url.pathname.match(/^\/api\/site\/images\/([a-f0-9]{64})$/);
      if (req.method === "GET" && imageMatch) return send(200, await siteImages.read(imageMatch[1]));
      if (req.method === "POST" && url.pathname === "/api/site/images") return send(200, await siteImages.upload(await body(req, 14 * 1024 * 1024)));
      if (req.method === "POST" && url.pathname === "/api/site/capture") {
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["sourceId", "revision", "width"].includes(k)) || typeof input.revision !== "string" || ![390,1280].includes(input.width)) return send(400, { error: "画面の取り込み設定を確認してください。" });
        const html = await siteEditor.preview(input.sourceId || "published", (await store.get()).shops, input.revision);
        return send(200, await capture({ html, width: input.width }));
      }
      if (req.method === "GET" && url.pathname === "/api/site/preview") {
        const html = await siteEditor.preview(url.searchParams.get("source") || "published", (await store.get()).shops);
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(html);
      }
      if (req.method === "POST" && ["/api/site/proposals", "/api/site/publish"].includes(url.pathname)) {
        const input = await body(req, 8 * 1024 * 1024);
        const allowed = url.pathname.endsWith("proposals") ? ["request", "revision", "sourceId", "media", "imageIds"] : ["revision", "sourceId"];
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return send(400, { error: "変更内容の形式を確認してください" });
        if (url.pathname.endsWith("publish")) return send(200, { ...await siteEditor.publish(input, user), publicUrl: publicPage.href });
        const controller = new AbortController(); res.once("close", () => { if (!res.writableFinished) controller.abort(); });
        return send(200, { ...await siteEditor.propose(input, user, (await store.get()).shops, controller.signal), publicUrl: publicPage.href });
      }
      if (req.method === "POST" && url.pathname === "/api/invitations") {
        if (integrationSecret.length < 32) return send(503, { error: "店舗への招待設定が必要です" });
        const target = new URL(shopOrigin);
        if (target.protocol !== "https:" && !(target.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.hostname.endsWith(".localhost")))) return send(503, { error: "店舗アプリのURL設定を確認してください" });
        const input = await body(req);
        const response = await fetchImpl(new URL("/api/platform/invitations", target), { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", Origin: target.origin, Authorization: `Bearer ${integrationSecret}`, ...(locale === "en" && { "X-Gemihub-Language": locale }) }, body: JSON.stringify({ email: input.email, name: input.name, industry: input.industry, senderEmail: user.email }) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); return send(response.status, { error: error.error || "招待メールを送信できませんでした" }); }
        await response.body?.cancel();
        return send(200, { ok: true, message: "招待メールを送りました。" });
      }
      if (req.method === "GET" && url.pathname === "/api/shops") return send(200, await store.get());
      if (req.method === "POST" && url.pathname === "/api/resolve") {
        const input = await body(req);
        const current = await store.get();
        if (input.id !== undefined && !current.shops.some(shop => shop.id === input.id)) throw new Error("編集する店が見つかりません");
        try {
          return send(200, await resolver(input.url, { shops: current.shops, editingId: input.id, networkIndex: input.networkIndex, discovery: true, production,
            suggestCuisine: details => cuisineSuggester(details, { apiKey: geminiApiKey }) }));
        } catch (error) {
          if (input.id) await store.recordError(input.id, error.message);
          throw error;
        }
      }
      if (req.method === "PUT" && url.pathname === "/api/shops") {
        const input = await body(req);
        return send(200, await store.save(Array.isArray(input) ? input : input.shops, input.cache || {}, input.revision));
      }
      const match = url.pathname.match(/^\/api\/shops\/([^/]+)$/);
      if (req.method === "DELETE" && match) return send(200, await store.delete(decodeURIComponent(match[1]), req.headers["if-match"]));
      const assets = { "/i18n.js": ["i18n.js", "text/javascript"], "/en.json": ["en.json", "application/json"], "/chat-documents-ui.js": ["chat-documents-ui.js", "text/javascript"], "/page-editor": ["dist/index.html", "text/html"], "/editor.js": ["dist/editor.js", "text/javascript"], "/editor.css": ["dist/editor.css", "text/css"], "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/admin.js": ["admin.js", "text/javascript"], "/site-editor.js": ["site-editor.js", "text/javascript"], "/admin.css": ["admin.css", "text/css"], "/shop-data.js": ["../site/shop-data.js", "text/javascript"] };
      if (["GET", "HEAD"].includes(req.method) && Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname];
        let data = await readFile(new URL(file, import.meta.url));
        if (type === "text/html" && (basePath || locale === "en")) {
          let html = localizeAdminHtml(data.toString(), locale);
          if (basePath) html = html.replace("<html ", `<html data-admin-base="${basePath}" `)
            .replace(/(?:href|src)="\/(?:admin\.css|admin\.js|editor\.css|editor\.js|auth\/google)"/g,
              attribute => attribute.replace('="/', `="${basePath}/`));
          data = Buffer.from(html);
        }
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      return send(404, { error: "見つかりません" });
    } catch (error) { if (!res.headersSent && !res.destroyed) send(error.status || 400, { error: error.message }); }
  });
  server.backfillIndustries = backfillIndustries;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--production")) throw new Error("Usage: npm run admin -- [--production]");
  const port = Number(process.env.ADMIN_PORT || 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ADMIN_PORTは1〜65535で指定してください");
  const server = createAdminServer({ production: args.includes("--production") });
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, process.env.ADMIN_HOST || "127.0.0.1", () => console.log(`店舗管理: ${process.env.PARENT_ORIGIN || `http://127.0.0.1:${port}`}/${args.includes("--production") ? " (production)" : ""}`));
}
