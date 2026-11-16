'use strict';
// Jaco Ebertsohn S&C app server: serves the app, handles sign-in and stores data in Postgres.
// No web framework: Node's http module plus the `pg` driver.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const SEED = path.join(__dirname, '..', 'db', 'seed.json');
const COOKIE = 'je_sess';
const SESSION_DAYS = 30;
const LOCK = 7344101; // advisory lock id that keeps change numbers in commit order
const DOC_COLS = new Set(['exercises', 'athletes', 'programs', 'feedback', 'settings']);
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const USERNAME_RE = /^[a-z0-9._-]{2,30}$/;
const MIN_PW = 8;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/* ---------- passwords (scrypt, built into Node) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
function scrypt(pw, salt, o = SCRYPT) {
  return new Promise((res, rej) => crypto.scrypt(String(pw), salt, o.len, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, len: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
let DUMMY_HASH = null; // used to keep timing similar for unknown usernames

/* ---------- small helpers ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const newId = (prefix, bytes = 9) => prefix + crypto.randomBytes(bytes).toString('base64url');
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const userView = (id, data) => ({ id, name: data.name, username: data.username, role: data.role, athleteId: data.athleteId || null });

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function athleteIdFor(col, id, data) {
  if (col === 'athletes') return id;
  if (col === 'programs' || col === 'feedback' || col === 'users') return (data && typeof data.athleteId === 'string') ? data.athleteId : null;
  return null;
}

/* ---------- document store ---------- */
const ROW = 'col, id, data, rev, deleted';
async function putDoc(col, id, data) {
  const r = await db.query(
    `INSERT INTO docs (col, id, data, athlete_id, rev, deleted, updated_at)
     SELECT $1, $2, $3::jsonb, $4, nextval('doc_rev'), false, now() FROM (SELECT pg_advisory_xact_lock(${LOCK})) l
     ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data, athlete_id = EXCLUDED.athlete_id, rev = EXCLUDED.rev, deleted = false, updated_at = now()
     RETURNING ${ROW}`, [col, id, data, athleteIdFor(col, id, data)]);
  return clean(r.rows[0]);
}
async function patchDoc(col, id, partial) {
  const r = await db.query(
    `UPDATE docs d SET data = jsonb_deep_merge(d.data, $3::jsonb),
       athlete_id = CASE WHEN d.col = 'athletes' THEN d.id
                         WHEN d.col IN ('programs', 'feedback', 'users') THEN jsonb_deep_merge(d.data, $3::jsonb) ->> 'athleteId'
                         ELSE NULL END,
       rev = nextval('doc_rev'), updated_at = now()
     FROM (SELECT pg_advisory_xact_lock(${LOCK})) l
     WHERE d.col = $1 AND d.id = $2 AND NOT d.deleted
     RETURNING d.col, d.id, d.data, d.rev, d.deleted`, [col, id, partial]);
  if (!r.rows.length) throw new HttpError(404, 'not_found');
  return clean(r.rows[0]);
}
async function deleteDoc(col, id) {
  const r = await db.query(
    `UPDATE docs d SET deleted = true, data = '{}'::jsonb, rev = nextval('doc_rev'), updated_at = now()
     FROM (SELECT pg_advisory_xact_lock(${LOCK})) l
     WHERE d.col = $1 AND d.id = $2 AND NOT d.deleted
     RETURNING d.col, d.id, d.data, d.rev, d.deleted`, [col, id]);
  if (!r.rows.length) throw new HttpError(404, 'not_found');
  return clean(r.rows[0]);
}
async function getDoc(col, id) {
  const r = await db.query(`SELECT ${ROW}, athlete_id FROM docs WHERE col = $1 AND id = $2 AND NOT deleted`, [col, id]);
  return r.rows[0] || null;
}
const clean = row => row && ({ col: row.col, id: row.id, data: row.deleted ? null : row.data, rev: Number(row.rev), deleted: !!row.deleted });

// What a signed-in user may read. Coaches see everything; athletes see the
// exercise library, practice details, and only their own athlete record,
// programs, session feedback and login.
function readFilter(user, firstParam) {
  if (user.role === 'coach') return { sql: 'TRUE', params: [] };
  const a = `$${firstParam}`, u = `$${firstParam + 1}`;
  return {
    sql: `(col IN ('exercises', 'settings') OR (col IN ('athletes', 'programs', 'feedback') AND athlete_id = ${a}) OR (col = 'users' AND id = ${u}))`,
    params: [user.athleteId || '', user.id],
  };
}

