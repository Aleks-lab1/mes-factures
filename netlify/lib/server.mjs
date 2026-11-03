// API de synchronisation de Mes Factures (fonction Netlify).
// Stockage : Netlify Blobs (une entrée "db" pour les données, une entrée "auth" pour le mot de passe).
// Routes :
//   GET  /api/status            -> { ok, configured }
//   POST /api/setup  {password} -> { token }   (une seule fois, tant qu'aucun mot de passe n'existe)
//   POST /api/login  {password} -> { token }
//   GET  /api/data?rev=N        -> { unchanged, rev } ou instantané complet
//   POST /api/ops    {ops: []}  -> { rev, applied }
//   POST /api/password {current, next} -> { token }  (déconnecte les autres appareils)
import { pbkdf2Sync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { applyOps, emptyDb, snapshotOf } from "../../src/core/sync-merge.js";

const ITER = 210000;
const TOKEN_DAYS = 400;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
});

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function hashPw(password, salt, iter = ITER) {
  return pbkdf2Sync(String(password).normalize("NFC"), Buffer.from(salt, "base64url"), iter, 32, "sha256").toString("base64url");
}
function eq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function sign(secret, payload) {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url");
}
function makeToken(auth) {
  const payload = b64u(JSON.stringify({ iat: Date.now(), v: auth.ver }));
  return payload + "." + sign(auth.secret, payload);
}
function checkToken(auth, token) {
  if (!auth || !token || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !eq(sig, sign(auth.secret, payload))) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.v === auth.ver && Date.now() - p.iat < TOKEN_DAYS * 86400000;
  } catch { return false; }
}
function newAuth(password, ver = 1) {
  const salt = b64u(randomBytes(16));
  return { salt, iter: ITER, hash: hashPw(password, salt), secret: b64u(randomBytes(32)), ver, fails: 0, lockUntil: 0 };
}
function validPassword(p) {
  return typeof p === "string" && p.length >= 8 && p.length <= 200;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lecture-modification-écriture protégée contre les écritures simultanées (ETag). */
async function mutate(store, key, init, fn) {
  for (let i = 0; i < 10; i++) {
    const cur = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const value = cur?.data ?? init();
    const result = fn(value);
    if (result === false) return { value, written: false };
    const w = cur ? await store.setJSON(key, value, { onlyIfMatch: cur.etag }) : await store.setJSON(key, value, { onlyIfNew: true });
    if (w?.modified) return { value, written: true };
    await sleep(40 * (i + 1) + Math.random() * 60);
  }
  throw new Error("write_conflict");
}

async function readBody(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw Object.assign(new Error("too_large"), { status: 413 });
  const txt = await req.text();
  if (txt.length > MAX_BODY) throw Object.assign(new Error("too_large"), { status: 413 });
  try { return JSON.parse(txt || "{}"); } catch { throw Object.assign(new Error("bad_json"), { status: 400 }); }
}

export function createHandler(getStore) {
  return async function handler(req) {
    const store = getStore();
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/api\//, "").replace(/\/+$/, "");
    try {
      if (route === "status" && req.method === "GET") {
        const auth = await store.get("auth", { type: "json", consistency: "strong" });
        return json(200, { ok: true, configured: !!auth });
      }

      if (route === "setup" && req.method === "POST") {
        const { password } = await readBody(req);
        if (!validPassword(password)) return json(400, { error: "weak_password" });
        const auth = newAuth(password);
        const w = await store.setJSON("auth", auth, { onlyIfNew: true });
        if (!w?.modified) return json(409, { error: "already_configured" });
        return json(200, { token: makeToken(auth) });
      }

      if (route === "login" && req.method === "POST") {
        const { password } = await readBody(req);
        let outcome = null;
        await mutate(store, "auth", () => null, (auth) => {
          if (!auth) { outcome = json(409, { error: "not_configured" }); return false; }
          const now = Date.now();
          if (auth.lockUntil && auth.lockUntil > now) { outcome = json(429, { error: "locked", retryAfter: Math.ceil((auth.lockUntil - now) / 1000) }); return false; }
          const ok = typeof password === "string" && eq(hashPw(password, auth.salt, auth.iter), auth.hash);
          if (ok) {
            outcome = json(200, { token: makeToken(auth) });
            if (!auth.fails && !auth.lockUntil) return false;
            auth.fails = 0; auth.lockUntil = 0;
            return true;
          }
          auth.fails = (auth.fails || 0) + 1;
          if (auth.fails >= MAX_FAILS) { auth.lockUntil = now + LOCK_MS; auth.fails = 0; }
          outcome = json(401, { error: "bad_password" });
          return true;
        });
        return outcome;
      }

      // --- routes protégées ---
      const auth = await store.get("auth", { type: "json", consistency: "strong" });
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!auth) return json(409, { error: "not_configured" });
      if (!checkToken(auth, token)) return json(401, { error: "unauthorized" });

      if (route === "data" && req.method === "GET") {
        const db = (await store.get("db", { type: "json", consistency: "strong" })) || emptyDb();
        const since = url.searchParams.get("rev");
        if (since !== null && Number(since) === Number(db.rev || 0)) return json(200, { unchanged: true, rev: Number(db.rev || 0) });
        return json(200, snapshotOf(db));
      }

      if (route === "ops" && req.method === "POST") {
        const { ops } = await readBody(req);
        if (!Array.isArray(ops)) return json(400, { error: "bad_ops" });
        let applied = 0;
        const { value } = await mutate(store, "db", emptyDb, (db) => {
          applied = applyOps(db, ops);
          if (!applied) return false;
          db.rev = (Number(db.rev) || 0) + 1;
          return true;
        });
        return json(200, { rev: Number(value.rev || 0), applied });
      }

      if (route === "password" && req.method === "POST") {
        const { current, next } = await readBody(req);
        if (!eq(hashPw(current || "", auth.salt, auth.iter), auth.hash)) return json(401, { error: "bad_password" });
        if (!validPassword(next)) return json(400, { error: "weak_password" });
        let fresh = null;
        await mutate(store, "auth", () => null, (a) => {
          if (!a) return false;
          fresh = newAuth(next, (a.ver || 1) + 1);
          Object.assign(a, fresh);
          return true;
        });
        return json(200, { token: makeToken(fresh) });
      }

      return json(404, { error: "not_found" });
    } catch (e) {
      if (e?.status) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: "server_error" });
    }
  };
}
