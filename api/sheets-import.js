// Google Sheets -> LinkBoard one-way sync webhook.
// Called from an Apps Script bound to the team's Google Sheet (see the
// "LinkBoard > Send row" menu item set up there). Writes straight to
// Firestore using the Admin SDK, bypassing client auth entirely, so it
// needs its own secret check instead of relying on a logged-in user.

const admin = require('./_lib/firebase-admin');
const { isSafeHost } = require('./_lib/security');
const { checkLink } = require('./_lib/linkcheck');
const { fillMissingMetrics } = require('./_lib/ahrefs-metrics');
const { setCors, memberFromRequest } = require('./_lib/auth');

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

    // Projects the caller explicitly asked to create when missing (a visible Sheet tab with no LinkBoard
    // project yet) — so none of its rows are dropped. Only these exact names; never guessed.
    const createdProjects = [];
    const wanted = Array.isArray(req.body && req.body.createProjects) ? req.body.createProjects : [];
    for (const nm of wanted) {
      const name = String(nm || '').trim();
      if (!name || projectByNorm.has(normProject(name))) continue;
      if (!dry) await db.collection('projects').add({ name, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      projectByNorm.set(normProject(name), name);
      createdProjects.push(name);
    }

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
          date: fmtDmy(parseDmy(r.date)) || String(r.date || '').trim() || new Date().toLocaleDateString('en-GB')
        });
      }
    }

    // Rows from the Sheet often have no DR/Traffic — look those up on Ahrefs before saving.
    let metrics = null;
    if (!dry) metrics = await fillMissingMetrics(toCreate);

    if (!dry) {
      for (let i = 0; i < toCreate.length; i += 400) {
        const batch = db.batch();
        toCreate.slice(i, i + 400).forEach(doc => batch.set(db.collection('links').doc(), { ...doc, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
        await batch.commit();
      }
    }
    return res.json({
      ok: true, dry, scanned: rows.length, created: toCreate.length, skipped, metrics,
      unmatchedProjects: [...unmatched], createdProjects,
      sample: toCreate.slice(0, 15).map(d => ({ project: d.project, domain: d.domain, status: d.status, date: d.date }))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// dd/mm/yyyy | dd.mm.yyyy | dd-mm-yyyy -> Date (UTC midnight) or null
function parseDmy(v) {
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(String(v || '').trim());
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
  return isNaN(d) || d.getUTCMonth() !== Number(m[2]) - 1 ? null : d; // 31/02 or month 13 -> null, not a rollover
}
// Date -> dd/mm/yyyy, the one format LinkBoard stores (matches Add link and the app's normDate)
function fmtDmy(d) {
  if (!d) return '';
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
}
const DATE_SYNC_DAYS = 62; // only RECENT sheet dates are copied onto LinkBoard links; old history keeps its dates

// Sheet -> LinkBoard STATUS sync. Only ever changes the `status` field of a link that already
// exists (matched by project + domain); never creates or deletes. The Sheet script only sends a
// row when its section changed since the last run (`delta`) or on its first-ever run (catch-up);
// a catch-up never pushes a link LinkBoard has as live back to pending (the Sheet is probably stale).
// The Sheet's Date is when the link was placed / went live (the Report counts by it), LinkBoard's own
// Date can be older or blank: for links dated in the last DATE_SYNC_DAYS days the Sheet date is copied over
// (the old one is kept in prevDate), so the dashboard's "this month's builders" matches the Sheet.
async function handleUpdateStatus(req, res) {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    const dry = !!(req.body && req.body.dry);
    if (!rows.length) return res.status(400).json({ error: 'rows required' });
    if (rows.length > IMPORT_MAX_ROWS) return res.status(400).json({ error: 'max ' + IMPORT_MAX_ROWS + ' rows per request' });

    const db = getDb();
    const projSnap = await db.collection('projects').get();
    const projectByNorm = new Map();
    projSnap.docs.forEach(d => { const n = d.data().name; if (n) projectByNorm.set(normProject(n), n); });

    const byProject = new Map();
    const results = [];
    for (const r of rows) {
      const canon = projectByNorm.get(normProject(r.project));
      if (!canon) { results.push({ i: r.i, project: r.project, domain: r.domain, result: 'unknown-project' }); continue; }
      if (!byProject.has(canon)) byProject.set(canon, []);
      byProject.get(canon).push(r);
    }

    const updates = []; // { ref, status }
    for (const [project, list] of byProject) {
      const snap = await db.collection('links').where('project', '==', project).select('domain', 'status', 'anchor', 'linkin', 'date').get();
      const index = new Map();
      snap.docs.forEach(d => {
        const k = normalizeDomain(d.data().domain);
        if (!k) return;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(d);
      });
      for (const r of list) {
        const base = { i: r.i, project, domain: r.domain };
        if (!ALLOWED_STATUS.includes(r.status)) { results.push({ ...base, result: 'bad-status' }); continue; }
        let docs = index.get(normalizeDomain(r.domain)) || [];
        if (!docs.length) { results.push({ ...base, result: 'not-found' }); continue; }
        if (docs.length > 1) { // same domain twice in one project: narrow by anchor / link-in page, else refuse to guess
          const anchor = String(r.anchor || '').toLowerCase().trim();
          const linkin = String(r.linkin || '').toLowerCase().trim();
          const narrowed = docs.filter(d => {
            const x = d.data();
            return (anchor && String(x.anchor || '').toLowerCase().trim() === anchor) || (linkin && String(x.linkin || '').toLowerCase().trim() === linkin);
          });
          if (narrowed.length !== 1) { results.push({ ...base, result: 'ambiguous' }); continue; }
          docs = narrowed;
        }
        const d = docs[0];
        const from = d.data().status || 'pending';
        // date: copy a RECENT sheet date over a different / blank LinkBoard date (same separator style as the existing one)
        let newDate = null;
        const sd = parseDmy(r.date);
        if (sd && Date.now() - sd.getTime() <= DATE_SYNC_DAYS * 86400000 && sd.getTime() <= Date.now() + 86400000) {
          const cur = String(d.data().date || '').trim();
          const cd = parseDmy(cur);
          if (!cd || cd.getTime() !== sd.getTime()) {
            newDate = fmtDmy(sd);
          }
        }
        const statusChange = from !== r.status && !(!r.delta && from === 'live' && r.status === 'pending');
        if (from !== r.status && !statusChange) { // protected (catch-up never moves live back to pending)
          if (newDate) updates.push({ ref: d.ref, from, date: newDate, prevDate: String(d.data().date || '') });
          results.push({ ...base, result: 'protected', from, to: r.status, dateTo: newDate || undefined });
          continue;
        }
        if (!statusChange && !newDate) { results.push({ ...base, result: 'same', from }); continue; }
        updates.push({ ref: d.ref, from, ...(statusChange ? { status: r.status } : {}), ...(newDate ? { date: newDate, prevDate: String(d.data().date || '') } : {}) });
        results.push({ ...base, result: statusChange ? (dry ? 'would-update' : 'updated') : (dry ? 'would-date' : 'date-updated'), from, to: statusChange ? r.status : from, dateFrom: newDate ? String(d.data().date || '') : undefined, dateTo: newDate || undefined });
      }
    }

    if (!dry) {
      for (let i = 0; i < updates.length; i += 400) {
        const batch = db.batch();
        updates.slice(i, i + 400).forEach(u => {
          const upd = { statusSyncedAt: admin.firestore.FieldValue.serverTimestamp(), statusSource: 'google-sheets' };
          if (u.status) { upd.status = u.status; upd.prevStatus = u.from; }
          if (u.date) { upd.date = u.date; upd.prevDate = u.prevDate; }
          batch.update(u.ref, upd);
        });
        await batch.commit();
      }
    }
    const counts = {};
    results.forEach(r => { counts[r.result] = (counts[r.result] || 0) + 1; });
    return res.json({ ok: true, dry, scanned: rows.length, counts, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Check of PENDING links. For every pending link that has a Link in + Link to, looks at the page: if a
// real <a href> to the target is there (same test as the app's own "Check link" button) the link is
// marked live, flagged for the double-check queue (Mika + Tatev) like any other newly-live link, and
// Mika (admin), Tatev and the builder get a notification. Anything inconclusive (blocked, error, not
// found yet) is left pending, never touched. Links already checked since `since` are skipped and the
// oldest-checked go first, so repeated runs rotate through all of them.
async function checkPendingChunk(db, { since, limit, dry, budgetMs, concurrency }) {
  const snap = await db.collection('links').where('status', '==', 'pending')
    .select('linkin', 'linkto', 'anchor', 'project', 'domain', 'builder', 'pendingCheckedAt').get();
  const checkedAt = d => { const t = d.data().pendingCheckedAt; return t && t.toMillis ? t.toMillis() : 0; };
  const eligible = snap.docs.filter(d => { const x = d.data(); return /^https?:\/\//i.test(String(x.linkin || '').trim()) && x.linkto && isSafeHost(x.linkin); });
  const todo = eligible.filter(d => checkedAt(d) < since).sort((a, b) => checkedAt(a) - checkedAt(b));
  const batch = todo.slice(0, limit);

  const live = [], counts = { live: 0, 'not-found': 0, blocked: 0, error: 0 };
  const started = Date.now();
  let next = 0;
  async function worker() {
    while (next < batch.length && Date.now() - started < budgetMs) {
      const d = batch[next++];
      const x = d.data();
      let out;
      try { out = await checkLink({ linkIn: x.linkin, linkTo: x.linkto, anchor: x.anchor || '' }); }
      catch (e) { out = { result: '⚠️ Error', ok: null }; }
      const isLive = out.ok === true && String(out.result || '').includes('Live');
      const kind = isLive ? 'live' : (out.ok === false ? 'not-found' : (String(out.result || '').includes('Blocked') ? 'blocked' : 'error'));
      counts[kind]++;
      if (dry) { if (isLive) live.push({ project: x.project, domain: x.domain, linkin: x.linkin }); continue; }
      const ts = admin.firestore.FieldValue.serverTimestamp();
      if (isLive) {
        live.push({ project: x.project, domain: x.domain, linkin: x.linkin });
        await d.ref.update({ status: 'live', prevStatus: 'pending', needsDoubleCheck: true, linkcheck: out.result, pendingCheckedAt: ts, statusSource: 'auto-check', statusSyncedAt: ts });
        const recipients = new Set(['admin', 'tatev']); // Mika + Tatev do the double-check; recipient = lower-cased name (app.html listenNotifications)
        const b = String(x.builder || '').trim().toLowerCase();
        if (b) recipients.add(b);
        for (const recipient of recipients) {
          await db.collection('notifications').add({
            type: 'link-live', recipient, domain: x.domain || '', project: x.project || '', linkin: x.linkin || '',
            builder: x.builder || '', read: false, createdAt: ts
          });
        }
      } else {
        await d.ref.update({ pendingCheckedAt: ts, pendingCheck: out.result || '' });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const done = Math.min(next, batch.length);
  return { pending: snap.size, eligible: eligible.length, checked: done, remaining: Math.max(todo.length - done, 0), counts, live };
}

// Re-check of LIVE links, so a backlink that was removed after going live gets noticed. Rotates through
// them oldest-checked first (liveCheckedAt). A "not found / page gone" answer only counts as a strike:
// two in a row (separate runs, hours apart) flag the link `lostSuspect` and notify Mika + the builder.
// Status is never changed here — someone confirms with Re-check (which sets lost) or fixes the link.
// Blocked / server errors are inconclusive and leave the strikes alone; a live answer clears them.
const LOST_STRIKES = 2;
async function checkLiveChunk(db, { limit, budgetMs, concurrency }) {
  const snap = await db.collection('links').where('status', '==', 'live')
    .select('linkin', 'linkto', 'anchor', 'project', 'domain', 'builder', 'liveCheckedAt', 'lostStrikes', 'lostSuspect').get();
  const checkedAt = d => { const t = d.data().liveCheckedAt; return t && t.toMillis ? t.toMillis() : 0; };
  const batch = snap.docs
    .filter(d => { const x = d.data(); return /^https?:\/\//i.test(String(x.linkin || '').trim()) && x.linkto && isSafeHost(x.linkin); })
    .sort((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, limit);

  const counts = { live: 0, 'not-found': 0, inconclusive: 0, flagged: 0 };
  const started = Date.now();
  let next = 0;
  async function worker() {
    while (next < batch.length && Date.now() - started < budgetMs) {
      const d = batch[next++];
      const x = d.data();
      let out;
      try { out = await checkLink({ linkIn: x.linkin, linkTo: x.linkto, anchor: x.anchor || '' }); }
      catch (e) { out = { result: '⚠️ Error', ok: null }; }
      const ts = admin.firestore.FieldValue.serverTimestamp();
      if (out.ok === true) {
        counts.live++;
        await d.ref.update({ liveCheckedAt: ts, lostStrikes: 0, lostSuspect: false, linkcheck: out.result });
      } else if (out.ok === false) {
        counts['not-found']++;
        const strikes = (Number(x.lostStrikes) || 0) + 1;
        const flag = strikes >= LOST_STRIKES;
        await d.ref.update({ liveCheckedAt: ts, lostStrikes: strikes, lostCheck: out.result || '', ...(flag ? { lostSuspect: true } : {}) });
        if (flag && !x.lostSuspect) {
          counts.flagged++;
          const recipients = new Set(['admin']);
          const b = String(x.builder || '').trim().toLowerCase();
          if (b) recipients.add(b);
          for (const recipient of recipients) {
            await db.collection('notifications').add({
              type: 'link-lost', recipient, domain: x.domain || '', project: x.project || '', linkin: x.linkin || '',
              builder: x.builder || '', reason: out.result || '', read: false, createdAt: ts
            });
          }
        }
      } else {
        counts.inconclusive++;
        await d.ref.update({ liveCheckedAt: ts });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { live: snap.size, checked: Math.min(next, batch.length), counts };
}

// Apps Script / manual: POST {action:'check-pending'} with the webhook secret (chunked; the caller loops).
async function handleCheckPending(req, res) {
  try {
    const body = req.body || {};
    const r = await checkPendingChunk(getDb(), {
      since: Number(body.since) || Date.now(), limit: Math.min(Math.max(Number(body.limit) || 40, 1), 80),
      dry: !!body.dry, budgetMs: 35000, concurrency: 8
    });
    return res.json({ ok: true, dry: !!body.dry, ...r });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Automatic runs, built into LinkBoard (no Apps Script needed): /api/pendingcheck is hit by the daily
// Vercel cron (Bearer CRON_SECRET) and by the app itself when someone opens it (Firebase ID token).
// Hobby cron is once a day, so the app-open trigger adds the extra runs, throttled by meta/pendingCheck
// (at most one run per MIN_GAP_MS, claimed in a transaction so two open tabs can't both run).
const PENDING_MIN_GAP_MS = 7 * 60 * 60 * 1000;
async function handleAutoPendingCheck(req, res) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    const db = getDb();
    const isCronCall = !!(process.env.CRON_SECRET && m[1] === process.env.CRON_SECRET);
    if (!isCronCall) {
      // Must be a LinkBoard team member, not just any Firebase account.
      const member = await memberFromRequest(req).catch(() => null);
      if (!member) return res.status(401).json({ error: 'Unauthorized' });
    }
    const ref = db.collection('meta').doc('pendingCheck');
    const gap = isCronCall ? 2 * 60 * 60 * 1000 : PENDING_MIN_GAP_MS;
    const now = Date.now();
    const claimed = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const last = snap.exists && snap.data().lastRunAt && snap.data().lastRunAt.toMillis ? snap.data().lastRunAt.toMillis() : 0;
      if (now - last < gap) return false;
      tx.set(ref, { lastRunAt: admin.firestore.Timestamp.fromMillis(now), trigger: isCronCall ? 'cron' : 'app' }, { merge: true });
      return true;
    });
    if (!claimed) return res.json({ ok: true, skipped: true });
    const r = await checkPendingChunk(db, { since: now, limit: 150, dry: false, budgetMs: 20000, concurrency: 12 });
    // What's left of the 60s function goes to re-checking live links. Budget only stops new checks from
    // starting, and one in flight can take ~30s (fetch retry + bot-bypass), hence the margin.
    const liveBudget = Math.max(34000 - (Date.now() - now), 0);
    const lr = liveBudget > 4000 ? await checkLiveChunk(db, { limit: 80, budgetMs: liveBudget, concurrency: 10 }) : null;
    await ref.set({ lastResult: { checked: r.checked, remaining: r.remaining, live: r.counts.live, liveChecked: lr ? lr.checked : 0, lostFlagged: lr ? lr.counts.flagged : 0, finishedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    return res.json({ ok: true, ...r, liveRecheck: lr });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Public landing-page counters (index.html). Returns ONLY three numbers —
// never documents — so the landing page keeps its stats while Firestore
// itself stays closed to anyone who isn't a signed-in team member.
// Cached per instance for 10 minutes; Firestore count() is cheap anyway.
let statsCache = null;
async function handlePublicStats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!statsCache || Date.now() - statsCache.at > 10 * 60 * 1000) {
      const db = getDb();
      const [l, p, u] = await Promise.all([
        db.collection('links').where('status', '==', 'live').count().get(),
        db.collection('projects').count().get(),
        db.collection('users').count().get()
      ]);
      statsCache = { at: Date.now(), data: { links: l.data().count, projects: p.data().count, team: u.data().count } };
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(statsCache.data);
  } catch (e) {
    return res.status(500).json({ error: 'stats unavailable' });
  }
}

module.exports = async function handler(req, res) {
  // Hobby plan = 12 functions max and all are used, so /api/gmail (rewritten
  // here in vercel.json) shares this one. Gmail auth is its own (Firebase ID
  // token / cron secret), so it must dispatch before the webhook-secret check.
  if ((req.query && req.query.gmail) || /^\/api\/gmail(\?|$)/.test(req.url || '')) {
    return require('./_lib/gmail')(req, res);
  }
  if ((req.query && req.query.pendingcheck) || /^\/api\/pendingcheck(\?|$)/.test(req.url || '')) {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    return handleAutoPendingCheck(req, res);
  }
  if (req.query && req.query.stats) return handlePublicStats(req, res);
  // The Sheet webhook is called server-to-server by Apps Script (no browser),
  // so it needs no CORS at all — only the app's own origin gets headers.
  setCors(req, res, { headers: 'Content-Type, X-Webhook-Secret' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.pull) return handleSheetPull(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!secretOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body && req.body.action === 'ack') return handleSheetAck(req, res);
  if (req.body && req.body.action === 'import-rows') return handleImportRows(req, res);
  if (req.body && req.body.action === 'update-status') return handleUpdateStatus(req, res);
  if (req.body && req.body.action === 'check-pending') return handleCheckPending(req, res);

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

    // The Sheet row often has no DR/Traffic — look the missing ones up on Ahrefs.
    const metrics = { domain: String(domain).trim(), dr: dr || '', traffic: traffic || '' };
    await fillMissingMetrics([metrics], { budgetMs: 30000 });

    const docRef = await db.collection('links').add({
      domain: String(domain).trim(),
      anchor: String(anchor || '').trim(),
      project: projectTrim,
      dr: metrics.dr,
      traffic: metrics.traffic,
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
