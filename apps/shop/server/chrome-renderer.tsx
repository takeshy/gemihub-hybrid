import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader, SiteFooter } from "../src/SiteChrome.tsx";
import type { ShopConfig } from "./domain.ts";
import { navigationItems } from "../shared/navigation.ts";
import { ThemePreview } from "../src/ThemePreview.tsx";
import type { VisualPreviewData } from "../shared/visual-review.ts";
import { requestLocale } from "./i18n.ts";
export function renderChrome(config: ShopConfig, part: "header" | "footer", resolvedImages?: Record<string, string>) {
  return renderToStaticMarkup(part === "header" ? <SiteHeader config={config} resolvedImages={resolvedImages}><nav className="public-nav">{navigationItems(config).map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav></SiteHeader> : <SiteFooter config={config} resolvedImages={resolvedImages} />);
}

// The first theme preview is inert. Chromium only needs its markup and the built preview CSS.
export function renderInitialThemeDocument(input: VisualPreviewData, stylesheets: string[]) {
  const images = Object.fromEntries(Object.entries(input.images).map(([id, image]) => [id, `data:${image.mimeType};base64,${image.data}`]));
  return "<!doctype html>" + requestLocale.run(input.locale, () => renderToStaticMarkup(
    <html lang={input.locale}><head>
      <meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
      {stylesheets.map(href => <link key={href} rel="stylesheet" href={href} />)}
    </head><body><div id="root"><div id="visual-review-surface">
      <ThemePreview config={input.config} shopId="visual-review" resolvedImages={images} />
    </div></div></body></html>
  ));
}
