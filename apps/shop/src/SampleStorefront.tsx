import React from "react";
import { publishedProducts, hoursText, type ShopConfig } from "../server/domain";
import { getLocale, intlLocale } from "../shared/i18n";
import { currencyOf, formatMoney, regionOf } from "../shared/region";

export type SampleOffering = { key: string; name: string; type: "MenuItem" | "Product"; price?: number; currency?: string };

/** What the sample home page lists, in order; the storefront's JSON-LD repeats exactly this. */
export function sampleOfferings(config: ShopConfig, robata = false): SampleOffering[] {
  const currency = currencyOf(regionOf(config));
  const products = publishedProducts(config);
  const items: SampleOffering[] = robata
    ? config.menus.filter(item => item.active).map(item => ({ key: `menu:${item.id}`, name: item.name, type: "MenuItem", price: item.price, currency }))
    : (config.products || []).filter(name => !products.some(product => product.name === name)).map(name => ({ key: `legacy-${name}`, name, type: "Product" }));
  return [...items, ...products.map(item => ({ key: `product:${item.id}`, name: item.name, type: "Product" as const, price: item.price, currency: item.currency }))];
}

export function SampleStorefront({ config, robata = false, bookingHref }: { config: ShopConfig; robata?: boolean; bookingHref?: string }) {
  const english = getLocale() === "en";
  const cafe = !robata && /\bcafe\b|café|喫茶|カフェ/i.test(`${config.name} ${config.description}`);
  const offerings = sampleOfferings(config, robata).map(item => ({ ...item,
    price: item.price === undefined ? undefined : formatMoney(item.price, item.currency as Parameters<typeof formatMoney>[1], intlLocale()) }));
  const menu = cafe || robata ? (english ? "Menu" : "メニュー") : (english ? "Products and services" : "商品・サービス");
  const hours = english ? "Opening hours" : "営業時間";
  const book = english ? "Book a table" : "席を予約";
  const category = robata ? (english ? "Japanese charcoal grill" : "炭火の炉端焼き") : cafe ? (english ? "Neighborhood café" : "街のカフェ") : (english ? "Neighborhood shop" : "街のお店");
  const photo = robata
    ? { src: "/media/robata-akari.webp", alt: english ? "Grilled fish and skewers served by a warm charcoal hearth" : "炭火の炉端と焼き魚、串焼き" }
    : cafe ? { src: "/media/sample-cafe.webp", alt: english ? "Coffee and toast on a wooden café table" : "木のテーブルに置かれたコーヒーとトースト" } : undefined;
  const action = offerings.length ? (cafe ? (english ? "Explore the menu" : "メニューを見る") : menu) : hours;
  return <div className={`sample-storefront${robata ? " sample-store-robata" : ""}`}>
    <header className="sample-store-masthead">
      <a href="#shop-introduction">{config.name}</a>
      <nav aria-label={english ? "Shop navigation" : "店内ナビゲーション"}>
        {!!offerings.length && <a href="#shop-products">{menu}</a>}
        <a href="#shop-hours">{hours}</a>
        {bookingHref && <a href={bookingHref}>{book}</a>}
      </nav>
    </header>
    <section id="shop-introduction" className={`sample-store-hero${photo ? " sample-store-with-photo" : ""}`} aria-labelledby="sample-store-title">
      <div className="sample-store-intro">
        <p className="sample-store-eyebrow">{category}</p>
        <h1 id="sample-store-title">{config.name}</h1>
        <p className="sample-store-description">{config.description}</p>
        <a className="sample-store-action" href={bookingHref || (offerings.length ? "#shop-products" : "#shop-hours")}>
          {bookingHref ? book : action}
        </a>
      </div>
      {photo && <figure className="sample-store-photo">
        <img src={photo.src} alt={photo.alt} />
        <figcaption>{english ? "Illustrative photo" : "イメージ写真"}</figcaption>
      </figure>}
    </section>
    <div className={`sample-store-details${offerings.length ? " sample-store-with-menu" : ""}`}>
      {!!offerings.length && <section id="shop-products" aria-labelledby="sample-store-menu">
        <h2 id="sample-store-menu">{menu}</h2>
        <ul>{offerings.map(item => <li key={item.key}>{item.name}{item.price && <small>{item.price}</small>}</li>)}</ul>
      </section>}
      <section id="shop-hours" aria-labelledby="sample-store-hours">
        <h2 id="sample-store-hours">{hours}</h2>
        <p>{hoursText(config)}</p>
      </section>
    </div>
    <footer className="sample-store-footer">
      <span>© {config.name}</span>
      <span>{english ? "Fictional sample shop" : "架空のサンプル店舗"}</span>
    </footer>
  </div>;
}
