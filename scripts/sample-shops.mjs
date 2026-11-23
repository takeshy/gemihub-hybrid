import { randomBytes } from "node:crypto";
import { emptyShop, shopSchema } from "../apps/shop/server/domain.ts";

const cookieName = "gemihub_sample";
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

async function readDraft(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) { req.resume(); return null; }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks)); } catch { return null; }
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 4) return null;
  const { name, description, opensAt, closesAt } = input;
  if (typeof name !== "string" || !name.trim() || name.length > 60 ||
      typeof description !== "string" || !description.trim() || description.length > 350 ||
      typeof opensAt !== "string" || !clock.test(opensAt) ||
      typeof closesAt !== "string" || !clock.test(closesAt) || opensAt >= closesAt) return null;
  return { name: name.trim(), description: description.trim(), opensAt, closesAt };
}

export function createSampleShops(store, origin) {
  const sessions = new Map();
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  const setCookie = (res, token) => res.setHeader("Set-Cookie",
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure}`);
  const sessionKey = req => cookiePattern.exec(req.headers.cookie || "")?.[1];
  const currentShop = token => {
    const entry = sessions.get(token);
    return entry?.expiresAt > Date.now() && !entry.pending ? entry.shop : null;
  };
  const normalName = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

  async function pruneExpired() {
    const expired = [];
    for (const [token, entry] of sessions) {
      if (entry.pending || entry.expiresAt > Date.now()) continue;
      sessions.delete(token);
      expired.push(entry.shop.id);
    }
    if (!expired.length) return;
    for (const slug of expired) await store.delete("shop", slug);
    for (const { id } of await store.entries("storefrontFile")) {
      if (expired.some(slug => id.startsWith(`shops/${slug}/`))) await store.delete("storefrontFile", id);
    }
  }

  async function api(req, res) {
    const token = sessionKey(req);
    if (req.method === "GET") {
      if (!token) setCookie(res, randomBytes(24).toString("hex"));
      return json(res, 200, { shop: currentShop(token) });
    }
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
      return json(res, 403, { error: "Open the town guide to create a sample shop." });
    if (!token) return json(res, 409, { error: "Reload the town guide to start a sample shop session." });
    const draft = await readDraft(req);
    if (!draft) return json(res, 400, { error: "Check the shop name, description, and opening hours." });
    await pruneExpired();
    if (sessions.has(token)) return json(res, 409, { error: "This session already has a sample shop." });
    const existingShops = await store.list("shop");
    if (existingShops.some(shop => !shop.slug.startsWith("sample-") &&
        normalName(shop.published?.name || "") === normalName(draft.name)))
      return json(res, 400, { error: "Choose a name that differs from the shops already listed." });
    // Claim the slot before awaiting the store write, including when two tabs publish at once.
    if (sessions.has(token)) return json(res, 409, { error: "This session already has a sample shop." });
    if (sessions.size >= maximumShops) return json(res, 429, { error: "Sample shop slots are full. Try the shops in the directory." });
    const slug = `sample-${randomBytes(12).toString("hex")}`;
    const address = `${origin}/s/${slug}`;
    const shop = { id: slug, name: draft.name, description: draft.description, area: "Sample shops",
      cuisine: "Sample shop", hours: `${draft.opensAt} – ${draft.closesAt}`, pageUrl: `${address}/`,
      networkUrl: `${address}/agent/shop_guide`, reservationEnabled: false };
    const entry = { shop, pending: true, expiresAt: Date.now() + lifetime * 1000 };
    sessions.set(token, entry);
    const owner = `${slug}@example.invalid`;
    try {
      const config = shopSchema.parse({
        ...emptyShop(owner), name: draft.name, description: draft.description, address: "",
        industry: "other", reservationsEnabled: false,
        hours: { start: draft.opensAt, end: draft.closesAt, closedWeekdays: [], holidays: [] },
      });
      await store.saveShop({ id: slug, slug, owner, published: config, publication: "public",
        draft: null, revision: 1, history: [] });
    } catch (error) {
      sessions.delete(token);
      throw error;
    }
    entry.pending = false;
    setCookie(res, token);
    return json(res, 201, { shop });
  }

  async function route(req, res, path) {
    if (path === "/api/demo-shop") {
      await api(req, res);
      return "handled";
    }
    const slug = /^\/(?:s|api\/public)\/(sample-[^/]+)(?:\/|$)/.exec(decodeURIComponent(path))?.[1];
    if (!slug) return "public";
    if (currentShop(sessionKey(req))?.id !== slug) {
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