/* ---------- sessions ---------- */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setCookie(req, res, value, maxAge) {
  const bits = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}
async function currentUser(req) {
  const tok = parseCookies(req)[COOKIE];
  if (!tok || tok.length > 100) return null;
  const r = await db.query(
    `SELECT d.id, d.data, s.token_hash FROM sessions s JOIN docs d ON d.col = 'users' AND d.id = s.user_id AND NOT d.deleted
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(tok)]);
  if (!r.rows.length) return null;
  return { ...userView(r.rows[0].id, r.rows[0].data), tokenHash: r.rows[0].token_hash };
}
async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'unauthenticated');
  return u;
}
async function requireCoach(req) {
  const u = await requireUser(req);
  if (u.role !== 'coach') throw new HttpError(403, 'forbidden');
  return u;
}

/* ---------- sign-in rate limit (per IP and per username) ---------- */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = { u: 10, ip: 30 }; // per username, and per network address (shared gym Wi-Fi etc.)
// Render adds the caller's address as the last X-Forwarded-For entry.
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
function limited(keys) {
  const now = Date.now();
  return keys.some(k => { const a = attempts.get(k); return a && a.until > now && a.n >= MAX_FAILS[k.split(':')[0]]; });
}
function failed(keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || a.until <= now) attempts.set(k, { n: 1, until: now + WINDOW });
    else a.n++;
  }
  if (attempts.size > 5000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
}

/* ---------- request plumbing ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 1024 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required');
  const buf = await readBody(req, limit);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { throw new HttpError(400, 'invalid_json'); }
}
function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
// Blocks cross-site form posts: writes must come from this site's own pages.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const gzCache = new Map();
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return notFound(res); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return notFound(res);
  let st;
  try { st = fs.statSync(file); } catch (e) { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const fresh = ext === '.html' || ext === '.webmanifest' || rel === '/sw.js';
  const headers = { 'Content-Type': type, 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=86400' };
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  headers.ETag = etag;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const text = /^(text\/|application\/(json|manifest)|image\/svg)/.test(type);
  if (text && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let gz = gzCache.get(file);
    if (!gz || gz.etag !== etag) { gz = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gzCache.set(file, gz); }
    headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : gz.buf);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(req)) throw new HttpError(403, 'bad_origin');

  if (p === '/api/settings' && m === 'GET') {
    const d = await getDoc('settings', 'app');
    const s = d ? d.data : {};
    // Public: only the practice details shown on the sign-in page.
    const tips = Array.isArray(s.tips) ? s.tips.filter(x => typeof x === 'string').slice(0, 60).map(x => x.slice(0, 220)) : [];
    return sendJson(res, 200, { settings: { practiceName: s.practiceName || '', coachName: s.coachName || '', tagline: s.tagline || '', phone: s.phone || '', email: s.email || '', website: s.website || '', tips, tipsByCoach: !!s.tipsByCoach } });
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req, 10 * 1024);
    const username = String(b.username || '').trim().toLowerCase(), password = String(b.password || '');
    const keys = ['ip:' + clientIp(req), 'u:' + username];
    if (limited(keys)) throw new HttpError(429, 'rate_limited');
    const r = await db.query(
      `SELECT d.id, d.data, c.pw_hash FROM docs d JOIN credentials c ON c.user_id = d.id
       WHERE d.col = 'users' AND NOT d.deleted AND lower(d.data ->> 'username') = $1`, [username]);
    const row = r.rows[0];
    const ok = await checkPassword(password, row ? row.pw_hash : DUMMY_HASH);
    if (!row || !ok || !username || !password) { failed(keys); throw new HttpError(401, 'bad_login'); }
    attempts.delete('u:' + username);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days') RETURNING user_id`, [sha256(token), row.id]);
    await db.query(`DELETE FROM sessions WHERE expires_at < now() RETURNING user_id`);
    setCookie(req, res, token, SESSION_DAYS * 86400);
    return sendJson(res, 200, { user: userView(row.id, row.data) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req)[COOKIE];
    if (tok) await db.query('DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id', [sha256(tok)]);
    setCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && m === 'GET') {
    const u = await requireUser(req);
    const { tokenHash, ...user } = u;
    return sendJson(res, 200, { user });
  }

  if (p === '/api/sync' && m === 'GET') {
    const u = await requireUser(req);
    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
    const f = readFilter(u, 2);
    // One statement, so the returned high-water mark matches the rows returned.
    const r = await db.query(
      `SELECT ${ROW}, (SELECT coalesce(max(rev), 0) FROM docs) AS maxrev FROM docs
       WHERE rev > $1 AND ($1 > 0 OR NOT deleted) AND ${f.sql} ORDER BY rev`, [since, ...f.params]);
    let rev = since;
    if (r.rows.length) rev = Number(r.rows[0].maxrev);
    else if (since === 0) rev = Number((await db.query('SELECT coalesce(max(rev), 0) AS m FROM docs')).rows[0].m);
    const docs = r.rows.map(row => {
      const d = clean(row);
      if (d.col === 'users' && d.data) d.data = { ...userView(d.id, d.data), createdAt: row.data.createdAt || null };
      return d;
    });
    return sendJson(res, 200, { rev, docs });
  }

  let mm = /^\/api\/docs\/([a-z]+)\/([^/]+)$/.exec(p);
  if (mm) {
    const col = mm[1];
    let id;
    try { id = decodeURIComponent(mm[2]); } catch (e) { throw new HttpError(400, 'bad_id'); }
    if (!DOC_COLS.has(col) || !ID_RE.test(id)) throw new HttpError(400, 'bad_id');
    if (col === 'settings' && id !== 'app') throw new HttpError(400, 'bad_id');
    const u = await requireUser(req);
    if (m === 'PUT') {
      const data = await readJson(req);
      if (!isObj(data)) throw new HttpError(400, 'invalid');
      delete data.id;
      if (u.role !== 'coach') {
        // Athletes may only add new session feedback for themselves.
        if (col !== 'feedback' || !u.athleteId || data.athleteId !== u.athleteId) throw new HttpError(403, 'forbidden');
        if (await getDoc(col, id)) throw new HttpError(403, 'forbidden');
      }
      return sendJson(res, 200, { doc: await putDoc(col, id, data) });
    }
    if (m === 'PATCH') {
      if (u.role !== 'coach') throw new HttpError(403, 'forbidden');
      const data = await readJson(req);
      if (!isObj(data)) throw new HttpError(400, 'invalid');
      delete data.id;
      return sendJson(res, 200, { doc: await patchDoc(col, id, data) });
    }
    if (m === 'DELETE') {
      if (u.role !== 'coach') throw new HttpError(403, 'forbidden');
      return sendJson(res, 200, { doc: await deleteDoc(col, id) });
    }
    throw new HttpError(405, 'method_not_allowed');
  }

  if (p === '/api/users' && m === 'POST') {
    await requireCoach(req);
    const b = await readJson(req, 10 * 1024);
    const name = String(b.name || '').trim().slice(0, 80);
    const username = String(b.username || '').trim().toLowerCase();
    const role = b.role === 'coach' ? 'coach' : 'athlete';
    const password = String(b.password || '');
    if (!name || !USERNAME_RE.test(username)) throw new HttpError(400, 'invalid');
    if (password.length < MIN_PW) throw new HttpError(400, 'weak_password');
    const data = { name, username, role, createdAt: new Date().toISOString() };
    if (role === 'athlete') {
      if (!b.athleteId || !(await getDoc('athletes', String(b.athleteId)))) throw new HttpError(400, 'invalid');
      data.athleteId = String(b.athleteId);
    }
    const taken = await db.query(`SELECT id FROM docs WHERE col = 'users' AND NOT deleted AND lower(data ->> 'username') = $1`, [username]);
    if (taken.rows.length) throw new HttpError(409, 'username_taken');
    let id = 'u-' + (slug(username) || 'user');
    if (await getDoc('users', id)) id = newId('u-');
    const hash = await hashPassword(password);
    await db.query(`INSERT INTO credentials (user_id, pw_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, updated_at = now() RETURNING user_id`, [id, hash]);
    try { await putDoc('users', id, data); }
    catch (e) { if (e.code === '23505') throw new HttpError(409, 'username_taken'); throw e; }
    return sendJson(res, 200, { user: userView(id, data) });
  }

  mm = /^\/api\/users\/([^/]+)\/password$/.exec(p);
  if (mm && m === 'POST') {
    const u = await requireUser(req);
    const id = decodeURIComponent(mm[1]);
    const b = await readJson(req, 10 * 1024);
    const password = String(b.password || '');
    if (u.role !== 'coach') {
      // Anyone may change their own password if they know the current one.
      if (id !== u.id) throw new HttpError(403, 'forbidden');
      const c = await db.query('SELECT pw_hash FROM credentials WHERE user_id = $1', [u.id]);
      if (!c.rows.length || !(await checkPassword(String(b.currentPassword || ''), c.rows[0].pw_hash))) throw new HttpError(403, 'wrong_password');
    }
    if (password.length < MIN_PW) throw new HttpError(400, 'weak_password');
    if (!(await getDoc('users', id))) throw new HttpError(404, 'not_found');
    const hash = await hashPassword(password);
    await db.query(`INSERT INTO credentials (user_id, pw_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, updated_at = now() RETURNING user_id`, [id, hash]);
    // Sign the person out everywhere else.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING user_id', [id, u.tokenHash]);
    return sendJson(res, 200, { ok: true });
  }

  mm = /^\/api\/users\/([^/]+)$/.exec(p);
  if (mm && m === 'DELETE') {
    const u = await requireCoach(req);
    const id = decodeURIComponent(mm[1]);
    if (id === u.id) throw new HttpError(400, 'cannot_remove_self');
    const doc = await deleteDoc('users', id);
    await db.query('DELETE FROM credentials WHERE user_id = $1 RETURNING user_id', [id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 RETURNING user_id', [id]);
    return sendJson(res, 200, { doc });
  }

  if (p === '/api/blobs' && m === 'POST') {
    const u = await requireCoach(req);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw new HttpError(415, 'image_required');
    const buf = await readBody(req, 8 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, 'empty');
    const id = newId('b');
    await db.query(`INSERT INTO blobs (id, mime, bytes, created_by) VALUES ($1, $2, decode($3, 'base64'), $4) RETURNING id`, [id, type, buf.toString('base64'), u.id]);
    return sendJson(res, 200, { id });
  }

  throw new HttpError(404, 'not_found');
}

async function blob(req, res, id) {
  await requireUser(req);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return notFound(res);
  const r = await db.query(`SELECT mime, encode(bytes, 'base64') AS b64 FROM blobs WHERE id = $1`, [id]);
  if (!r.rows.length) return notFound(res);
  const buf = Buffer.from(r.rows[0].b64, 'base64');
  res.writeHead(200, { 'Content-Type': r.rows[0].mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, 'http://local'); } catch (e) { res.writeHead(400); return res.end(); }
  securityHeaders(req, res);
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/_blob/')) {
      let id = '';
      try { id = decodeURIComponent(url.pathname.slice(7)); } catch (e) { return notFound(res); }
      return await blob(req, res, id);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 401 && url.pathname.startsWith('/_blob/')) { res.writeHead(401); return res.end(); }
      return sendJson(res, e.status, { error: e.code });
    }
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  } finally {
    if (url.pathname.startsWith('/api/') && process.env.LOG_REQUESTS) console.log(req.method, url.pathname, res.statusCode, Date.now() - started + 'ms');
  }
});

