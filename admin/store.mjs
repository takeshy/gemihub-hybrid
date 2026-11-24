import { readFile, writeFile, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { SHOP_FIELDS, validateShops } from "../scripts/shops.mjs";
import { buildSite } from "../scripts/build.mjs";

export const generatedFiles = [
  "site/shop-registry.js", "site/reservation_finder.hocon", "site/reservation_finder.network.json",
  "site/agent-manifest.json", "site/links.json", "site/_headers", "site/agent-mcp.json",
  "site/.well-known/nsdeploy.json", "site/.well-known/nsdeploy-agent.json",
  "site/bridge/action-bridge.html", "site/bridge/agent-manifest.json",
];
const serialize = value => JSON.stringify(value, null, 2) + "\n";
const revision = bytes => createHash("sha256").update(bytes).digest("hex");

async function readOptional(file) {
  try { return await readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function atomicWrite(file, data, options = {}) {
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data, { ...options, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

function cleanMetadata(value = {}) {
  const result = Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    (["fetchedAt", "description", "reservationSummary", "error"].includes(key) && typeof item === "string") ||
    (key === "status" && ["connected", "needs-review", "error"].includes(item))));
  if (result.status !== "error") delete result.error;
  return result;
}

// A single queue covers all reads and mutations, so no client observes a half-published save.
export function createShopStore({ root, production = false, build = buildSite, write = atomicWrite } = {}) {
  root = resolve(root);
  const shopsPath = join(root, "site/shops.json");
  const cachePath = join(root, "admin/cache.json");
  let pending = Promise.resolve();
  const exclusive = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  async function read() {
    const bytes = await readFile(shopsPath);
    const config = JSON.parse(bytes);
    const cacheBytes = await readOptional(cachePath);
    const cache = cacheBytes ? JSON.parse(cacheBytes).shops || {} : {};
    return { version: 1, shops: config.shops, cache, revision: revision(bytes), production };
  }
  async function save(shops, updates = {}, expectedRevision) {
    const current = await read();
    if (expectedRevision && current.revision !== expectedRevision) {
      const error = new Error("店舗一覧が別の操作で更新されました。ページを再読み込みしてください。");
      error.status = 409;
      throw error;
    }
    const validated = validateShops({ version: 1, shops }, { production });
    const config = { version: 1, shops: validated.map(shop => Object.fromEntries(SHOP_FIELDS.filter(key => Object.hasOwn(shop, key)).map(key => [key, shop[key]]))) };
    const cache = { version: 1, shops: Object.fromEntries(config.shops.map(shop => [shop.id, cleanMetadata({ ...current.cache[shop.id], ...(Object.hasOwn(updates, shop.id) ? updates[shop.id] : {}) })])) };
    const stage = await mkdtemp(join(tmpdir(), "gemihub-admin-"));
    try {
      await mkdir(join(stage, "site"));
      // The fixed runtime and build inputs are read only throughout staging.
      const linkType = process.platform === "win32" ? "junction" : "dir";
      for (const path of ["src", "vendor", "site/runtime"]) {
        await symlink(join(root, path), join(stage, path), linkType);
      }
      await writeFile(join(stage, "site/shops.json"), serialize(config));
      await build({ root: pathToFileURL(stage + sep), production, stdio: "pipe" });
      const files = [...generatedFiles, "admin/cache.json", "site/shops.json"];
      const data = await Promise.all(files.map(path => path === "admin/cache.json" ? serialize(cache) : readFile(join(stage, path))));
      const before = await Promise.all(files.map(path => readOptional(join(root, path))));
      // Detect manual edits made while building as well as stale API clients.
      if (revision(await readFile(shopsPath)) !== current.revision) throw new Error("ビルド中に shops.json が変更されました。保存をやり直してください。");
      let attempted = -1;
      try {
        for (let i = 0; i < files.length; i++) { attempted = i; await write(join(root, files[i]), data[i]); }
      } catch (error) {
        const failures = [];
        for (let i = attempted; i >= 0; i--) {
          try {
            if (before[i] === null) await rm(join(root, files[i]), { force: true });
            else await atomicWrite(join(root, files[i]), before[i]);
          } catch (rollbackError) { failures.push(rollbackError.message); }
        }
        if (failures.length) throw new Error(`${error.message}\n復元に失敗しました: ${failures.join("\n")}`);
        throw error;
      }
      return { ...await read(), files: generatedFiles, message: "保存しました。公開サイトを再読み込みすると反映されます。" };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  return {
    get: () => exclusive(read),
    save: (shops, cache, expectedRevision) => exclusive(() => save(shops, cache, expectedRevision)),
    delete: (id, expectedRevision) => exclusive(async () => {
      const current = await read();
      if (!current.shops.some(shop => shop.id === id)) { const error = new Error("店が見つかりません"); error.status = 404; throw error; }
      return save(current.shops.filter(shop => shop.id !== id), {}, expectedRevision);
    }),
    recordError: (id, message) => exclusive(async () => {
      const current = await read();
      if (!current.shops.some(shop => shop.id === id)) return;
      current.cache[id] = { ...current.cache[id], status: "error", error: message };
      await atomicWrite(cachePath, serialize({ version: 1, shops: current.cache }));
    }),
  };
}
