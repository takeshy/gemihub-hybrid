const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const pdfFile = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.pdf$/;
const pdfBase = new URL("./chat-document-files/", import.meta.url);
function terms(query) {
  const words = normalize(query).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9]+/gu) || [];
  return [...new Set(words.flatMap(word => /^[a-z0-9]+$/.test(word) || word.length < 2 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))))].slice(0, 200);
}

export function searchDocuments(documents, query, limit = 5) {
  if (typeof query !== "string" || !query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("調べたい内容を500文字以内で指定してください。");
  const keywords = terms(query);
  const exact = normalize(query);
  const matches = [];
  for (const document of documents) {
    const title = normalize(document.name);
    for (let start = 0, part = 1; start < document.text.length; start += 1200, part++) {
      const content = document.text.slice(start, start + 1500);
      const haystack = normalize(content);
      const score = keywords.reduce((sum, word) => sum + (title.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0) + (haystack.includes(exact) ? 10 : 0);
      if (score) {
        const filename = document.id + ".pdf";
        const pdfUrl = document.hasPdf === true && pdfFile.test(filename) ? new URL(filename, pdfBase).href : undefined;
        matches.push({ score, sourceId: document.id, source: document.name, updatedAt: document.updatedAt, part, text: content, ...(pdfUrl && { pdfUrl }) });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.part - b.part);
  return { results: matches.slice(0, limit).map(({ score, ...match }) => match), hasMore: matches.length > limit, documentCount: documents.length };
}

export function mountDocumentPreview(messages) {
  messages.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest(".ns-msg.bot a[href]");
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin !== pdfBase.origin || !url.pathname.startsWith(pdfBase.pathname) || !pdfFile.test(url.pathname.slice(pdfBase.pathname.length)) || url.search || url.hash) return;
    event.preventDefault();

    const dialog = document.createElement("dialog");
    dialog.className = "document-pdf-preview";
    dialog.setAttribute("aria-labelledby", "document-pdf-title");
    const toolbar = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "document-pdf-title";
    title.textContent = "Local guide (PDF)";
    const newTab = document.createElement("a");
    newTab.href = url.href;
    newTab.target = "_blank";
    newTab.rel = "noopener noreferrer";
    newTab.textContent = "Open in a new tab";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    const frame = document.createElement("iframe");
    frame.title = title.textContent;
    frame.src = url.href;
    toolbar.append(title, newTab, close);
    dialog.append(toolbar, frame);
    dialog.addEventListener("close", () => { dialog.remove(); link.focus(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  });
}

export async function searchChatDocuments(args, { fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    // Always revalidate (an operator may have removed or replaced a document during this visit), but
    // let the browser keep the file, so repeated searches get 304 instead of downloading it again.
    const response = await fetchImpl(new URL("./chat-documents.json", import.meta.url), { cache: "no-cache" });
    if (response.status === 404) return { ok: true, ...searchDocuments([], args.query, args.limit) };
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.version !== 1 || !Array.isArray(data.documents) || data.documents.length > 50 || data.documents.some(doc => typeof doc.id !== "string" || typeof doc.name !== "string" || typeof doc.text !== "string" || doc.text.length > 100000)) throw new Error();
    return { ok: true, ...searchDocuments(data.documents, args.query, args.limit) };
  } catch { return { ok: false, reason: "資料を検索できませんでした。少し待ってからお試しください。" }; }
}