/* ---------- start-up: schema, then first-run data ---------- */
async function seedIfEmpty() {
  const r = await db.query(`SELECT count(*)::int AS n FROM docs WHERE col = 'users'`);
  if (r.rows[0].n > 0 || !fs.existsSync(SEED)) return;
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  let n = 0;
  if (seed.settings) { await putDoc('settings', 'app', seed.settings); n++; }
  for (const col of ['exercises', 'athletes', 'programs', 'feedback']) {
    for (const d of seed[col] || []) { const { id, ...data } = d; await putDoc(col, id, data); n++; }
  }
  const pw = process.env.SEED_PASSWORD || 'admin';
  for (const u of seed.users || []) {
    const data = { name: u.name, username: u.username, role: u.role, createdAt: u.createdAt || new Date().toISOString() };
    if (u.athleteId) data.athleteId = u.athleteId;
    await db.query(`INSERT INTO credentials (user_id, pw_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [u.id, await hashPassword(pw)]);
    await putDoc('users', u.id, data); n++;
  }
  console.log(`Seeded ${n} records from db/seed.json`);
}

async function main() {
  if (db.schema) await db.query(`CREATE SCHEMA IF NOT EXISTS ${db.schema}`);
  // Refuse to start if tables would land outside the app's own schema.
  const cur = (await db.query('SELECT current_schema() AS s')).rows[0].s;
  if (db.schema && cur !== db.schema) throw new Error(`Expected schema ${db.schema}, connected to ${cur}`);
  await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await seedIfEmpty();
  DUMMY_HASH = await hashPassword(crypto.randomBytes(12).toString('hex'));
  server.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT} (db: ${db.kind}${db.schema ? ', schema ' + db.schema : ''})`));
}
main().catch(e => { console.error('Start-up failed:', e); process.exit(1); });

module.exports = { server };
