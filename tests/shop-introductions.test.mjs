import assert from "node:assert/strict";
import test from "node:test";
import { validateShops } from "../scripts/shops.mjs";
import { extractShopPage } from "../scripts/shop-html.mjs";
import { resolveShop } from "../scripts/resolve-shop.mjs";
import { canReserve, hasAgent, canCheckReservations, reservationPageUrl, shopPageUrl } from "../site/shop-data.js";
import { FinderPage } from "../site/finder.js";
import { installInquiryPolicy, ShopInquiries } from "../site/inquiries.js";
import { ShopFrame } from "../site/shop-frame.js";
import { App } from "../site/script.js";
import { StubDocument } from "./stub_document.mjs";

const origin = "https://shops.example";
const store = { id: "zakka", name: "暮らしの雑貨店", area: "東京都新宿区", cuisine: "雑貨・生活雑貨", description: "器や文具、贈り物を扱うお店。", pageUrl: `${origin}/s/zakka/`, networkUrl: "", reservationEnabled: false };
const agentShop = { ...store, id: "agent-shop", pageUrl: `${origin}/s/agent-shop/`, networkUrl: `${origin}/s/agent-shop/agent/shop_guide` };
const bookable = { ...store, id: "bookable", pageUrl: `${origin}/s/bookable/`, reservationEnabled: true, reservationUrl: `${origin}/s/bookable/book` };
const full = { ...bookable, id: "full", pageUrl: `${origin}/s/full/`, reservationUrl: `${origin}/s/full/book`, networkUrl: `${origin}/s/full/agent/shop_guide` };
const html = '<html><head><title>暮らしの雑貨店</title><meta name="description" content="器と文具 &amp; 贈り物"><script type="application/ld+json">{"@type":"HomeGoodsStore","name":"暮らしの雑貨店","address":{"addressRegion":"東京都","addressLocality":"新宿区"}}</script></head></html>';

test("agent and reservation capabilities support all four combinations", () => {
  const validated = validateShops({ version: 1, shops: [store, agentShop, bookable, full] });
  assert.deepEqual(validated.map(shop => [hasAgent(shop), canReserve(shop)]), [[false, false], [true, false], [false, true], [true, true]]);
  assert.equal(validated[0].networkTool, undefined);
  assert.equal(validated[1].networkTool, "s_agent_shop_agent_shop_guide");
  assert.equal(validated[0].description, store.description);
  assert.deepEqual(validated.map(canCheckReservations), [false, false, false, true]);
});

