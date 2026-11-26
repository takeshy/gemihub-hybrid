import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RestaurantReservationForm } from "../src/RestaurantReservation.tsx";
import { z } from "zod";
import { getLocale, tr } from "../shared/i18n.ts";
import { restaurantReservations, type Booking, type ShopConfig } from "./domain.ts";
import { shopGuideFront, shopGuideInfo, shopGuideNetwork, shopGuideQueries, shopGuideTool } from "./shop-guide.ts";
import { callRestaurantTool, restaurantTools, shopInfo } from "./restaurant-mcp.ts";
import { agentCopy, reservePageCopy, sampleQueries } from "../shared/restaurant-agent-copy.ts";
export { sampleQueries };

// A shop's open agentic website (Worldwide Agentic Web MVP Profile 0.2):
//   /s/<slug>/agent/                 the public bundle other agent sites read: manifest, network, bridge, runtime
//   /s/<slug>/agent/mcp              read-only MCP server: restaurant seats/menu, or other-shop hours/products
//   /s/<slug>/reserve                published reservation page with an optional assistant
// The bundle is built per shop by the official build script, because the network names the shop's own MCP address.

export const networkName = "reservation_concierge";
export const frontAgent = "reservation_front";
export const supportsShopAgent = (config: ShopConfig) => restaurantReservations(config) || config.industry === "other";
const networkFor = (shop: AgenticShop) => shop.config.industry === "other" ? shopGuideNetwork : networkName;
const skillDir = resolve("agentic/skill");
const siteDir = resolve("agentic/site");
const sharedVoiceDir = resolve(siteDir, "../../../../site");
const sharedVoiceFiles = new Set(["voice-chat.js", "voice-audio.js", "voice-chat.css", "hybrid.bundle.js", "hybrid.css", "hybrid-config.json"]);
const runtimeDir = join(skillDir, "runtime");
const run = promisify(execFile);
const mcpProtocol = "2025-06-18";

const contentTypes: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
/** The page's own modules and styles, served next to the generated bundle. */
const siteFiles = new Set(["site.js", "ai-connection.js", "reservation-actions.js", "reserve-page.js", "review-dialog.js", "voice-bridge.js", "voice-turn.js", "shop-voice.js", "assistant.css", "storefront-agent.css"]);
/** Files other origins fetch: these, and only these, carry the CORS header. */
const publicFiles = new Set(["agent-manifest.json", `${networkName}.network.json`, "links.json", "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json"]);
const generatedFiles = new Set([...publicFiles, "bridge/action-bridge.html", "bridge/agent-manifest.json"]);
const guideFiles = new Set(["agent-manifest.json", `${shopGuideNetwork}.network.json`, "links.json", "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json"]);

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export type AgenticShop = { slug: string; config: ShopConfig };
/** Where a shop's pages live: the app's own origin under /s/<slug>, or the shop's own host at its root. */
export type AgenticSite = { origin: string; base: string };
export const appSite = (origin: string, slug: string): AgenticSite => ({ origin, base: `/s/${slug}` });
const router = () => (process.env.AGENT_LLM_ROUTER || "https://api.otari.ai/api/v1").replace(/\/$/, "");
const model = () => process.env.AGENT_LLM_MODEL || "alibaba/qwen3.8-flash";
const themeColor = (config: ShopConfig) => ({ sage: "#3f5d4a", rose: "#8a3d52", navy: "#1f3a5f" })[config.appearance?.accent || "navy"] || "#7a3b1d";

