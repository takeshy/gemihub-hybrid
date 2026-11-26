import React from "react";
import { tr } from "../shared/i18n";
import type { Booking, ShopConfig } from "../server/domain";
import { ChromePreview, ThemeBody } from "./SiteChrome";
import { hasThemeFrame } from "../shared/theme-editing";
import { PaymentDetails } from "./PaymentDetails";
import { defaultRefundTiers } from "../server/payment-domain";
import { currencyOf, regionOf, toMinor } from "../shared/region";

function ThemeSamples({ config }: { config: ShopConfig }) {
  // A fixed sample: a new shop has no menus yet, and review screenshots must not change between renders.
  const currency = currencyOf(regionOf(config));
  const price = config.menus[0]?.price || (currency === "JPY" ? 5500 : 55);
  const amount = toMinor(price, currency);
  const at = "2030-01-10T01:00:00.000Z";
  const booking: Booking = { id: "sample-palette", shopId: "sample", customer: "sample@example.com", name: tr("サンプルのお客様"), menuId: config.menus[0]?.id || "sample", staffId: "sample", start: "2030-01-15T01:00:00.000Z", end: "2030-01-15T02:00:00.000Z", price, status: "cancelled", message: "", createdAt: at, payment: { provider: "paypal", environment: "sandbox", amount, currency, orderId: "sample", captureId: "sample", policy: structuredClone(defaultRefundTiers), cancellation: { status: "completed", amount, percent: 100, at, by: "sample@example.com", reason: "customer", requestId: "sample" } } };
  return <div className="theme-placeholder">
    <strong>{tr("Dummy（仮の内容）")}</strong>
    <p>{tr("各画面で使う部品の見本です。色・文字・ボタン・入力欄・カードをまとめて確認できます。")}</p>
    <section className="panel theme-sample-card">
      <h2>{tr("見出しの見本")}</h2><p>{tr("本文の見本です。お店の紹介やご案内がここに入ります。")}</p>
      <div className="theme-sample-fields">
        <label className="field">{tr("お名前")}<input readOnly value={tr("サンプルのお客様")} /></label>
        <label className="field">{tr("メニュー")}<select defaultValue="sample"><option value="sample">{tr("サンプルメニュー")}</option></select></label>
        <label className="field">{tr("メッセージ")}<textarea readOnly rows={2} value={tr("メッセージの見本です。")} /></label>
      </div>
      <div className="actions"><button type="button" className="primary">{tr("予約する")}</button><button type="button">{tr("戻る")}</button><button type="button" className="selected">{tr("選択中")}</button><a>{tr("詳しく見る")}</a><svg className="icon" role="img" aria-label={tr("アイコン")} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg></div>
      <div className="actions"><button type="button" className="primary" disabled>{tr("この内容で予約する")} →</button></div>
      <p className="notice">{tr("ご案内の見本です。実際の予約や送信は行いません。")}</p>
      <div className="menu-options"><button type="button" className="selected"><span>{tr("サンプルメニュー")}<small>60{tr("分")}</small></span><strong><span aria-hidden="true">●</span></strong></button></div>
      <aside className="booking-summary"><span className="line-flower" aria-hidden="true">✳︎</span><p>{tr("サンプルメニュー")}</p></aside>
      <details className="waitlist-request"><summary>{tr("希望の時間が空いたら知らせる")}</summary><p>{tr("ご案内の見本です。実際の予約や送信は行いません。")}</p></details>
      <div className="actions"><button type="button" className="secondary">{tr("戻る")}</button><span className="status active">{tr("予約確定")}</span><span className="status cancelled">{tr("キャンセル済み")}</span></div>
      <div className="recent-post-list"><a><span className="pill">{tr("お知らせ")}</span><strong>{tr("お店からのお便り（サンプル）")}</strong></a></div>
      <PaymentDetails booking={booking} />
    </section>
  </div>;
}

/** A complete frame containing inert samples of the real screens' UI elements. */
export function ThemePreview({ config, shopId, themeRef, resolvedImages }: { config: ShopConfig; shopId: string; resolvedImages?: Record<string, string>; themeRef?: React.RefObject<HTMLDivElement | null> }) {
  const accent = config.appearance?.accent || "sage";
  const layout = config.appearance?.layout || "standard";
  return <div className="theme-preview" ref={themeRef} inert aria-label={tr("ページ全体の見本")}>
      <ChromePreview config={config} part="header" imageBase={`/api/shops/${shopId}/menu-images`} resolvedImages={resolvedImages} />
      <div className={`public-shop accent-${accent} layout-${layout}${hasThemeFrame(config.appearance?.theme)?" custom-theme":""}`}>
        <ThemeBody config={config} imageBase={`/api/shops/${shopId}/menu-images`} resolvedImages={resolvedImages}><ThemeSamples config={config} /></ThemeBody>
      </div>
      <ChromePreview config={config} part="footer" imageBase={`/api/shops/${shopId}/menu-images`} resolvedImages={resolvedImages} />
    </div>;
}
