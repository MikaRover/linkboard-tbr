// Outreach Agent — admin-only.
//
// The admin pastes websites; the page finds a contact per site with the
// existing /api/scrape-contacts and /api/snov, then this module stores the
// rows, asks Claude for a personalised draft, sends a reviewed draft from the
// admin's own Gmail (needs the gmail.send scope — "Connect Gmail for sending"
// on the Agent page), and later marks it replied/bounced by reading only the
// thread's From headers (metadata scope, never the message text).
//
// Every row lives in Firestore `outreachAgent` and is read/written only here
// (Admin SDK) — the collection is closed to the browser in firestore.rules.
//
// Nothing is ever sent without an explicit click: `send` takes one row id
// plus the exact address the admin saw, and refuses if the row changed, the
// address was already contacted, it failed verification, or the mailbox hit
// its daily limit.
//
// Lives in api/_lib (Hobby plan: all 12 function slots are taken) —
// api/sheets-import.js dispatches /api/outreach here.
//
// Env: ANTHROPIC_API_KEY, plus everything api/_lib/gmail.js needs.
// Optional: OUTREACH_DAILY_LIMIT (per mailbox, default 30), OUTREACH_MIN_GAP_SEC
// (minimum seconds between two emails from one mailbox, default 240).

const { setCors, requireMember } = require('./auth');
const { isSafeHost, cleanHost, browserHeaders } = require('./security');
const { getAdmin, decrypt, tokenRequest, gmailGet, mailboxId } = require('./gmail').internals;

const COLL = 'outreachAgent';
const DAY = 86400000;
const DAILY_LIMIT = Math.max(1, parseInt(process.env.OUTREACH_DAILY_LIMIT, 10) || 30);
const RECONTACT_DAYS = 90;   // never email the same address or site again within this window
const TRACK_DAYS = 45;       // stop checking a thread for replies after this long
const MAX_ROWS = 300;        // per save call
// Several wordings so the footer isn't an identical fingerprint on every email.
const OPT_OUTS = [
  "P.S. If you'd rather not hear from me, just reply \"no\" and I won't email you again.",
  "If this isn't of interest, just reply \"no\" and I won't follow up.",
  "Not interested? A quick \"no\" is fine and I won't contact you again.",
  "If you'd prefer no further emails, simply reply \"no\" and I'll take you off my list."
];
const hasOptOut = body => OPT_OUTS.some(o => body.includes(o));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
// Minimum time between two emails from the same mailbox (the page waits a
// random 4–5 min; this is the hard floor even with two tabs or a single Send).
const MIN_GAP_MS = Math.max(0, parseInt(process.env.OUTREACH_MIN_GAP_SEC, 10) || 240) * 1000;

// Each draft gets a random angle, greeting and sign-off, so a batch never
// reads like one template — repeated identical text is a strong spam signal.
const STYLES = [
  'Open with one short, specific observation about an article or section of their site, then make the ask.',
  'Open directly with who you are and why you are writing; brisk and businesslike.',
  'Open with a short question about their site or audience, then make the ask.',
  'Very short: 50–80 words, friendly and to the point.',
  'Warm and conversational; mention their readers and why the article would suit them.',
  'Structured: one line of context, one line with the request, one closing question.'
];
const GREETINGS = ['Hi', 'Hello', 'Hey', 'Good day'];
const SIGNOFFS = ['Best', 'Thanks', 'Kind regards', 'Cheers', 'Best regards', 'Thank you'];
const SUBJECT_STYLES = [
  'a short question', 'a plain statement mentioning their site name', 'two or three words, lowercase is fine',
  'mention the topic of the article', 'a polite request'
];

// Fields the browser may set. Status values that mean "an email went out"
// (sent/replied/bounced) are server-only, so a page can't fake a send.
const EDITABLE = ['domain', 'name', 'firstName', 'title', 'email', 'smtp', 'source', 'candidates', 'subject', 'body', 'skipReason', 'note', 'batch'];
const CLIENT_STATUSES = ['found', 'nocontact', 'draft', 'skipped'];

const db = () => getAdmin().firestore();
const FieldValue = () => require('./firebase-admin').firestore.FieldValue;
const today = () => new Date().toISOString().slice(0, 10);
const isEmail = e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(String(e || ''));
const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();

function clean(item) {
  const out = {};
  EDITABLE.forEach(k => { if (item[k] !== undefined) out[k] = item[k]; });
  if (out.domain !== undefined) out.domain = cleanHost(out.domain);
  if (out.email !== undefined) out.email = String(out.email || '').trim().toLowerCase();
  if (out.candidates !== undefined) out.candidates = (Array.isArray(out.candidates) ? out.candidates : []).slice(0, 12);
  ['subject', 'body', 'name', 'firstName', 'title', 'note', 'skipReason'].forEach(k => { if (out[k] !== undefined) out[k] = String(out[k] || '').slice(0, k === 'body' ? 6000 : 300); });
  if (item.status !== undefined && CLIENT_STATUSES.includes(item.status)) out.status = item.status;
  return out;
}

