import { adminLocale, adminText as tr, translateAdminMessage } from "./i18n.js";
import { canReserve, hasAgent, reservationPageUrl, shopPageUrl } from "/shop-data.js";
import { mountSiteEditor } from "./site-editor.js";
import { mountChatDocuments } from "./chat-documents-ui.js";

const $ = selector => document.querySelector(selector);
const basePath = document.documentElement.dataset.adminBase || "";
const keys = ["id", "name", "area", "cuisine", "pageUrl", "networkUrl", "description", "address", "reservationUrl"];
const labels = { address: tr("住所（地図用）"), name: tr("店名"), area: tr("エリア"), cuisine: tr("ジャンル"), pageUrl: tr("店舗ページURL"), networkUrl: tr("ネットワークURL"), description: tr("紹介文"), reservationUrl: tr("予約ページURL") };
const statuses = { connected: tr("接続OK"), "needs-review": tr("要確認"), error: tr("エラー") };
let state = { shops: [], cache: {} };
let editingId;
let metadata = {};
let busy = false;
let diffs = [];
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(path, method = "GET", data, headers = {}) {
  const response = await fetch(basePath + path, { method, headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function message(text, error = false) {
  const node = $("#message");
  node.replaceChildren(element("div", text));
  node.className = error ? "error" : "";
  node.hidden = false;
}
function buttons() {
  for (const button of document.querySelectorAll("button")) button.disabled = busy || button.dataset.unavailable === "true";
  for (const input of document.querySelectorAll("input, select, textarea")) input.disabled = busy;
  document.body.setAttribute("aria-busy", String(busy));
}
async function run(operation) {
  if (busy) return;
  busy = true; buttons();
  try { await operation(); }
  catch (error) { message(error.message, true); }
  finally { busy = false; buttons(); }
}
function action(text, handler, { unavailable = false, className = "secondary", title } = {}) {
  const button = element("button", text, className);
  button.type = "button";
  button.dataset.unavailable = String(unavailable);
  if (title) { button.title = title; button.setAttribute("aria-label", title); }
  button.addEventListener("click", () => run(handler));
  return button;
}
function render() {
  $("#shops").replaceChildren();
  $("#empty").hidden = state.shops.length > 0;
  $("#mode").textContent = state.production ? tr("公開用モード · HTTPSのURLだけ登録できます。保存後は公開サイトを再読み込みしてください。") : tr("ローカル用モード · 保存後は公開サイトを再読み込みしてください。公開するフォルダは site/ だけです。");
  state.shops.forEach((shop, index) => {
    const row = element("tr");
    for (const value of [shop.name, shop.area, shop.cuisine, new URL(shop.pageUrl).origin]) row.append(element("td", value));
    const info = state.cache[shop.id] || {};
    const status = element("td");
    const badge = element("span", info.status === "connected" && !hasAgent(shop) ? tr("情報取得済み") : statuses[info.status] || tr("要確認"), `badge ${info.status || ""}`);
    const error = translateAdminMessage(adminLocale(), info.error);
    badge.title = error || (info.fetchedAt ? tr("最終取得: {0}", info.fetchedAt) : tr("まだ店の情報を取得していません"));
    status.append(badge);
    if (error) status.append(element("div", error, "note"));
    row.append(status);
    const operations = element("td", undefined, "actions");
    operations.append(
      action(tr("編集"), () => showEditor(shop)),
      action(tr("再読込"), async () => { showEditor(shop); await resolvePreview(); }),
      action(tr("削除"), async () => {
        if (!confirm(tr("「{0}」を削除しますか？", shop.name))) return;
        state = await api(`/api/shops/${encodeURIComponent(shop.id)}`, "DELETE", undefined, { "If-Match": state.revision });
        if (editingId === shop.id) $("#editor").hidden = true;
        render(); message(state.message);
      }, { className: "danger" }),
      action("↑", () => move(index, -1), { unavailable: index === 0, title: tr("{0}を上へ", shop.name) }),
      action("↓", () => move(index, 1), { unavailable: index === state.shops.length - 1, title: tr("{0}を下へ", shop.name) }),
    );
    row.append(operations); $("#shops").append(row);
  });
  buttons();
}
async function save(shops, cache = {}) {
  state = await api("/api/shops", "PUT", { shops, cache, revision: state.revision });
  render(); message(state.message);
}
async function move(index, direction) {
  const shops = [...state.shops];
  [shops[index], shops[index + direction]] = [shops[index + direction], shops[index]];
  await save(shops);
}
function fields() {
  const shop = Object.fromEntries(keys.map(key => [key, $("#shop-form").elements.namedItem(key).value.trim()]));
  shop.reservationEnabled = $("#shop-form").elements.namedItem("reservationEnabled").checked;
  if (!shop.reservationEnabled) delete shop.reservationUrl;
  return shop;
}
function reservationFields() {
  const enabled = $("#shop-form").elements.namedItem("reservationEnabled").checked;
  $("#reservation-url-field").hidden = !enabled;
  $("#shop-form").elements.namedItem("reservationUrl").required = enabled;
}
function fill(shop) {
  for (const key of keys) $("#shop-form").elements.namedItem(key).value = shop[key] || "";
  $("#shop-form").elements.namedItem("reservationEnabled").checked = !!shop.pageUrl && canReserve(shop);
  reservationFields();
}
function showMetadata() {
  $("#metadata").replaceChildren();
  for (const [key, label] of [["reservationSummary", tr("予約条件")], ["fetchedAt", tr("最終取得")]]) {
    if (!metadata[key]) continue;
    const value = key === "reservationSummary" && adminLocale() === "en" ?
      metadata[key].split("、").map(part => {
        if (part === "席のみ可" || part === "席のみ不可") return tr("席のみ{0}", tr(part.slice(3)));
        return translateAdminMessage("en", part);
      }).join(", ") : metadata[key];
    $("#metadata").append(element("dt", label), element("dd", value));
  }
}
function showEditor(shop) {
  editingId = shop?.id;
  metadata = state.cache[editingId] || {};
  $("#editor-title").textContent = shop ? tr("{0}を編集", shop.name) : tr("店を追加");
  $("#source-url").value = shop ? shopPageUrl(shop) : "";
  $("#resolve").textContent = shop ? tr("店から取り直す") : tr("読み込む");
  $("#shop-form").hidden = !shop;
  $("#choice-form").hidden = $("#differences").hidden = true;
  $("#preview-message").textContent = "";
  fill(shop ? { ...shop, pageUrl: shopPageUrl(shop), reservationUrl: reservationPageUrl(shop), reservationEnabled: canReserve(shop), description: shop.description ?? metadata.description ?? "" } : {});
  $("#shop-form").elements.namedItem("id").readOnly = !!shop;
  showMetadata();
  $("#editor").hidden = false;
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#source-url").focus();
}
async function resolvePreview(networkIndex) {
  if (!editingId) $("#shop-form").hidden = true;
  $("#preview-message").textContent = tr("店の情報を読み込んでいます…");
  $("#choice-form").hidden = $("#differences").hidden = true;
  let preview;
  try { preview = await api("/api/resolve", "POST", { url: $("#source-url").value, id: editingId, networkIndex }); }
  catch (error) {
    $("#preview-message").textContent = error.message;
    state = await api("/api/shops"); render();
    throw error;
  }
  if (preview.choices) {
    $("#network-choice").replaceChildren(...preview.choices.map(choice => {
      const option = element("option", `${choice.name} · ${choice.description || choice.hocon}`);
      option.value = choice.index; return option;
    }));
    $("#choice-form").hidden = false;
    $("#preview-message").textContent = tr("エージェントが複数あります。問い合わせ先を選んでください。");
    return;
  }
  metadata = preview.cache;
  $("#preview-message").textContent = preview.warning || tr("読み込みました。ジャンルなどを確認・編集して保存してください。まだ店舗は保存していません。");
  if (!editingId) fill(preview.shop);
  else {
    const current = fields();
    diffs = Object.entries(labels).filter(([key]) => preview.shop[key] && preview.shop[key] !== current[key]);
    $("#diff-fields").replaceChildren(...diffs.map(([key, label]) => {
      const row = element("label", undefined, "difference");
      const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.value = key;
      checkbox.dataset.value = preview.shop[key];
      row.append(checkbox, element("span", tr("{0}（変更あり）\n現在: {1}\n取得: {2}", label, current[key] || tr("未入力"), preview.shop[key])));
      return row;
    }));
    $("#differences").hidden = !diffs.length;
    if (!diffs.length && !preview.warning) $("#preview-message").textContent = tr("店の情報を取り直しました。変更された項目はありません。保存すると取得日時を記録します。");
  }
  showMetadata(); $("#shop-form").hidden = false;
}

$("#add-shop").addEventListener("click", () => showEditor());
$("#shop-form").elements.namedItem("reservationEnabled").addEventListener("change", reservationFields);
$("#close-editor").addEventListener("click", () => { $("#editor").hidden = true; });
$("#resolve-form").addEventListener("submit", event => { event.preventDefault(); run(() => resolvePreview()); });
$("#choice-form").addEventListener("submit", event => { event.preventDefault(); run(() => resolvePreview(Number($("#network-choice").value))); });
$("#apply-differences").addEventListener("click", () => {
  for (const checkbox of document.querySelectorAll("#diff-fields input:checked")) $("#shop-form").elements.namedItem(checkbox.value).value = checkbox.dataset.value;
  $("#differences").hidden = true;
});
$("#shop-form").addEventListener("submit", event => {
  event.preventDefault();
  run(async () => {
    const shop = fields();
    const shops = editingId ? state.shops.map(item => item.id === editingId ? shop : item) : [...state.shops, shop];
    await save(shops, { [shop.id]: metadata });
    $("#editor").hidden = true;
  });
});
try { sessionStorage.removeItem("gemihub-admin-ai-v1"); } catch { /* Remove obsolete admin-only credentials. */ }
$("#logout").addEventListener("click", () => run(async () => { await api("/api/logout", "POST", {}); location.reload(); }));
$("#invite-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = Object.fromEntries(new FormData(form));
  run(async () => {
    const result = await api("/api/invitations", "POST", input);
    message(result.message); form.reset();
  });
});
run(async () => {
  const session = await api("/api/session");
  $("#operator-status").textContent = session.user?.email || "";
  $("#login-note").textContent = session.setupMessage || tr("店舗の招待・管理には、運営者のGoogleログインが必要です。");
  $("#google-login").hidden = !session.configured;
  $("#operator").hidden = !!session.user;
  $("#account").hidden = $("#registry").hidden = $("#invitations").hidden = !session.user;
  if (session.user) {
    state = await api("/api/shops"); render();
    const { publicUrl, editorAvailable } = await api("/api/site");
    if (editorAvailable !== false) mountSiteEditor({ basePath });
    if (publicUrl) { $("#finder-link").href = publicUrl; $("#finder-link").hidden = false; }
    await mountChatDocuments({ api, run });
  }
});
