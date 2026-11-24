import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { google } from "googleapis";
import { atomicWrite } from "./store.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const cookie = (req, key) => (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${key}=`))?.slice(key.length + 1);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const same = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function trustedIntegration(req, secret = process.env.PARENT_INTEGRATION_SECRET || "") {
  return secret.length >= 32 && same(req.headers.authorization, `Bearer ${secret}`);
}

/** Operator sessions and Gmail grants stay on the server. The public finder needs no session. */
export function createGoogleAuth({ root, env = process.env, basePath = "", oauthFactory = redirect => new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirect), send = async (client, message) => google.gmail({ version: "v1", auth: client }).users.messages.send(message) }) {
  const file = join(root, "admin/auth.json");
  const admins = new Set((env.PARENT_ADMIN_EMAILS || "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean));
  const secret = env.PARENT_AUTH_SECRET || env.SESSION_SECRET || "";
  const configured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && secret.length >= 32 && admins.size);
  let pending = Promise.resolve();
  const transact = work => {
    const next = pending.then(async () => {
      let data;
      try { data = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; data = { accounts: {}, sessions: {}, challenges: {} }; }
      const result = await work(data);
      await atomicWrite(file, JSON.stringify(data) + "\n", { mode: 0o600 });
      return result;
    });
    pending = next.catch(() => {}); return next;
  };
  const key = () => createHash("sha256").update(secret).digest();
  const encrypt = text => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  };
  const decrypt = text => {
    const data = Buffer.from(text, "base64url"), cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
  };
  const sessionCookie = (origin, name, value, age) => `${name}=${value}; HttpOnly; SameSite=Lax; Path=${basePath || "/"}; Max-Age=${age}${origin.startsWith("https:") ? "; Secure" : ""}`;
  return {
    async session(req) {
      if (!configured) return null;
      const id = cookie(req, "finder_operator");
      if (!id) return null;
      return transact(data => {
        const session = data.sessions[digest(id)];
        return session && session.expires > Date.now() && admins.has(session.email) ? { email: session.email } : null;
      });
    },
    status(user) { return { user, configured, ...(!configured ? { setupMessage: "運営者のGoogleログインがまだ設定されていません。" } : {}) }; },
    async begin(res, origin) {
      if (!configured) fail(503, "運営者のGoogleログイン設定が必要です。");
      if (env.PARENT_ORIGIN && env.PARENT_ORIGIN.replace(/\/$/, "") !== origin) {
        res.writeHead(302, { Location: new URL(`${basePath}/auth/google`, env.PARENT_ORIGIN).href }); res.end(); return;
      }
      const redirect = `${env.PARENT_ORIGIN || origin}${basePath}/auth/google/callback`;
      const client = oauthFactory(redirect), state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
      await transact(data => {
        const now = Date.now();
        for (const [key, value] of Object.entries(data.challenges)) if (value.expires <= now) delete data.challenges[key];
        for (const [key, value] of Object.entries(data.sessions)) if (value.expires <= now) delete data.sessions[key];
        if (Object.keys(data.challenges).length >= 1000) fail(429, "少し時間をおいてお試しください。");
        data.challenges[digest(state)] = { verifier, origin, redirect, expires: now + 600000 };
      });
      res.setHeader("Set-Cookie", sessionCookie(origin, "finder_oauth", state, 600));
      res.writeHead(302, { Location: client.generateAuthUrl({ access_type: "offline", prompt: "consent select_account", scope: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send"], state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }) });
      res.end();
    },
    async callback(req, res, url, origin) {
      if (!configured) fail(503, "運営者のGoogleログイン設定が必要です。");
      const state = url.searchParams.get("state");
      if (!state || !same(state, cookie(req, "finder_oauth"))) fail(400, "Googleログインをやり直してください。");
      const challenge = await transact(data => { const value = data.challenges[digest(state)]; delete data.challenges[digest(state)]; return value; });
      if (!challenge || challenge.origin !== origin || challenge.expires <= Date.now() || !url.searchParams.get("code") || url.searchParams.has("error")) fail(400, "Googleログインをやり直してください。");
      const client = oauthFactory(challenge.redirect);
      const { tokens } = await client.getToken({ code: url.searchParams.get("code"), codeVerifier: challenge.verifier });
      const identity = (await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID })).getPayload();
      const email = identity?.email?.toLowerCase();
      if (!identity?.email_verified || !admins.has(email)) fail(403, "このGoogleアカウントには運営権限がありません。");
      if (!tokens.scope?.split(" ").includes("https://www.googleapis.com/auth/gmail.send")) fail(403, "招待メールを送るため、Gmailの送信を許可してください。");
      const id = randomBytes(32).toString("base64url");
      await transact(data => {
        const refresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : data.accounts[email]?.refresh;
        if (!refresh) fail(400, "Gmailの権限を再承認してください。");
        data.accounts[email] = { refresh };
        data.sender = email;
        data.sessions[digest(id)] = { email, expires: Date.now() + 8 * 3600000 };
      });
      res.setHeader("Set-Cookie", [sessionCookie(origin, "finder_oauth", "", 0), sessionCookie(origin, "finder_operator", id, 8 * 3600)]);
      res.writeHead(302, { Location: `${basePath}/` }); res.end();
    },
    /** A shared demo link signs visitors in as the operator who already connected Gmail. Disabled unless a long token is configured. */
    async demo(res, url, origin, invitation = url.searchParams.get("token")) {
      const token = env.PARENT_DEMO_LOGIN_TOKEN || "";
      const until = env.PARENT_DEMO_LOGIN_UNTIL ? Date.parse(env.PARENT_DEMO_LOGIN_UNTIL) : Infinity;
      if (!configured || !(Date.now() < until) || token.length < 32 || !same(invitation, token)) fail(404, "見つかりません");
      const expires = Math.min(Date.now() + 8 * 3600000, until);
      const id = randomBytes(32).toString("base64url");
      await transact(data => {
        const email = data.sender;
        if (!admins.has(email) || !data.accounts[email]) fail(503, "運営者が先にGoogleでログインしてください。");
        data.sessions[digest(id)] = { email, expires };
      });
      res.setHeader("Set-Cookie", sessionCookie(origin, "finder_operator", id, Math.max(0, Math.floor((expires - Date.now()) / 1000))));
      res.writeHead(basePath ? 303 : 302, { Location: `${basePath}/` }); res.end();
    },
    async logout(req, res, origin) {
      const id = cookie(req, "finder_operator");
      if (id) await transact(data => { delete data.sessions[digest(id)]; });
      res.setHeader("Set-Cookie", sessionCookie(origin, "finder_operator", "", 0));
    },
    async mail(input, operatorEmail) {
      if (!configured) fail(503, "Gmail送信の設定が必要です。");
      const { to, subject, text, cc = [], attachments = [] } = input || {};
      const address = value => typeof value === "string" && /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/.test(value);
      if (!address(to) || !Array.isArray(cc) || cc.length > 10 || cc.some(value => !address(value)) || typeof subject !== "string" || subject.length > 500 || typeof text !== "string" || text.length > 100000 || !Array.isArray(attachments) || attachments.length > 5) fail(400, "メールの内容を確認してください。");
      let total = 0;
      for (const file of attachments) {
        if (!file || typeof file.name !== "string" || /[\r\n\0]/.test(file.name) || typeof file.mimeType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType) || typeof file.data !== "string") fail(400, "添付ファイルを確認してください。");
        const bytes = Buffer.from(file.data, "base64"); total += bytes.length;
        if (bytes.toString("base64") !== file.data || bytes.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) fail(400, "添付ファイルが大きすぎます。");
      }
      const account = await transact(data => { const email = operatorEmail || env.PARENT_MAIL_SENDER || data.sender; return admins.has(email) ? data.accounts[email] : null; });
      if (!account) fail(503, "運営者がGoogleにログインして、Gmailを接続してください。");
      const client = oauthFactory(undefined); client.setCredentials({ refresh_token: decrypt(account.refresh) });
      const headers = `To: ${to}\r\n${cc.length ? `Cc: ${cc.join(", ")}\r\n` : ""}Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\n`;
      const content = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString("base64")}`;
      const boundary = `finder-${randomBytes(18).toString("hex")}`;
      const parts = attachments.map(file => `Content-Type: ${file.mimeType}\r\nContent-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.data.match(/.{1,76}/g)?.join("\r\n") || ""}`);
      const mime = attachments.length ? `${headers}Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${[content, ...parts].join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n` : headers + content;
      try { await send(client, attachments.length ? { userId: "me", media: { mimeType: "message/rfc822", body: mime } } : { userId: "me", requestBody: { raw: Buffer.from(mime).toString("base64url") } }); }
      catch { fail(503, "Gmailから送信できませんでした。Googleへの再接続を確認してください。"); }
    },
  };
}
