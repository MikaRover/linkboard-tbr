// Gmail "emails sent per day" tracking.
//
// Each team member connects their own Gmail once (Google OAuth, read-only
// *metadata* scope — headers and labels only, LinkBoard can never read a
// message body). A sync then counts messages in their SENT label per UTC day
// and stores the totals in Firestore `emailCounts/{date}_{name}`.
//
// Lives in api/_lib (not api/) because the Vercel Hobby plan caps the number
// of serverless functions and every slot is taken — api/sheets-import.js
// dispatches here for /api/gmail.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_TOKEN_KEY (any long
// random string — encrypts refresh tokens + signs OAuth state), CRON_SECRET
// (Vercel Cron sends it as a Bearer token), FIREBASE_SERVICE_ACCOUNT.
// Optional: GMAIL_REDIRECT_URI (defaults to https://<host>/api/gmail),
// GMAIL_INTERNAL_DOMAINS (comma list, default thebusinessrover.com — mail
// only to these domains is not counted as outreach).

const admin = require('firebase-admin');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const DAY = 86400000;
const MAX_MESSAGES_PER_USER = 1500;
const SYNC_BUDGET_MS = 50000;

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(name + ' not configured');
  return v;
}

// ─── crypto helpers ──────────────────────────────────────
function key() { return crypto.createHash('sha256').update(need('GMAIL_TOKEN_KEY')).digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function signState(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  return body + '.' + sig;
}
function readState(s) {
  const [body, sig] = String(s || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return obj.exp > Date.now() ? obj : null;
  } catch (e) { return null; }
}

// ─── auth ────────────────────────────────────────────────
async function userFromRequest(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const a = getAdmin();
  let decoded;
  try { decoded = await a.auth().verifyIdToken(m[1]); } catch (e) { return null; }
  const snap = await a.firestore().collection('users').doc(decoded.uid).get();
  if (!snap.exists) return null;
  const u = snap.data();
  return { uid: decoded.uid, name: u.name || (decoded.email || '').split('@')[0], role: u.role || 'builder' };
}
function isCron(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!(m && process.env.CRON_SECRET && m[1] === process.env.CRON_SECRET);
}

function redirectUri(req) {
  return process.env.GMAIL_REDIRECT_URI || `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/gmail`;
}

// ─── Google calls ────────────────────────────────────────
async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: need('GOOGLE_CLIENT_ID'), client_secret: need('GOOGLE_CLIENT_SECRET'), ...params })
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error_description || j.error || 'token error'); e.code = j.error; throw e; }
  return j;
}

