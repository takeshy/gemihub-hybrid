import { randomBytes, timingSafeEqual } from "node:crypto";
import { emptyShop, shopSchema } from "../apps/shop/server/domain.ts";

const cookieName = "gemihub_judge";
const lifetime = 2 * 60 * 60;
const maximumShops = 20;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const cookiePattern = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{48})(?:;|$)`);

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) { req.resume(); return null; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { return null; }
}

function readDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["name", "description", "opensAt", "closesAt", "products"].includes(key))) return null;
  const { name, description, opensAt, closesAt, products = [] } = input;
  if (typeof name !== "string" || !name.trim() || name.length > 60 ||
      typeof description !== "string" || !description.trim() || description.length > 350 ||
      typeof opensAt !== "string" || !clock.test(opensAt) ||
      typeof closesAt !== "string" || !clock.test(closesAt) || opensAt >= closesAt ||
      !Array.isArray(products) || products.length > 6 ||
      products.some(product => typeof product !== "string" || !product.trim() || product.length > 60)) return null;
  return { name: name.trim(), description: description.trim(), opensAt, closesAt,
    products: [...new Set(products.map(product => product.trim()))] };
}

export function createSampleShops(store, origin, {
  invite = process.env.HYBRID_JUDGE_INVITE,
  until = process.env.HYBRID_JUDGE_UNTIL,
} = {}) {
  const sessions = new Map();
  const cutoff = Date.parse(until || "");
  const configuredInvite = /^[A-Za-z0-9_-]{32,128}$/.test(invite || "") ? Buffer.from(invite) : null;
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  const setCookie = (res, token, expiresAt) => res.setHeader("Set-Cookie",
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}${secure}`);
  const sessionKey = req => cookiePattern.exec(req.headers.cookie || "")?.[1];
  const session = req => {
    const entry = sessions.get(sessionKey(req));
    return entry?.expiresAt > Date.now() ? entry : null;
  };
  const sameOriginJson = req => req.headers.origin === origin &&
    /^application\/json(?:;|$)/i.test(req.headers["content-type"] || "");
  const normalName = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

  async function removeFiles(prefix) {
    for (const { id } of await store.entries("storefrontFile")) {
      if (id.startsWith(prefix)) await store.delete("storefrontFile", id);
    }
  }

  async function pruneExpired() {
    const expired = [];
    for (const [token, entry] of sessions) {
      if (entry.pending || entry.expiresAt > Date.now()) continue;
      sessions.delete(token);
      if (entry.shop) expired.push(entry.shop.id);
    }
    for (const slug of expired) {
      await store.locked(slug, async () => {
        await store.delete("shop", slug);
        await removeFiles(`shops/${slug}/`);
      });
    }
  }

  async function acceptInvite(req, res) {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!sameOriginJson(req)) return json(res, 403, { error: "Open the invitation on this site." });
    const input = await readJson(req);
    const candidate = typeof input?.invite === "string" ? Buffer.from(input.invite) : null;
    if (!configuredInvite || !(Date.now() < cutoff) || candidate?.length !== configuredInvite.length ||
        !timingSafeEqual(candidate, configuredInvite))
      return json(res, 403, { error: "This invitation is invalid or expired." });
    await pruneExpired();
    const active = session(req);
    if (!active && sessions.size >= maximumShops)
      return json(res, 429, { error: "All judge sessions are in use. Try again later." });
    const token = active ? sessionKey(req) : randomBytes(24).toString("hex");
    const entry = active || { shop: null, draft: null, pending: false };
    entry.expiresAt = Math.min(cutoff, Date.now() + lifetime * 1000);
    sessions.set(token, entry);
    setCookie(res, token, entry.expiresAt);
    return json(res, 200, { authenticated: true });
  }

  async function api(req, res) {
    const entry = session(req);
    if (req.method === "GET")
      return json(res, 200, { authenticated: !!entry, shop: entry?.shop || null, draft: entry?.draft || null });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!sameOriginJson(req)) return json(res, 403, { error: "Open the judge workspace on this site." });
    if (!entry) return json(res, 401, { error: "Reopen your invitation to start a judge session." });
    const draft = readDraft(await readJson(req));
    if (!draft) return json(res, 400, { error: "Check the shop details. Use up to six products or services, with up to 60 characters each." });
    const existingShops = await store.list("shop");
    if (existingShops.some(shop => !shop.slug.startsWith("sample-") &&
        normalName(shop.published?.name || "") === normalName(draft.name)))
      return json(res, 400, { error: "Choose a name that differs from the shops already listed." });
    if (entry !== session(req)) return json(res, 401, { error: "Reopen your invitation to resume." });
    if (entry.pending) return json(res, 409, { error: "A shop update is already in progress." });
    const existing = !!entry.shop;
    const slug = entry.shop?.id || `sample-${randomBytes(12).toString("hex")}`;
    const address = `${origin}/s/${slug}`;
    const shop = { id: slug, name: draft.name, description: draft.description, products: draft.products, area: "Sample shops",
      cuisine: "Sample shop", hours: `${draft.opensAt} – ${draft.closesAt}`, pageUrl: `${address}/`,
      networkUrl: `${address}/agent/shop_guide`, reservationEnabled: false };
    const owner = `${slug}@example.invalid`;
    entry.pending = true;
    try {
      const config = shopSchema.parse({
        ...emptyShop(owner), name: draft.name, description: draft.description, products: draft.products, address: "",
        industry: "other", reservationsEnabled: false,
        hours: { start: draft.opensAt, end: draft.closesAt, closedWeekdays: [], holidays: [] },
      });
      await store.locked(slug, async () => {
        const previous = await store.shop(slug);
        await store.saveShop({ id: slug, slug, owner, published: config, publication: "public",
          draft: null, revision: (previous?.revision || 0) + 1, history: [] });
        if (previous?.storefrontRelease)
          await removeFiles(`shops/${slug}/releases/${previous.storefrontRelease.id}/`);
      });
      entry.shop = shop;
      entry.draft = draft;
    } finally {
      entry.pending = false;
    }
    return json(res, existing ? 200 : 201, { shop, draft });
  }

  async function route(req, res, path) {
    if (path === "/api/judge/session") {
      await acceptInvite(req, res);
      return "handled";
    }
    if (path === "/api/demo-shop") {
      await api(req, res);
      return "handled";
    }
    const slug = /^\/(?:s|api\/public)\/(sample-[^/]+)(?:\/|$)/.exec(decodeURIComponent(path))?.[1];
    if (!slug) return "public";
    if (session(req)?.shop?.id !== slug) {
      json(res, 404, { error: "This sample shop is unavailable in this browser." });
      return "handled";
    }
    const read = req.method === "GET" || req.method === "HEAD";
    const readMcp = req.method === "POST" && decodeURIComponent(path) === `/s/${slug}/agent/mcp`;
    if (!read && !readMcp) {
      json(res, 405, { error: "This sample shop serves published information." });
      return "handled";
    }
    return "private";
  }

  return { route };
}
