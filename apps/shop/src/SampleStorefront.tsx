import React from "react";
import { hoursText, type ShopConfig } from "../server/domain";
import { getLocale } from "../shared/i18n";

export function SampleStorefront({ config }: { config: ShopConfig }) {
  const english = getLocale() === "en";
  const cafe = /\bcafe\b|café|喫茶|カフェ/i.test(`${config.name} ${config.description}`);
  const products = config.products || [];
  const menu = cafe ? (english ? "Menu" : "メニュー") : (english ? "Products and services" : "商品・サービス");
  const hours = english ? "Opening hours" : "営業時間";
  return <div className="sample-storefront">
    <header className="sample-store-masthead">
      <a href="#shop-introduction">{config.name}</a>
      <nav aria-label={english ? "Shop navigation" : "店内ナビゲーション"}>
        {!!products.length && <a href="#shop-products">{menu}</a>}
        <a href="#shop-hours">{hours}</a>
      </nav>
    </header>
    <section id="shop-introduction" className={`sample-store-hero${cafe ? " sample-store-with-photo" : ""}`} aria-labelledby="sample-store-title">
      <div className="sample-store-intro">
        <p className="sample-store-eyebrow">{cafe ? (english ? "Neighborhood café" : "街のカフェ") : (english ? "Neighborhood shop" : "街のお店")}</p>
        <h1 id="sample-store-title">{config.name}</h1>
        <p className="sample-store-description">{config.description}</p>
        <a className="sample-store-action" href={products.length ? "#shop-products" : "#shop-hours"}>
          {products.length ? (cafe ? (english ? "Explore the menu" : "メニューを見る") : menu) : hours}
        </a>
      </div>
      {cafe && <figure className="sample-store-photo">
        <img src="/media/sample-cafe.webp" alt={english ? "Coffee and toast on a wooden café table" : "木のテーブルに置かれたコーヒーとトースト"} />
        <figcaption>{english ? "Illustrative photo" : "イメージ写真"}</figcaption>
      </figure>}
    </section>
    <div className={`sample-store-details${products.length ? " sample-store-with-menu" : ""}`}>
      {!!products.length && <section id="shop-products" aria-labelledby="sample-store-menu">
        <h2 id="sample-store-menu">{menu}</h2>
        <ul>{products.map(product => <li key={product}>{product}</li>)}</ul>
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
