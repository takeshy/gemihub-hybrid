// Run against the local fictional-shop demo. Chrome's LanguageModel is
// simulated; no request leaves loopback and no real reservation is made.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = new URL(process.env.FINDER_URL || "http://localhost:8088");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname), "Use the local demo");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const [path, initial] of [["/", "available"], ["/s/akari/", "downloadable"], ["/", "unsupported"]]) {
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === base.origin
      ? route.continue() : route.abort());
    await page.addInitScript(state => {
      window.deviceLoadStarts = 0;
      window.LanguageModel = state === "unsupported" ? undefined : {
        async availability() { return state; },
        create({ monitor } = {}) {
          window.deviceLoadStarts++;
          if (window.deviceLoadStarts > 1) return Promise.resolve({
            prompt: async () => "We open at 17:00.",
            promptStreaming: () => new ReadableStream({ start(controller) {
              controller.enqueue("We open at 17:00."); controller.close();
            } }),
            destroy() {},
          });
          return new Promise(resolve => {
            window.finishDeviceLoad = () => { state = "available"; resolve({ destroy() {} }); };
            monitor?.({ addEventListener(_type, report) { report({ loaded: 0.4, total: 1 }); } });
          });
        },
      };
    }, initial);

    await page.goto(new URL(path, base).href);
    const input = page.locator("#ns-input");
    const send = page.locator("#ns-send");
    const chip = page.locator(".hybrid-chip[data-kind=local]");
    if (path !== "/" && !(await input.isVisible())) {
      const open = page.locator("#assistant-toggle");
      await open.click();
    }
    await page.waitForFunction(() => document.querySelector("#ns-send")?.disabled === true);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await chip.isDisabled(), true);
    const status = page.locator(".hybrid-device-gate");
    assert.ok(await status.isVisible());
    const settings = page.locator("#ai-settings-open");
    if (initial === "unsupported") {
      assert.match(await status.textContent(), /not available/);
      await page.close();
      continue;
    }
    if (initial === "downloadable") {
      assert.equal(await page.evaluate(() => window.deviceLoadStarts), 0);
      await settings.click();
      await page.locator(".hybrid-controls button").click();
    }
    await page.waitForFunction(() => typeof window.finishDeviceLoad === "function");
    assert.match(await status.textContent(), /40%/);
    // Even a synthetic keyboard event cannot enter the shared runtime.
    await input.evaluate(el => {
      el.value = "Early message";
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(await page.locator("#ns-msgs .ns-msg.user").count(), 0);
    await page.evaluate(() => window.finishDeviceLoad());
    await page.waitForFunction(() => document.querySelector("#ns-send")?.disabled === false);
    assert.equal(await chip.isDisabled(), false);
    assert.equal(await status.isVisible(), false);
    assert.match(await settings.textContent(), /On-device AI ready/);
    if (initial === "downloadable") await page.locator("#ai-setup-close").click();
    await chip.click();
    await page.locator("#ns-msgs .ns-msg.user").waitFor();
    await page.close();
  }
} finally { await browser.close(); }
console.log("Local-model gate: town warm-up, storefront setup click, unsupported browser, and early-send rejection passed.");
