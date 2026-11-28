import { parseExternalAgent } from "../site/runtime/kernel.js";
import { safeName } from "../site/runtime/runner.js";

export const SHOP_FIELDS = ["id", "name", "area", "cuisine", "industry", "pageUrl", "networkUrl", "description", "address", "reservationEnabled", "reservationUrl"];

export function validateShops(config, { production = false } = {}) {
  if (config?.version !== 1 || !Array.isArray(config.shops)) throw new Error("shops.json: version:1 と shops の配列が必要です。");
  const ids = new Set();
  const tools = new Set(["condition_checker", "finder_front", "render_cruse"]);
  return config.shops.map(shop => {
    for (const key of ["id", "name", "area", "cuisine", "pageUrl"]) {
      if (typeof shop[key] !== "string" || !shop[key].trim()) throw new Error(`shops.json: ${key} が必要です。`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(shop.id) || ids.has(shop.id)) throw new Error(`shops.json: 不正または重複したid ${shop.id}`);
    ids.add(shop.id);
    if (shop.address !== undefined && (typeof shop.address !== "string" || shop.address.length > 500)) throw new Error("shops.json: 住所は500文字以内にしてください。");
    if (shop.industry !== undefined && !["restaurant", "hair", "nail", "other"].includes(shop.industry)) throw new Error("shops.json: 業種が不正です。");
    if (shop.networkUrl !== undefined && typeof shop.networkUrl !== "string") throw new Error("shops.json: networkUrl は文字列にしてください。");
    if (shop.description !== undefined && (typeof shop.description !== "string" || shop.description.length > 2000)) throw new Error("shops.json: 紹介文は2000文字以内にしてください。");
    if (shop.reservationEnabled !== undefined && typeof shop.reservationEnabled !== "boolean") throw new Error("shops.json: 予約対応は真偽値にしてください。");
    if (shop.reservationUrl !== undefined && typeof shop.reservationUrl !== "string") throw new Error("shops.json: reservationUrl は文字列にしてください。");
    if (shop.reservationEnabled === true && !shop.reservationUrl) throw new Error("shops.json: 予約対応の店には予約ページURLが必要です。");
    const values = [["pageUrl", shop.pageUrl], ...(shop.networkUrl ? [["networkUrl", shop.networkUrl]] : []), ...(shop.reservationUrl ? [["reservationUrl", shop.reservationUrl]] : [])];
    const urls = values.map(([key, value]) => {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (production && local)) throw new Error(`公開URLはHTTPS、HTTPはループバックのみ: ${value}`);
      if (url.username || url.password || url.search && key !== "reservationUrl" || url.hash) throw new Error("登録URLに認証情報・フラグメントは使用できません。クエリは予約ページURLだけに使えます。");
      if (url.href !== value || (key === "networkUrl" && (!url.pathname.split("/").at(-1) || /[%\s]/.test(url.pathname)))) throw new Error(`正規化したページ/ネットワークURLを指定してください: ${value}`);
      return url;
    });
    if (urls.some(url => url.origin !== urls[0].origin)) throw new Error("店ページ・予約ページ・ネットワークは同じオリジンにしてください。");
    const result = Object.fromEntries(SHOP_FIELDS.filter(key => Object.hasOwn(shop, key)).map(key => [key, shop[key]]));
    if (shop.networkUrl) {
      const tool = safeName(parseExternalAgent(shop.networkUrl, urls[0].origin).agentName);
      if (tools.has(tool) || tool.startsWith("website_")) throw new Error(`ネットワークのツール名が衝突します: ${tool}`);
      tools.add(tool);
      result.networkTool = tool;
    }
    return result;
  });
}
