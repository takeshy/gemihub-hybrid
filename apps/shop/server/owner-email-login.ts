import { randomBytes } from "node:crypto";
import { z } from "zod";
import { digest } from "./auth.ts";
import { asRestaurant, emptyShop, sample, type ShopConfig } from "./domain.ts";
import { isArchivedShop, type Shop, type Store, type User } from "./store.ts";
import type { PlatformMailer } from "./platform-mail.ts";
import { accessPasswordEnabled } from "./judge.ts";
import { tr } from "../shared/i18n.ts";

export const isSalon = (industry: ShopConfig["industry"]) => industry === "nail" || industry === "hair";
const industrySchema = z.enum(["restaurant", "other"]);
const inputSchema = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()), industry: industrySchema.default("other"), name: z.string().trim().min(1).max(100).optional() });
type Challenge = { email: string; origin: string; expires: number; industry: "restaurant" | "other"; name?: string; invitation?: boolean };
const invalid = () => Object.assign(new Error(tr("認証リンクが無効か、有効期限が切れています。メールを送り直してください。")), { status: 400 });
const denied = () => Object.assign(new Error(tr("サロンの運営にはGoogleログインが必要です。")), { status: 403 });
const lifetime = 15 * 60000;
export function ownerEmailLogin(store: Store, send: PlatformMailer, entryPath = "/") {
  const existingShop = async (email: string) => (await store.list<Shop>("shop")).find(shop => shop.owner === email && !isArchivedShop(shop));
  async function check(token: unknown, origin: string) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const key = digest(token), value = await store.get<Challenge>("ownerEmailLogin", key);
    if (!value || value.origin !== origin || value.expires <= Date.now()) throw invalid();
    return { key, value };
  }
  async function limit(key: string, maximum: number, cooldown = 0) {
    await store.locked(`owner-email-limit:${key}`, async () => {
      const now = Date.now(), old = await store.get<{ count: number; last: number; expires: number }>("ownerEmailLimit", key);
      const value = old && old.expires > now ? old : { count: 0, last: 0, expires: now + lifetime };
      if (value.count >= maximum || value.last && now - value.last < cooldown) throw Object.assign(new Error(tr("少し時間をおいてから、もう一度お試しください。")), { status: 429 });
      await store.put("ownerEmailLimit", key, { ...value, count: value.count + 1, last: now });
    });
  }
  return {
    async inviteSalon(raw: unknown, origin: string, ip: string, senderEmail?: string) {
      const input = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()), name: z.string().trim().min(1).max(100), industry: z.enum(["nail", "hair"]) }).parse(raw);
      await limit(`ip:${digest(ip)}`, 20); await limit(`email:${digest(input.email)}`, 3, 60000);
      const key = digest(input.email);
      await store.put("ownerGoogleInvitation", key, { ...input, origin, expires: Date.now() + lifetime });
      try { await send(input.email, tr("お店の管理に招待されました"), tr("サロンの管理に招待されました。次のリンクから、招待されたメールアドレスのGoogleアカウントでログインしてください。\n\n{0}\n\n招待は15分間有効です。", new URL("/auth/google", origin).href), [], [], senderEmail); }
      catch { await store.delete("ownerGoogleInvitation", key); throw Object.assign(new Error(tr("メールを送信できませんでした。しばらくしてからお試しください。")), { status: 503 }); }
      return { ok: true };
    },
    async request(raw: unknown, origin: string, ip: string, invitation = false, senderEmail?: string) {
      const input = inputSchema.parse(raw);
      await limit(`ip:${digest(ip)}`, 20);
      await limit(`email:${digest(input.email)}`, 3, 60000);
      const shop = await existingShop(input.email);
      if (shop && isSalon((shop.published || shop.draft || sample).industry)) throw denied();
      if (!shop && !invitation && accessPasswordEnabled()) throw Object.assign(new Error(tr("新しいお店は運営者からの招待メールから始めてください。")), { status: 403 });
      const token = randomBytes(32).toString("base64url"), key = digest(token);
      const value: Challenge = { ...input, origin, expires: Date.now() + lifetime, ...(invitation ? { invitation: true } : {}) };
      await store.put("ownerEmailLogin", key, value);
      const url = new URL(entryPath, origin); url.hash = new URLSearchParams({ "owner-login": token }).toString();
      try { await send(input.email, invitation ? tr("お店の管理に招待されました") : tr("お店の管理へのログイン"), tr("{0}\n次のリンクを開いて、メールアドレスを確認してください。\n\n{1}\n\nリンクは15分間有効で、1回だけ使えます。心当たりがない場合は、このメールを無視してください。", invitation ? tr("お店の管理に招待されました。") : tr("ログインのリクエストを受け付けました。"), url.href), [], [], senderEmail); }
      catch { await store.delete("ownerEmailLogin", key); throw Object.assign(new Error(tr("メールを送信できませんでした。しばらくしてからお試しください。")), { status: 503 }); }
      return { ok: true };
    },
    async info(raw: unknown, origin: string) {
      const { value } = await check((raw as { token?: unknown })?.token, origin);
      return { email: value.email, invitation: !!value.invitation, industry: value.industry, name: value.name || "" };
    },
    async verify(raw: unknown, origin: string): Promise<User> {
      const { key, value } = await check((raw as { token?: unknown })?.token, origin);
      return store.locked(`owner-email:${value.email}`, async () => {
        let shop = await existingShop(value.email);
        if (shop && isSalon((shop.published || shop.draft || sample).industry)) throw denied();
        if (!shop && !value.invitation && accessPasswordEnabled()) throw Object.assign(new Error(tr("運営者からの招待が必要です。")), { status: 403 });
        const consumed = await store.take<Challenge>("ownerEmailLogin", key);
        if (!consumed || consumed.expires <= Date.now()) throw invalid();
        const existing = await store.get<User>("user", value.email);
        if (!shop) {
          shop = await store.createShop(value.email);
          shop.draft = asRestaurant({ ...emptyShop(value.email), name: value.name || tr("新しいお店"), description: "", address: "", industry: value.industry, ...(value.industry === "restaurant" ? { reservationsEnabled: false } : {}) });
          await store.saveShop(shop);
        }
        const user: User = { ...existing, email: value.email, name: existing?.name || value.name || value.email, role: "owner", shopId: shop.id, authMethod: "owner-email", legacyNotes: false, accessPending: false };
        await store.put("user", value.email, user);
        return user;
      });
    },
  };
}
