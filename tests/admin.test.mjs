import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, createShopStore, generatedFiles } from "../admin/store.mjs";
import { createAdminServer } from "../admin/server.mjs";
import { parseHocon } from "../site/runtime/hocon.js";

const source = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gemihub-admin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "site"));
  await cp(join(source, "src"), join(root, "src"), { recursive: true });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  for (const path of ["vendor", "site/runtime"]) {
    await symlink(join(source, path), join(root, path), linkType);
  }
  for (const path of ["site/shops.json", ...generatedFiles]) { await mkdir(join(root, path, ".."), { recursive: true }); await cp(join(source, path), join(root, path)); }
  // Admin fixtures exercise loopback/production validation independently of the demo hostname.
  const published = JSON.parse(await readFile(join(source, "site/shops.json"), "utf8"));
  const shops = published.shops.map(({ id, name, area, cuisine }) => ({ id, name, area, cuisine,
    pageUrl: `http://127.0.0.1:3000/s/${id}/reserve`,
    networkUrl: `http://127.0.0.1:3000/s/${id}/agent/reservation_concierge` }));
  await writeFile(join(root, "site/shops.json"), JSON.stringify({ version: 1, shops }));
  return { root, store: createShopStore({ root, ...options }) };
}
async function snapshot(root) {
  return Promise.all(["site/shops.json", ...generatedFiles].map(path => readFile(join(root, path), "utf8")));
}
test("real staged build publishes all generated outputs and stores metadata separately", async t => {
  const { root, store } = await fixture(t);
  const current = await store.get();
  const shops = current.shops.toReversed();
  shops[0].name = "変更した店名";
  const result = await store.save(shops, { [shops[0].id]: { status: "connected", description: "説明", fetchedAt: "2026-11-15T00:00:00Z", secret: "omit" } }, current.revision);
  assert.deepEqual(result.files, generatedFiles);
  assert.equal(result.shops[0].name, "変更した店名");
  assert.equal(result.cache[shops[0].id].description, "説明");
  assert.equal(result.cache[shops[0].id].secret, undefined);
  const config = JSON.parse(await readFile(join(root, "site/shops.json")));
  assert.deepEqual(Object.keys(config.shops[0]).sort(), ["id", "name", "area", "cuisine", "pageUrl", "networkUrl"].sort());
  assert.ok(!(await readFile(join(root, "site/shop-registry.js"), "utf8")).includes("description"));
  const network = JSON.parse(await readFile(join(root, "site/reservation_finder.network.json")));
  assert.deepEqual(Object.values(network.link_labels), shops.map(shop => shop.name));
  await assert.rejects(store.save(current.shops, {}, current.revision), /別の操作/);
});
test("validator and production errors do not change the registry or artifacts", async t => {
  const { root, store } = await fixture(t);
  const before = await snapshot(root);
  const current = await store.get();
  await assert.rejects(store.save([{ ...current.shops[0], cuisine: "" }]), /cuisine/);
  await assert.rejects(store.save([current.shops[0], current.shops[0]]), /重複/);
  const productionStore = createShopStore({ root, production: true });
  await assert.rejects(productionStore.save(current.shops), /HTTPS/);
  assert.deepEqual(await snapshot(root), before);
});
test("a failed real build preserves shops.json and every published artifact", async t => {
  const { root, store } = await fixture(t);
  const before = await snapshot(root);
  const template = parseHocon(await readFile(join(root, "src/reservation_finder.hocon"), "utf8"));
  template.tools[0].tools = ["missing"];
  template.tools[1].tools = ["missing"];
  await writeFile(join(root, "src/reservation_finder.hocon"), JSON.stringify(template));
  await assert.rejects(store.save((await store.get()).shops), /missing/);
  assert.deepEqual(await snapshot(root), before);
});
test("publication failure rolls back already replaced files, cache, and registry", async t => {
  let calls = 0;
  const { root, store } = await fixture(t, { write: async (file, data) => { await atomicWrite(file, data); if (++calls === generatedFiles.length + 2) throw new Error("disk failure"); } });
  const before = await snapshot(root);
  const current = await store.get();
  await assert.rejects(store.save(current.shops.toReversed(), { akari: { status: "connected" } }), /disk failure/);
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(readFile(join(root, "admin/cache.json")), { code: "ENOENT" });
});
test("serialized deletes preserve other changes and prune cache", async t => {
  const { store } = await fixture(t);
  await store.recordError("akari", "offline");
  assert.equal((await store.get()).cache.akari.status, "error");
  await Promise.all([store.delete("akari"), store.delete("trattoria-sole")]);
  const result = await store.get();
  assert.deepEqual(result.shops.map(shop => shop.id), ["kanton-ryu"]);
  assert.equal(result.cache.akari, undefined);
  await assert.rejects(store.delete("unknown"), /見つかりません/);
  await store.delete("kanton-ryu");
  assert.deepEqual((await store.get()).shops, []);
});

