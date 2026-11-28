// Types for schema-org.js, which the shop server imports for storefront JSON-LD.
export type ShopFacts = {
  id?: string; name?: string; description?: string; cuisine?: string; industry?: string;
  address?: string; area?: string; pageUrl?: string; reservationUrl?: string; reservationEnabled?: boolean;
  hours?: string | { regular?: string; closedWeekdays?: (number | string)[]; weekdayHours?: { day: number; start: string; end: string }[]; closedDates?: string[]; specialDays?: string | { date: string; start: string; end: string }[] };
  products?: (string | { name?: string; type?: "MenuItem" | "Product" | "Service" })[];
};
export function parseHoursText(value: unknown): { start: string; end: string; weekdayHours: { day: number; start: string; end: string }[] } | null;
export function openingHoursSpecification(hours: ShopFacts["hours"]): { weekly: Record<string, unknown>[]; exceptions: Record<string, unknown>[]; parsed: boolean };
export function shopJsonLd(facts: ShopFacts, options?: { context?: boolean; industry?: string }): Record<string, unknown> | null;
export function jsonLdScript(value: unknown): string;