async function gmailGet(path, accessToken) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('Gmail ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

function internalDomains() {
  return String(process.env.GMAIL_INTERNAL_DOMAINS || 'thebusinessrover.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}
function recipientDomains(headers) {
  const out = [];
  (headers || []).forEach(h => {
    if (!/^(to|cc|bcc)$/i.test(h.name)) return;
    (String(h.value).match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) || []).forEach(a => out.push(a.split('@')[1].toLowerCase()));
  });
  return out;
}

async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

// Counts SENT messages since `sinceMs` (a UTC day boundary, so every day
// touched is counted completely) and overwrites those days' totals — safe to
// re-run, never double counts.
async function syncOne(conn, secretDoc, sinceMs, deadline) {
  const db = getAdmin().firestore();
  const refresh = decrypt(secretDoc.refreshTokenEnc);
  let access;
  try { access = (await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })).access_token; }
  catch (e) {
    if (e.code === 'invalid_grant') {
      await db.collection('gmailConnections').doc(conn.uid).set({ lastError: 'Access revoked — reconnect Gmail', lastErrorAt: Date.now() }, { merge: true });
    }
    throw e;
  }

  const internal = internalDomains();
  const days = {}; // 'YYYY-MM-DD' -> {sent, external, newThreads}
  let seen = 0, pageToken = '', reachedOld = false;
  while (!reachedOld && seen < MAX_MESSAGES_PER_USER && Date.now() < deadline) {
    const list = await gmailGet('messages?labelIds=SENT&maxResults=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), access);
    const ids = (list.messages || []).map(m => m.id);
    if (!ids.length) break;
    const msgs = await inChunks(ids, 10, id =>
      gmailGet(`messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&fields=id,threadId,internalDate,payload/headers`, access).catch(() => null));
    for (const m of msgs) {
      if (!m) continue;
      seen++;
      const t = Number(m.internalDate);
      if (t < sinceMs) { reachedOld = true; continue; }
      const d = new Date(t).toISOString().slice(0, 10);
      const rec = days[d] = days[d] || { sent: 0, external: 0, newThreads: 0 };
      rec.sent++;
      const isExternal = recipientDomains(m.payload && m.payload.headers).some(x => !internal.includes(x));
      if (isExternal) { rec.external++; if (m.threadId === m.id) rec.newThreads++; }
    }
    pageToken = list.nextPageToken || '';
    if (!pageToken) break;
  }

  // Write every day in range (zeros included) so a day that lost messages
  // since the last sync is corrected too.
  const nowMs = Date.now();
  const batch = db.batch();
  for (let t = sinceMs; t <= nowMs; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    const rec = days[d] || { sent: 0, external: 0, newThreads: 0 };
    batch.set(db.collection('emailCounts').doc(d + '_' + conn.name.replace(/[^\w.-]/g, '_')), {
      builder: conn.name, date: d, ...rec, source: 'gmail', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  batch.set(db.collection('gmailConnections').doc(conn.uid), {
    lastSyncAt: nowMs, lastSyncDay: new Date(nowMs).toISOString().slice(0, 10), lastError: null, truncated: seen >= MAX_MESSAGES_PER_USER
  }, { merge: true });
  await batch.commit();
  return { name: conn.name, messages: seen };
}

function startOfDay(ms) { return Math.floor(ms / DAY) * DAY; }

async function syncAll({ onlyUid, days }) {
  const db = getAdmin().firestore();
  const deadline = Date.now() + SYNC_BUDGET_MS;
  let conns = (await db.collection('gmailConnections').get()).docs.map(d => ({ uid: d.id, ...d.data() }));
  if (onlyUid) conns = conns.filter(c => c.uid === onlyUid);
  const results = [];
  await inChunks(conns, 3, async conn => {
    try {
      const sec = await db.collection('gmailSecrets').doc(conn.uid).get();
      if (!sec.exists) throw new Error('no stored token');
      const backfill = Math.min(Math.max(parseInt(days) || 0, 0), 60);
      // Normal run: re-count from the last synced day (so today is always
      // refreshed). Manual/backfill run or first sync: go back N days.
      let since;
      if (backfill) since = startOfDay(Date.now() - (backfill - 1) * DAY);
      else if (conn.lastSyncDay) since = Math.max(Date.parse(conn.lastSyncDay + 'T00:00:00Z'), startOfDay(Date.now() - 59 * DAY));
      else since = startOfDay(Date.now() - 13 * DAY);
      results.push(await syncOne(conn, sec.data(), since, deadline));
    } catch (e) {
      results.push({ name: conn.name, error: e.message });
    }
  });
  return results;
}

// ─── HTTP handler ────────────────────────────────────────
module.exports = async function gmailHandler(req, res) {
  const q = req.query || {};
  const action = q.action || (q.code || q.error ? 'callback' : '');
  try {
    // OAuth redirect back from Google — a browser navigation, no bearer header.
    if (action === 'callback') {
      const state = readState(q.state);
      const ret = state && /^\/[^/\\]/.test(state.ret || '') ? state.ret : '/app.html';
      const go = (flag) => { res.statusCode = 302; res.setHeader('Location', ret + (ret.includes('?') ? '&' : '?') + 'gmail=' + flag); res.end(); };
      if (!state || q.error || !q.code) return go(q.error === 'access_denied' ? 'denied' : 'error');
      try {
      const tok = await tokenRequest({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri(req) });
      if (!tok.refresh_token || !String(tok.scope || '').includes('gmail.metadata')) return go('error');
      let email = '';
      try {
        const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
        email = info.email || '';
      } catch (e) {}
      const db = getAdmin().firestore();
      await db.collection('gmailSecrets').doc(state.uid).set({ refreshTokenEnc: encrypt(tok.refresh_token) });
      await db.collection('gmailConnections').doc(state.uid).set({
        uid: state.uid, name: state.name, email, connectedAt: Date.now(), lastSyncAt: null, lastSyncDay: null, lastError: null
      });
      // First data straight away: backfill two weeks so the admin page isn't empty.
      try { await syncAll({ onlyUid: state.uid, days: 14 }); } catch (e) {}
      return go('connected');
      } catch (e) { return go('error'); }
    }

    if (action === 'connect') {
      const u = await userFromRequest(req);
      if (!u) return res.status(401).json({ error: 'Unauthorized' });
      const ret = /^\/[^/\\]/.test(q.ret || '') ? q.ret : '/app.html';
      const params = new URLSearchParams({
        client_id: need('GOOGLE_CLIENT_ID'), redirect_uri: redirectUri(req), response_type: 'code',
        scope: SCOPE + ' openid email', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
        state: signState({ uid: u.uid, name: u.name, ret, exp: Date.now() + 15 * 60000 })
      });
      return res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
    }

    if (action === 'disconnect') {
      const u = await userFromRequest(req);
      if (!u) return res.status(401).json({ error: 'Unauthorized' });
      const db = getAdmin().firestore();
      const sec = await db.collection('gmailSecrets').doc(u.uid).get();
      if (sec.exists) {
        try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(decrypt(sec.data().refreshTokenEnc)), { method: 'POST' }); } catch (e) {}
      }
      await db.collection('gmailSecrets').doc(u.uid).delete();
      await db.collection('gmailConnections').doc(u.uid).delete();
      return res.json({ ok: true });
    }

    if (action === 'sync') {
      let onlyUid = q.uid || '';
      if (!isCron(req)) {
        const u = await userFromRequest(req);
        if (!u) return res.status(401).json({ error: 'Unauthorized' });
        if (u.role !== 'admin') onlyUid = u.uid; // builders can only refresh themselves
      }
      const results = await syncAll({ onlyUid, days: q.days });
      return res.json({ ok: true, results });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