// ─── list / save / delete ────────────────────────────────
async function list(uid) {
  const snap = await db().collection(COLL).where('ownerUid', '==', uid).get();
  const rows = snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, ...x, createdAt: x.createdAt?.toMillis?.() || null, updatedAt: x.updatedAt?.toMillis?.() || null };
  });
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

async function save(uid, items) {
  const col = db().collection(COLL);
  const now = FieldValue().serverTimestamp();
  const ids = [];
  const batch = db().batch();
  for (const item of (items || []).slice(0, MAX_ROWS)) {
    const data = clean(item || {});
    if (item.id) {
      const ref = col.doc(String(item.id));
      const cur = await ref.get();
      if (!cur.exists || cur.data().ownerUid !== uid) continue;
      // A row that already went out is a record — only its note can change.
      if (['sent', 'sending', 'replied', 'bounced'].includes(cur.data().status)) {
        if (data.note !== undefined) batch.update(ref, { note: data.note, updatedAt: now });
        ids.push(ref.id);
        continue;
      }
      batch.update(ref, { ...data, updatedAt: now });
      ids.push(ref.id);
    } else {
      if (!data.domain) continue;
      const ref = col.doc();
      batch.set(ref, { status: 'found', ...data, ownerUid: uid, createdAt: now, updatedAt: now });
      ids.push(ref.id);
    }
  }
  await batch.commit();
  return ids;
}

async function remove(uid, ids) {
  const batch = db().batch();
  const deleted = [];
  for (const id of (ids || []).slice(0, MAX_ROWS)) {
    const ref = db().collection(COLL).doc(String(id));
    const cur = await ref.get();
    // Emailed rows stay: they are what stops the agent emailing someone twice.
    if (cur.exists && cur.data().ownerUid === uid && !['sent', 'sending', 'replied', 'bounced'].includes(cur.data().status)) { batch.delete(ref); deleted.push(ref.id); }
  }
  await batch.commit();
  return deleted;
}

// ─── mailboxes ───────────────────────────────────────────
async function mailboxes(uid) {
  const snap = await db().collection('gmailConnections').where('ownerUid', '==', uid).get();
  const sentToday = await db().collection(COLL).where('sentDay', '==', today()).get();
  const counts = {};
  sentToday.docs.forEach(d => { const m = d.data().fromMailbox; if (m) counts[m] = (counts[m] || 0) + 1; });
  return snap.docs.map(d => ({ id: d.id, email: d.data().email, canSend: !!d.data().canSend, lastError: d.data().lastError || null, sentToday: counts[d.id] || 0, limit: DAILY_LIMIT }));
}

async function accessTokenFor(mailbox) {
  const sec = await db().collection('gmailSecrets').doc(mailbox).get();
  if (!sec.exists) throw new Error('Mailbox is not connected');
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(sec.data().refreshTokenEnc) });
  return tok.access_token;
}

// ─── AI draft ────────────────────────────────────────────
function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
}

async function siteContext(domain) {
  try {
    const r = await fetch('https://' + domain, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    const html = (await r.text()).slice(0, 400000);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const heads = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)].map(m => textOf(m[1])).filter(t => t.length > 15 && t.length < 140).slice(0, 10);
    return [`Title: ${textOf(title)}`, `Description: ${textOf(desc)}`, heads.length ? `Headlines on the homepage:\n- ${heads.join('\n- ')}` : '', `Homepage text: ${textOf(html).slice(0, 1500)}`].filter(Boolean).join('\n');
  } catch (e) { return ''; }
}

