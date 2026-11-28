import { writeFile } from "node:fs/promises";
import { restaurantDemoShops } from "../apps/shop/scripts/seed-restaurant-demo.ts";
import { hoursText } from "../apps/shop/server/domain.ts";
import { currencyOf, regionOf } from "../apps/shop/shared/region.ts";
import { address, area } from "./hybrid-neighborhood.mjs";
const origin = "https://gemihub-hybrid-2026.web.app";
const rows = restaurantDemoShops("2030-01-01", "en", address);
const cuisines = ["Japanese robata", "Italian", "Cantonese"];
const shops = rows.map(({ slug, config }, index) => ({ id: slug, name: config.name,
  area, cuisine: cuisines[index], industry: config.industry, description: config.description, address: config.address,
  pageUrl: `${origin}/s/${slug}/`, reservationEnabled: true, reservationUrl: `${origin}/s/${slug}/reserve`,
  networkUrl: `${origin}/s/${slug}/agent/reservation_concierge` }));
const facts = Object.fromEntries(rows.map(({ slug, config }) => [slug, {
  sourcePageUrl: `${origin}/s/${slug}/`, hours: hoursText(config),
  products: config.menus.filter(menu => menu.active).map(menu => menu.name),
  // List prices for the town MCP's JSON-LD only; the on-device prompt reads names from products.
  menu: config.menus.filter(menu => menu.active).map(menu => ({ name: menu.name, type: "MenuItem", price: menu.price, currency: currencyOf(regionOf(config)) })),
}]));
await writeFile(new URL("../site/shops.json", import.meta.url), JSON.stringify({ version: 1, shops }, null, 2) + "\n");
await writeFile(new URL("../site/shop-public-facts.json", import.meta.url), JSON.stringify(facts, null, 2) + "\n");