test("successful refresh clears an earlier error and production saves build HTTPS peers", async t => {
  const { root, store } = await fixture(t);
  await store.recordError("akari", "offline");
  const current = await store.get();
  const shops = current.shops.map(shop => ({ ...shop, pageUrl: shop.pageUrl.replace("http://127.0.0.1:3000", "https://shops.example"), networkUrl: shop.networkUrl.replace("http://127.0.0.1:3000", "https://shops.example") }));
  const productionStore = createShopStore({ root, production: true });
  const saved = await productionStore.save(shops, { akari: { status: "connected" } });
  assert.equal(saved.production, true);
  assert.equal(saved.cache.akari.status, "connected");
  assert.equal(saved.cache.akari.error, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(root, "site/agent-manifest.json"))).allowed_peers, ["https://shops.example"]);
});

async function apiFixture(t, options = {}) {
  const { root, store } = await fixture(t);
  const calls = [];
  const server = createAdminServer({ auth: false, root, store, resolver: async (url, opts) => { calls.push({ url, opts }); if (url === "fail") throw new Error("解決失敗"); return { shop: { id: "preview" }, cache: {} }; }, ...options });
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  function call(path, { method = "GET", host = `127.0.0.1:${port}`, origin = `http://${host}`, data, headers = {} } = {}) {
    return new Promise((accept, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method, agent: false, headers: { host, ...(origin === null ? {} : { origin }), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, res => {
        let body = "";
        res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => accept({ status: res.statusCode, headers: res.headers, body, json: res.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : undefined }));
      });
      req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  return { root, store, calls, call, port };
}
test("API rejects foreign Host, foreign or missing Origin and cross-site requests", async t => {
  const { call, calls, port } = await apiFixture(t);
  for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost:${port + 1}`, `user@127.0.0.1:${port}`]) assert.equal((await call("/api/shops", { host })).status, 403);
  for (const method of ["POST", "PUT", "DELETE"]) for (const origin of [null, "null", "https://evil.example", `http://localhost:${port}`]) assert.equal((await call("/api/resolve", { method, origin, data: { url: "test" } })).status, 403);
  assert.equal((await call("/api/shops", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call("/api/shops", { host: `localhost:${port}`, origin: null })).status, 200);
  assert.equal(calls.length, 0);
});
test("API previews without saving and exposes only allowlisted UI assets", async t => {
  const { call, store, calls } = await apiFixture(t);
  const before = await store.get();
  assert.equal((await call("/api/resolve", { method: "POST", data: { url: "test" } })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await store.get()).revision, before.revision);
  for (const path of ["/cache.json", "/server.mjs", "/store.mjs", "/../site/shops.json", "/runtime/kernel.js"]) assert.equal((await call(path)).status, 404);
  assert.equal((await call("/")).status, 200);
  assert.equal((await call("/admin.js")).headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await call("/api/resolve", { method: "POST", data: {}, headers: { "Content-Type": "text/plain" } })).status, 415);
});
test("API save/build failures preserve bytes; stale revisions are rejected", async t => {
  const { call, root } = await apiFixture(t);
  const current = (await call("/api/shops")).json;
  const before = await snapshot(root);
  const invalid = await call("/api/shops", { method: "PUT", data: [{ ...current.shops[0], cuisine: "" }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /cuisine/);
  assert.deepEqual(await snapshot(root), before);
  const template = parseHocon(await readFile(join(root, "src/reservation_finder.hocon"), "utf8"));
  template.tools[1].tools = ["missing"];
  await writeFile(join(root, "src/reservation_finder.hocon"), JSON.stringify(template));
  const failedBuild = await call("/api/shops", { method: "PUT", data: current.shops });
  assert.equal(failedBuild.status, 400);
  assert.match(failedBuild.json.error, /missing/);
  assert.deepEqual(await snapshot(root), before);
  await cp(join(source, "src/reservation_finder.hocon"), join(root, "src/reservation_finder.hocon"));
  const saved = await call("/api/shops", { method: "PUT", data: { shops: current.shops.toReversed(), revision: current.revision } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.files, generatedFiles);
  assert.equal((await call("/api/shops/akari", { method: "DELETE", headers: { "If-Match": current.revision } })).status, 409);
  assert.equal((await call("/api/shops/akari", { method: "DELETE", headers: { "If-Match": saved.json.revision } })).status, 200);
});
test("failed refresh records error state for existing shops", async t => {
  const { call } = await apiFixture(t);
  assert.equal((await call("/api/resolve", { method: "POST", data: { url: "fail", id: "akari" } })).status, 400);
  assert.equal((await call("/api/shops")).json.cache.akari.status, "error");
});

test("Gemini uses only the server key; no AI settings or genre autosave are exposed", async t => {
  const received = [];
  const { call, root } = await apiFixture(t, {
    geminiApiKey: "server-secret",
    resolver: async (_url, { suggestCuisine }) => ({ shop: { cuisine: await suggestCuisine({ name: "炉端 灯", description: "炉端焼き" }) } }),
    cuisineSuggester: async (details, config) => { received.push({ details, config }); return "和食・炉端焼き"; },
  });
  const before = await snapshot(root);
  assert.equal((await call("/api/ai-config")).status, 404);
  assert.equal((await call("/api/models", { method: "POST", data: {} })).status, 404);
  const html = (await call("/")).body;
  assert.doesNotMatch(html, /ai-settings|ai-form|ai-model|ai-key/);
  assert.equal((await call("/api/resolve", { method: "POST", data: { url: "test" } })).json.shop.cuisine, "和食・炉端焼き");
  assert.equal(received[0].config.apiKey, "server-secret");
  await call("/api/resolve", { method: "POST", data: { url: "test", ai: { baseUrl: "https://other.example/v1", model: "other", apiKey: "own-key" } } });
  assert.deepEqual(received[1].config, { apiKey: "server-secret" });
  await call("/api/resolve", { method: "POST", data: { url: "test", ai: { baseUrl: "https://other.example/v1" } } });
  assert.deepEqual(received[2].config, { apiKey: "server-secret" });
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await call("/runtime/byok.js")).status, 404);
  assert.equal((await call("/runtime/model.js")).status, 404);
});

test("ordinary shop descriptions and independent capabilities survive a real save/build", async t => {
  const { store, root } = await fixture(t);
  const current = await store.get();
  const shop = { id: "zakka", name: "雑貨の森", area: "東京都新宿区", cuisine: "雑貨・生活雑貨", pageUrl: "https://zakka.example/", networkUrl: "", description: "器と文具のお店。", reservationEnabled: false };
  const saved = await store.save([...current.shops, shop]);
  assert.deepEqual(saved.shops.at(-1), shop);
  const manifest = JSON.parse(await readFile(join(root, "site/agent-manifest.json")));
  assert.ok(!manifest.allowed_peers.includes("https://zakka.example"));
  assert.match(await readFile(join(root, "site/_headers"), "utf8"), /frame-src[^\n]*https:\/\/zakka.example/);
  assert.match(await readFile(join(root, "site/shop-registry.js"), "utf8"), /器と文具のお店/);
  const network = JSON.parse(await readFile(join(root, "site/reservation_finder.network.json")));
  assert.ok(!network.tools[0].tools.some(tool => typeof tool === "string" && tool.includes("zakka.example")));
  await store.save([shop]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "site/agent-manifest.json"))).allowed_peers, []);
  assert.deepEqual(JSON.parse(await readFile(join(root, "site/reservation_finder.network.json"))).tools[0].tools, ["condition_checker"]);
});