async function draft(uid, { id, pitch, senderName, mode, avoidSubjects }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const ref = db().collection(COLL).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== uid) throw new Error('Row not found');
  const row = snap.data();
  if (['sent', 'sending', 'replied', 'bounced'].includes(row.status)) throw new Error('Already sent');
  if (!isSafeHost(row.domain)) throw new Error('Invalid domain');

  const ctx = await siteContext(row.domain);
  const paid = mode !== 'guest';
  const greeting = pick(GREETINGS);
  const avoid = (Array.isArray(avoidSubjects) ? avoidSubjects : []).map(oneLine).filter(Boolean).slice(0, 15);
  const goal = paid
    ? `This is an inquiry to BUY a paid placement (sponsored article / guest post) on their site. Ask for their price for publishing an article, and briefly ask whether links are dofollow and whether the post is labelled "sponsored". Do not ask for anything free and do not negotiate in this first email.`
    : `This is a request for a FREE guest post collaboration: offer an original article written for their readers in exchange for one relevant link.`;
  const prompt = `You write short, personal outreach emails for link building. They must read like one person writing to one person — never like a template.

Goal: ${goal}

Website: ${row.domain}
${ctx || '(the homepage could not be read — keep the personal line general but honest)'}

Recipient: ${row.name || 'unknown name'}${row.title ? ', ' + row.title : ''}
Sender name: ${oneLine(senderName) || 'the sender'}
Sender's notes (use these, do not invent other offers or facts):
${String(pitch || '').slice(0, 1500) || '(none)'}

Style for THIS email: ${pick(STYLES)}
Greeting: "${greeting} ${row.firstName || '[first name]'}," if the first name is known, otherwise "${greeting} there," or "${greeting},".
Sign-off: "${pick(SIGNOFFS)}," then the sender name.
Subject style: ${pick(SUBJECT_STYLES)}; under 60 characters, no clickbait, no ALL CAPS, no exclamation marks.
${avoid.length ? 'Do NOT reuse or closely copy any of these recent subjects:\n- ' + avoid.join('\n- ') : ''}

Rules:
- Plain text, 50–130 words, no markdown, no links, no placeholders in brackets, no emoji.
- One specific, honest sentence about their site based on the context above — never invent facts.
- Avoid spam-trigger wording: "free", "guaranteed", "100%", "act now", "limited time", "SEO boost", "backlinks" in the subject, and money symbols in the subject.
- End with one simple question.

Answer with JSON only: {"subject": "...", "body": "..."}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1500, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(40000)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic HTTP ' + r.status));
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let out;
  try { out = JSON.parse(m ? m[0] : text); } catch (e) { throw new Error('AI answer was not readable — try again'); }
  const subject = oneLine(out.subject).slice(0, 120);
  const body = String(out.body || '').trim() + '\n\n' + pick(OPT_OUTS);
  if (!subject || !out.body) throw new Error('AI returned an empty draft — try again');
  await ref.update({ subject, body, status: 'draft', draftedAt: Date.now(), updatedAt: FieldValue().serverTimestamp() });
  return { subject, body };
}

// ─── send ────────────────────────────────────────────────
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
function buildMime({ from, fromName, to, subject, body }) {
  const lines = [
    `From: ${fromName ? encodeHeader(oneLine(fromName).replace(/["<>]/g, '')) + ' ' : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(oneLine(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// Why this address/site must not be emailed again, or '' if it's fine.
async function contactBlock(id, email, domain) {
  const since = Date.now() - RECONTACT_DAYS * DAY;
  const out = ['sent', 'sending', 'replied', 'bounced'];
  const byEmail = await db().collection(COLL).where('email', '==', email).get();
  for (const d of byEmail.docs) {
    if (d.id === id) continue;
    const x = d.data();
    if (x.status === 'replied' || x.status === 'bounced') return `${email} already ${x.status} to an earlier email`;
    if (out.includes(x.status) && (x.sentAt || 0) >= since) return `${email} was already emailed on ${x.sentDay || 'a recent day'}`;
  }
  const byDomain = await db().collection(COLL).where('domain', '==', domain).get();
  for (const d of byDomain.docs) {
    if (d.id === id) continue;
    const x = d.data();
    if (out.includes(x.status) && (x.sentAt || 0) >= since) return `${domain} was already emailed on ${x.sentDay || 'a recent day'} (${x.email})`;
  }
  return '';
}

async function send(user, { id, email, from }) {
  const ref = db().collection(COLL).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Row not found');
  const row = snap.data();
  const to = String(row.email || '').toLowerCase();
  if (!['draft', 'failed'].includes(row.status)) throw new Error('Only a reviewed draft can be sent (status is ' + row.status + ')');
  // The page sends the address it showed — if the row changed underneath, stop.
  if (!to || to !== String(email || '').toLowerCase()) throw new Error('The recipient changed — review the row again');
  if (!isEmail(to)) throw new Error('Not a valid email address');
  if (row.smtp === 'invalid') throw new Error('This address failed verification');
  if (!row.subject || !row.body) throw new Error('Draft is empty');

  const block = await contactBlock(ref.id, to, row.domain);
  if (block) { await ref.update({ status: 'skipped', skipReason: block, updatedAt: FieldValue().serverTimestamp() }); throw new Error(block); }

  const mbId = mailboxId(from);
  const conn = await db().collection('gmailConnections').doc(mbId).get();
  if (!conn.exists || conn.data().ownerUid !== user.uid) throw new Error('Pick one of your connected mailboxes');
  if (!conn.data().canSend) throw new Error('This mailbox is connected read-only — click "Connect Gmail for sending"');

  // Claim the row and a slot of today's quota in one transaction, so a double
  // click or two open tabs can never send twice or overshoot the limit.
  const day = today();
  await db().runTransaction(async tx => {
    const cur = await tx.get(ref);
    if (!['draft', 'failed'].includes(cur.data().status)) throw new Error('Already being sent');
    const sentToday = await tx.get(db().collection(COLL).where('sentDay', '==', day));
    const mine = sentToday.docs.filter(d => d.data().fromMailbox === mbId);
    if (mine.length >= DAILY_LIMIT) throw new Error(`Daily limit reached for ${conn.data().email} (${DAILY_LIMIT}/day)`);
    const last = Math.max(0, ...mine.map(d => d.data().sentAt || 0));
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) throw new Error(`Wait ${Math.ceil(wait / 60000)} min before the next email from ${conn.data().email}`);
    tx.update(ref, { status: 'sending', sentDay: day, fromMailbox: mbId, fromEmail: conn.data().email, sentAt: Date.now() });
  });

  const body = hasOptOut(row.body) ? row.body : row.body.trim() + '\n\n' + OPT_OUTS[0];
  try {
    const access = await accessTokenFor(mbId);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildMime({ from: conn.data().email, fromName: user.name, to, subject: row.subject, body }) })
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Gmail HTTP ' + r.status));
    await ref.update({ status: 'sent', body, messageId: j.id, threadId: j.threadId, sentAt: Date.now(), sentBy: user.name, error: null, updatedAt: FieldValue().serverTimestamp() });
  } catch (e) {
    // Not sent — free the quota slot and let the admin retry.
    await ref.update({ status: 'failed', error: String(e.message || e).slice(0, 300), sentDay: null, sentAt: null, updatedAt: FieldValue().serverTimestamp() });
    throw e;
  }

  // Keep the Domains DB as the team's shared "who did we contact" list.
  try {
    const dom = await db().collection('domains').where('domain', '==', row.domain).get();
    const note = `Outreach Agent: emailed ${to} on ${day}`;
    const same = dom.docs.find(d => String(d.data().email || '').toLowerCase() === to);
    if (same) await same.ref.update({ notes: [same.data().notes, note].filter(Boolean).join(' · ') });
    else await db().collection('domains').add({
      domain: row.domain, email: to, smtp: row.smtp || 'unknown', firstName: row.firstName || '', lastName: '',
      position: row.title || '', dr: '', traffic: '', project: '', notes: note, addedBy: user.name || '', createdAt: FieldValue().serverTimestamp()
    });
  } catch (e) {}
  return { ok: true };
}

// ─── reply / bounce tracking ─────────────────────────────
async function trackAll(onlyUid) {
  const snap = await db().collection(COLL).where('status', '==', 'sent').get();
  const since = Date.now() - TRACK_DAYS * DAY;
  const rows = snap.docs.filter(d => d.data().threadId && (d.data().sentAt || 0) >= since && (!onlyUid || d.data().ownerUid === onlyUid));
  const tokens = {};
  let replied = 0, bounced = 0;
  const deadline = Date.now() + 45000;
  for (const d of rows) {
    if (Date.now() > deadline) break;
    const x = d.data();
    try {
      if (!(x.fromMailbox in tokens)) tokens[x.fromMailbox] = await accessTokenFor(x.fromMailbox).catch(() => null);
      const access = tokens[x.fromMailbox];
      if (!access) continue;
      const t = await gmailGet(`threads/${x.threadId}?format=metadata&metadataHeaders=From&fields=messages(id,internalDate,payload/headers)`, access);
      let status = '';
      for (const m of (t.messages || [])) {
        if (m.id === x.messageId) continue;
        const fromH = ((m.payload && m.payload.headers) || []).find(h => /^from$/i.test(h.name));
        const f = String(fromH && fromH.value || '').toLowerCase();
        if (/mailer-daemon|postmaster|mail delivery/.test(f)) { status = 'bounced'; break; }
        if (f && !f.includes(String(x.fromEmail || '').toLowerCase())) status = 'replied';
      }
      if (status) {
        await d.ref.update({ status, [status + 'At']: Date.now(), updatedAt: FieldValue().serverTimestamp() });
        if (status === 'replied') replied++; else bounced++;
      }
    } catch (e) {}
  }
  return { checked: rows.length, replied, bounced };
}

// ─── HTTP ────────────────────────────────────────────────
async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireMember(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'Outreach Agent is admin-only' });
  const b = req.body || {};
  try {
    switch (b.action) {
      case 'list': return res.json({ rows: await list(user.uid) });
      case 'save': return res.json({ ids: await save(user.uid, b.items) });
      case 'delete': return res.json({ deleted: await remove(user.uid, b.ids) });
      case 'mailboxes': return res.json({ mailboxes: await mailboxes(user.uid), limit: DAILY_LIMIT });
      case 'draft': return res.json(await draft(user.uid, b));
      case 'send': return res.json(await send(user, b));
      case 'track': return res.json(await trackAll(user.uid));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}

module.exports = handler;
module.exports.trackAll = trackAll;
