import { parse, serialize } from "parse5";
import { translateAdmin } from "./i18n.js";

export function localizeAdminHtml(html, locale) {
  if (locale !== "en") return html;
  const document = parse(html);
  function visit(node) {
    if (node.tagName === "script" || node.tagName === "style") return;
    if (node.nodeName === "#text") {
      const source = node.value.trim();
      if (source) node.value = node.value.replace(source, () => translateAdmin(locale, source));
    }
    for (const attribute of node.attrs || []) {
      if (node.tagName === "html" && attribute.name === "lang") attribute.value = locale;
      if (["placeholder", "aria-label", "title"].includes(attribute.name))
        attribute.value = translateAdmin(locale, attribute.value);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  return serialize(document);
}
