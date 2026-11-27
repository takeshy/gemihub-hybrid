import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { digest } from "../server/auth.ts";
import { sample, type ShopConfig } from "../server/domain.ts";
import * as ai from "../server/ai.ts";
import { splitThemeStyles } from "../shared/theme-styles.ts";

const theme = splitThemeStyles({ headerHtml: '<header class="brand"><slot name="title"></slot><slot name="navigation"></slot></header>', bodyHtml: '<main><slot name="content"></slot></main>', footerHtml: '<footer><slot name="content"></slot></footer>', css: ".brand{background:#251334;color:#fff;padding:24px}" });
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("a new shop opens with the built-in design at once and its own AI design arrives as a proposal", { timeout: 20000 }, async t => {
  delete process.env.DEMO_MODE;
  const store = new Store(":memory:");
  const shop = await store.createShop("owner@example.com");
  await store.put("session", digest("proposal-owner"), { user: { email: shop.owner, name: "Owner", role: "owner", shopId: shop.id }, expires: Date.now() + 600000 });
  const gate = latch();
  let deferred: boolean | undefined, themeCalls = 0, failNext = false;
  const server = createApp(store, { ...ai,
    async propose(_text, current, email, _demo, _images, _region, context) {
      assert.equal(current, null);
      deferred = context?.deferTheme;
      const config: ShopConfig = { ...structuredClone(sample), notificationEmail: email, appearance: { accent: "sage", layout: "standard", imageUrl: "" } };
      return { config, summary: ["First shop"], themeReview: undefined };
    },
    async initialTheme(input) {
      themeCalls++;
      assert.equal(input.config.appearance?.theme, undefined, "the design is made for the shop as proposed");
      await gate.promise;
      if (failNext) { failNext = false; throw new Error("Temporary design failure"); }
      return { config: input.config, request: input.request, imageIds: [], attempts: 1, feedback: [], candidate: theme, review: { approved: true, issues: [], imageUsage: [] } };
    },
    async themeContrast() { return []; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.APP_ORIGIN = origin;
  t.after(async () => { server.close(); await store.close(); });
  const call = async (path: string, data?: unknown) => {
    const response = await fetch(origin + path, { method: data === undefined ? "GET" : "POST", headers: { Origin: origin, Cookie: "gemihub_session=proposal-owner", "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  };
  const proposal = () => call(`/api/shops/${shop.id}/theme-proposal`);
  const until = async (status: string) => { for (let i = 0; i < 100; i++) { const current = await proposal(); if (current.status === status) return current; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail(`proposal never became ${status}`); };

  assert.deepEqual(await proposal(), { status: "none" });
  // A job recorded before this server started (lost to a restart) can be retried at once.
  await store.put("themeProposal", shop.id, { shopId: shop.id, status: "generating", themeRunId: "old", request: "r", imageIds: [], config: sample, startedAt: 1, updatedAt: 1 });
  assert.equal((await proposal()).status, "failed");
  await store.delete("themeProposal", shop.id);
  const plan = await call(`/api/shops/${shop.id}/plan`, { text: "A calm nail salon" });
  assert.equal(deferred, true, "the first proposal does not wait for the AI design");
  assert.equal(plan.config.appearance.theme, undefined);
  assert.equal(plan.themeProposal, true, "the first review tells the owner the design is on its way");
  assert.equal((await proposal()).status, "generating");
  const scopedProposal = await call(`/api/shops/${shop.id}/theme-proposal?plan=${plan.id}`);
  assert.equal(scopedProposal.status, "generating");
  assert.deepEqual(await call(`/api/shops/${shop.id}/theme-proposal?plan=missing`), { status: "none" });
  // The owner opens the shop with the built-in design while the AI design is still running.
  await call(`/api/shops/${shop.id}/plans/${plan.id}/approve`, {});
  await call(`/api/shops/${shop.id}/plans/${plan.id}/publish`, { publication: "provisional" });
  assert.equal((await store.shop(shop.id))!.publication, "provisional");
  // Public publication waits for the design and then for the owner's decision.
  const publishPublicly = async () => {
    const preview = await call(`/api/shops/${shop.id}/publication-preview`);
    return fetch(origin + `/api/shops/${shop.id}/publication`, { method: "POST", headers: { Origin: origin, Cookie: "gemihub_session=proposal-owner", "Content-Type": "application/json" }, body: JSON.stringify({ publication: "public", revision: preview.revision, hash: preview.hash }) });
  };
  assert.equal((await publishPublicly()).status, 409);
  gate.resolve();
  const ready = await until("ready");
  assert.equal((await publishPublicly()).status, 409);
  assert.deepEqual(ready.theme, theme);

  // Applying uses the normal theme release path and leaves every other setting unchanged.
  const snapshot = await call(`/api/shops/${shop.id}/local-editor`);
  const after = { ...snapshot.config, appearance: { ...snapshot.config.appearance, theme: ready.theme } };
  const applied = await call(`/api/shops/${shop.id}/plan`, { text: "Apply the AI design", config: after, local: { base: snapshot.base, source: snapshot.source, requestId: crypto.randomUUID(), scope: { kind: "theme" } } });
  await call(`/api/shops/${shop.id}/plans/${applied.id}/approve`, {});
  await call(`/api/shops/${shop.id}/plans/${applied.id}/publish`, {});
  const live = await call(`/api/shops/${shop.id}/local-editor`);
  assert.deepEqual(live.config.appearance.theme, theme);
  for (const key of ["name", "menus", "staff", "hours", "rules"] as const) assert.deepEqual(live.config[key], snapshot.config[key]);
  assert.deepEqual(await call(`/api/shops/${shop.id}/theme-proposal/applied`, {}), { status: "none" });
  assert.deepEqual(await proposal(), { status: "none" });
  assert.equal((await publishPublicly()).status, 200, "once decided, the shop can be published publicly");
  assert.equal(themeCalls, 1);

  // A failed design can be created again; a design in progress cannot be started twice.
  const stored = await store.get<{ startedAt: number }>("themeProposal", shop.id);
  failNext = true;
  await store.put("themeProposal", shop.id, { ...stored, status: "failed", error: "Temporary design failure" });
  const retried = await call(`/api/shops/${shop.id}/theme-proposal/retry`, {});
  assert.equal(retried.status, "generating");
  await until("failed");
  assert.equal((await call(`/api/shops/${shop.id}/theme-proposal/retry`, {})).status, "generating");
  const conflict = await fetch(origin + `/api/shops/${shop.id}/theme-proposal/retry`, { method: "POST", headers: { Origin: origin, Cookie: "gemihub_session=proposal-owner", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(conflict.status, 409);
  await until("ready");
  assert.deepEqual(await call(`/api/shops/${shop.id}/theme-proposal/dismiss`, {}), { status: "none" });
  assert.deepEqual(await proposal(), { status: "none" });
});