test("ordinary shop reservation links keep their routing query without allowing query-bearing agent URLs", () => {
  const input = { ...bookable, reservationUrl: `${origin}/s/bookable/?pane=reserve` };
  const [shop] = validateShops({ version: 1, shops: [input] }, { production: true });
  assert.equal(reservationPageUrl(shop), input.reservationUrl);
  assert.throws(() => validateShops({ version: 1, shops: [{ ...input, networkUrl: `${origin}/agent/shop?token=unsafe` }] }));
  assert.throws(() => validateShops({ version: 1, shops: [{ ...input, reservationUrl: `${input.reservationUrl}#private` }] }));
});
test("a reservation URL without an agent is shown only as a normal shop link", t => {
  const before = globalThis.document;
  t.after(() => { globalThis.document = before; });
  globalThis.document = new StubDocument();
  const plain = App.introductionCard(bookable);
  assert.equal(plain.querySelectorAll("button").some(button => button.textContent === "予約ページへ"), false);
  const [link] = plain.querySelectorAll("a");
  assert.equal(link.href, bookable.pageUrl);
  assert.equal(link.target, "_blank");
  assert.equal(plain.querySelectorAll("p").some(p => p.textContent.includes("予約ページあり")), false);
  assert.equal(App.introductionCard(full).querySelectorAll("button").some(button => button.textContent === "予約ページへ"), true);
});
test("agentless reservation URLs cannot bypass the hidden control through a tool or restored frame", () => {
  const page = new FinderPage([bookable, full], { now: () => new Date("2026-11-15T00:00:00Z") });
  page.setConditions({ date: "2026-12-18", time: "19:00", partySize: 2 });
  assert.equal(page.checkOpenShop({ shopId: bookable.id, expectedVersion: page.version }).ok, false);
  assert.equal(page.framedShopUrl(bookable.id, "reserve").ok, false);
  assert.deepEqual(page.framedShopUrl(bookable.id, "shop"), { url: bookable.pageUrl, conditions: null });
  assert.equal(page.showCandidates({ candidates: [{ shopId: bookable.id, status: "available", summary: "unverified" }], expectedVersion: page.version }).ok, false);
  const frame = new ShopFrame({ shops: [bookable], relay: {}, getPage: () => page, modelName: () => "fixture" });
  assert.equal(frame.open(bookable.id, { target: "reserve" }).ok, false);
  assert.equal(frame.open(bookable.id, { target: "shop" }).ok, false);
  assert.equal(frame.shop, null);
});
test("legacy restaurants preserve their reservation pages", () => {
  const legacy = { ...store, pageUrl: `${origin}/s/zakka/reserve` };
  delete legacy.reservationEnabled;
  assert.equal(canReserve(legacy), true);
  assert.equal(reservationPageUrl(legacy), legacy.pageUrl);
  assert.equal(shopPageUrl(legacy), store.pageUrl);
  assert.equal(canReserve({ ...legacy, reservationEnabled: false }), false);
});
test("explicit reservation support requires a same-origin reservation URL", () => {
  for (const change of [{ reservationEnabled: true }, { reservationEnabled: "yes" }, { reservationUrl: "https://evil.example/book" }, { networkUrl: "https://evil.example/agent/shop" }, { description: "x".repeat(2001) }]) assert.throws(() => validateShops({ version: 1, shops: [{ ...store, ...change }] }));
});
test("ordinary HTML metadata is data, including JSON-LD graphs and entities", () => {
  assert.deepEqual(extractShopPage(html), { name: "暮らしの雑貨店", description: "器と文具 & 贈り物", address: "東京都新宿区" });
  const page = '<!-- <meta name="description" content="ignored"> --><title>Title &amp; more</title><meta property="og:description" content="A > B"><script type="application/ld+json">invalid</script><script>throw new Error("must not execute")</script>';
  assert.deepEqual(extractShopPage(page), { name: "Title & more", description: "A > B", address: "" });
});
test("ordinary websites resolve without manifests, agents, or reservation URLs", async () => {
  const calls = [];
  const result = await resolveShop(store.pageUrl, { discovery: true, fetch: async url => { calls.push(url); return url.endsWith("agent-manifest.json") ? new Response("", { status: 404 }) : new Response(html); }, suggestCuisine: async input => {
    assert.equal(input.includeShops, true);
    assert.equal(input.name, store.name);
    return store.cuisine;
  } });
  assert.equal(result.shop.name, store.name);
  assert.equal(result.shop.area, store.area);
  assert.equal(result.shop.cuisine, store.cuisine);
  assert.equal(result.shop.networkUrl, "");
  assert.equal(result.shop.reservationEnabled, false);
  assert.equal(result.shop.pageUrl, store.pageUrl);
  assert.equal(result.shop.description, "器と文具 & 贈り物");
  assert.equal(result.cache.status, "connected");
  assert.equal(calls.length, 2);
});
test("a manifest with no networks still permits ordinary shop introductions", async () => {
  const result = await resolveShop(store.pageUrl, { discovery: true, fetch: async url => url.endsWith("agent-manifest.json") ? Response.json({ networks: [] }) : new Response(html) });
  assert.equal(result.shop.networkUrl, "");
  assert.equal(result.shop.reservationEnabled, false);
});
for (const [name, reservations] of [["shop_guide", false], ["reservation_concierge", false], ["shop_guide", true]]) test(`agent ${name} does not determine reservation support (${reservations})`, async () => {
  const base = `${origin}/s/zakka`;
  const info = { shop: store.name, address: store.area, description: store.description, ...(reservations ? { reservation: { partySize: { min: 1, max: 10 } }, reservePageUrl: `${base}/reserve` } : {}) };
  const result = await resolveShop(`${base}/`, { discovery: true, fetch: async (url, options) => {
    if (url.endsWith("agent-manifest.json")) return Response.json({ networks: [{ name, front_man: "front", hocon: `./${name}.network.json` }] });
    if (url.endsWith(".network.json")) return Response.json({ tools: [{ name: "front", instructions: "Read shop information", tools: [{ url: `${base}/agent/mcp`, tools: ["get_shop_info"] }] }] });
    const rpc = JSON.parse(options.body);
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.ok(["initialize", "tools/call"].includes(rpc.method));
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize" ? {} : { structuredContent: info } });
  } });
  assert.equal(result.shop.networkUrl, `${base}/agent/${name}`);
  assert.equal(result.shop.reservationEnabled, reservations);
  assert.equal(canReserve(result.shop), reservations);
  if (!reservations) assert.equal(result.shop.reservationUrl, undefined);
});
test("shop introductions and filters work before dates or party size are provided", () => {
  const page = new FinderPage([store, agentShop, bookable, full]);
  assert.equal(page.getState().valid, false);
  assert.equal(page.showIntroductions({ shopIds: [store.id, agentShop.id] }).ok, true);
  assert.deepEqual(page.getState().introductions, [store.id, agentShop.id]);
  assert.deepEqual(page.listShops({ purpose: "reservation" }).map(shop => shop.id), [full.id]);
  assert.equal(page.listShops({ query: "贈り物" }).length, 4);
  assert.equal(page.listShops({ query: "未掲載の商品" }).length, 0);
  const before = page.getState();
  assert.equal(page.showIntroductions({ shopIds: ["missing"] }).ok, false);
  assert.deepEqual(page.getState(), before);
});

