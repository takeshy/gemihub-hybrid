import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultDesign, validateDesign, renderDesign, previewDesign, atomicFile, codeRoot } from "../admin/site-design.mjs";
import { createSiteEditor } from "../admin/site-editor-store.mjs";
import { createSiteDesignGenerator } from "../admin/site-editor-ai.mjs";
import { createAdminServer } from "../admin/server.mjs";
import { initializeParent } from "../infra/dev/init-parent.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "finder-editor-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "site")); await cp(join(codeRoot, "site/index.html"), join(root, "site/index.html"));
  await writeFile(join(root, "site/shops.json"), JSON.stringify({ version: 1, shops: [] })); return root;
}
const operator = { email: "operator@example.com" };
const generate = async ({ request, current }) => ({ config: { ...current, title: request, css: ":root { --accent:#315b93; --paper:#f0f5fb; }", copy: { ...current.copy, greeting: "新しい案内です。" } }, summary: ["青系のデザインに変更しました。"] });

test("the editable layout retains working parts and renders escaped copy with an immutable stylesheet", async () => {
  const design = await defaultDesign(); design.copy.assistantHeading = '<img src=x onerror="alert(1)">';
  const page = await renderDesign(design);
  assert.match(page.html, /&lt;img/); assert.doesNotMatch(page.html, /<slot\b/);
  for (const id of ["assistant", "shop-list", "shop-count", "shop-page-frame", "shop-view-header", "ai-settings-open"]) assert.equal((page.html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  assert.match(page.html, /data-greeting=/); assert.ok(page.html.includes(page.cssName)); assert.match(page.css, /data-editor-chrome/);
});
test("unsafe HTML, replaced application controls, missing slots and external CSS are rejected", async () => {
  const base = await defaultDesign();
  const invalid = [
    { html: base.html + '<script>alert(1)</script>' }, { html: base.html + '<img src="https://images.example/photo.jpg" onerror="alert(1)">' },
    { html: base.html + '<iframe src="https://evil.example/"></iframe>' }, { html: base.html + '<form><button>fake</button></form>' },
    { html: base.html + '<div id="agent-app"></div>' }, { html: base.html.replace('<slot name="assistant"></slot>', "") },
    { html: base.html + '<slot name="shops"></slot>' }, { html: base.html + '<a href="javascript:alert(1)">bad</a>' },
    { css: '@import "https://evil.example/style.css";' }, { css: 'body{background:url(https://evil.example/)}' },
    { css: 'body{background:u/**/rl(https://evil.example/)}' }, { css: '/* </style><script>bad</script> */' },
    { css: 'a{background:\\75rl(https://evil.example/)}' }, { css: '@font-face{font-family:x;src:local(foo)}' },
  ];
  for (const patch of invalid) await assert.rejects(validateDesign({ ...base, ...patch }), { status: 400 });
  await assert.rejects(validateDesign({ ...base, model: "unapproved" }), { status: 400 });
  const valid = await validateDesign({ ...base, html: base.html + '<section id="custom-faq"><h2>よくある質問</h2><a href="https://example.com/" target="_blank">案内</a></section>', css: '@media(max-width:600px){.custom-hero{padding:20px}}' });
  assert.match(valid.html, /noopener noreferrer/);
});
test("preview is inert and contains the real page text and registered shop cards", async () => {
  const design = await defaultDesign(), html = await previewDesign(design, [{ name: '<script>shop</script>', area: "横浜", cuisine: "雑貨", description: "試験用" }]);
  assert.doesNotMatch(html, /<script\b|<iframe\b|href=|<noscript\b/); assert.match(html, /&lt;script&gt;shop/); assert.match(html, /<style>/); assert.match(html, /textarea disabled/);
});
test("proposals remain private until publish, can be refined, and a history entry restores the page", async t => {
  const root = await fixture(t), editor = createSiteEditor({ root, configured: true, generate }), initial = await editor.get();
  const before = await readFile(join(root, "site/index.html"));
  const a = await editor.propose({ request: "青いページ", revision: initial.revision }, operator, []);
  assert.deepEqual(await readFile(join(root, "site/index.html")), before); assert.ok((await stat(join(root, "admin/site-editor.json"))).mode & 0o600);
  const b = await editor.propose({ request: "見出しを調整", revision: initial.revision, sourceId: a.proposal.id }, operator, []);
  const result = await editor.publish({ sourceId: b.proposal.id, revision: initial.revision }, operator);
  assert.notEqual(result.revision, initial.revision); assert.match(await readFile(join(root, "site/index.html"), "utf8"), /<title>見出しを調整<\/title>/);
  assert.match(await readFile(join(root, "site/index.html"), "utf8"), /data-greeting="新しい案内です。"/);
  const restored = await editor.publish({ sourceId: "initial", revision: result.revision }, operator);
  assert.equal(restored.revision, initial.revision); assert.equal(restored.versions.length, 3);
  assert.deepEqual(JSON.parse(await readFile(join(root, "site/shops.json"))), { version: 1, shops: [] });
});
test("stale proposals cannot overwrite a later publication, even if the client refreshes its revision", async t => {
  const root = await fixture(t), editor = createSiteEditor({ root, configured: true, generate }), initial = await editor.get();
  const a = await editor.propose({ request: "変更A", revision: initial.revision }, operator, []), b = await editor.propose({ request: "変更B", revision: initial.revision }, operator, []);
  const published = await editor.publish({ sourceId: a.proposal.id, revision: initial.revision }, operator);
  await assert.rejects(editor.publish({ sourceId: b.proposal.id, revision: initial.revision }, operator), { status: 409 });
  await assert.rejects(editor.publish({ sourceId: b.proposal.id, revision: published.revision }, operator), { status: 409 });
  await assert.rejects(editor.propose({ request: "変更C", revision: published.revision, sourceId: b.proposal.id }, operator, []), { status: 409 });
});
test("a failed publication restores the preceding index and keeps the previous private state", async t => {
  const root = await fixture(t); let failCommit = false;
  const editor = createSiteEditor({ root, configured: true, generate, write: async (path, ...args) => { if (failCommit && path.endsWith("site-editor.json")) throw new Error("injected disk failure"); return atomicFile(path, ...args); } });
  const initial = await editor.get(), draft = await editor.propose({ request: "失敗する変更", revision: initial.revision }, operator, []), before = await readFile(join(root, "site/index.html"));
  failCommit = true; await assert.rejects(editor.publish({ sourceId: draft.proposal.id, revision: initial.revision }, operator), /disk failure/);
  assert.deepEqual(await readFile(join(root, "site/index.html")), before); assert.equal((await editor.get()).revision, initial.revision);
});
test("redeployment preserves the published design, drafts, history and shop registry", async t => {
  const root = await fixture(t); await initializeParent({ root });
  const editor = createSiteEditor({ root, configured: true, generate }), initial = await editor.get();
  const draft = await editor.propose({ request: "再配備しても残るページ", revision: initial.revision }, operator, []);
  await editor.publish({ sourceId: draft.proposal.id, revision: initial.revision }, operator);
  const before = await readFile(join(root, "site/index.html")), privateState = await readFile(join(root, "admin/site-editor.json"));
  await initializeParent({ root });
  assert.deepEqual(await readFile(join(root, "site/index.html")), before); assert.deepEqual(await readFile(join(root, "admin/site-editor.json")), privateState);
});
test("the fixed Gemini generator uses the server key and low reasoning without echoing provider errors", async () => {
  const current = await defaultDesign(), calls = [], generator = createSiteDesignGenerator({ apiKey: "not-for-browser", fetch: async (url, options) => {
    calls.push({ url, options }); return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: "reasoning" }, { text: JSON.stringify({ config: current, summary: ["変更案"] }) }] } }] });
  } });
  const result = await generator({ request: "青く", current, shops: [] }); assert.equal(result.config.title, current.title);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "not-for-browser"); assert.match(calls[0].url, /gemini-4-hydrogen:generateContent$/);
  assert.equal(JSON.parse(calls[0].options.body).generationConfig.thinkingConfig.thinkingLevel, "LOW");
  const broken = createSiteDesignGenerator({ apiKey: "private-key", fetch: async () => new Response("private-key upstream detail", { status: 403 }) });
  await assert.rejects(broken({ request: "x", current, shops: [] }), e => e.status === 502 && !e.message.includes("private-key"));
});
test("editor API requires operator login and same-origin requests; preview and publish use server-held proposals", async t => {
  const root = await fixture(t), key = "fixture-service-key"; let authenticated = false, calls = 0;
  const server = createAdminServer({ root, geminiApiKey: key, auth: { session: async () => authenticated ? operator : null, status: user => ({ user, configured: true }) }, fetch: async (_url, options) => {
    calls++; assert.equal(options.headers["x-goog-api-key"], key);
    const { current, request } = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(await generate({ current, request })) }] } }] });
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, call = (path, method = "GET", data, origin = base) => fetch(base + path, { method, headers: { Origin: origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  for (const path of ["/api/site", "/api/site/preview"]) assert.equal((await call(path)).status, 401);
  assert.equal((await call("/api/site/proposals", "POST", {})).status, 401);
  authenticated = true;
  assert.equal((await call("/api/site/proposals", "POST", {}, "https://evil.example")).status, 403);
  const initial = await (await call("/api/site")).json(); assert.ok(!JSON.stringify(initial).includes(key));
  assert.equal((await call("/api/site/proposals", "POST", { request: "x", revision: initial.revision, model: "not-allowed" })).status, 400); assert.equal(calls, 0);
  const proposal = await (await call("/api/site/proposals", "POST", { request: "APIで作ったページ", revision: initial.revision })).json(); assert.ok(proposal.proposal.id);
  const preview = await call(`/api/site/preview?source=${proposal.proposal.id}`); assert.equal(preview.status, 200); assert.match(preview.headers.get("content-security-policy"), /sandbox/); assert.doesNotMatch(await preview.text(), /<script\b/);
  assert.equal((await call("/api/site/publish", "POST", { sourceId: proposal.proposal.id, revision: initial.revision })).status, 200);
  assert.match(await readFile(join(root, "site/index.html"), "utf8"), /APIで作ったページ/);
  assert.equal((await call("/admin/site-editor.json")).status, 404);
});

test('attachments stay private until used in a published design; marked screenshots reach generation and refinement', async t => {
  const {createSiteImages} = await import('../admin/site-images.mjs'), sharp = (await import('sharp')).default;
  const root=await fixture(t), images=createSiteImages({root}), data=(await sharp({create:{width:40,height:30,channels:3,background:'#e32236'}}).png().toBuffer()).toString('base64');
  const {imageId}=await images.upload({name:'写真.png',mimeType:'image/png',data});assert.equal((await images.list()).length,1);
  const savedImage = await stat(join(root, 'admin/site-images', imageId + '.webp'));
  assert.ok(savedImage.isFile());
  if (process.platform !== 'win32') assert.equal(savedImage.mode & 0o077, 0);
  await assert.rejects(stat(join(root,'site/page-images',imageId+'.webp')),{code:'ENOENT'});
  const calls=[], editor=createSiteEditor({root,configured:true,generate:async input=>{calls.push(input);return{config:{...input.current,title:input.request,html:input.current.html+(input.current.html.includes('data-image-id=')?'':`<img data-image-id="${imageId}" alt="添付した写真">`)},summary:['添付画像を配置しました。']};}}),initial=await editor.get();
  const draft=await editor.propose({request:'写真を配置',revision:initial.revision,media:{mimeType:'image/png',data},imageIds:[imageId]},operator,[]);
  assert.equal(calls[0].media.mimeType,'image/png');assert.equal(calls[0].images[0].id,imageId);assert.equal(calls[0].images[0].mimeType,'image/jpeg');assert.deepEqual(draft.proposal.imageIds,[imageId]);
  assert.match(await editor.preview(draft.proposal.id,[]),/src="data:image\/webp;base64,/);await assert.rejects(stat(join(root,'site/page-images',imageId+'.webp')),{code:'ENOENT'});
  const refined=await editor.propose({request:'もっと大きく',revision:initial.revision,sourceId:draft.proposal.id,media:{mimeType:'image/png',data},imageIds:[imageId]},operator,[]);assert.equal(calls[1].current.title,'写真を配置');assert.ok(calls[1].media);
  await editor.publish({sourceId:refined.proposal.id,revision:initial.revision},operator);assert.ok((await stat(join(root,'site/page-images',imageId+'.webp'))).size>0);assert.match(await readFile(join(root,'site/index.html'),'utf8'),new RegExp(`src="./page-images/${imageId}.webp"`));
  await initializeParent({root});assert.ok((await stat(join(root,'site/page-images',imageId+'.webp'))).size>0);assert.equal((await images.list()).length,1);
  await assert.rejects(editor.propose({request:'不正な添付',revision:(await editor.get()).revision,imageIds:['0'.repeat(64)]},operator,[]),{status:404});
  await assert.rejects(images.upload({name:'not.png',mimeType:'image/png',data:Buffer.from('<svg onload="evil"/>').toString('base64')}),{status:400});
  await assert.rejects(editor.propose({request:'不正な画面',revision:(await editor.get()).revision,media:{mimeType:'image/svg+xml',data}},operator,[]),{status:400});
});

test('Gemini receives marked screen pixels and labelled attachments on the same generation request', async () => {
 const current=await defaultDesign();let parts;
 const generate=createSiteDesignGenerator({apiKey:'private',fetch:async(_url,options)=>{parts=JSON.parse(options.body).contents[0].parts;return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({config:current,summary:['変更']})}]}}]});}});
 await generate({request:'赤丸を修正',current,shops:[],media:{mimeType:'image/png',data:'marked-pixels'},images:[{id:'a'.repeat(64),name:'参照写真',mimeType:'image/jpeg',data:'reference-pixels'}]});
 assert.equal(parts.filter(p=>p.inlineData).length,2);assert.equal(parts.find(p=>p.inlineData?.mimeType==='image/png').inlineData.data,'marked-pixels');assert.ok(parts.some(p=>p.text?.includes('attachmentId')&&p.text.includes('参照写真')));
});