export function shopManifest(shop: AgenticShop, site: AgenticSite) {
  const name = shop.config.name;
  const guide = shop.config.industry === "other";
  const network = networkFor(shop);
  const front = guide ? shopGuideFront : frontAgent;
  return {
    brand: guide ? `${name} ご案内` : agentCopy.brand(name),
    networks: [{
      name: network,
      front_man: front,
      hocon: `./${network}.network.json`,
      description: guide ? `${name}の営業時間・休業日・取扱品をご案内します。` : agentCopy.manifestDescription(name),
      tags: guide ? ["agentified-website", "shop", "shop-guide"] : ["agentified-website", "restaurant", "restaurant-reservation"],
      sample_queries: guide ? shopGuideQueries() : sampleQueries(),
    }],
    llm_router: { base_url: router(), mock: false, byok_router: router() },
    // The network calls nothing but this shop's own read-only MCP endpoint.
    allowed_peers: [site.origin],
    peer_policy: { mode: "closed", deny_origins: [], note: "Calls only this shop's own read-only MCP endpoint." },
    agent_mcp: {
      protocol: "nsdeploy-agent-mcp/v1",
      network,
      front_man: front,
      available: false,
      reason: guide ? "The guide uses the shop's read-only MCP server for opening hours and products." : "The network itself is not exposed as an MCP facade; its agents use the shop's read-only MCP server for seats and menu facts.",
    },
    theme: { primary: themeColor(shop.config) },
    linking: {
      protocol: "nsdeploy-link/v1",
      exports: [{ network, front_man: front, aliases: [network, front], url: network }],
      imports: [],
      link_updates: { mode: "browser-local" },
    },
    deployment: { mode: "static", self_contained_runtime: true, browser_mock: false, direct_byok: false, direct_mcp_requires_cors: true, public_mcp_facade: false },
    ...(!guide ? { actions: {
      version: 1,
      module: "./reservation-actions.js",
      bridge: "./bridge/action-bridge.html",
      agentTools: ["get_reservation_page_state", "get_reservation_request", "fill_reservation_form", "place_reservation"],
    } } : {}),
  };
}

export async function shopHocon(shop: AgenticShop, site: AgenticSite) {
  const name = shop.config.name;
  const guide = shop.config.industry === "other";
  const template = await readFile(join(siteDir, `${networkFor(shop)}.hocon`), "utf8");
  const values: Record<string, unknown> = {
    __DESCRIPTION__: guide ? `${name}の営業時間と取扱品をご案内します。` : agentCopy.networkDescription(name),
    __SAMPLE_QUERIES__: guide ? shopGuideQueries() : sampleQueries(),
    __MODEL__: model(),
    __SHOP_NAME__: name,
    __FRONT_DESCRIPTION__: guide ? `Read-only guide for ${name}: opening hours, closed days, address and published products or services.` : `Reservation desk of the restaurant ${name}: open seats for any party size (seats only or with a course), what each course and dish contains, and reservations on the restaurant's own page.`,
    __MCP_URL__: `${site.origin}${site.base}/agent/mcp`,
  };
  // JSON strings are valid HOCON strings. Braces would be read as {placeholders} by the runtime.
  return template.replace(/__[A-Z_]+__/g, key => key in values ? JSON.stringify(values[key]).replace(/[{}]/g, "") : key);
}

const builds = new Map<string, Promise<string>>();
/** Build (once per content) the shop's bundle with the official script; returns its folder. */
export async function shopBundle(shop: AgenticShop, site: AgenticSite) {
  const network = networkFor(shop);
  const hocon = await shopHocon(shop, site);
  const manifest = JSON.stringify(shopManifest(shop, site), null, 2) + "\n";
  const script = join(skillDir, "scripts/build_network.mjs");
  const key = createHash("sha256").update([hocon, manifest, await readFile(script, "utf8")].join("\0")).digest("hex").slice(0, 32);
  let build = builds.get(key);
  if (!build) {
    build = (async () => {
      const root = join(tmpdir(), "gemihub-agentic");
      const dir = join(root, key);
      if (await readFile(join(dir, ".built"), "utf8").catch(() => "")) return dir;
      const work = `${dir}.${process.pid}.${Date.now()}`;
      await mkdir(work, { recursive: true });
      try {
        await writeFile(join(work, `${network}.hocon`), hocon);
        await writeFile(join(work, "agent-manifest.json"), manifest);
        await writeFile(join(work, "links.json"), JSON.stringify({ version: 1, networks: { [network]: {} } }, null, 2) + "\n");
        const result = await run(process.execPath, [script, join(work, `${network}.hocon`), "--manifest", join(work, "agent-manifest.json"), "--runtime", runtimeDir], { timeout: 60000 })
          .catch(error => { throw new Error(`Agent network build failed for ${shop.slug}:\n${error.stdout || ""}${error.stderr || error.message}`); });
        await writeFile(join(work, ".built"), result.stdout || "ok");
        // Another process may have finished the same build first; either result is identical.
        await rename(work, dir).catch(() => rm(work, { recursive: true, force: true }));
      } catch (error) {
        await rm(work, { recursive: true, force: true });
        throw error;
      }
      return dir;
    })();
    builds.set(key, build);
    build.catch(() => builds.delete(key));
    if (builds.size > 200) builds.delete(builds.keys().next().value!);
  }
  return build;
}

