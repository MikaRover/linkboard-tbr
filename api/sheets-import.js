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

// ─── Google Sheets -> LinkBoard (batch, create-only) ─────────────────────
// A scheduled Apps Script scans the board and sends the rows it hasn't sent
// before. Existing links are never modified here (that's the single-row path
// above for `paid`); only links LinkBoard doesn't have yet are created.
//   - project names are resolved case/punctuation-insensitively against the real
//     `projects` collection ("Novisign" -> "NoviSign"); an unknown project is
//     REPORTED, never created — a typo'd tab must not spawn a phantom project;
//   - duplicates (same normalized domain in the same project) are skipped,
//     both against what's stored and within the request itself;
//   - `dry:true` computes everything and writes nothing (used for the first look).
const IMPORT_MAX_ROWS = 500;
const ALLOWED_STATUS = ['live', 'pending', 'needs-change', 'lost', 'rejected'];
const normProject = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function handleImportRows(req, res) {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    const dry = !!(req.body && req.body.dry);
    if (!rows.length) return res.status(400).json({ error: 'rows required' });
    if (rows.length > IMPORT_MAX_ROWS) return res.status(400).json({ error: 'max ' + IMPORT_MAX_ROWS + ' rows per request' });

    const db = getDb();
    const projSnap = await db.collection('projects').get();
    const projectByNorm = new Map();
    projSnap.docs.forEach(d => { const n = d.data().name; if (n) projectByNorm.set(normProject(n), n); });

    const unmatched = new Set();
    const byProject = new Map(); // canonical project -> rows
    for (const r of rows) {
      const canon = projectByNorm.get(normProject(r.project));
      if (!canon || !r.domain) { if (!canon && r.project) unmatched.add(String(r.project)); continue; }
      if (!byProject.has(canon)) byProject.set(canon, []);
      byProject.get(canon).push(r);
    }

    const toCreate = [];
    let skipped = 0;
    for (const [project, list] of byProject) {
      // one field-masked read per project per request
      const existing = await db.collection('links').where('project', '==', project).select('domain').get();
      const have = new Set(existing.docs.map(d => normalizeDomain(d.data().domain)));
      for (const r of list) {
        const key = normalizeDomain(r.domain);
        if (!key || have.has(key)) { skipped++; continue; }
        have.add(key); // duplicate rows inside the same request
        const status = ALLOWED_STATUS.includes(r.status) ? r.status : 'pending';
        toCreate.push({
          domain: String(r.domain).trim(), anchor: String(r.anchor || '').trim(), project,
          dr: r.dr === 0 || r.dr ? String(r.dr) : '', traffic: r.traffic === 0 || r.traffic ? String(r.traffic) : '', ss: r.ss === 0 || r.ss ? String(r.ss) : '',
          price: String(r.price || '').replace(/^\$+/, '').trim(),
          linkin: r.linkin || '', linkto: r.linkto || '', builder: r.builder || '', status,
          invoice: r.invoice || '', paid: typeof r.paid === 'boolean' ? r.paid : false, comments: r.comments || '',
          relevancy: '', linkcheck: '', check: '', source: 'google-sheets',
          date: r.date || new Date().toLocaleDateString('en-GB')
        });
      }
    }

    if (!dry) {
      for (let i = 0; i < toCreate.length; i += 400) {
        const batch = db.batch();
        toCreate.slice(i, i + 400).forEach(doc => batch.set(db.collection('links').doc(), { ...doc, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
        await batch.commit();
      }
    }
    return res.json({
      ok: true, dry, scanned: rows.length, created: toCreate.length, skipped,
      unmatchedProjects: [...unmatched],
      sample: toCreate.slice(0, 15).map(d => ({ project: d.project, domain: d.domain, status: d.status, date: d.date }))
    });
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
  if (req.body && req.body.action === 'import-rows') return handleImportRows(req, res);

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
