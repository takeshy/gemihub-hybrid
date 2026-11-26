import { configuredOrigin } from "./auth.ts";
import type { ShopConfig } from "./domain.ts";
import { accessPasswordEnabled } from "./judge.ts";
import type { Shop } from "./store.ts";

export type ParentListing = "listed" | "removed" | "skipped" | "failed";

/**
 * Only a town deployment sets PARENT_SHOPS_URL, and it also requires ACCESS_PASSWORD, so every
 * shop there began from the town's invitation. Changes to the town's list never block the shop's
 * own operation: a failure is logged and the operator can still edit the list by hand.
 */
async function updateParent(shop: Shop, action: "list" | "remove", body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<ParentListing> {
  const target = process.env.PARENT_SHOPS_URL;
  const secret = process.env.PARENT_INTEGRATION_SECRET || "";
  if (!target || secret.length < 32 || !accessPasswordEnabled() || shop.judge) return "skipped";
  try {
    const url = new URL(action === "remove" ? `${target.replace(/\/$/, "")}/remove` : target);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      throw new Error("PARENT_SHOPS_URL must use HTTPS or loopback HTTP");
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ pageUrl: `${configuredOrigin()}/s/${shop.slug}`, ...body }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await response.body?.cancel();
    return action === "remove" ? "removed" : "listed";
  } catch (error) {
    console.error(JSON.stringify({ event: action === "remove" ? "parent_removal_failed" : "parent_listing_failed", shopId: shop.id, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
    return "failed";
  }
}

/** Adds a shop that has just become public to the parent town's shop list. */
export function listOnParent(shop: Shop, config: ShopConfig, fetchImpl: typeof fetch = fetch) {
  return updateParent(shop, "list", { name: config.name, industry: config.industry }, fetchImpl);
}

/** Removes a closed shop (for example, one the owner started over) from the parent town's shop list. */
export function removeFromParent(shop: Shop, fetchImpl: typeof fetch = fetch) {
  return updateParent(shop, "remove", {}, fetchImpl);
}
