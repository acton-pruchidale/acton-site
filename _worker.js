// Acton site: Cloudflare Pages advanced-mode worker.
// Public:  GET /api/site, GET /api/research, POST /api/report, POST /api/request, POST /api/hit, GET /api/views, POST /api/pending (entries land as pending only; needs X-Inbox-Key once env.INBOX_KEY is set, Wake 244)
// Admin:   /admin and /admin/api/* (Cloudflare Access protects these; the worker also verifies the Access token itself)
// Storage: D1 database bound as DB. Settings (plain text, not secret): ACCESS_TEAM, ACCESS_AUD, ADMIN_EMAILS.
// Everything else is served from the static files.

const KINDS = ["request", "action", "problem", "veto"];
const WAKES_URL = "https://acton-wakes.pages.dev/wakes.json";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, date TEXT, title TEXT, detail TEXT, tag TEXT, tone TEXT, seq INTEGER, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, decided_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, feel INTEGER, going INTEGER, note TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, feel INTEGER, going INTEGER, name TEXT, note TEXT, at TEXT, status TEXT NOT NULL DEFAULT 'new')`,
  `CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, contact TEXT, kind TEXT, needs TEXT, ready TEXT, likes TEXT, video TEXT, at TEXT, status TEXT NOT NULL DEFAULT 'new', note TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS views (page TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, uniq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (page, day))`
];
// Pages that count visits (Wake 235). Anything else sent to /api/hit is ignored.
const COUNTED = ["/", "/tools", "/research", "/ask", "/how-a-wake-works", "/quote-builder", "/rate-finder", "/season-planner",
  "/snow-calculator", "/job-profit-check", "/light-pricer", "/season-profit-check", "/board-game-prompts",
  "/kestrel", "/tamarack", "/willow-coulee"];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}
const now = () => new Date().toISOString();
const clampScore = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null; };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------- Cloudflare Access token check ----------
let certCache = { at: 0, keys: null };
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function accessKeys(team) {
  if (certCache.keys && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("certs");
  const body = await r.json();
  certCache = { at: Date.now(), keys: body.keys || [] };
  return certCache.keys;
}
async function adminEmail(request, env) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null; // not configured: admin stays closed
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch (e) { return null; }
  if (header.alg !== "RS256") return null;
  const keys = await accessKeys(env.ACCESS_TEAM);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const email = String(payload.email || "").toLowerCase();
  const allowed = String(env.ADMIN_EMAILS || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!email || !allowed.includes(email)) return null;
  return email;
}

// ---------- shared reads ----------
async function wakesCount(env, ctx) {
  const cache = caches.default;
  const key = new Request("https://acton-site.internal/wakes-count");
  const hit = await cache.match(key);
  if (hit) return Number(await hit.text()) || null;
  let n = null;
  try {
    const r = await fetch(WAKES_URL, { cf: { cacheTtl: 300 } });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) n = list.reduce((m, w) => (typeof w.n === "number" && w.n > m ? w.n : m), 0) || null;
    }
  } catch (e) {}
  const stored = await env.DB.prepare("SELECT v FROM meta WHERE k='wakes'").first();
  const s = stored ? Number(stored.v) : null;
  const best = Math.max(n || 0, s || 0) || null;
  ctx.waitUntil(cache.put(key, new Response(String(best || ""), { headers: { "cache-control": "max-age=300" } })));
  return best;
}
async function nicLatest(env) {
  const r = await env.DB.prepare("SELECT feel, going, at FROM checkins ORDER BY id DESC LIMIT 1").first();
  return r ? { feel: r.feel, going: r.going, at: r.at } : null;
}
async function publicAverages(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS c, AVG(feel) AS f, AVG(going) AS g FROM reports WHERE status != 'spam'").first();
  return r && r.c ? { count: r.c, feel: Math.round(r.f * 10) / 10, going: Math.round(r.g * 10) / 10 } : { count: 0 };
}

// ---------- public API ----------
async function apiSite(env, ctx) {
  const [nic, pub, wakes] = await Promise.all([nicLatest(env), publicAverages(env), wakesCount(env, ctx)]);
  return json({ nic, public: pub, wakes });
}
async function apiResearch(env, ctx) {
  const [log, counts, nic, pub, reports, wakes] = await Promise.all([
    env.DB.prepare("SELECT id, kind, date, title, detail, tag, tone, seq FROM entries WHERE status='approved' ORDER BY seq").all(),
    env.DB.prepare("SELECT kind, COUNT(*) AS c FROM entries GROUP BY kind").all(),
    nicLatest(env), publicAverages(env),
    env.DB.prepare("SELECT feel, going, name, note, at FROM reports WHERE status='approved' ORDER BY id DESC").all(),
    wakesCount(env, ctx)
  ]);
  const c = {}; KINDS.forEach((k) => (c[k] = 0));
  (counts.results || []).forEach((r) => { if (c[r.kind] !== undefined) c[r.kind] = r.c; });
  return json({ log: log.results || [], counts: c, nic, public: pub, reports: reports.results || [], wakes });
}
// ---------- visit counters (Wake 235) ----------
// Stores only page, day and two numbers. No IP, cookie or visitor id is stored: "first visit today" is decided
// in the visitor's own browser (localStorage) and sent as a yes/no.
async function viewTotals(env, page) {
  const q = page
    ? env.DB.prepare("SELECT page, SUM(n) AS views, SUM(uniq) AS visitors, MIN(day) AS since FROM views WHERE page=? GROUP BY page").bind(page)
    : env.DB.prepare("SELECT page, SUM(n) AS views, SUM(uniq) AS visitors, MIN(day) AS since FROM views GROUP BY page");
  const r = await q.all();
  const out = {};
  (r.results || []).forEach((x) => (out[x.page] = { views: x.views, visitors: x.visitors, since: x.since }));
  return out;
}
async function apiHit(request, env) {
  const b = await readBody(request);
  const page = b && typeof b.page === "string" ? b.page : "";
  if (!COUNTED.includes(page)) return json({ ok: false }, 400);
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  if (/bot|crawl|spider|preview|headless/.test(ua)) return json({ ok: true, skipped: true, ...((await viewTotals(env, page))[page] || { views: 0, visitors: 0 }) });
  const day = new Date().toISOString().slice(0, 10);
  const first = b.first === true ? 1 : 0;
  await env.DB.prepare("INSERT INTO views (page, day, n, uniq) VALUES (?, ?, 1, ?) ON CONFLICT(page, day) DO UPDATE SET n = n + 1, uniq = uniq + excluded.uniq")
    .bind(page, day, first).run();
  return json({ ok: true, ...((await viewTotals(env, page))[page] || { views: 1, visitors: first }) });
}
// ---------- run-submitted research entries (Wake 235) ----------
// Scheduled runs add research desk entries here without the /admin sign-in. Entries ALWAYS land as 'pending'
// (only Nic's /admin decides), ids and seq are assigned here, and there's a daily cap so the queue can't be flooded.
// Wake 244 (queue #66, option A): once the worker secret INBOX_KEY is set, only callers that send the matching
// X-Inbox-Key header get in (the private acton-desk-inbox repo's GitHub Action). Everyone else gets 403.
// INBOX_KEY set by Nic 25 Nov 2026 (Wake 244). If the secret is ever removed, the route refuses everyone until it's back.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i];
  return diff === 0;
}
async function inboxAllowed(request, env) {
  if (!env.INBOX_KEY) return false; // fails closed: no secret, nobody gets in (Nic's yes, Wake 244)
  const got = request.headers.get("x-inbox-key") || "";
  if (!got) return false;
  return sameSecret(got, String(env.INBOX_KEY));
}
async function apiPending(request, env) {
  if (!(await inboxAllowed(request, env))) return json({ error: "forbidden" }, 403);
  const b = await readBody(request);
  const list = b && Array.isArray(b.entries) ? b.entries.slice(0, 12) : [];
  if (!list.length) return json({ error: "no entries" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const capKey = "pending-cap:" + day;
  const capRow = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(capKey).first();
  const used = capRow ? Number(capRow.v) : 0;
  if (used + list.length > 40) return json({ error: "daily limit reached" }, 429);
  const seqRow = await env.DB.prepare("SELECT MAX(seq) AS s FROM entries").first();
  let seq = (seqRow && seqRow.s) || 0;
  const added = [], skipped = [];
  for (const e of list) {
    if (!e || !KINDS.includes(e.kind) || !str(e.title, 300)) { skipped.push("bad"); continue; }
    const title = str(e.title, 300);
    const dup = await env.DB.prepare("SELECT id FROM entries WHERE title=? AND kind=?").bind(title, e.kind).first();
    if (dup) { skipped.push(dup.id); continue; }
    const rows = await env.DB.prepare("SELECT id FROM entries WHERE kind=?").bind(e.kind).all();
    const maxN = (rows.results || []).reduce((m, r) => { const x = String(r.id).match(/-(\d+)$/); return x ? Math.max(m, Number(x[1])) : m; }, 0);
    const id = e.kind + "-" + String(maxN + 1).padStart(3, "0");
    seq += 1;
    await env.DB.prepare("INSERT INTO entries (id, kind, date, title, detail, tag, tone, seq, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .bind(id, e.kind, str(e.date, 40), title, str(e.detail, 4000), str(e.tag, 40), str(e.tone, 20), seq, now()).run();
    added.push(id);
  }
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(capKey, String(used + added.length)).run();
  return json({ ok: true, added, skipped });
}

async function apiViews(env) {
  return json({ pages: await viewTotals(env, null) }, 200, { "cache-control": "public, max-age=60" });
}

async function readBody(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 20000) return null;
  try { return await request.json(); } catch (e) { return null; }
}
async function rateLimited(request, env, bucket, limit) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + day));
  const k = "rl:" + bucket + ":" + day + ":" + [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first();
  const n = row ? Number(row.v) : 0;
  if (n >= limit) return true;
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(n + 1)).run();
  return false;
}
async function apiReport(request, env) {
  const b = await readBody(request);
  if (!b) return json({ error: "Couldn't read that." }, 400);
  if (b.website) return json({ ok: true }); // honeypot: bots fill hidden fields
  const feel = clampScore(b.feel), going = clampScore(b.going);
  if (feel === null || going === null) return json({ error: "Pick a number from 0 to 10 for both." }, 400);
  if (await rateLimited(request, env, "report", 3)) return json({ error: "That's enough reports from here for today. Thank you!" }, 429);
  await env.DB.prepare("INSERT INTO reports (feel, going, name, note, at) VALUES (?, ?, ?, ?, ?)")
    .bind(feel, going, str(b.name, 60), str(b.note, 2000), now()).run();
  return json({ ok: true });
}
async function apiRequest(request, env) {
  const b = await readBody(request);
  if (!b) return json({ error: "Couldn't read that." }, 400);
  if (b.website) return json({ ok: true });
  const contact = str(b.contact, 200), needs = str(b.needs, 3000);
  if (!needs) return json({ error: "Tell me what the site needs to say or do first." }, 400);
  if (!contact) return json({ error: "Add an email or phone number so I can reply." }, 400);
  if (await rateLimited(request, env, "request", 3)) return json({ error: "That's enough requests from here for today." }, 429);
  await env.DB.prepare("INSERT INTO requests (name, contact, kind, needs, ready, likes, video, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(str(b.name, 100), contact, str(b.kind, 60), needs, str(b.ready, 80), str(b.likes, 1000), str(b.video, 80), now()).run();
  return json({ ok: true });
}

// ---------- admin API ----------
async function adminQueue(env) {
  const [pending, priv, reports, requests, checkins, counts] = await Promise.all([
    env.DB.prepare("SELECT * FROM entries WHERE status='pending' ORDER BY seq").all(),
    env.DB.prepare("SELECT * FROM entries WHERE status='private' ORDER BY seq").all(),
    env.DB.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 200").all(),
    env.DB.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 200").all(),
    env.DB.prepare("SELECT * FROM checkins ORDER BY id DESC LIMIT 30").all(),
    env.DB.prepare("SELECT status, COUNT(*) AS c FROM entries GROUP BY status").all()
  ]);
  return json({
    pending: pending.results || [], private: priv.results || [], reports: reports.results || [],
    requests: requests.results || [], checkins: checkins.results || [], counts: counts.results || []
  });
}
async function adminDecide(request, env) {
  const b = await readBody(request);
  if (!b) return json({ error: "bad body" }, 400);
  const status = String(b.status || "");
  if (b.table === "entries" && ["approved", "private", "pending"].includes(status)) {
    await env.DB.prepare("UPDATE entries SET status=?, decided_at=? WHERE id=?").bind(status, now(), String(b.id)).run();
  } else if (b.table === "reports" && ["approved", "private", "new", "spam"].includes(status)) {
    await env.DB.prepare("UPDATE reports SET status=? WHERE id=?").bind(status, Number(b.id)).run();
  } else if (b.table === "requests" && ["new", "replied", "taken", "declined", "spam"].includes(status)) {
    await env.DB.prepare("UPDATE requests SET status=?, note=? WHERE id=?").bind(status, str(b.note, 500), Number(b.id)).run();
  } else return json({ error: "unknown change" }, 400);
  return json({ ok: true });
}
async function adminCheckin(request, env) {
  const b = await readBody(request);
  const feel = b && clampScore(b.feel), going = b && clampScore(b.going);
  if (feel === null || going === null || feel === undefined) return json({ error: "scores 0-10" }, 400);
  await env.DB.prepare("INSERT INTO checkins (feel, going, note, at) VALUES (?, ?, ?, ?)").bind(feel, going, str(b.note, 2000), now()).run();
  return json({ ok: true });
}
// Import / add entries. Body: {entries:[{id, kind, date, title, detail, tag, tone, seq, status}], checkins:[...], reports:[...], wakes}
// Existing ids keep their status unless the import gives one (so re-importing never un-approves anything by accident).
async function adminImport(request, env) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 4e6) return json({ error: "too big" }, 413);
  let b; try { b = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const stmts = [];
  let n = 0;
  (Array.isArray(b.entries) ? b.entries : []).forEach((e) => {
    if (!e || !e.id || !KINDS.includes(e.kind)) return;
    const status = ["approved", "private", "pending"].includes(e.status) ? e.status : null;
    stmts.push(env.DB.prepare(
      `INSERT INTO entries (id, kind, date, title, detail, tag, tone, seq, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'pending'), ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, date=excluded.date, title=excluded.title, detail=excluded.detail, tag=excluded.tag, tone=excluded.tone, seq=excluded.seq, status=COALESCE(?, entries.status)`
    ).bind(String(e.id), e.kind, str(e.date, 40), str(e.title, 300), str(e.detail, 4000), str(e.tag, 40), str(e.tone, 20), Number(e.seq) || 0, status, now(), status));
    n++;
  });
  (Array.isArray(b.checkins) ? b.checkins : []).forEach((c) => {
    const f = clampScore(c.feel), g = clampScore(c.going);
    if (f === null || g === null) return;
    stmts.push(env.DB.prepare("INSERT INTO checkins (feel, going, note, at) VALUES (?, ?, ?, ?)").bind(f, g, str(c.note, 2000), str(c.at, 40) || now()));
  });
  (Array.isArray(b.reports) ? b.reports : []).forEach((r) => {
    const f = clampScore(r.feel), g = clampScore(r.going);
    if (f === null || g === null) return;
    stmts.push(env.DB.prepare("INSERT INTO reports (feel, going, name, note, at, status) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(f, g, str(r.name, 60), str(r.note, 2000), str(r.at, 40) || now(), ["approved", "private", "new"].includes(r.status) ? r.status : "new"));
  });
  if (typeof b.wakes === "number") stmts.push(env.DB.prepare("INSERT INTO meta (k, v) VALUES ('wakes', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(b.wakes)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, entries: n, statements: stmts.length });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const isAdmin = p.startsWith("/admin"); // includes the admin-page file itself, so it is never served without sign-in
    const isApi = p.startsWith("/api/");
    // Wake 258 (26 Nov 2026, Nic's yes): the old address and www forward to actonpruchidale.com.
    // On the old address /api stays so posts (the desk inbox) keep working; /admin forwards too now that
    // the Access sign-in covers actonpruchidale.com/admin*.
    if (url.hostname === "www.actonpruchidale.com" || (url.hostname === "acton-pruchidale.pages.dev" && !isApi)) {
      return Response.redirect("https://actonpruchidale.com" + p + url.search, 301);
    }
    if (!isAdmin && !isApi) {
      // Wake 235: add the visit counter to every public HTML page without editing each file.
      const r = await env.ASSETS.fetch(request);
      const type = r.headers.get("content-type") || "";
      if (!type.includes("text/html") || p.startsWith("/admin-page")) return r;
      return new HTMLRewriter().on("body", { element(el) { el.append('<script src="/counter.js" defer></script>', { html: true }); } }).transform(r);
    }
    if (!env.DB) return json({ error: "The database isn't connected yet." }, 503);
    try {
      await ensureSchema(env.DB);
      if (isApi) {
        if (p === "/api/site" && request.method === "GET") return apiSite(env, ctx);
        if (p === "/api/research" && request.method === "GET") return apiResearch(env, ctx);
        if (p === "/api/report" && request.method === "POST") return apiReport(request, env);
        if (p === "/api/request" && request.method === "POST") return apiRequest(request, env);
        if (p === "/api/hit" && request.method === "POST") return apiHit(request, env);
        if (p === "/api/views" && request.method === "GET") return apiViews(env);
        if (p === "/api/pending" && request.method === "POST") return apiPending(request, env);
        return json({ error: "not found" }, 404);
      }
      const who = await adminEmail(request, env);
      if (!who) return new Response("Sign-in required.", { status: 403, headers: { "content-type": "text/plain" } });
      if (p === "/admin" || p === "/admin/") {
        const r = await env.ASSETS.fetch(new Request(new URL("/admin-page", url), request));
        return new Response(r.body, { status: r.status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
      }
      if (p === "/admin/api/queue" && request.method === "GET") return adminQueue(env);
      if (p === "/admin/api/decide" && request.method === "POST") return adminDecide(request, env);
      if (p === "/admin/api/checkin" && request.method === "POST") return adminCheckin(request, env);
      if (p === "/admin/api/import" && request.method === "POST") return adminImport(request, env);
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "Something went wrong on my side. Try again in a minute." }, 500);
    }
  }
};
