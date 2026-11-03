// Fusion des modifications pour la synchronisation en ligne.
// Utilisé à la fois par la fonction serveur (Netlify) et par l'app (pour superposer
// les modifications pas encore envoyées). Règle : la modification la plus récente gagne.
//
// Base : { rev, colls: { clients: {id: rec}, ... }, settings, settingsT, tomb: { "coll/id": t } }
// Opérations :
//   { type: "put", coll, rec }          rec.updatedAt = date de modification (ms)
//   { type: "del", coll, id, t }
//   { type: "settings", data, t }
//   { type: "replace", data: { clients: [], ..., settings }, t }   (restauration d'une sauvegarde)

export const SYNC_COLLS = ["clients", "articles", "docs", "payments"];

export function emptyDb() {
  return { rev: 0, colls: { clients: {}, articles: {}, docs: {}, payments: {} }, settings: null, settingsT: 0, tomb: {} };
}

function normDb(db) {
  const d = db && typeof db === "object" ? db : emptyDb();
  d.colls = d.colls || {};
  for (const c of SYNC_COLLS) d.colls[c] = d.colls[c] || {};
  d.tomb = d.tomb || {};
  d.settingsT = Number(d.settingsT) || 0;
  d.rev = Number(d.rev) || 0;
  if (d.settings === undefined) d.settings = null;
  return d;
}

const ts = (x) => Number(x) || 0;

/** Applique des opérations sur la base (modifiée sur place). Renvoie le nombre d'opérations retenues. */
export function applyOps(dbIn, ops) {
  const db = normDb(dbIn);
  let applied = 0;
  for (const op of ops || []) {
    if (!op || typeof op !== "object") continue;
    if (op.type === "put") {
      const { coll, rec } = op;
      if (!SYNC_COLLS.includes(coll) || !rec || typeof rec.id !== "string" || !rec.id) continue;
      const key = coll + "/" + rec.id;
      const t = ts(rec.updatedAt);
      const cur = db.colls[coll][rec.id];
      if (cur && ts(cur.updatedAt) > t) continue;
      if (ts(db.tomb[key]) > t) continue;
      db.colls[coll][rec.id] = rec;
      delete db.tomb[key];
      applied++;
    } else if (op.type === "del") {
      const { coll, id } = op;
      if (!SYNC_COLLS.includes(coll) || typeof id !== "string" || !id) continue;
      const key = coll + "/" + id;
      const t = ts(op.t);
      const cur = db.colls[coll][id];
      if (cur && ts(cur.updatedAt) > t) continue;
      delete db.colls[coll][id];
      db.tomb[key] = Math.max(ts(db.tomb[key]), t);
      applied++;
    } else if (op.type === "settings") {
      const t = ts(op.t);
      if (!op.data || typeof op.data !== "object") continue;
      if (t < db.settingsT) continue;
      db.settings = op.data;
      db.settingsT = t;
      applied++;
    } else if (op.type === "replace") {
      const t = ts(op.t);
      const data = op.data || {};
      for (const c of SYNC_COLLS) {
        const next = {};
        for (const r of Array.isArray(data[c]) ? data[c] : []) if (r && typeof r.id === "string" && r.id) next[r.id] = r;
        for (const id of Object.keys(db.colls[c])) if (!next[id]) db.tomb[c + "/" + id] = Math.max(ts(db.tomb[c + "/" + id]), t);
        for (const id of Object.keys(next)) delete db.tomb[c + "/" + id];
        db.colls[c] = next;
      }
      if (data.settings && typeof data.settings === "object") { db.settings = data.settings; db.settingsT = Math.max(t, db.settingsT); }
      applied++;
    }
  }
  return applied;
}

/** Vue « liste » envoyée à l'app. */
export function snapshotOf(dbIn) {
  const db = normDb(dbIn);
  const out = { rev: db.rev, settings: db.settings, settingsT: db.settingsT };
  for (const c of SYNC_COLLS) out[c] = Object.values(db.colls[c]);
  return out;
}

/** Construit une base à partir d'une vue « liste » (côté app). */
export function dbFromSnapshot(snap) {
  const db = emptyDb();
  db.rev = ts(snap?.rev);
  db.settings = snap?.settings ?? null;
  db.settingsT = ts(snap?.settingsT);
  for (const c of SYNC_COLLS) for (const r of snap?.[c] || []) if (r && r.id) db.colls[c][r.id] = r;
  return db;
}
