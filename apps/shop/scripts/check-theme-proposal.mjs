// Browser check for the shop's AI design proposal: run with `npx tsx scripts/check-theme-proposal.mjs` after `npm run build`.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createApp } from "../server/app.ts";
import { digest } from "../server/auth.ts";
import { sample } from "../server/domain.ts";
import { Store } from "../server/store.ts";
import { splitThemeStyles } from "../shared/theme-styles.ts";
process.env.NODE_ENV = "production"; process.env.DEMO_MODE = "false";
const out = process.argv[2] || "tmp/theme-proposal";
await mkdir(out, { recursive: true });
const theme = splitThemeStyles({ headerHtml: '<header class="brand"><slot name="title"></slot><slot name="navigation"></slot></header>', bodyHtml: '<main><slot name="content"></slot></main>', footerHtml: '<footer><slot name="content"></slot></footer>', css: ".brand{background:#251334;color:#fff;padding:24px}" });
const store = new Store(":memory:"); const server = createApp(store);
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_ORIGIN = origin;
const shop = await store.createShop("owner@example.com"); shop.published = structuredClone(sample); shop.publication = "provisional"; await store.saveShop(shop);
const user = { email: shop.owner, name: "Owner", role: "owner", shopId: shop.id }; await store.put("user", user.email, user);
const sid = randomUUID(); await store.put("session", digest(sid), { user, expires: Date.now() + 3600000 });
await store.put("themeProposal", shop.id, { shopId: shop.id, status: "generating", themeRunId: "x", request: "r", imageIds: [], config: sample, startedAt: Date.now(), updatedAt: Date.now() });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox"] });
{
  const newShop = await store.createShop("preview-owner@example.com");
  const previewOwner = { email: newShop.owner, name: "Owner", role: "owner", shopId: newShop.id };
  const previewSession = randomUUID();
  await store.put("user", previewOwner.email, previewOwner);
  await store.put("session", digest(previewSession), { user: previewOwner, expires: Date.now() + 3600000 });
  const planId = randomUUID();
  const proposal = { shopId: newShop.id, planId, themeRunId: planId, request: "Create the shop design", imageIds: [], config: sample, startedAt: Date.now(), updatedAt: Date.now() };
  await store.put("plan", planId, { id: planId, shopId: newShop.id, themeRunId: planId, themeProposal: true, config: sample, base: newShop.revision, createdAt: Date.now(), summary: ["Create shop"], approved: false, requiresSetup: true });
  await store.put("themeProposal", newShop.id, { ...proposal, status: "generating" });

  const initialContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" });
  await initialContext.addCookies([{ name: "gemihub_session", value: previewSession, url: origin }]);
  const initialPage = await initialContext.newPage();
  await initialPage.clock.install();
  await initialPage.goto(`${origin}/?lang=en`);
  const review = initialPage.locator(".request-review");
  await review.locator(".screen-name-list").waitFor();
  await review.locator('[data-theme-status="generating"]').waitFor();
  assert.equal(await review.locator(".theme-preview").count(), 0);
  assert.equal(await review.getByRole("button", { name: "Open a private preview with the standard design", exact: true }).isEnabled(), true);
  await store.put("themeProposal", newShop.id, { ...proposal, status: "ready", theme });
  await initialPage.clock.fastForward(3500);
  await review.locator(".theme-preview .brand").waitFor();
  assert.equal(await review.locator(".theme-preview .brand").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(37, 19, 52)");
  await initialPage.screenshot({ path: `${out}/tp-initial-ready-390.png`, fullPage: true });
  await initialPage.reload();
  await review.locator(".theme-preview .brand").waitFor();
  await review.getByRole("button", { name: "Publish private preview", exact: true }).click();
  await initialPage.locator(".publication-status").waitFor();
  assert.deepEqual((await store.shop(newShop.id)).published.appearance.theme, theme);
  assert.equal((await store.get("themeProposal", newShop.id)).status, "applied");
  await initialContext.close();
  console.log("en 390px: the initial review updates to the AI design, survives reload and publishes the displayed theme.");
}
// While the design is being made, public publication cannot start from either screen.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "gemihub_session", value: sid, url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}/?lang=en`);
  await page.locator(".theme-proposal-notice[data-status=generating]").waitFor();
  assert.equal(await page.getByRole("button", { name: /Review screens and publish/ }).isDisabled(), true);
  assert.equal(await page.locator("[data-publication-preview-link]").count(), 0);
  await page.goto(`${origin}/publication-preview/${shop.id}?lang=en`);
  const publish = page.getByRole("button", { name: "Publish publicly", exact: true });
  await publish.waitFor();
  await page.getByText(/AI is creating your shop's own design/).waitFor();
  assert.equal(await publish.isDisabled(), true);
  await page.screenshot({ path: `${out}/tp-generating-preview-390.png`, fullPage: true });
  await context.close();
  console.log("en 390px: publication waits while the design is being made.");
}
await store.put("themeProposal", shop.id, { shopId: shop.id, status: "ready", themeRunId: "x", request: "r", imageIds: [], config: sample, theme, startedAt: Date.now(), updatedAt: Date.now() });
try {
  for (const [width, language] of [[1280, "ja"], [390, "en"]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language === "ja" ? "ja-JP" : "en-US" });
    await context.addCookies([{ name: "gemihub_session", value: sid, url: origin }]);
    const page = await context.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/?lang=${language}`);
    const notice = page.locator(".theme-proposal-notice"); await notice.waitFor();
    await page.screenshot({ path: `${out}/tp-notice-${width}.png` });
    await notice.getByRole("button", { name: language === "ja" ? "デザインを確認する" : "Review the design", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.locator(".brand").waitFor();
    await page.screenshot({ path: `${out}/tp-review-${width}.png` });
    if (width === 1280) { await dialog.getByRole("button", { name: "あとで決める", exact: true }).click(); assert.equal(await dialog.count(), 0); console.log(`${language} ${width}px: ready notice, comparison dialog and decide later passed.`); continue; }
    await dialog.getByRole("button", { name: "Use this design", exact: true }).click();
    await notice.waitFor({ state: "detached" });
    const live = await store.shop(shop.id);
    assert.ok(JSON.stringify(live.published).includes("#251334") || JSON.stringify(live).includes("251334"), "theme applied");
    assert.equal((await store.get("themeProposal", shop.id)).status, "applied");
    assert.deepEqual(errors, []);
    console.log(`${language} ${width}px: ready notice, comparison dialog and applying only the theme passed.`);
  }
} finally { await browser.close(); server.close(); await store.close(); }
