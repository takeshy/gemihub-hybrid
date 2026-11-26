import test from "node:test";
import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import { createApp } from "../server/app.ts";
import { Store, type Shop } from "../server/store.ts";
import { bookableMenus, menuSelection, sample, shopSchema } from "../server/domain.ts";
import { basicSchema, liveValue, updateLiveValue } from "../server/live-settings.ts";
import { shopGuideInfo } from "../server/shop-guide.ts";

const config = () => shopSchema.parse({ ...structuredClone(sample), industry: "other", name: "文具と器 こまど",
  products: ["作家の器", "手帳"], description: "紙雑貨も扱うお店です。", notificationEmail: "private-owner@example.com",
  staff: [], ownerBooking: true,
  menus: [{ id: "wrapping", name: "包装の相談", price: 500, duration: 15, active: true }, { id: "hidden", name: "非公開の品", price: 1000, duration: 15, active: false }],
  hours: { start: "12:00", end: "21:00", closedWeekdays: [2], holidays: ["2030-01-01", "2030-02-01"], weekdayHours: [{ day: 6, start: "13:00", end: "20:00" }], specialDays: [{ date: "2030-01-08", start: "14:00", end: "19:00" }] },
});

test("other shops save products as basic settings and expose only published product/hour facts", () => {
  const c = config();
  const next = updateLiveValue(c, "basic", { ...liveValue(c, "basic") as object, products: ["紙雑貨"] });
  assert.deepEqual(next.products, ["紙雑貨"]);
  assert.equal(basicSchema.safeParse({ ...c, products: [""] }).success, false);
  const info = shopGuideInfo(c, "https://shop.example/s/komado/", {}, new Date("2030-01-07T01:00:00Z"));
  assert.deepEqual(info.products, ["作家の器", "手帳", "包装の相談"]);
  assert.deepEqual(info.hours.closedDates, ["2030-02-01"]);
  assert.match(info.hours.regular, /12:00.*21:00.*13:00.*20:00/);
  assert.match(info.hours.specialDays, /14:00.*19:00/);
  assert.equal(info.stock, "unknown");
  assert.doesNotMatch(JSON.stringify(info), /非公開の品|private-owner|staff|reservation/);
  assert.throws(() => shopGuideInfo(c, "https://shop.example/", { stock: true }));
  assert.deepEqual(shopGuideInfo({ ...c, products: undefined, menus: [] }, "https://shop.example/").products, []);
});

test("service settings save priced products without a duration or booking assignment", () => {
  const original = config();
  const product = { id: "notebook", name: "Notebook", price: 1200, active: true };
  const hidden = { ...product, id: "pen", name: "Pen", active: false };
  const value = { menus: original.menus, catalogProducts: [product, hidden] };
  const saved = updateLiveValue(original, "menus", value);
  assert.deepEqual(liveValue(saved, "menus"), value);
  assert.deepEqual(updateLiveValue(saved, "menus", original.menus).catalogProducts, value.catalogProducts);
  assert.deepEqual(saved.products, original.products);
  assert.deepEqual(bookableMenus(saved), bookableMenus(original));
  assert.equal(menuSelection(saved, product.id), undefined);
  assert.equal(menuSelection(saved, original.menus[0].id, [product.id]), undefined);
  const info = shopGuideInfo(saved, "https://shop.example/");
  assert.deepEqual(info.catalog, [{ id: product.id, name: product.name, price: 1200, currency: "JPY" }]);
  assert.ok(info.products.includes(product.name));
  assert.ok(!info.products.includes(hidden.name));
  assert.throws(() => updateLiveValue(saved, "menus", { ...value, menus: [{ ...original.menus[0], duration: undefined }] }));
  assert.throws(() => updateLiveValue(saved, "menus", { ...value, catalogProducts: [{ ...product, price: 5.25 }] }));
});

