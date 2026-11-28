// Read-only public MCP endpoint for the Gemihub Hybrid town guide.
// Exposes only published shop facts and public community documents; no reservations or writes.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { searchDocuments } from "../site/chat-documents.js";
import { shopJsonLd } from "../hybrid/schema-org.js";

const MCP_PROTOCOL = "2025-06-18";

export const townMcpTools = Object.freeze([
  {
    name: "list_town_shops",
    description: "List published shops in the town guide. Optional area or cuisine filter.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "Optional area substring filter." },
        cuisine: { type: "string", description: "Optional cuisine substring filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "query_shop_facts",
    description: "Return published hours, menu items, address, and URLs for one shop by ID or name. The result also carries the same facts as schema.org JSON-LD in jsonLd (Restaurant, HairSalon, NailSalon, or LocalBusiness when the business type is unknown; no prices or seat availability; acceptsReservations only links to the booking page).",
    inputSchema: {
      type: "object",
      properties: {
        shopId: { type: "string", description: "Registered shop ID (e.g. akari)." },
        shopName: { type: "string", description: "Registered shop display name (e.g. Robata Akari)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_local_events",
    description: "Search published local community documents and event notices in the town guide.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (1 to 500 chars)." },
        limit: { type: "integer", minimum: 1, maximum: 8, description: "Maximum results (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
]);

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().trim();

export function serverMetadata() {
  return {
    protocolVersion: MCP_PROTOCOL,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: "gemihub-town-guide",
      title: "Gemihub Hybrid Town Guide (Read-Only MCP)",
      version: "1.0.0",
    },
    instructions: "Read-only town guide MCP: list_town_shops, query_shop_facts, and search_local_events return only published neighborhood facts. Live availability checks and reservations belong to each shop's own MCP/reservation page.",
  };
}

export async function loadTownData({ siteDir, factsDir = siteDir, deployedOrigin, publicOrigin }) {
  const rewrite = value => typeof value === "string" && deployedOrigin && publicOrigin
    ? value.replaceAll(deployedOrigin, publicOrigin) : value;
  const [shopsRaw, factsRaw, docsRaw] = await Promise.all([
    readFile(resolve(siteDir, "shops.json"), "utf8").then(JSON.parse).catch(() => ({ shops: [] })),
    readFile(resolve(factsDir, "shop-public-facts.json"), "utf8").then(JSON.parse).catch(() => ({})),
    readFile(resolve(siteDir, "chat-documents.json"), "utf8").then(JSON.parse).catch(() => ({ version: 1, documents: [] })),
  ]);
  const shops = (Array.isArray(shopsRaw?.shops) ? shopsRaw.shops : []).map(shop => {
    const facts = factsRaw?.[shop.id];
    const extra = facts && rewrite(facts.sourcePageUrl) === rewrite(shop.pageUrl) ? facts : {};
    return {
      id: shop.id,
      name: shop.name,
      area: shop.area,
      cuisine: shop.cuisine,
      ...(typeof shop.industry === "string" ? { industry: shop.industry } : {}),
      description: shop.description,
      address: shop.address,
      hours: extra.hours || shop.hours || null,
      products: Array.isArray(extra.products) ? extra.products : [],
      pageUrl: rewrite(shop.pageUrl),
      reservationEnabled: shop.reservationEnabled === true,
      reservationUrl: rewrite(shop.reservationUrl),
    };
  });
  const documents = docsRaw?.version === 1 && Array.isArray(docsRaw.documents) ? docsRaw.documents : [];
  return { shops, documents };
}

export function callTownMcpTool(name, args = {}, data) {
  if (name === "list_town_shops") {
    const area = normalize(args.area);
    const cuisine = normalize(args.cuisine);
    const filtered = data.shops.filter(shop =>
      (!area || normalize(shop.area).includes(area))
      && (!cuisine || normalize(shop.cuisine).includes(cuisine))
    );
    return { count: filtered.length, shops: filtered };
  }
  if (name === "query_shop_facts") {
    const found = shop => ({ found: true, shop, jsonLd: shopJsonLd(shop) });
    const id = normalize(args.shopId);
    const shopName = normalize(args.shopName);
    if (!id && !shopName) return { found: false, error: "Provide shopId or shopName." };
    const byId = id && data.shops.find(item => normalize(item.id) === id);
    if (byId) return found(byId);
    if (!shopName) return { found: false, shop: null };
    // An exact name wins; a partial name must match exactly one shop, never the first of several.
    const exact = data.shops.filter(item => normalize(item.name) === shopName);
    const matches = exact.length ? exact : data.shops.filter(item => normalize(item.name).includes(shopName));
    if (matches.length === 1) return found(matches[0]);
    if (matches.length > 1) return { found: false, shop: null, ambiguous: true,
      candidates: matches.slice(0, 10).map(item => ({ id: item.id, name: item.name })) };
    return { found: false, shop: null };
  }
  if (name === "search_local_events") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(8, args.limit)) : 5;
    if (!query || query.length > 500) return { error: "query must be 1 to 500 characters." };
    return searchDocuments(data.documents, query, limit);
  }
  return undefined;
}

export function handleTownMcpMessage(message, data) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.method.length > 100) {
    return { status: 400, body: rpcError(null, -32600, "Invalid request: send one JSON-RPC 2.0 message.") };
  }
  const { id, method, params } = message;
  if (id === undefined) return { status: 202, body: null };
  if (method === "initialize") return { status: 200, body: rpc(id, serverMetadata()) };
  if (method === "ping") return { status: 200, body: rpc(id, {}) };
  if (method === "tools/list") return { status: 200, body: rpc(id, { tools: townMcpTools }) };
  if (method === "tools/call") {
    if (!params || typeof params !== "object" || typeof params.name !== "string" || params.name.length > 80) {
      return { status: 200, body: rpcError(id, -32602, "Invalid params: name is required.") };
    }
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    const result = callTownMcpTool(params.name, args, data);
    if (result === undefined) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
    const isError = Boolean(result?.error);
    return {
      status: 200,
      body: rpc(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError }),
    };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) return { tooLarge: true };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
  catch { return { parseError: true }; }
}