/**
 * The finder site this server's restaurants are registered with (AGENT_PARENT_URL), or undefined.
 * Its origin alone may show a reservation page in a frame and relay its model requests.
 */
export function parentSite() {
  try {
    const url = new URL(process.env.AGENT_PARENT_URL || "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return { origin: url.origin, url: url.href };
  } catch {
    return undefined;
  }
}
const pageCsp = (frameAncestors: string) => `default-src 'self'; script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; worker-src 'self' blob:; frame-src 'self' https://www.google.com https://recaptcha.google.com; frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'`;

type ReservationCopy = ReturnType<typeof reservePageCopy>;
function assistantPanel(t: ReservationCopy) {
  return `<aside id="assistant" class="assistant-sidebar" aria-labelledby="assistant-heading" hidden>
<header class="assistant-sidebar-header">
<h2 id="assistant-heading">${t.assistant}</h2>
<button id="assistant-close" type="button" class="assistant-back-button">${t.closeChat}</button>
</header>
<div class="assistant-sidebar-content">
<p class="assistant-lead">${t.assistantLead}</p>
<div class="assistant-options"><button id="ai-settings-open" type="button" disabled>${t.aiSettings}</button>
<details class="assistant-info"><summary>${t.privacyHeading}</summary>
<p id="assistant-privacy-note" class="assistant-note reserve-note">${t.privacy}</p>
<p id="assistant-key-note" class="assistant-note reserve-note">${t.key}</p>
</details></div>
<p id="assistant-status" role="status">${t.connecting}</p>
<div id="agent-app">
<div data-ns-slot="header"></div>
<div data-ns-slot="chat"></div>
<div data-ns-slot="agents" hidden></div>
<dialog id="ai-setup-dialog" class="ai-setup" aria-labelledby="ai-setup-heading" aria-describedby="ai-setup-description">
<header class="ai-setup-header"><h2 id="ai-setup-heading">${t.aiSettings}</h2>
<button id="ai-setup-close" class="assistant-icon-button" type="button" aria-label="${t.closeSettings}">×</button></header>
<p id="ai-setup-description">${t.settingsDescription}</p>
<label for="ai-provider">${t.provider}<select id="ai-provider"></select></label>
<p><a id="ai-key-link" target="_blank" rel="noopener noreferrer"></a></p>
<div data-ns-slot="settings"></div>
</dialog>
</div>
</div>
</aside>`;
}

/** Add the same page-owned assistant to a restaurant's published home page. */
export function storefrontAssistant(shop: AgenticShop, site: AgenticSite, reservation = false) {
  const locale = getLocale();
  const name = escapeHtml(shop.config.name);
  const guide = shop.config.industry === "other";
  const t = { ...reservePageCopy(locale, name), ...(guide ? locale === "ja" ? {
    assistant: `${name}のご案内`, assistantLead: "営業時間やお休み、扱っている品についてご相談ください。",
    privacy: "メッセージと公開されているお店の情報は、「AIの設定」で選んだプロバイダーに送られます。キーはこのブラウザに保存され、お店には送られません。",
  } : {
    assistant: `${name} shop guide`, assistantLead: "Ask about opening hours, closed days and the products the shop carries.",
    privacy: "Your messages and public shop information go to the provider you choose in AI settings. Your key stays in this browser and is never sent to the shop.",
  } : {}) };
  Object.assign(t, {
    privacy: locale === "ja" ? "簡単な質問は端末内で処理し、端末内AIが使えない場合や予約の相談はFirebase経由でクラウドへ送ります。" : "Simple questions can run on-device. Unsupported devices and reservation conversations use the cloud through Firebase.",
    key: locale === "ja" ? "APIキーの入力は不要です。" : "No API key is required.",
    settingsDescription: locale === "ja" ? "端末内AIの準備と推論の記録を確認できます。" : "Prepare on-device AI and inspect inference details.",
  });
  const base = site.base;
  const parent = parentSite();
  return {
    attributes: ` data-slug="${escapeHtml(shop.slug)}" data-shop-name="${escapeHtml(shop.config.name)}"${guide ? ' data-agent-kind="shop"' : ""}${parent ? ` data-parent-origin="${escapeHtml(parent.origin)}"` : ""}`,
    head: `<link rel="stylesheet" href="${base}/agent/hybrid.css"><link rel="stylesheet" href="${base}/agent/assistant.css"><link rel="stylesheet" href="${base}/agent/storefront-agent.css"><link rel="stylesheet" href="${base}/agent/voice-chat.css"><link rel="agent-manifest" href="${base}/agent/agent-manifest.json"><script type="module" src="${base}/agent/reserve-page.js"></script><script type="module" src="${base}/agent/site.js"></script>`,
    // Other pages keep backing controls hidden; /reserve owns its visible form.
    body: `${reservation ? "" : `<button id="assistant-toggle" class="restaurant-ai-toggle" type="button" aria-controls="assistant" aria-expanded="false" disabled>${t.askAI}</button>${guide ? "" : `<div id="restaurant-reservation" class="restaurant-reservation" hidden>${renderToStaticMarkup(createElement(RestaurantReservationForm, { config: shop.config }))}</div>`}`}${assistantPanel(t)}`,
    csp: pageCsp(parent ? parent.origin : "'none'"),
    frameable: !!parent,
  };
}

async function rawBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The address a request came from. Behind a load balancer every socket is the balancer's, so with
 * TRUSTED_PROXY_HOPS set, the X-Forwarded-For entry that many proxies from the right is used instead.
 */
export function clientAddress(req: IncomingMessage, hops = Number(process.env.TRUSTED_PROXY_HOPS || 0)) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(part => part.trim()).filter(Boolean);
  return Number.isInteger(hops) && hops > 0 && forwarded.length >= hops ? forwarded[forwarded.length - hops] : req.socket.remoteAddress || "unknown";
}

