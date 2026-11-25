import { configuredOrigin } from "./auth.ts";
import type { ShopConfig } from "./domain.ts";
import { accessPasswordEnabled } from "./judge.ts";
import type { Shop } from "./store.ts";

export type ParentListing = "listed" | "skipped" | "failed";

/**
 * Adds a shop that has just become public to the parent town's shop list.
 *
 * Only a town deployment sets PARENT_SHOPS_URL, and it also requires ACCESS_PASSWORD, so every
 * shop there began from the town's invitation. Listing never blocks publication: a failure is
 * logged and the operator can still add the shop from the town administration.
 */
export async function listOnParent(shop: Shop, config: ShopConfig, fetchImpl: typeof fetch = fetch): Promise<ParentListing> {
  const target = process.env.PARENT_SHOPS_URL;
  const secret = process.env.PARENT_INTEGRATION_SECRET || "";
  if (!target || secret.length < 32 || !accessPasswordEnabled() || shop.judge) return "skipped";
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      throw new Error("PARENT_SHOPS_URL must use HTTPS or loopback HTTP");
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ pageUrl: `${configuredOrigin()}/s/${shop.slug}`, name: config.name, industry: config.industry }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await response.body?.cancel();
    return "listed";
  } catch (error) {
    console.error(JSON.stringify({ event: "parent_listing_failed", shopId: shop.id, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
    return "failed";
  }
}
