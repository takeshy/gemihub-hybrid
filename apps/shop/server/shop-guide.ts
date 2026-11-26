import { z } from "zod";
import { hoursText, publishedProducts, shopDate, specialDaysText, type ShopConfig } from "./domain.ts";
import { regionOf } from "../shared/region.ts";

export const shopGuideNetwork = "shop_guide";
export const shopGuideFront = "shop_front";
export const shopGuideQueries = () => ["営業時間とお休みを教えてください", "どんな品を扱っていますか？", "お店への行き方を教えてください"];
export const shopGuideTool = {
  name: "get_shop_info",
  title: "Opening hours and products",
  description: "This shop's published name, introduction, address, opening hours, closed days and products or services. Products come from its published products list and active menu; the introduction may describe other goods. This does not report stock or accept orders, payments or reservations. Read-only.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
} as const;

/** Only published customer-facing facts; never staff, contacts, drafts or bookings. */
export function shopGuideInfo(config: ShopConfig, pageUrl: string, args: unknown = {}, now = new Date()) {
  z.object({}).strict().parse(args);
  const catalog = publishedProducts(config);
  return {
    shop: config.name,
    description: config.description,
    address: config.address,
    timeZone: regionOf(config).timeZone,
    hours: {
      regular: hoursText(config),
      closedWeekdays: config.hours.closedWeekdays,
      weekdayHours: config.hours.weekdayHours || [],
      closedDates: config.hours.holidays.filter(date => date >= shopDate(config, now)).sort().slice(0, 30),
      specialDays: specialDaysText({ ...config, staff: [] }),
    },
    products: [...new Set([...(config.products || []), ...config.menus.filter(menu => menu.active).map(menu => menu.name), ...catalog.map(product => product.name)])],
    catalog,
    stock: "unknown",
    pageUrl,
    checkedAt: now.toISOString(),
  };
}
