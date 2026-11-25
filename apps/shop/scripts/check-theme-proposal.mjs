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
await store.put("themeProposal", shop.id, { shopId: shop.id, status: "ready", themeRunId: "x", request: "r", imageIds: [], config: sample, theme, startedAt: Date.now(), updatedAt: Date.now() });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox"] });
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