test("nail salon searches match registered nail services with area and keyword restrictions intact", () => {
  const nail = { ...store, id: "nail", name: "Num05", area: "横浜市港北区", cuisine: "ネイル・美容サービス", description: "気さくなお店" };
  const page = new FinderPage([nail, store]);
  for (const filter of [{ cuisine: "ネイルサロン" }, { query: "ネイルサロン" }, { cuisine: "ネイル", area: "横浜" }]) {
    assert.deepEqual(page.listShops(filter).map(shop => shop.id), [nail.id]);
  }
  assert.deepEqual(page.listShops({ cuisine: "ネイルサロン", area: "新宿" }), []);
  assert.deepEqual(page.listShops({ query: "ネイルサロン 未掲載の施術" }), []);
  assert.deepEqual(page.listShops({ cuisine: "ネイルサロン", purpose: "reservation" }), []);
});

test("agents without get_shop_info still use the normal page for shop metadata", async () => {
  let calls = 0;
  const result = await resolveShop(store.pageUrl, { discovery: true, fetch: async (url, options) => {
    if (options.method === "POST") { calls++; assert.fail("metadata must not call undeclared tools"); }
    if (url.endsWith("agent-manifest.json")) return Response.json({ networks: [{ name: "shop_guide", front_man: "front", hocon: "./shop_guide.network.json" }] });
    if (url.endsWith(".network.json")) return Response.json({ tools: [{ name: "front", instructions: "Read products", tools: [{ url: `${origin}/agent/mcp`, tools: ["list_products"] }] }] });
    return new Response(html);
  } });
  assert.equal(result.shop.name, store.name);
  assert.equal(result.shop.reservationEnabled, false);
  assert.equal(result.cache.status, "connected");
  assert.equal(result.warning, undefined);
  assert.equal(calls, 0);
});
test("reservation conditions never leak into a non-reservable shop page", () => {
  const page = new FinderPage([store, agentShop], { now: () => new Date("2026-11-15T00:00:00Z") });
  page.setConditions({ date: "2026-12-18", time: "19:00", partySize: 2 });
  for (const shop of [store, agentShop]) {
    assert.deepEqual(page.framedShopUrl(shop.id, "shop"), { url: shop.pageUrl, conditions: null });
    assert.equal(page.framedShopUrl(shop.id, "reserve").ok, false);
    assert.equal(page.checkOpenShop({ shopId: shop.id, expectedVersion: page.version }).ok, false);
    assert.equal(page.showCandidates({ candidates: [{ shopId: shop.id, status: "available", summary: "fake" }], expectedVersion: page.version }).ok, false);
  }
});
test("agent-only shop queries need no reservation conditions and exclude agentless shops", async () => {
  const page = new FinderPage([store, agentShop, bookable, full]);
  const inquiries = new ShopInquiries(() => page, async plan => { assert.equal(plan.purpose, "introduction"); return true; });
  const result = await inquiries.confirm({ cuisine: "雑貨", area: "", purpose: "introduction", query: "贈り物になる文具はありますか？", expectedVersion: 0 });
  assert.equal(result.approved, true);
  assert.deepEqual(result.shops.map(shop => shop.id), [agentShop.id, full.id]);
  assert.equal(inquiries.canContactNetwork(agentShop.networkUrl), true);
  assert.equal((await inquiries.confirm({ cuisine: "", area: "", expectedVersion: 0 })).ok, false);
});
test("introduction queries expose read-only MCP tools and expire with the approval", async () => {
  const page = new FinderPage([agentShop]);
  const inquiries = new ShopInquiries(() => page, async () => true);
  const writes = [];
  const engine = { consent: new Map(), resolveRemote: () => ({}), resolveMcp: async () => ({
    listTools: async () => [{ name: "get_shop_info" }, { name: "list_products", annotations: { readOnlyHint: true } }, { name: "purchase" }],
    callTool: async name => { writes.push(name); return "public info"; },
  }) };
  installInquiryPolicy(engine, inquiries);
  await inquiries.confirm({ cuisine: "", area: "", purpose: "introduction", query: "扱う商品を教えて", expectedVersion: 0 });
  const client = await engine.resolveMcp({ url: `${origin}/s/agent-shop/agent/mcp` });
  assert.deepEqual((await client.listTools()).map(tool => tool.name), ["get_shop_info", "list_products"]);
  await client.callTool("list_products");
  assert.throws(() => client.callTool("purchase"), /読み取り専用/);
  inquiries.invalidate();
  assert.throws(() => client.callTool("list_products"), /もう一度確認/);
  assert.deepEqual(writes, ["list_products"]);
});
test("framed shop pages cannot open the removed parent BYOK relay", t => {
  const previous = globalThis.document;
  t.after(() => { globalThis.document = previous; });
  const sent = [];
  const frameWindow = { postMessage: message => sent.push(message) };
  const elements = new Map([["shop-page-frame", { contentWindow: frameWindow }]]);
  globalThis.document = { getElementById: id => elements.get(id) };
  let opened = 0;
  const relay = { ready: () => true, open: () => { opened++; return { id: "session" }; }, close: () => null };
  const framed = new ShopFrame({ shops: [store, agentShop], relay, getPage: () => new FinderPage([store, agentShop]), modelName: () => "chosen" });
  framed.shop = store;
  framed.onMessage({ source: frameWindow, origin, data: { type: "gemihub:relay-hello", version: 1, shop: store.id } });
  assert.equal(opened, 0);
  framed.shop = agentShop;
  framed.onMessage({ source: frameWindow, origin, data: { type: "gemihub:relay-hello", version: 1, shop: agentShop.id } });
  assert.equal(opened, 0);
  assert.equal(sent.length, 0);
});