test('image and capture APIs require operator auth and validate origin, image bytes and capture source', async t => {
 const root=await fixture(t);let authenticated=false,captures=0;
 const server=createAdminServer({root,auth:{session:async()=>authenticated?operator:null,status:user=>({user,configured:true})},capture:async({html,width})=>{captures++;assert.doesNotMatch(html,/<script\b|<iframe\b/);assert.equal(width,390);return{mimeType:'image/png',data:'fixture'};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,call=(path,data,origin=base)=>fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 assert.equal((await call('/api/site/images')).status,401);assert.equal((await call('/api/site/capture',{})).status,401);authenticated=true;
 const initial=await(await call('/api/site')).json();assert.equal((await call('/api/site/capture',{revision:initial.revision,width:390},'https://evil.example')).status,403);
 assert.equal((await call('/api/site/capture',{revision:initial.revision,width:390,url:'http://internal/'})).status,400);
 assert.equal((await call('/api/site/capture',{revision:'stale',width:390})).status,409);assert.equal(captures,0);
 assert.equal((await call('/api/site/capture',{revision:initial.revision,width:390})).status,200);assert.equal(captures,1);
 assert.equal((await call('/api/site/images',{name:'evil.svg',mimeType:'image/svg+xml',data:'AAAA'})).status,400);
 assert.equal((await call('/admin/site-images/private.webp')).status,404);
});

test('a failed publication does not expose an unpublished attachment', async t => {
 const {createSiteImages}=await import('../admin/site-images.mjs'),sharp=(await import('sharp')).default,root=await fixture(t),images=createSiteImages({root});
 const {imageId}=await images.upload({name:'private.png',mimeType:'image/png',data:(await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer()).toString('base64')});let fail=false;
 const editor=createSiteEditor({root,configured:true,generate:async({current})=>({config:{...current,html:current.html+`<img data-image-id="${imageId}" alt="private">`},summary:['写真']}),write:async(path,...args)=>{if(fail&&path.endsWith('site-editor.json'))throw Error('disk error');return atomicFile(path,...args);}});
 const initial=await editor.get(),draft=await editor.propose({request:'写真',revision:initial.revision},operator,[]);fail=true;
 await assert.rejects(editor.publish({sourceId:draft.proposal.id,revision:initial.revision},operator),/disk error/);await assert.rejects(stat(join(root,'site/page-images',imageId+'.webp')),{code:'ENOENT'});assert.equal((await editor.get()).revision,initial.revision);
});

test('finder attachments accept real PNGs above 5MB up to 10MB over HTTP, and reject anything larger', async t => {
 const sharp=(await import('sharp')).default,{randomBytes}=await import('node:crypto'),root=await fixture(t);
 const server=createAdminServer({root,auth:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,upload=data=>fetch(base+'/api/site/images',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'写真.png',mimeType:'image/png',data:data.toString('base64')})});
 const bytes=await sharp(randomBytes(1850*1850*3),{raw:{width:1850,height:1850,channels:3}}).png({compressionLevel:0}).toBuffer();assert.ok(bytes.length>9*1024*1024&&bytes.length<=10*1024*1024);
 const response=await upload(bytes);assert.equal(response.status,200);assert.match((await response.json()).imageId,/^[a-f0-9]{64}$/);
 const rejected=await upload(Buffer.alloc(10*1024*1024+1));assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/10MB/);
});