export function agenticSite(options: {
  bookings: (shopId: string) => Promise<readonly Booking[]>;
  /** False once this key has used up its requests for the current minute. */
  allowed: (key: string, limit: number) => boolean;
}) {
  const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function mcp(req: IncomingMessage, res: ServerResponse, shop: AgenticShop & { id: string }, site: AgenticSite) {
    const guide = shop.config.industry === "other";
    // No cookie or session is read here: the answers are the same for every caller.
    for (const name of ["Vary", "X-Frame-Options", "Content-Security-Policy"]) res.removeHeader(name);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Cache-Control", "no-store");
    const send = (status: number, data?: unknown) => {
      if (data === undefined) { res.writeHead(status); res.end(); return; }
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "OPTIONS") return send(204);
    if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return send(405, rpcError(null, -32600, "Use POST.")); }
    if (!options.allowed(`mcp:${shop.id}:${clientAddress(req)}`, 60)) { res.setHeader("Retry-After", "60"); return send(429, rpcError(null, -32000, "Too many requests. Try again in a minute.")); }
    const text = await rawBody(req, 16384);
    if (text === undefined) return send(413, rpcError(null, -32600, "Request too large."));
    let message: unknown;
    try { message = JSON.parse(text); } catch { return send(400, rpcError(null, -32700, "Parse error.")); }
    const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).safeParse(message);
    if (!parsed.success) return send(400, rpcError(null, -32600, "Invalid request: send one JSON-RPC 2.0 message."));
    const { id, method, params } = parsed.data;
    // Notifications get no body.
    if (id === undefined) return send(202);
    if (method === "initialize") return send(200, rpc(id, {
      protocolVersion: mcpProtocol,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: guide ? "gemihub-shop" : "gemihub-restaurant", title: `${shop.config.name} ${guide ? "opening hours and products" : "seats and menu"}`, version: "1.0.0" },
      instructions: guide ? "Read-only: get_shop_info returns this shop's published opening hours and products. Stock is unknown. No orders, payments or reservations." : "Read-only: open seats (check_availability) and menu ingredients (find_menu_items) of one restaurant. Reservations are made on the restaurant's own page.",
    }));
    if (method === "ping") return send(200, rpc(id, {}));
    if (method === "tools/list") return send(200, rpc(id, { tools: guide ? [shopGuideTool] : restaurantTools }));
    if (method === "tools/call") {
      const call = z.object({ name: z.string().max(80), arguments: z.record(z.string(), z.unknown()).default({}) }).safeParse(params);
      if (!call.success) return send(200, rpcError(id, -32602, "Invalid params: name and arguments are required."));
      try {
        const result = guide ? call.data.name === "get_shop_info" ? shopGuideInfo(shop.config, `${site.origin}${site.base}/`, call.data.arguments) : undefined : await callRestaurantTool(call.data.name, call.data.arguments, {
          config: shop.config,
          bookings: () => options.bookings(shop.id),
          reservePageUrl: `${site.origin}${site.base}/reserve`,
        });
        if (result === undefined) return send(200, rpcError(id, -32602, `Unknown tool: ${call.data.name}`));
        return send(200, rpc(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false }));
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        const detail = error.issues.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
        return send(200, rpc(id, { content: [{ type: "text", text: `Invalid arguments. ${detail}` }], isError: true }));
      }
    }
    return send(200, rpcError(id, -32601, `Method not found: ${method}`));
  }

  async function file(res: ServerResponse, method: string, path: string, headers: Record<string, string> = {}) {
    const data = await readFile(path).catch(() => undefined);
    if (!data) return false;
    res.writeHead(200, { "Content-Type": contentTypes[extname(path)] || "application/octet-stream", "Cache-Control": "no-cache", ...headers });
    res.end(method === "HEAD" ? undefined : data);
    return true;
  }
  const notFound = (res: ServerResponse) => {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: tr("見つかりません") }));
  };

  return {
    /** Whether this path belongs to a shop's agent bundle. */
    route(path: string, hosted = false) {
      // On the shop's own host the same pages sit at the root.
      const match = hosted ? path.match(/^\/()agent\/(.+)$/) : path.match(/^\/s\/([^/]+)\/agent\/(.+)$/);
      return match ? { slug: decodeURIComponent(match[1]), rest: match[2] } : undefined;
    },
    async handle(req: IncomingMessage, res: ServerResponse, shop: AgenticShop & { id: string }, route: { rest: string }, site: AgenticSite) {
      const method = req.method || "GET";
      if (route.rest === "mcp") return mcp(req, res, shop, site);
      if (method !== "GET" && method !== "HEAD") return notFound(res);
      // Public, identical for every visitor: nothing here depends on a cookie.
      res.removeHeader("Vary");
      const rest = route.rest;
      if (rest.startsWith("runtime/")) {
        const path = resolve(runtimeDir, rest.slice("runtime/".length));
        if (!path.startsWith(runtimeDir + sep)) return notFound(res);
        // The tool sandbox may run only the code handed to it, and may reach nothing.
        const headers = rest === "runtime/sandbox-worker.js" ? { "Content-Security-Policy": "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'" } : undefined;
        if (headers) res.removeHeader("Content-Security-Policy");
        return await file(res, method, path, headers) || notFound(res);
      }
      if (rest === "facts.json") {
        const info = shop.config.industry === "other"
          ? shopGuideInfo(shop.config, site.origin + site.base + "/")
          : shopInfo(shop.config, site.origin + site.base + "/reserve");
        const facts = { id: shop.slug, name: info.shop, description: info.description,
          address: info.address, hours: info.hours,
          products: [
            ...(shop.config.products || []).map(name => ({ name })),
            ...shop.config.menus.filter(menu => menu.active).map(menu => ({ name: menu.name })),
            ...info.catalog,
          ],
          pageUrl: site.origin + site.base + "/", checkedAt: info.checkedAt };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(method === "HEAD" ? undefined : JSON.stringify(facts));
        return true;
      }
      if (sharedVoiceFiles.has(rest)) return await file(res, method, join(sharedVoiceDir, rest)) || notFound(res);
      if (siteFiles.has(rest)) return await file(res, method, join(siteDir, rest), rest === "llm-relay-sw.js" ? { "Service-Worker-Allowed": `${site.base}/` } : undefined) || notFound(res);
      const guide = shop.config.industry === "other";
      if (!(guide ? guideFiles : generatedFiles).has(rest)) return notFound(res);
      const dir = await shopBundle(shop, site);
      if (rest.startsWith("bridge/")) {
        // Other agent sites load the bridge in a hidden frame, so framing must stay allowed here.
        res.removeHeader("X-Frame-Options");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'");
      }
      return await file(res, method, join(dir, rest), (guide ? guideFiles : publicFiles).has(rest) ? { "Access-Control-Allow-Origin": "*" } : undefined) || notFound(res);
    },
  };
}