test("other shop pages and custom hosts serve an actionable chat/voice guide with only get_shop_info", async t => {
  const previous = { ...process.env };
  Object.assign(process.env, { DEMO_MODE: "true", SITE_DOMAIN: "shops.test", AGENT_PARENT_URL: "https://guide.example" });
  const store = new Store(":memory:");
  const shop: Shop = { id: "komado-test", slug: "komado", owner: "owner@example.com", published: config(), publication: "public", draft: { ...config(), products: ["下書きの品"] }, revision: 1, history: [] };
  await store.saveShop(shop);
  const server = createApp(store);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  process.env.APP_ORIGIN = origin;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); process.env = previous; });
  const call = (path: string, data?: unknown, host = `127.0.0.1:${port}`) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; json: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: data === undefined ? "GET" : "POST", headers: { Host: host, Origin: "https://foreign.example", "Accept-Language": "ja", ...(data === undefined ? {} : { "Content-Type": "application/json" }) } }, res => {
      let body = "";
      res.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body, json: res.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : undefined }));
    });
    req.on("error", reject).end(data === undefined ? undefined : JSON.stringify(data));
  });
  for (const hosted of [false, true]) {
    const host = hosted ? "komado.shops.test" : `127.0.0.1:${port}`;
    const base = hosted ? "" : "/s/komado";
    const page = await call(base + "/", undefined, host);
    assert.equal(page.status, 200);
    assert.match(page.body, /data-agent-kind="shop"/);
    assert.match(page.body, /営業時間やお休み、扱っている品/);
    assert.match(page.body, /id="assistant-toggle"/);
    assert.doesNotMatch(page.body, /id="reserve-form"|予約アシスタント/);
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors https:\/\/guide.example/);
    const manifest = await call(base + "/agent/agent-manifest.json", undefined, host);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers["access-control-allow-origin"], "*");
    assert.equal(manifest.json.networks[0].name, "shop_guide");
    assert.equal(manifest.json.actions, undefined);
    const network = (await call(base + "/agent/shop_guide.network.json", undefined, host)).json;
    assert.deepEqual(network.tools[0].tools, [{ url: `${hosted ? "https://" + host : origin}${base}/agent/mcp`, tools: ["get_shop_info"] }]);
    const rpc = async (method: string, params?: unknown) => (await call(base + "/agent/mcp", { jsonrpc: "2.0", id: 1, method, params }, host)).json;
    assert.equal((await rpc("initialize")).result.serverInfo.name, "gemihub-shop");
    assert.deepEqual((await rpc("tools/list")).result.tools.map((tool: any) => tool.name), ["get_shop_info"]);
    const info = (await rpc("tools/call", { name: "get_shop_info", arguments: {} })).result.structuredContent;
    assert.deepEqual(info.products, ["作家の器", "手帳", "包装の相談"]);
    assert.doesNotMatch(JSON.stringify(info), /下書きの品|非公開の品|private-owner/);
    assert.equal((await rpc("tools/call", { name: "check_availability" })).error.code, -32602);
    assert.equal((await rpc("tools/call", { name: "place_reservation" })).error.code, -32602);
    assert.equal((await rpc("tools/call", { name: "get_shop_info", arguments: { stock: true } })).result.isError, true);
    for (const file of ["site.js", "reserve-page.js", "voice-bridge.js", "voice-turn.js", "shop-voice.js", "voice-chat.js", "voice-chat.css", "voice-audio.js", "runtime/index.js"]) assert.equal((await call(base + "/agent/" + file, undefined, host)).status, 200);
    assert.equal((await call(base + "/agent/reservation_concierge.network.json", undefined, host)).status, 404);
    assert.equal((await call(base + "/reserve", undefined, host)).status, 404);
  }
  shop.publication = "provisional"; await store.saveShop(shop);
  assert.equal((await call("/s/komado/agent/agent-manifest.json")).status, 404);
  assert.equal((await call("/s/komado/agent/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
  shop.publication = "public"; shop.archivedAt = new Date().toISOString(); await store.saveShop(shop);
  assert.equal((await call("/s/komado/agent/agent-manifest.json")).status, 404);
});
