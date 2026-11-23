import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Store } from "../server/store.ts";

test("sample shop creation and storefront access stay within one browser session", async t => {
  const { createSampleShops } = await import(new URL("../../../scripts/sample-shops.mjs", import.meta.url).href);
  const store = new Store(":memory:");
  const origin = "https://hybrid.gemihub.net";
  const { route } = createSampleShops(store, origin);
  const server = createServer((req, res) => {
    void route(req, res, new URL(req.url || "/", origin).pathname).then((result: string) => {
      if (result !== "handled") res.end(result);
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = async () => {
    const response = await fetch(`${base}/api/demo-shop`);
    assert.deepEqual(await response.json(), { shop: null });
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie || "", /HttpOnly; SameSite=Lax; Max-Age=7200; Secure/);
    return cookie!.split(";")[0];
  };
  const owner = await session(), other = await session();
  const draft = { name: "Willow Café", description: "Toast and coffee.", opensAt: "10:00", closesAt: "18:00" };
  const publish = (requestOrigin = origin, body = draft) => fetch(`${base}/api/demo-shop`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: owner },
    body: JSON.stringify(body),
  });
  assert.equal((await publish("https://example.org")).status, 403);
  assert.equal((await publish(origin, { ...draft, closesAt: "09:00" })).status, 400);
  const created = await publish();
  assert.equal(created.status, 201);
  const { shop } = await created.json();
  assert.equal(shop.hours, "10:00 – 18:00");
  assert.deepEqual((await store.shop(shop.id))?.published?.hours,
    { start: "10:00", end: "18:00", closedWeekdays: [], holidays: [] });
  assert.equal((await publish()).status, 409);
  for (const path of [`/s/${shop.id}/`, `/s/${shop.id}/agent/facts.json`, `/api/public/${shop.id}`]) {
    const unauthenticated = await fetch(base + path);
    assert.equal(unauthenticated.status, 404, path);
    const unauthorised = await fetch(base + path, { headers: { Cookie: other } });
    assert.equal(unauthorised.status, 404, path);
    const authorised = await fetch(base + path, { headers: { Cookie: owner } });
    assert.equal(await authorised.text(), "private", path);
  }
  const booking = await fetch(`${base}/api/public/${shop.id}/bookings`, {
    method: "POST", headers: { Cookie: owner, Origin: origin },
  });
  assert.equal(booking.status, 405);
});
