import { writeFile } from "node:fs/promises";
import { restaurantDemoShops } from "../apps/shop/scripts/seed-restaurant-demo.ts";
import { hoursText } from "../apps/shop/server/domain.ts";
const origin = "https://gemihub-hybrid-2026.web.app";
const rows = restaurantDemoShops("2030-01-01", "en");
const areas = ["Shinjuku, Tokyo", "Shibuya, Tokyo", "Yokohama, Kanagawa"];
const cuisines = ["Japanese robata", "Italian", "Cantonese"];
const shops = rows.map(({ slug, config }, index) => ({ id: slug, name: config.name,
  area: areas[index], cuisine: cuisines[index], description: config.description, address: config.address,
  pageUrl: `${origin}/s/${slug}/`, reservationEnabled: true, reservationUrl: `${origin}/s/${slug}/reserve`,
  networkUrl: `${origin}/s/${slug}/agent/reservation_concierge` }));
const facts = Object.fromEntries(rows.map(({ slug, config }) => [slug, {
  hours: hoursText(config), products: config.menus.filter(menu => menu.active).map(menu => menu.name),
}]));
await writeFile(new URL("../site/shops.json", import.meta.url), JSON.stringify({ version: 1, shops }, null, 2) + "\n");
await writeFile(new URL("../site/shop-public-facts.json", import.meta.url), JSON.stringify(facts, null, 2) + "\n");
