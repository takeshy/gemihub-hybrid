import english from "./en.json" with { type: "json" };

export const adminLocale = () => globalThis.document?.documentElement.lang === "en" ? "en" : "ja";

export function translateAdmin(locale, source, ...values) {
  const text = locale === "en" && Object.hasOwn(english, source) ? english[source] : source;
  return text.replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[Number(index)]) : match);
}

export const adminText = (source, ...values) => translateAdmin(adminLocale(), source, ...values);

// Admin modules return a few parameterized validation messages as strings.
const messagePatterns = Object.keys(english).filter(key => key.includes("{0}")).map(key => {
  const pattern = key.split(/\{\d+\}/g).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([\\s\\S]*?)");
  return [key, new RegExp(`^${pattern}$`)];
});

export function translateAdminMessage(locale, source) {
  if (locale !== "en" || typeof source !== "string") return source;
  if (Object.hasOwn(english, source)) return english[source];
  for (const [key, pattern] of messagePatterns) {
    const match = pattern.exec(source);
    if (match) return translateAdmin(locale, key, ...match.slice(1));
  }
  return source;
}
