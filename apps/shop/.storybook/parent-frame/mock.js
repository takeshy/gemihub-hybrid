// Storybook-only loader for the parent finder (site/) and its administration page (admin/).
// It loads the real HTML, CSS and JavaScript, answers every /api/ request from fixtures in this
// frame, and never contacts a live server. The story passes its scenario as ?c=<JSON>.
(async () => {
  const config = JSON.parse(new URLSearchParams(location.search).get("c") || "{}");
  if (config.voice) (await import("./voice-demo.js")).installVoiceDemo();
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const absolute = path => new URL(path, location.href).href;
  const sessionKey = `parent-story-signed-out:${location.search}`;
  const stored = () => { try { return sessionStorage.getItem(sessionKey) === "1"; } catch { return false; } };
  const store = value => { try { value ? sessionStorage.setItem(sessionKey, "1") : sessionStorage.removeItem(sessionKey); } catch { /* Stories still render. */ } };

  function admin() {
    let user = config.user === false || stored() ? null : { email: "operator@example.com" };
    const configured = config.configured !== false;
    let state = { version: 1, shops: config.shops || [], cache: config.cache || {}, revision: "1", production: true };
    let documents = { documents: structuredClone(config.documents || []), revision: "1" };
    const next = message => { state = { ...state, revision: String(Number(state.revision) + 1), message }; return json(state); };
    return (url, method, body) => {
      const path = url.pathname;
      if (path === "/api/session") return json({ user, configured, ...(configured ? {} : { setupMessage: "運営者のGoogleログインがまだ設定されていません。" }) });
      if (path === "/api/logout") { user = null; store(true); return json({ ok: true }); }
      if (!user) return json({ error: "運営者としてGoogleにログインしてください" }, 401);
      if (path === "/api/site") return json({ publicUrl: absolute("../parent-site/index.html") });
      if (path === "/api/chat-documents" && method === "GET") return json(documents);
      if (path === "/api/chat-documents/import" && method === "POST") {
        if (!/\.(txt|md|markdown|csv|json|pdf)$/i.test(body.name || "")) return json({ error: "テキスト・Markdown・CSV・JSON・PDFを選んでください。" }, 400);
        if (typeof body.data !== "string" || body.data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) return json({ error: "資料は1ファイル5MB以内にしてください。" }, 413);
        let text;
        try {
          text = /\.pdf$/i.test(body.name) ? "StorybookのPDF読み取り例です。中央図書館は午前9時に開館します。実際のPDFやAIには接続していません。" : new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(body.data), c => c.charCodeAt(0)));
        } catch { return json({ error: "UTF-8のテキストファイルを選んでください。" }, 400); }
        if (!text.trim() || text.length > 100000) return json({ error: "本文は空でない10万文字以内の文章にしてください。" }, 400);
        return json({ name: body.name, text });
      }
      if (path === "/api/chat-documents" && method === "PUT") {
        if (body.revision !== documents.revision) return json({ error: "資料が別の操作で更新されました。一覧を読み直してください。" }, 409);
        const item = { id: body.id || `storybook-document-${documents.revision}`, name: body.name, text: body.text, published: body.published, updatedAt: "2026-11-16T09:00:00.000Z" };
        documents = { documents: body.id ? documents.documents.map(doc => doc.id === body.id ? item : doc) : [...documents.documents, item], revision: String(Number(documents.revision) + 1) };
        return json(documents);
      }
      const removedDocument = path.match(/^\/api\/chat-documents\/([^/]+)$/);
      if (removedDocument && method === "DELETE") {
        documents = { documents: documents.documents.filter(doc => doc.id !== removedDocument[1]), revision: String(Number(documents.revision) + 1) };
        return json(documents);
      }
      if (path === "/api/shops" && method === "GET") return json(state);
      if (path === "/api/shops" && method === "PUT") {
        const fetchedAt = "2026-11-16T09:00:00.000Z";
        const cache = Object.fromEntries(body.shops.map(shop => [shop.id, { status: "connected", fetchedAt, ...state.cache[shop.id], ...body.cache?.[shop.id] }]));
        state = { ...state, shops: body.shops, cache };
        return next("保存しました。公開サイトを再読み込みすると反映されます。");
      }
      const removed = path.match(/^\/api\/shops\/([^/]+)$/);
      if (removed && method === "DELETE") {
        state = { ...state, shops: state.shops.filter(shop => shop.id !== decodeURIComponent(removed[1])) };
        return next("削除しました。公開サイトを再読み込みすると反映されます。");
      }
      if (path === "/api/resolve") {
        if (!/^https?:\/\//.test(body.url || "")) return json({ error: "店のURLを確認してください" }, 400);
        const current = state.shops.find(shop => shop.id === body.id);
        const fresh = { id: "komorebi-zakka", name: "こもれび雑貨店", area: "東京都世田谷区", address: "東京都世田谷区北沢２丁目１０", cuisine: "雑貨・生活雑貨", description: "作家の器と文具をそろえた小さな雑貨店です。", pageUrl: new URL("/", body.url).href, reservationEnabled: false };
        return json({ shop: current ? { ...current, description: `${current.description || ""}（店のページから取り直した紹介文）` } : fresh, cache: { status: "connected", fetchedAt: "2026-11-16T09:00:00.000Z" } });
      }
      if (path === "/api/invitations") return json({ ok: true, message: "招待メールを送りました。" });
    };
  }

  function site() {
    const managed = config.ai !== "byok", model = "gemini-4-hydrogen";
    const answer = "Storybookの固定の返答です。実際のAIには接続していません。";
    return (url, method, body) => {
      const path = url.pathname;
      if (path === "/parent-site/chat-documents.json") return json({ version: 1, documents: (config.documents || []).filter(doc => doc.published).map(({ id, name, text, updatedAt }) => ({ id, name, text, updatedAt })) });
      if (path === "/api/ai/config") return json({ managed, defaultMode: managed ? "managed" : "byok", model: managed ? model : "", reasoning: "low", router: "/api/ai/v1", voice: !!config.voice });
      if (path === "/api/ai/session") return json({ token: "storybook-session", expiresIn: 7200, model, router: "/api/ai/v1" });
      if (path === "/api/ai/v1/models") return json({ object: "list", data: [{ id: model, object: "model" }] });
      if (path === "/api/ai/v1/chat/completions" && method === "POST") {
        if (config.open === "document-answer" || config.voice) {
          const receipt = body.messages.filter(message => message.role === "tool").at(-1);
          const result = receipt ? JSON.parse(receipt.content).result : null;
          const source = result?.results?.[0];
          const delta = receipt ? { content: source ? `${source.text}\n資料: ${source.source}` : "公開資料から確認できませんでした。" } : { tool_calls: [{ index: 0, id: "storybook-documents", type: "function", function: { name: "website_search_chat_documents", arguments: JSON.stringify({ query: "中央図書館 開館時間" }) } }] };
          return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: receipt ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
    };
  }

  const pages = {
    admin: {
      url: "../parent-admin/index.html", handler: admin,
      rewrite: html => html.replace('href="/admin.css"', 'href="../parent-admin/admin.css"').replace('src="/admin.js"', 'src="../parent-admin/admin.js"'),
      // admin.js imports its helpers from the administration server's root.
      imports: { "/shop-data.js": absolute("../parent-site/shop-data.js"), "/site-editor.js": absolute("../parent-admin/site-editor.js"), "/chat-documents-ui.js": absolute("../parent-admin/chat-documents-ui.js") },
    },
    site: {
      url: "../parent-site/index.html", handler: site,
      rewrite: html => html.replace(/(href|src)="\.\/([\w.-]+\.(?:css|js))"/g, '$1="../parent-site/$2"'),
      // The generated registry reflects local shops; stories use their own fixture shops.
      imports: { [absolute("../parent-site/shop-registry.js")]: `data:text/javascript;charset=utf-8,${encodeURIComponent(`export const shops = ${JSON.stringify(config.shops || [])};`)}`,
        // Fixed cloud answers instead of the real Firebase project; on-device calls use this browser's Nano.
        [absolute("../parent-site/ai-connection.js")]: absolute("./hybrid-stub.js") },
    },
  };
  const page = pages[config.page];
  if (!page) { document.body.textContent = "Unknown story page"; return; }
  const realFetch = window.fetch.bind(window), handle = page.handler();
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
    // The runtime probes the AI router's origin for an agent manifest; the managed router has none.
    if (url.origin === location.origin && url.pathname === "/agent-manifest.json") return json({ error: "Not found" }, 404);
    if (url.origin === location.origin && url.pathname === "/parent-site/chat-documents.json") return await handle(url, "GET") || json({ version: 1, documents: [] });
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    return await handle(url, (init.method || "GET").toUpperCase(), body) || json({ error: "Storybookでは使えない操作です" }, 404);
  };
  const html = page.rewrite(await (await realFetch(page.url)).text())
    .replace("<head>", `<head><script type="importmap">${JSON.stringify({ imports: page.imports }).replace(/</g, "\\u003c")}</script>`);
  document.open(); document.write(html); document.close();
  // document.open() drops earlier listeners, so add them to the written page.
  window.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#google-login")) { event.preventDefault(); store(false); location.reload(); return; }
    if (target?.closest("#site-design-toggle")) {
      event.stopImmediatePropagation();
      const message = document.getElementById("message");
      if (message) { message.textContent = "Storybookでは「ページ編集」のストーリーで確認できます。"; message.hidden = false; }
      return;
    }
    // Keep ordinary links from leaving the story; in-page anchors and new tabs behave as usual.
    const link = target?.closest("a[href]");
    if (link && !link.getAttribute("href").startsWith("#") && link.target !== "_blank") event.preventDefault();
  }, true);
  if (config.open === "add") {
    const timer = setInterval(() => {
      const add = document.getElementById("add-shop");
      if (!add || add.disabled || document.getElementById("registry").hidden) return;
      clearInterval(timer); add.click();
      document.getElementById("source-url").value = "https://komorebi-zakka.example/";
      document.getElementById("resolve-form").requestSubmit();
    }, 50);
  }
  if (config.open === "document" || config.open === "document-answer") {
    const timer = setInterval(() => {
      if (config.open === "document") {
        const edit = [...document.querySelectorAll("#documents-list button")].find(button => button.textContent === "本文を確認");
        if (!edit || edit.disabled) return;
        clearInterval(timer); edit.click(); document.getElementById("document-preview").scrollIntoView();
      } else {
        const send = document.getElementById("ns-send"), input = document.getElementById("ns-input");
        if (!window.__nsweb?.engine || !send || send.disabled || !input) return;
        clearInterval(timer); input.value = "中央図書館の開館時間を教えて"; input.dispatchEvent(new Event("input", { bubbles: true })); send.click();
      }
    }, 50);
  }
})();
