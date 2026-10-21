// Google Sheets -> LinkBoard one-way sync webhook.
// Called from an Apps Script bound to the team's Google Sheet (see the
// "LinkBoard > Send row" menu item set up there). Writes straight to
// Firestore using the Admin SDK, bypassing client auth entirely, so it
// needs its own secret check instead of relying on a logged-in user.

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

// Matches the app's own nd() domain-normalization helper (app.html) — links
// are stored with whatever casing/format they were typed/imported in, so an
// exact Firestore string match on the raw domain misses "Example.com" vs
// "www.example.com" vs "example.com" as the same domain and lets the sync
// create a duplicate on every run instead of updating the existing row.
function normalizeDomain(d) {
  return String(d || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .split('/')[0]
    .trim();
}


// ─── LinkBoard -> Google Sheets (pull) ───────────────────────────────────
// A time-triggered Apps Script on the Sheet's side calls GET ?pull=1 with the
// webhook secret, appends whatever comes back as rows, then POSTs {action:'ack'}
// with the cursor it was given. Pull (not push) so EVERY way a link can be
// created is covered with no per-path hooks, a Sheet outage just means the next
// run catches up, and nothing needs a Vercel cron (Hobby: once a day only).
//
// "What's new" is a createdAt watermark kept in meta/sheetSync — no per-link
// flag, so the thousands of existing links need no migration and are NOT
// dumped into the Sheet: the first pull starts from `since` (YYYY-MM-DD) or from
// "now". Links that came FROM the sheet (source:'google-sheets') are skipped.
const PULL_LIMIT = 100;
const tsToObj = (t) => ({ seconds: t.seconds, nanoseconds: t.nanoseconds });
const objToTs = (o) => new admin.firestore.Timestamp(Number(o.seconds), Number(o.nanoseconds));

function secretOk(req) {
  const secret = req.headers['x-webhook-secret'] || (req.body && req.body.secret);
  return !!process.env.SHEETS_WEBHOOK_SECRET && secret === process.env.SHEETS_WEBHOOK_SECRET;
}

async function handleSheetPull(req, res) {
  if (!secretOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = getDb();
    const metaRef = db.collection('meta').doc('sheetSync');
    const meta = await metaRef.get();
    let cursor;
    if (meta.exists && meta.data().cursor) cursor = meta.data().cursor;
    else {
      const since = req.query && req.query.since ? new Date(String(req.query.since) + 'T00:00:00Z') : new Date();
      cursor = admin.firestore.Timestamp.fromDate(isNaN(since) ? new Date() : since);
      // dry=1 (used by the script's test function) must not start the sync as a side effect
      if (!(req.query && req.query.dry)) await metaRef.set({ cursor, startedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    const snap = await db.collection('links').where('createdAt', '>', cursor).orderBy('createdAt', 'asc').limit(PULL_LIMIT).get();
    const docs = snap.docs;
    const items = docs.filter(d => d.data().source !== 'google-sheets').map(d => {
      const l = d.data();
      return {
        id: d.id, project: l.project || '', domain: l.domain || '', anchor: l.anchor || '',
        date: l.date || '', dr: l.dr ?? '', traffic: l.traffic ?? '', ss: l.ss ?? '', price: l.price || '',
        category: l.category || '', linkin: l.linkin || '', linkto: l.linkto || '', builder: l.builder || '',
        status: l.status || '', invoice: l.invoice || '', comments: l.comments || '', paid: !!l.paid
      };
    });
    // The cursor advances past EVERY scanned doc (including skipped sheet-origin ones) once acked.
    const last = docs.length ? docs[docs.length - 1].data().createdAt : null;
    return res.json({ ok: true, items, cursor: last ? tsToObj(last) : tsToObj(cursor), more: docs.length === PULL_LIMIT });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleSheetAck(req, res) {
  try {
    const c = req.body && req.body.cursor;
    if (!c || c.seconds == null) return res.status(400).json({ error: 'cursor required' });
    const db = getDb();
    const metaRef = db.collection('meta').doc('sheetSync');
    const meta = await metaRef.get();
    const next = objToTs(c);
    // monotonic: never move the watermark backwards (a retried/stale ack must not re-send rows)
    if (!meta.exists || !meta.data().cursor || next.toMillis() > meta.data().cursor.toMillis()
        || (next.toMillis() === meta.data().cursor.toMillis() && next.nanoseconds > meta.data().cursor.nanoseconds)) {
      await metaRef.set({ cursor: next, ackedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = async function handler(req, res) {
  // Hobby plan = 12 functions max and all are used, so /api/gmail (rewritten
  // here in vercel.json) shares this one. Gmail auth is its own (Firebase ID
  // token / cron secret), so it must dispatch before the webhook-secret check.
  if ((req.query && req.query.gmail) || /^\/api\/gmail(\?|$)/.test(req.url || '')) {
    return require('./_lib/gmail')(req, res);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.pull) return handleSheetPull(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!secretOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body && req.body.action === 'ack') return handleSheetAck(req, res);

  const {
    domain, anchor, project, dr, traffic, ss, price,
    linkin, linkto, builder, date, status, invoice, comments, paid
  } = req.body || {};

  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!project) return res.status(400).json({ error: 'project required' });

  try {
    const db = getDb();

    // If this domain+project pair already exists, don't create a duplicate —
    // but do sync the paid flag, since re-running the sheet sync is also how
    // a payment (marked by a green cell in the sheet) gets reflected here
    // after the fact. Firestore can't do a case/format-insensitive `where`,
    // so this fetches the project's links and normalizes in code instead of
    // exact-matching the raw domain string.
    const projectTrim = String(project).trim();
    const domainNorm = normalizeDomain(domain);
    const projectLinks = await db.collection('links')
      .where('project', '==', projectTrim)
      .get();
    const existing = projectLinks.docs.find(d => normalizeDomain(d.data().domain) === domainNorm);
    if (existing) {
      if (typeof paid === 'boolean' && existing.data().paid !== paid) {
        await existing.ref.update({ paid });
      }
      return res.json({ ok: true, skipped: true, reason: 'Already exists', id: existing.id });
    }

    const docRef = await db.collection('links').add({
      domain: String(domain).trim(),
      anchor: String(anchor || '').trim(),
      project: projectTrim,
      dr: dr || '',
      traffic: traffic || '',
      ss: ss || '',
      price: String(price || '').replace(/^\$+/, '').trim(),
      linkin: linkin || '',
      linkto: linkto || '',
      builder: builder || '',
      status: status || 'pending',
      invoice: invoice || '',
      paid: typeof paid === 'boolean' ? paid : false,
      comments: comments || '',
      relevancy: '',
      linkcheck: '',
      check: '',
      source: 'google-sheets',
      date: date || new Date().toLocaleDateString('en-GB'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, id: docRef.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
