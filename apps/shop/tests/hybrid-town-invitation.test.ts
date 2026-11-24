import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";

test("the mounted town admin sends a normal invitation and the recipient gets the shop creation workspace", async t => {
  const { initializeTown, startTownAdmin, adminPath } = await import(new URL("../../../scripts/hybrid-town-admin.mjs", import.meta.url).href);
  const { createGoogleAuth } = await import(new URL("../../../admin/google-auth.mjs", import.meta.url).href);
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "hybrid-town-invitation-"));
  const store = new Store(":memory:");
  const previous = Object.fromEntries(
    ["APP_ORIGIN", "PARENT_INTEGRATION_SECRET", "PARENT_MAIL_URL", "ACCESS_PASSWORD", "OWNER_EMAIL_ENTRY_PATH"]
      .map(key => [key, process.env[key]]),
  );
  process.env.OWNER_EMAIL_ENTRY_PATH = "/?shop=1";
  const shop = createApp(store);
  let admin: Server | undefined;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const server of [admin, shop]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const integrationSecret = "hybrid-test-integration-secret".repeat(2);
  const operator = "operator@example.test";
  const judge = "test-only-hybrid-judge-invitation".repeat(2);
  const mails: string[] = [];
  await new Promise<void>(resolve => shop.listen(0, "127.0.0.1", resolve));
  const port = (shop.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const auth = createGoogleAuth({
    root, basePath: adminPath, env: {
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      PARENT_ORIGIN: origin,
      PARENT_ADMIN_EMAILS: operator,
      PARENT_AUTH_SECRET: "hybrid-test-auth-secret".repeat(2),
      PARENT_DEMO_LOGIN_TOKEN: judge,
      PARENT_DEMO_LOGIN_UNTIL: new Date(Date.now() + 60000).toISOString(),
    },
    oauthFactory: (redirect: string) => ({
      generateAuthUrl({ state }: { state: string }) {
        return `https://accounts.google.com/test?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`;
      },
      async getToken() { return { tokens: { refresh_token: "test-refresh", scope: "https://www.googleapis.com/auth/gmail.send" } }; },
      async verifyIdToken() { return { getPayload: () => ({ email_verified: true, email: operator }) }; },
      setCredentials() {},
    }),
    send: async (_client: unknown, message: { requestBody: { raw: string } }) => {
      mails.push(Buffer.from(message.requestBody.raw, "base64url").toString());
    },
  });
  await initializeTown({ root: source, data: root, origin });
  const adminServer = await startTownAdmin({ origin, data: root, shopPort: port, auth, env: { PARENT_INTEGRATION_SECRET: integrationSecret } });
  admin = adminServer;
  const adminOrigin = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;
  const settings = {
    APP_ORIGIN: origin, PARENT_INTEGRATION_SECRET: integrationSecret,
    PARENT_MAIL_URL: adminOrigin + "/api/internal/mail",
    ACCESS_PASSWORD: "test-only-invitation-mode",
  };
  Object.assign(process.env, settings);
  const adminRequest = (path: string, cookie = "", data?: unknown) => new Promise<Response>((resolve, reject) => {
    const req = request(adminOrigin + adminPath + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { Host: new URL(origin).host, Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { headers, status: response.statusCode! }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(data));
  });
  const adminPage = await adminRequest("/");
  assert.equal(adminPage.headers.get("content-language"), "en");
  assert.match(await adminPage.text(), /<html[^>]*lang="en"[^>]*>[\s\S]*Sign in with Google[\s\S]*Invite a shop[\s\S]*id="invite-form"/);
  const oldEditorLink = await adminRequest("/page-editor");
  assert.equal(oldEditorLink.status, 302);
  assert.equal(oldEditorLink.headers.get("location"), adminPath + "/");
  const denied = await adminRequest("/api/shops");
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "Sign in with an operator’s Google account.");
  const google = await adminRequest("/auth/google");
  const authorization = new URL(google.headers.get("location")!);
  assert.equal(authorization.searchParams.get("redirect_uri"), origin + adminPath + "/auth/google/callback");
  const challenge = google.headers.get("set-cookie")!.split(";")[0];
  const callback = await adminRequest(`/auth/google/callback?code=test&state=${authorization.searchParams.get("state")}`, challenge);
  assert.equal(callback.headers.get("location"), adminPath + "/");

  assert.equal((await adminRequest("/auth/demo", "", { invite: "invalid" })).status, 404);
  const demo = await adminRequest("/auth/demo", "", { invite: judge });
  assert.equal(demo.status, 303);
  assert.match(demo.headers.get("set-cookie")!, /Path=\/judge\/admin;/);
  const operatorCookie = demo.headers.get("set-cookie")!.split(";")[0];
  const invitation = { email: "owner@example.test", name: "Neighborhood Café", industry: "restaurant" };
  const guide = await (await adminRequest("/api/site", operatorCookie)).json();
  assert.deepEqual(guide, { editorAvailable: false, publicUrl: origin + "/?guide=1" });
  assert.equal((await adminRequest("/api/site/preview", operatorCookie)).status, 404);
  assert.equal((await adminRequest("/api/site/publish", operatorCookie, {})).status, 404);
  const documents = await (await adminRequest("/api/chat-documents", operatorCookie)).json();
  assert.equal(documents.pdfImportAvailable, false);
  assert.deepEqual(documents.documents, []);
  const sent = await adminRequest("/api/invitations", operatorCookie, invitation);
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).message, "Invitation email sent.");
  assert.equal(mails.length, 1);
  assert.match(mails[0], /To: owner@example.test/);
  const text = Buffer.from(mails[0].split("\r\n\r\n").at(-1)!, "base64").toString();
  const link = new URL(text.match(/https?:\/\/[^\s]+/)![0]);
  assert.equal(link.searchParams.get("shop"), "1");
  const token = new URLSearchParams(link.hash.slice(1)).get("owner-login");
  const login = await fetch(origin + "/api/owner-login/verify", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const ownerCookie = login.headers.get("set-cookie")!.split(";")[0];
  const workspace = await fetch(origin + "/api/workspace", { headers: { Cookie: ownerCookie } });
  assert.equal(workspace.status, 200);
  const [draft] = (await workspace.json()).shops;
  assert.equal(draft.published, null);
  assert.equal(draft.draft.name, invitation.name);
  assert.equal(draft.draft.industry, invitation.industry);
});