export function createTownMcpHandler({ siteDir, factsDir, deployedOrigin, publicOrigin }) {
  const hits = new Map();
  let globalHits = [];
  const allowed = key => {
    const now = Date.now();
    // A global ceiling still holds when a client rotates keys or keys are evicted.
    globalHits = globalHits.filter(t => now - t < 60000);
    if (globalHits.length >= 600) return false;
    const recent = (hits.get(key) || []).filter(t => now - t < 60000);
    if (recent.length >= 60) { hits.set(key, recent); return false; }
    recent.push(now);
    globalHits.push(now);
    hits.delete(key); hits.set(key, recent); // Most recently used last.
    if (hits.size > 500) hits.delete(hits.keys().next().value);
    return true;
  };
  // The published JSON changes only on a rebuild; re-read it at most every 30 s.
  let cached = null;
  const townData = () => {
    if (!cached || Date.now() - cached.at > 30000) {
      const at = Date.now();
      const pending = loadTownData({ siteDir, factsDir, deployedOrigin, publicOrigin });
      cached = { at, pending };
      pending.catch(() => { if (cached?.pending === pending) cached = null; });
    }
    return cached.pending;
  };
  return async (req, res) => {
    const send = (status, body) => {
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Mcp-Protocol-Version",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (body !== undefined && body !== null) headers["Content-Type"] = "application/json; charset=utf-8";
      res.writeHead(status, headers);
      res.end(body !== undefined && body !== null ? JSON.stringify(body) : undefined);
    };
    if (req.method === "OPTIONS") return send(204);
    if (req.method === "GET") return send(200, { ...serverMetadata(), tools: townMcpTools });
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return send(405, rpcError(null, -32600, "Use GET or POST."));
    }
    // Caddy writes the client address as the last hop; earlier entries are client-controlled.
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(part => part.trim()).filter(Boolean);
    const addr = forwarded.at(-1) || req.socket?.remoteAddress || "local";
    if (!allowed(addr)) {
      res.setHeader("Retry-After", "60");
      return send(429, rpcError(null, -32000, "Too many requests. Try again in a minute."));
    }
    const parsed = await readJsonBody(req);
    if (parsed.tooLarge) return send(413, rpcError(null, -32600, "Request too large."));
    if (parsed.parseError) return send(400, rpcError(null, -32700, "Parse error."));
    const data = await townData();
    const reply = handleTownMcpMessage(parsed.value, data);
    return send(reply.status, reply.body);
  };
}
