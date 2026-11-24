import { adminText as tr } from "./i18n.js";
export async function mountChatDocuments({ api, run }) {
  const $ = id => document.getElementById(id);
  const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
  let state = await api("/api/chat-documents");
  if (state.pdfImportAvailable === false) {
    $("document-file").accept = ".txt,.md,.markdown,.csv,.json";
    $("document-import-help").textContent = tr("UTF-8のテキスト・Markdown・CSV・JSON、1ファイル5MB・本文10万文字まで。公開前に内容を確認・修正できます。");
  }
  // Saves send the revision of the latest list this page has seen. This page's own unpublish or delete
  // updates it, so they do not block the open draft; a change from another tab still returns 409.
  let editingId, editingBase, pendingPdf;
  const status = text => { $("documents-status").textContent = text; };
  function edit(doc) {
    pendingPdf = undefined;
    editingId = doc.id; editingBase = { name: doc.name, text: doc.text };
    $("document-name").value = doc.name;
    $("document-text").value = doc.text;
    $("document-pdf-note").hidden = !doc.hasPdf;
    $("document-preview").hidden = false;
    $("document-preview").querySelector('button[value="draft"]').textContent = doc.published ? tr("公開をやめて下書き保存") : tr("下書きを保存");
    status(doc.published ? tr("公開中の資料です。本文を変更したら「公開する」で反映します。") : tr("本文を確認・修正してから公開してください。まだチャットには使われません。"));
  }
  function button(label, operation) {
    const element = node("button", label); element.type = "button"; element.className = "secondary";
    element.addEventListener("click", () => run(async () => {
      try { await operation(); } catch (error) { status(error.message); }
    }));
    return element;
  }
  function render() {
    $("documents-list").replaceChildren();
    $("documents-empty").hidden = state.documents.length > 0;
    for (const doc of state.documents) {
      const item = node("li"); item.className = "document-item";
      const details = node("div");
      details.append(node("strong", doc.name), node("p", tr("{0} · {1}文字{2}", doc.published ? tr("公開中") : tr("下書き"), doc.text.length.toLocaleString(), doc.hasPdf ? tr(" · PDFあり") : "")));
      const actions = node("div"); actions.className = "document-actions";
      actions.append(button(tr("本文を確認"), () => edit(doc)));
      if (doc.published) actions.append(button(tr("公開をやめる"), async () => {
        state = await api("/api/chat-documents", "PUT", { id: doc.id, name: doc.name, text: doc.text, published: false, revision: state.revision });
        render(); status(tr("公開をやめました。今後の検索には使われません。すでに表示された回答には残ります。"));
      }));
      actions.append(button(tr("削除"), async () => {
        if (!confirm(tr("「{0}」を削除しますか？", doc.name))) return;
        state = await api(`/api/chat-documents/${doc.id}`, "DELETE", undefined, { "If-Match": state.revision });
        if (editingId === doc.id) { editingId = undefined; $("document-preview").hidden = true; }
        render(); status(tr("削除しました。すでに表示された回答には残ります。"));
      }));
      item.append(details, actions); $("documents-list").append(item);
    }
  }
  $("documents-refresh").addEventListener("click", () => run(async () => {
    try { state = await api("/api/chat-documents"); render(); status(tr("一覧を読み直しました。")); } catch (error) { status(error.message); }
  }));
  $("document-upload").addEventListener("submit", event => {
    event.preventDefault();
    const file = $("document-file").files[0];
    if (!file) return;
    run(async () => {
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error(tr("資料は1ファイル5MB以内にしてください。"));
        status(tr("資料の本文を読み込んでいます…"));
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error(tr("ファイルを読み込めませんでした。"))); reader.readAsDataURL(file);
        });
        const doc = await api("/api/chat-documents/import", "POST", { name: file.name, data });
        const isPdf = /\.pdf$/i.test(file.name);
        edit({ ...doc, hasPdf: isPdf });
        if (isPdf) pendingPdf = data;
      } catch (error) { status(error.message); }
    });
  });
  $("document-preview").addEventListener("submit", event => {
    event.preventDefault();
    const published = event.submitter?.value === "publish";
    run(async () => {
      try {
        // The list may have been reloaded after another tab changed this document: do not overwrite it.
        const current = state.documents.find(doc => doc.id === editingId);
        if (editingId && (!current || current.name !== editingBase.name || current.text !== editingBase.text)) throw new Error(tr("この資料は別の画面で変更または削除されました。「一覧を読み直す」から開き直してください。"));
        state = await api("/api/chat-documents", "PUT", { id: editingId, name: $("document-name").value, text: $("document-text").value, published, revision: state.revision, pdf: pendingPdf });
        $("document-preview").hidden = true; $("document-file").value = ""; editingId = undefined; pendingPdf = undefined;
        render(); status(published ? tr("公開しました。チャットで資料をもとに回答できます。") : tr("下書きを保存しました。チャットには使われません。"));
      } catch (error) { status(error.message); }
    });
  });
  $("document-cancel").addEventListener("click", () => { $("document-preview").hidden = true; editingId = undefined; pendingPdf = undefined; status(tr("編集を閉じました。")); });
  render(); $("chat-documents").hidden = false;
}
