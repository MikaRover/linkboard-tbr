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
// Each mailbox's owner can raise its own daily limit to one of these.
const LIMIT_CHOICES = [30, 45, 60];
const limitOf = c => LIMIT_CHOICES.includes(+((c && c.dailyLimit) || 0)) ? +c.dailyLimit : DAILY_LIMIT;
const RECONTACT_DAYS = 90;   // never email the same address again within this window
const TRACK_DAYS = 90;       // stop checking a thread for replies after this long
const MAX_ROWS = 300;        // per save call
// Several wordings so the footer isn't an identical fingerprint on every email.
const OPT_OUTS = [
  "If this isn't relevant, just let me know and I won't follow up.",
  "If it's not a fit, a quick \"no\" is totally fine and I won't email again.",
  "No worries if not; just reply \"no\" and I won't reach out again.",
  "If you'd rather not get emails like this, just say so and I won't write again."
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
const EDITABLE = ['domain', 'name', 'firstName', 'title', 'email', 'smtp', 'source', 'candidates', 'subject', 'body', 'skipReason', 'note', 'batch', 'folder', 'dr', 'traffic'];
// 'new' = analyzed (type, DR, traffic) but no contact searched yet.
const CLIENT_STATUSES = ['new', 'found', 'nocontact', 'draft', 'skipped'];

const db = () => getAdmin().firestore();
const FieldValue = () => require('./firebase-admin').firestore.FieldValue;
const today = () => new Date().toISOString().slice(0, 10);
const isEmail = e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(String(e || ''));
const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
// Generated subjects start with a capital letter ("quick question" → "Quick question").
const capFirst = s => String(s || '').replace(/\p{L}/u, c => c.toUpperCase());

function clean(item) {
  const out = {};
  EDITABLE.forEach(k => { if (item[k] !== undefined) out[k] = item[k]; });
  if (out.domain !== undefined) out.domain = cleanHost(out.domain);
  if (out.email !== undefined) out.email = String(out.email || '').trim().toLowerCase();
  if (out.candidates !== undefined) out.candidates = (Array.isArray(out.candidates) ? out.candidates : []).slice(0, 12);
  ['subject', 'body', 'name', 'firstName', 'title', 'note', 'skipReason'].forEach(k => { if (out[k] !== undefined) out[k] = String(out[k] || '').slice(0, k === 'body' ? 6000 : 300); });
  if (out.folder !== undefined) out.folder = oneLine(out.folder).slice(0, 80);
  ['dr', 'traffic'].forEach(k => { if (out[k] !== undefined) { const n = Math.round(Number(out[k])); out[k] = Number.isFinite(n) && n > 0 ? n : null; } });
  if (item.status !== undefined && CLIENT_STATUSES.includes(item.status)) out.status = item.status;
  if (item.category !== undefined && SITE_CATEGORIES.includes(item.category)) Object.assign(out, { category: item.category, categoryBy: 'hand' });
  return out;
}

// ─── site category ───────────────────────────────────────
// Free — no AI: the homepage's structure (dated, bylined article lists, RSS,
// schema.org types, pricing / sign-up / cart / services links) plus its
// wording decide Magazine, SaaS, Service or General; a parked or empty page is
// Other. The category then picks the template on the page: Magazine / Service
// / General → Paid, SaaS → Exchange.
const SITE_CATEGORIES = ['SaaS', 'Service', 'Magazine', 'General', 'Other'];
const CAT_PATHS = ['', '/pricing', '/plans', '/integrations', '/services'];
// Free site classifier: page structure + wording. pages: [{path, html}] (path '' = homepage).
function classifySite(pages, domain) {
  const home = pages.find(p => p.path === '') || pages[0];
  if (!home) return { category: 'Other' };
  const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  const H = strip(home.html);
  const text = H.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/gi, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (text.length < 150 || /domain (is )?for sale|buy this domain|parked free|this domain may be for sale/i.test(text)) return { category: 'Other' };
  const host = domain.replace(/^www\./, '');
  const hrefs = [...home.html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1].toLowerCase())
    .filter(h => h.startsWith('/') || h.includes(host));
  const cnt = re => hrefs.filter(h => re.test(h)).length;
  const uniq = re => new Set(hrefs.filter(h => re.test(h))).size;
  const ld = [...home.html.matchAll(/"@type"\s*:\s*\[?\s*"([A-Za-z]+)"/g)].map(m => m[1]);
  const hasLd = re => ld.some(t => re.test(t));
  const kw = list => list.filter(k => new RegExp('(^|[^a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(text)).length;
  const has = p => pages.some(x => x.path === p);
  const lim = (n, max) => Math.min(n, max);

  // Publishing: the homepage itself is a list of dated, bylined articles.
  const articles = (H.match(/<article\b/gi) || []).length;
  const times = (H.match(/<time\b[^>]*datetime/gi) || []).length;
  const postLinks = uniq(/\/(category|tag|author|topics?)\/[^/]+/) ;
  const dated = uniq(/\/20\d\d\/\d\d\//);
  const bylines = (text.match(/\bby [a-z][a-z.'-]+ [a-z][a-z.'-]+/g) || []).length;
  const ago = (text.match(/\b\d+ (minutes?|hours?|days?) ago\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}, 20\d\d\b/g) || []).length;
  let mag = lim(articles, 20) * 0.6 + lim(times, 20) * 0.5 + lim(postLinks, 30) * 0.4 + lim(dated, 20) * 0.6 + lim(bylines, 15) * 0.5 + lim(ago, 15) * 0.6
    + (/application\/(rss|atom)\+xml/i.test(home.html) ? 2 : 0)
    + (hasLd(/^(NewsMediaOrganization|NewsArticle|BlogPosting|Blog|Article|ReportageNewsArticle)$/) ? 4 : 0)
    + kw(['latest news', 'latest articles', 'latest posts', 'recent posts', 'editor\'s picks', 'editors picks', 'trending', 'read more', 'write for us', 'advertise with us', 'newsletter', 'subscribe', 'editorial', 'magazine']) * 0.8;
  if (/(news|times|herald|tribune|journal|daily|gazette|blog|magazine|digest|post)\b/.test(host.split('.')[0])) mag += 3;

  // Software product: pricing + sign-up / log-in into an app.
  const pricing = cnt(/\/(pricing|plans)(\/|$|\?)/) > 0;
  const signup = cnt(/\/(signup|sign-up|register|get-started|start|trial|free-trial|demo|book-a-demo)(\/|$|\?)|\/\/(app|dashboard|my|account|login|auth)\./) ;
  const login = cnt(/\/(login|log-in|signin|sign-in)(\/|$|\?)/);
  let saas = (pricing ? 4 : 0) + (has('/pricing') || has('/plans') ? 2 : 0) + (has('/integrations') ? 3 : 0) + lim(signup, 4) + (login ? 2 : 0)
    + (hasLd(/^(SoftwareApplication|WebApplication|MobileApplication)$/) ? 5 : 0)
    + kw(['free trial', 'start free', 'try for free', 'try it free', 'get started free', 'sign up free', 'no credit card required', 'book a demo', 'request a demo', 'get a demo', 'integrations', 'api', 'platform', 'software', 'dashboard', 'automate', 'workflow', 'cancel anytime', 'per month', '/mo', 'per user']) * 1.2;

  // Agency / services: people doing work for clients.
  let service = (has('/services') ? 3 : 0) + lim(uniq(/\/services?\/[^/]+/), 8) * 0.6
    + (hasLd(/^(ProfessionalService|LocalBusiness|LegalService|AccountingService|HomeAndConstructionBusiness|MedicalBusiness)$/) ? 3 : 0)
    + kw(['our services', 'our clients', 'case studies', 'case study', 'get a quote', 'request a quote', 'free consultation', 'book a call', 'schedule a call', 'agency', 'consulting', 'consultancy', 'we help', 'hire us', 'work with us', 'our team', 'proposal', 'contact us', 'results']) * 1.2;

  // Shop / other real business.
  let shop = lim(cnt(/\/(cart|basket|checkout)(\/|$|\?)/), 3) * 2 + lim(uniq(/\/(products?|collections|shop|store|p)\/[^/]+/), 20) * 0.4
    + (hasLd(/^(Product|Offer|AggregateOffer|Store|OnlineStore)$/) ? 4 : 0) + kw(['add to cart', 'add to bag', 'free shipping', 'shop now', 'in stock', 'checkout', 'returns']) * 1.5;

  const s = { mag: +mag.toFixed(1), saas: +saas.toFixed(1), service: +service.toFixed(1), shop: +shop.toFixed(1) };
  const top = Object.entries(s).sort((a, b) => b[1] - a[1]);
  const [best, score] = top[0], second = top[1][1];
  let category = 'General';
  if (score >= 5 && score >= second * 1.15) category = { mag: 'Magazine', saas: 'SaaS', service: 'Service', shop: 'General' }[best];
  else if (best === 'mag' && score >= 4) category = 'Magazine';
  return { category, scores: s };
}
async function siteCategory(domain) {
  const pages = await Promise.all(CAT_PATHS.map(async path => {
    try {
      const r = await fetch('https://' + domain + path, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      return { path, html: (await r.text()).slice(0, path ? 200000 : 600000) };
    } catch (e) { return null; }
  }));
  const home = pages[0];
  if (!home) return null; // site didn't answer (or blocks bots) — not "Other"
  // Paths that just serve the homepage again (SPAs, soft 404s) don't count.
  const real = pages.filter((p, i) => p && (i === 0 || p.html.slice(0, 3000) !== home.html.slice(0, 3000)));
  return classifySite(real, domain).category;
}
async function categorize(uid, { ids }) {
  const refs = (Array.isArray(ids) ? ids : []).slice(0, 8).map(id => db().collection(COLL).doc(String(id)));
  const results = {};
  await Promise.all(refs.map(async ref => {
    const d = await ref.get();
    if (!d.exists || d.data().ownerUid !== uid) return;
    const domain = d.data().domain;
    if (!domain || !isSafeHost(domain) || ['hand', 'failed'].includes(d.data().categoryBy)) return;
    const category = await siteCategory(domain);
    if (!category) { await ref.update({ categoryBy: 'failed', categoryAt: Date.now() }); results[ref.id] = ''; return; }
    await ref.update({ category, categoryBy: 'auto', categoryAt: Date.now() });
    results[ref.id] = category;
  }));
  return { results };
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
      // A row that already went out is a record — only its note and folder can change.
      if (['sent', 'sending', 'replied', 'bounced'].includes(cur.data().status)) {
        const keep = {};
        if (data.note !== undefined) keep.note = data.note;
        if (data.folder !== undefined) keep.folder = data.folder;
        if (item.fuBody !== undefined && cur.data().status === 'sent' && !cur.data().fuQueue) keep.fuBody = String(item.fuBody || '').replace(/\r\n/g, '\n').slice(0, 4000);
        // "Followed up" (done by hand in Gmail): restarts the follow-up clock on a sent row.
        if (item.followedUp === true && cur.data().status === 'sent') Object.assign(keep, { followUps: FieldValue().increment(1), followedUpAt: Date.now() });
        if (Object.keys(keep).length) batch.update(ref, { ...keep, updatedAt: now });
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
  const fuToday = await db().collection(COLL).where('fuDay', '==', today()).get();
  const counts = {};
  [...sentToday.docs, ...fuToday.docs].forEach(d => { const m = d.data().fromMailbox; if (m) counts[m] = (counts[m] || 0) + 1; });
  const smtp = await require('./mailsmtp').list(uid);
  const list = [
    ...snap.docs.map(d => ({ id: d.id, email: d.data().email, provider: 'gmail', canSend: !!d.data().canSend, lastError: d.data().lastError || null, sentToday: counts[d.id] || 0, limit: limitOf(d.data()), resumeUntil: d.data().resumeUntil || 0 })),
    ...smtp.map(c => ({ id: c.id, email: c.email, provider: c.provider, canSend: !!c.canSend, lastError: c.lastError || null, sentToday: counts[c.id] || 0, limit: limitOf(c), resumeUntil: c.resumeUntil || 0 }))
  ];
  await Promise.all(list.filter(m => m.canSend).map(async m => {
    const [health, bounce] = await Promise.all([domainHealth(m.email, m.provider), bounceStats(m.id)]);
    Object.assign(m, { health, bounce, paused: isPaused(bounce, m.resumeUntil) });
  }));
  return list;
}

// ─── mailbox health ──────────────────────────────────────
// 1) The sending domain's records: SPF must list the provider, DKIM must be
//    published, DMARC should exist — the three things inbox providers check
//    first. @gmail.com is Google's own domain and needs nothing.
// 2) Bounce rate over the last 14 days: at 20% or more (20+ sent) the mailbox
//    pauses itself, because a high bounce rate is what gets a mailbox flagged.
//    Its owner can resume it for 24 hours after cleaning the list.
const DNS_TTL_MS = 6 * 3600 * 1000;
const dnsCache = new Map();
const PROVIDER_SPF = { gmail: /_spf\.google\.com/i, privateemail: /spf\.privateemail\.com/i };
const DKIM_SELECTOR = { gmail: 'google', privateemail: 'default' };
const PROVIDER_LABEL = { gmail: 'Google', privateemail: 'Private Email' };
async function txtRecords(name) {
  try { return (await require('dns').promises.resolveTxt(name)).map(r => r.join('')); } catch (e) { return []; }
}
async function domainHealth(email, provider) {
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  if (!domain) return null;
  if (/^(gmail|googlemail)\.com$/.test(domain)) return { domain, managed: true };
  const key = domain + '|' + provider;
  const hit = dnsCache.get(key);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.data;
  const [root, dmarc, dkim] = await Promise.all([
    txtRecords(domain), txtRecords('_dmarc.' + domain), txtRecords(`${DKIM_SELECTOR[provider] || 'google'}._domainkey.${domain}`)
  ]);
  const spf = root.find(t => /^v=spf1/i.test(t));
  const dm = dmarc.find(t => /^v=DMARC1/i.test(t));
  const data = {
    domain, provider: PROVIDER_LABEL[provider] || provider,
    spf: !spf ? 'missing' : (PROVIDER_SPF[provider] && !PROVIDER_SPF[provider].test(spf) ? 'wrong' : 'ok'),
    dkim: dkim.some(t => /v=DKIM1|p=/i.test(t)) ? 'ok' : 'missing',
    dmarc: dm ? ((dm.match(/;\s*p=(\w+)/i) || [])[1] || 'ok').toLowerCase() : 'missing'
  };
  dnsCache.set(key, { at: Date.now(), data });
  return data;
}
const BOUNCE_DAYS = 14, BOUNCE_MIN_SENT = 20, BOUNCE_PAUSE_PCT = 20;
async function bounceStats(mbId) {
  const since = Date.now() - BOUNCE_DAYS * DAY;
  const snap = await db().collection(COLL).where('fromMailbox', '==', mbId).get();
  const rows = snap.docs.map(d => d.data()).filter(x => (x.sentAt || 0) >= since && ['sent', 'replied', 'bounced'].includes(x.status));
  const bounced = rows.filter(x => x.status === 'bounced').length;
  return { sent: rows.length, bounced, pct: rows.length ? Math.round(bounced / rows.length * 1000) / 10 : 0, days: BOUNCE_DAYS };
}
const isPaused = (b, resumeUntil) => b.sent >= BOUNCE_MIN_SENT && b.pct >= BOUNCE_PAUSE_PCT && !((resumeUntil || 0) > Date.now());

async function setMailboxLimit(uid, { id, limit }) {
  limit = +limit;
  if (!LIMIT_CHOICES.includes(limit)) throw new Error('Pick 30, 45 or 60');
  for (const coll of ['gmailConnections', 'smtpConnections']) {
    const ref = db().collection(coll).doc(String(id || ''));
    const d = await ref.get();
    if (d.exists) {
      if (d.data().ownerUid !== uid) break;
      await ref.update({ dailyLimit: limit });
      return { ok: true, limit };
    }
  }
  throw new Error('Mailbox not found');
}

async function resumeMailbox(uid, { id }) {
  const mbId = String(id || '');
  for (const coll of ['gmailConnections', 'smtpConnections']) {
    const ref = db().collection(coll).doc(mbId);
    const d = await ref.get();
    if (d.exists) {
      if (d.data().ownerUid !== uid) break;
      const until = Date.now() + DAY;
      await ref.update({ resumeUntil: until });
      return { ok: true, resumeUntil: until };
    }
  }
  throw new Error('Mailbox not found');
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

// Paid mode uses the team's own short templates instead of AI: five light
// variations, each with its own subject, moving to the next one every
// TEMPLATE_EVERY drafts so no long run of identical emails goes out.
const TEMPLATE_EVERY = 3;
const PAID_TEMPLATES = [
  { subject: 'content collaboration with {site}',
    body: "Hi {name},\n\nMy name is {sender}. I'm an off-page SEO specialist, and I work with brands on content and look for good sites to partner with.\n\nI'd love to do a content collaboration with {site}. Could you let me know your terms?\n\n{optout}\n\nThanks,\n{signature}" },
  { subject: 'quick question about {site}',
    body: "Hello {name},\n\nMy name is {sender}. I'm an off-page SEO specialist working on content for a few brands.\n\nI came across {site} and would like to do a content collaboration with you. What are your terms?\n\n{optout}\n\nBest,\n{signature}" },
  { subject: 'collaboration idea',
    body: "Hi {name},\n\nMy name is {sender}. I work in off-page SEO and help brands publish useful content on sites like yours.\n\nI'm interested in a content collaboration with {site}. Could you share your terms?\n\n{optout}\n\nKind regards,\n{signature}" },
  { subject: 'working together on content',
    body: "Hi {name},\n\nMy name is {sender}, and I'm an off-page SEO specialist.\n\nI'd like to work with {site} on a content collaboration. What terms do you offer?\n\n{optout}\n\nThanks,\n{signature}" },
  { subject: 'content partnership with {site}',
    body: "Hello {name},\n\nMy name is {sender}. I'm an off-page SEO specialist working with several brands.\n\nI'm reaching out because I'd like to set up a content collaboration with {site}. Could you tell me your terms?\n\n{optout}\n\nBest regards,\n{signature}" }
];

// Link exchange: the team's own wording (two ways we collaborate, offer examples).
const EXCHANGE_TEMPLATES = [
  { subject: 'content collaboration?',
    body: "Hi {name},\n\nI wanted to check if you'd be open to a content collaboration.\n\nWe usually collaborate in two ways:\n\n• A-B-C content exchange with SaaS partners we already work with\n• Co-created content that fits your audience and editorial style\n\n{offer}If this sounds interesting, I'd be happy to share a few examples and see if it could be a good fit ✨\n\n{optout}\n\nBest regards,\n{signature}" },
  { subject: 'collaboration with {site}',
    body: "Hello {name},\n\nI'm reaching out to see if {site} would be interested in working together on content.\n\nThere are two ways we usually do this:\n\n• An A-B-C content exchange with SaaS partners we already work with\n• Content we create together, written for your readers and in your editorial style\n\n{offer}If either sounds good, I can send over a few examples so you can see if it's a fit.\n\n{optout}\n\nBest,\n{signature}" },
  { subject: 'quick question about {site}',
    body: "Hi {name},\n\nWould you be open to a content collaboration with {site}?\n\nWe normally work with sites in one of two ways:\n\n• A-B-C content exchange through the SaaS partners we already work with\n• Co-written content that suits your audience and style\n\n{offer}Happy to share some examples if you'd like to take a look.\n\n{optout}\n\nKind regards,\n{signature}" },
  { subject: 'working together on content',
    body: "Hi {name},\n\nI came across {site} and wanted to ask if you'd be interested in collaborating.\n\nWe usually partner in two ways:\n\n• A-B-C content exchange with our existing SaaS partners\n• Co-created content tailored to your audience and editorial guidelines\n\n{offer}If that sounds interesting, I'd be glad to share a few examples ✨\n\n{optout}\n\nThanks,\n{signature}" },
  { subject: 'content partnership idea',
    body: "Hello {name},\n\nI wanted to reach out about a possible content partnership with {site}.\n\nHere's how we usually collaborate:\n\n• A-B-C content exchange with SaaS partners we already work with\n• Content we co-create to match your audience and editorial style\n\n{offer}Let me know if you'd like to see a few examples, and we can see if it's a good fit.\n\n{optout}\n\nBest regards,\n{signature}" }
];
const TEMPLATE_SETS = { paid: PAID_TEMPLATES, exchange: EXCHANGE_TEMPLATES };
// Paid (team templates): the subject is picked from this pool instead of the
// template's own, never one used recently. They read like one person writing
// to another — no "collaboration", "partnership", "paid", "SEO" or "links",
// the words link-building filters learn — and many different subjects across
// a batch avoid the identical-subject pattern spam filters look for.
const PAID_SUBJECTS = [
  'question about {site}', 'quick question about {site}', 'a question about {site}', 'one question about {site}',
  'quick one about {site}', 'reaching out about {site}', 'writing for {site}', 'an article for {site}',
  'an idea for {site}', 'content for {site}', 'who handles content at {site}?', 'is this the right inbox?',
  'a short question', 'hello from {sender}', '{site}'
];
// The sites we can offer in an exchange, phrased a little differently per template.
const OFFER_LINES = [
  'The sites we can offer are {list}.',
  'Here are the sites we could feature you on: {list}.',
  'We can mention you on {list}.',
  'Our sites: {list}.',
  'You can pick from {list}.'
];
// Up to 4 short lines, e.g. "Mika Hovsepyan / Growth Marketing Manager | Company".
function cleanSignature(sig) {
  return String(sig || '').split(/\r?\n/).map(l => l.trim().slice(0, 100)).filter(Boolean).slice(0, 4).join('\n');
}
function offerLine(offer, idx) {
  const hosts = [...new Set((Array.isArray(offer) ? offer : String(offer || '').split(/[\s,;]+/))
    .map(cleanHost).filter(h => h && isSafeHost(h)))].slice(0, 5);
  if (!hosts.length) return '';
  const list = hosts.length === 1 ? hosts[0] : hosts.slice(0, -1).join(', ') + ' and ' + hosts[hosts.length - 1];
  return OFFER_LINES[idx % OFFER_LINES.length].replace('{list}', list) + '\n\n';
}

// Each person may replace a set with their own templates (outreachTemplates/{uid},
// server-only like outreachAgent); a set they haven't written uses the team's.
const TPL_COLL = 'outreachTemplates';
const MAX_OWN_TEMPLATES = 5;
// Exchange is different: 5–15 own versions mixed at random, and every email
// gets a subject from EXCHANGE_SUBJECTS, so a template carries no subject of its own.
const TPL_LIMITS = { paid: { min: 1, max: 5 }, exchange: { min: 5, max: 15 } };
const tplMax = set => (TPL_LIMITS[set] || {}).max || MAX_OWN_TEMPLATES;
const AI_SUBJECT_SETS = ['exchange'];
async function ownTemplates(uid) {
  const d = await db().collection(TPL_COLL).doc(uid).get();
  const x = d.exists ? d.data() : {};
  const out = {};
  Object.keys(TEMPLATE_SETS).forEach(set => { if (Array.isArray(x[set]) && x[set].length) out[set] = x[set]; });
  return out;
}
async function getTemplates(uid) {
  const d = await db().collection(TPL_COLL).doc(uid).get();
  return { own: await ownTemplates(uid), team: TEMPLATE_SETS, limits: TPL_LIMITS, aiSubject: AI_SUBJECT_SETS, folderColors: (d.exists && d.data().folderColors) || {} };
}

// Each person's client folders can carry a color label (kept with their templates, only they see it).
const FOLDER_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
async function saveFolderColor(uid, { folder, color }) {
  const name = oneLine(folder).slice(0, 80);
  if (!name) throw new Error('Pick a folder first');
  if (color && !FOLDER_COLORS.includes(color)) throw new Error('Unknown color');
  const ref = db().collection(TPL_COLL).doc(uid);
  const colors = await db().runTransaction(async tx => {
    const d = await tx.get(ref);
    const map = { ...((d.exists && d.data().folderColors) || {}) };
    if (color) map[name] = color; else delete map[name];
    // update() replaces the whole map, so a removed color really goes (set+merge would keep it).
    if (d.exists) tx.update(ref, { folderColors: map }); else tx.set(ref, { folderColors: map });
    return map;
  });
  return { folderColors: colors };
}
// templates: [{subject, body}] — an empty list goes back to the team's set.
async function saveTemplates(uid, { set, templates }) {
  if (!TEMPLATE_SETS[set]) throw new Error('Unknown template type');
  const list = (Array.isArray(templates) ? templates : []).map(t => ({
    subject: oneLine(t && t.subject).slice(0, 150),
    body: String((t && t.body) || '').replace(/\r\n/g, '\n').trim().slice(0, 4000)
  })).filter(t => t.subject || t.body);
  const { min, max } = TPL_LIMITS[set];
  if (list.length > max) throw new Error(`Up to ${max} templates`);
  if (list.length && list.length < min) throw new Error(`Add at least ${min} versions (you have ${list.length}) — Generate can write the rest`);
  const aiSubject = AI_SUBJECT_SETS.includes(set);
  list.forEach((t, i) => {
    if (!t.subject && !aiSubject) throw new Error(`Template ${i + 1}: add a subject`);
    if (t.body.length < 20) throw new Error(`Template ${i + 1}: the email text is too short`);
  });
  await db().collection(TPL_COLL).doc(uid).set({ [set]: list.length ? list : FieldValue().delete(), updatedAt: Date.now() }, { merge: true });
  return getTemplates(uid);
}

// Writes new versions in the style of the templates someone typed, each with
// its own subject, so their rotation isn't one email sent over and over.
// Nothing is saved here: the page shows them in the editor for review.
const PLACEHOLDERS = ['{name}', '{site}', '{sender}', '{signature}', '{offer}', '{optout}'];
async function templateVariations({ set, templates, count }) {
  if (!TEMPLATE_SETS[set]) throw new Error('Unknown template type');
  const src = (Array.isArray(templates) ? templates : []).map(t => ({
    subject: oneLine(t && t.subject).slice(0, 150), body: String((t && t.body) || '').trim().slice(0, 4000)
  })).filter(t => t.body.length >= 20).slice(0, tplMax(set));
  if (!src.length) throw new Error('Write one version first, then generate more like it');
  // At most 5 per call keeps one answer short enough to come back whole.
  const n = Math.max(1, Math.min(5, tplMax(set) - src.length, parseInt(count, 10) || 1));
  if (tplMax(set) - src.length <= 0) throw new Error(`You already have ${tplMax(set)} versions`);
  const withSubject = !AI_SUBJECT_SETS.includes(set);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  // Placeholders every source uses must stay in every new version.
  const keep = PLACEHOLDERS.filter(p => src.every(t => t.body.includes(p)));
  const prompt = `You help a link-building outreach specialist vary their cold email template, so a batch doesn't send the same text again and again (a spam signal).

Their template${src.length > 1 ? 's' : ''}:
${src.map((t, i) => `--- Version ${i + 1}\n${withSubject ? `Subject: ${t.subject}\n` : ''}${t.body}`).join('\n\n')}

Write ${n} NEW version${n > 1 ? 's' : ''} of this email.
- Same meaning, offer, ask, tone, length and structure as theirs; it must still sound like the same person. Reword sentences, reorder where natural, vary the greeting and sign-off words.
${withSubject ? '- Every version gets its own subject line in the same style as theirs, different from theirs and from each other; under 60 characters, no clickbait, no ALL CAPS, no exclamation marks.\n' : '- Each version must differ clearly from theirs and from the others (not just one swapped word). No subject lines are needed: set "subject" to "".\n'}- Keep these placeholders exactly as written, curly braces included, each in every version: ${keep.length ? keep.join(' ') : '(none)'}. Do not add other placeholders or brackets.
- Do not invent facts, prices, sites, numbers or promises that aren't in theirs. No links, no markdown.
- Avoid spam wording: "free", "guaranteed", "100%", "act now", "limited time", "SEO boost".
- Plain text with blank lines between paragraphs, like theirs. Keep bullets if theirs has bullets.

Answer with JSON only: {"versions": [{"subject": "...", "body": "..."}]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 4000, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(50000)
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic HTTP ' + r.status));
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let out;
  try { out = JSON.parse(m ? m[0] : text); } catch (e) { throw new Error('AI answer was not readable — try again'); }
  const seen = new Set(src.map(t => t.subject.toLowerCase()));
  const srcBrackets = src.some(t => /\[[^\]]*\]/.test(t.body));
  const versions = (Array.isArray(out.versions) ? out.versions : []).map(v => ({
    subject: capFirst(oneLine(v && v.subject).slice(0, 150)), body: String((v && v.body) || '').replace(/\r\n/g, '\n').trim().slice(0, 4000)
  })).filter(v => {
    if (withSubject && (!v.subject || seen.has(v.subject.toLowerCase()))) return false;
    if (v.body.length < 20) return false;
    if (!withSubject) v.subject = '';
    if (!keep.every(p => v.body.includes(p))) return false;           // lost a placeholder
    if (/\{(?!name\}|site\}|sender\}|signature\}|offer\}|optout\})[^}]*\}/.test(v.body)) return false; // made one up
    if (!srcBrackets && /\[[^\]]*\]/.test(v.body)) return false;    // "[Your name]"-style gaps
    if (withSubject) seen.add(v.subject.toLowerCase());
    return true;
  }).slice(0, n);
  if (!versions.length) throw new Error('The AI versions didn\'t keep your placeholders — try again');
  return { versions };
}

// Exchange subjects: picked from this pool, free (no AI), never one the row
// or the page used recently. Short, personal questions — most greet the
// person by first name ({name}, "there" when unknown) — plus a few that name
// the A-B-C collaboration, so a batch doesn't repeat one subject line.
const EXCHANGE_SUBJECTS = [
  'Hi {name}, open for collaboration?', 'Hi {name}, open to a collaboration?', 'Hey {name}, open for a collab?',
  '{name}, open to collaborating?', 'Hi {name}, quick collaboration idea', 'Hi {name}, collaboration with {site}?',
  'Hello {name}, open for a content collab?', '{name}, would you be open to a collab?', 'Hi {name}, A-B-C collaboration?',
  'Hey {name}, A-B-C collab idea', 'Hi {name}, quick question', 'open for collaboration, {name}?',
  'A-B-C collaboration with {site}?', 'open to an A-B-C collaboration?', 'A-B-C collab idea for {site}'
];
// A first name read from the email address when the row has none:
// "anna@…", "anna.smith@…", "anna_s@…" → "Anna". Role inboxes (info@, editor@…)
// and joined initials ("jsmith@") give '' so the subject says "Hi there".
const ROLE_LOCALS = /^(info|contact|contacts|hello|hi|hey|admin|administrator|support|help|sales|marketing|editor|editors|editorial|team|office|press|media|news|newsroom|pr|partners?|partnerships?|collab|collaborations?|business|biz|webmaster|web|site|mail|email|noreply|no-reply|enquiries|enquiry|inquiries|inquiry|general|hr|jobs|careers|billing|accounts?|feedback|content|blog|write|writers?|submissions?|guest|guestposts?|ads|advertising|advertise|sponsor|sponsorships?|seo|outreach|growth|community|social|founders?|ceo|owner|staff|desk|tips|legal|privacy|abuse|postmaster|hostmaster|service|services|customer|customers|orders|shop|store|team|us|me|mailbox)$/i;
const START_PAIRS = /^(bl|br|ch|cl|cr|dr|fl|fr|gl|gr|kh|kr|ph|pl|pr|sc|sh|sk|sl|sm|sn|sp|st|sv|sw|th|tr|ts|tw|wh|zh|gw|dm|chr|shr|str|thr)/;
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/\+.*$/, '');
  if (!local || ROLE_LOCALS.test(local)) return '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const cand = parts[0] || '';
  if (!/^[a-z]{3,12}$/.test(cand) || ROLE_LOCALS.test(cand)) return '';
  // "vidico@vidico.com" is the company, not a person.
  const host = String(email || '').split('@')[1] || '';
  if (host && host.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z]/g, '').startsWith(cand)) return '';
  // One run with no separator: "jsmith" / "mkline" (initial + surname) are skipped.
  if (parts.length === 1) {
    if (cand.length > 8) return ''; // "johnsmith" — rather "Hi there" than "Hi Johnsmith"
    if (!/[aeiouy]/.test(cand.slice(0, 4))) return '';
    if (!/^[aeiouy]/.test(cand) && !/^[aeiouy]/.test(cand.slice(1)) && !START_PAIRS.test(cand)) return '';
  }
  return cand.charAt(0).toUpperCase() + cand.slice(1);
}
const firstNameOf = row => oneLine(row.firstName).split(' ')[0] || nameFromEmail(row.email);

function pickSubject(pool, fill, row, avoid, senderName) {
  const used = new Set([row.subject, ...(Array.isArray(avoid) ? avoid : [])].map(x => oneLine(x).toLowerCase()));
  // Without a first name only the "Hi {name}" ones stay ("Hi there"); "{name}, open…" would read "There, open…".
  const noName = !firstNameOf(row);
  const all = pool.filter(x => !(x.includes('{sender}') && !oneLine(senderName)))
    .filter(x => !(noName && x.includes('{name}') && !/^(hi|hey|hello) \{name\}/i.test(x)))
    .map(x => capFirst(fill(x)));
  const fresh = all.filter(x => !used.has(x.toLowerCase()));
  return pick(fresh.length ? fresh : all);
}

async function templateDraft(uid, ref, row, senderName, set, offer, signature, avoidSubjects) {
  if (!TEMPLATE_SETS[set]) set = 'paid';
  const own = (await ownTemplates(uid))[set];
  const list = own || TEMPLATE_SETS[set];
  const mixed = AI_SUBJECT_SETS.includes(set);
  // Rewriting a draft moves it to the next template of the same set; a new
  // draft takes the slot for its place in that set's sequence (every
  // TEMPLATE_EVERY drafts → next). Rows from before sets existed count as paid.
  let idx;
  if (mixed) {
    // Exchange: a random version each time; "Next version" never gives the same one back.
    const cur = Number.isInteger(row.templateIdx) && row.templateSet === set ? row.templateIdx : -1;
    const pool = list.map((_, i) => i).filter(i => i !== cur);
    idx = pool.length ? pick(pool) : 0;
  } else if (Number.isInteger(row.templateIdx) && (row.templateSet || 'paid') === set) idx = (row.templateIdx + 1) % list.length;
  else {
    const mine = await db().collection(COLL).where('ownerUid', '==', uid).get();
    const n = mine.docs.filter(d => Number.isInteger(d.data().templateIdx) && (d.data().templateSet || 'paid') === set).length;
    idx = Math.floor(n / TEMPLATE_EVERY) % list.length;
  }
  const t = list[idx % list.length];
  const first = firstNameOf(row);
  const fill = str => str
    .replace(/\{name\}/g, first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there')
    .replace(/\{optout\}/g, OPT_OUTS[idx % OPT_OUTS.length])
    .replace(/\{offer\}/g, offerLine(offer, idx))
    .replace(/\{signature\}/g, cleanSignature(signature) || oneLine(senderName) || 'the LinkBoard team')
    .replace(/\{site\}/g, FREE_MAIL.test(row.domain) ? 'your site' : row.domain)
    .replace(/\{sender\}/g, oneLine(senderName) || 'the LinkBoard team');
  const body = fill(t.body);
  let subject;
  if (mixed) subject = pickSubject(EXCHANGE_SUBJECTS, fill, row, avoidSubjects, senderName);
  else if (set === 'paid' && !own) subject = pickSubject(PAID_SUBJECTS, fill, row, avoidSubjects, senderName);
  else subject = capFirst(fill(t.subject));
  await ref.update({ subject, body, templateIdx: idx, templateSet: set, templateOwn: !!own, status: 'draft', draftedAt: Date.now(), updatedAt: FieldValue().serverTimestamp() });
  return { subject, body, templateIdx: idx, templateSet: set, templateOwn: !!own };
}

async function draft(uid, { id, pitch, senderName, mode, avoidSubjects, offer, signature }) {
  const ref = db().collection(COLL).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== uid) throw new Error('Row not found');
  const row = snap.data();
  if (['sent', 'sending', 'replied', 'bounced'].includes(row.status)) throw new Error('Already sent');
  if (!isSafeHost(row.domain)) throw new Error('Invalid domain');
  if (mode !== 'guest') return templateDraft(uid, ref, row, senderName, mode, offer, signature, avoidSubjects);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const ctx = await siteContext(row.domain);
  const paid = mode !== 'guest';
  const greeting = pick(GREETINGS);
  const avoid = (Array.isArray(avoidSubjects) ? avoidSubjects : []).map(oneLine).filter(Boolean).slice(0, 15);
  const goal = paid
    ? `The sender is an off-page SEO specialist looking for a paid collaboration (publishing a paid guest post on their site) or a content exchange. Never use the word "sponsored". Follow this shape, in your own words each time:
  1. Greeting.
  2. One line: who the sender is (off-page SEO specialist) and that they came across the site.
  3. One honest, specific line about the site.
  4. One line: interested in a paid collaboration (guest post on their site) or a content exchange, whichever they prefer.
  5. Ask for their price for a guest post and whether links are dofollow.
  6. Sign-off.
Keep it 45–90 words. Do not negotiate and do not promise anything beyond this.`
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
Greeting: "${greeting} ${row.firstName || '[first name]'}," if the first name is known, otherwise "${greeting} team," or "${greeting} ${row.domain} team,".
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
  const subject = capFirst(oneLine(out.subject).slice(0, 120));
  const body = String(out.body || '').trim() + '\n\n' + pick(OPT_OUTS);
  if (!subject || !out.body) throw new Error('AI returned an empty draft — try again');
  await ref.update({ subject, body, status: 'draft', draftedAt: Date.now(), updatedAt: FieldValue().serverTimestamp() });
  return { subject, body };
}

// ─── send ────────────────────────────────────────────────
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
function mimeText({ from, fromName, to, subject, body, messageId, extra }) {
  const lines = [
    `From: ${fromName ? encodeHeader(oneLine(fromName).replace(/["<>]/g, '')) + ' ' : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(oneLine(subject))}`,
    ...(messageId ? [`Message-ID: ${messageId}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`] : []),
    ...Object.entries(extra || {}).map(([k, v]) => `${k}: ${oneLine(v)}`),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  ];
  return lines.join('\r\n');
}
const buildMime = m => Buffer.from(mimeText(m), 'utf8').toString('base64url');

// Why this address must not be emailed again, or '' if it's fine.
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|yandex|zoho)\.[a-z.]+$/;
// Only the same address blocks: another person at the same site (info@ after
// jhaxell@) is fine to email. A teammate's earlier email to that address still
// blocks, but the message never names them or shows their row.
async function contactBlock(id, email, uid) {
  const since = Date.now() - RECONTACT_DAYS * DAY;
  const out = ['sent', 'sending', 'replied', 'bounced'];
  const byEmail = await db().collection(COLL).where('email', '==', email).get();
  for (const d of byEmail.docs) {
    if (d.id === id) continue;
    const x = d.data();
    const who = x.ownerUid === uid ? '' : ' by a teammate';
    if (x.status === 'replied' || x.status === 'bounced') return `${email} already ${x.status} to an earlier email${who}`;
    if (out.includes(x.status) && (x.sentAt || 0) >= since) return `${email} was already emailed${who} on ${x.sentDay || 'a recent day'}`;
  }
  return '';
}

// Which of these sites YOU already emailed with the agent, and when, so a
// re-pasted list says "already emailed on …". Teammates' outreach isn't listed.
async function emailedSites(uid, domains) {
  const list = [...new Set((Array.isArray(domains) ? domains : []).map(cleanHost).filter(Boolean))].slice(0, 600);
  const out = {};
  for (let i = 0; i < list.length; i += 30) {
    const snap = await db().collection(COLL).where('domain', 'in', list.slice(i, i + 30)).get();
    snap.docs.forEach(d => {
      const x = d.data();
      if (!['sent', 'sending', 'replied', 'bounced'].includes(x.status) || !x.sentAt) return;
      const mine = x.ownerUid === uid;
      if (!mine) return;
      const cur = out[x.domain];
      // Keep the latest send; your own beats a teammate's on the same day.
      if (cur && (cur.sentAt > x.sentAt || (cur.sentAt === x.sentAt && cur.mine))) return;
      out[x.domain] = { sentAt: x.sentAt, day: x.sentDay || new Date(x.sentAt).toISOString().slice(0, 10), status: x.status, mine,
        followUps: x.followUps || 0, ...(mine ? { email: x.email || '', id: d.id } : {}) };
    });
  }
  return { sites: out };
}

// A test copy of a draft to an address you type (a deliverability tester such
// as mail-tester.com, or yourself): the exact message, from the same mailbox,
// so the test sees what recipients get. It is not outreach — the row's status,
// the daily limit and the 90-day rule are untouched. Up to 10 a day per person.
const TESTS_PER_DAY = 10;
async function sendTest(user, { id, to, from, fromName, extra }) {
  const senderName = oneLine(fromName).slice(0, 60) || (/^admin$/i.test(user.name || '') ? '' : user.name);
  to = String(to || '').trim().toLowerCase();
  if (!isEmail(to)) throw new Error('Enter the test address');
  const snap = await db().collection(COLL).doc(String(id || '')).get();
  if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Row not found');
  const row = snap.data();
  if (!row.subject || !row.body) throw new Error('Write the draft first');
  const mbId = mailboxId(from);
  const gconn = await db().collection('gmailConnections').doc(mbId).get();
  const sconn = gconn.exists ? null : await require('./mailsmtp').get(mbId);
  const connData = gconn.exists ? gconn.data() : sconn;
  if (!connData || connData.ownerUid !== user.uid) throw new Error('Pick one of your connected mailboxes');
  if (!connData.canSend) throw new Error('This mailbox is connected read-only — click "Connect Gmail for sending"');
  const quota = db().collection(TPL_COLL).doc(user.uid);
  const day = today();
  await db().runTransaction(async tx => {
    const q = await tx.get(quota);
    const n = q.exists && q.data().testDay === day ? (q.data().testCount || 0) : 0;
    if (n >= TESTS_PER_DAY) throw new Error(`Test limit reached (${TESTS_PER_DAY} a day)`);
    tx.set(quota, { testDay: day, testCount: n + 1 }, { merge: true });
  });
  const body = hasOptOut(row.body) ? row.body : row.body.trim() + '\n\n' + OPT_OUTS[0];
  if (sconn) {
    const messageId = `<${require('crypto').randomUUID()}@${sconn.email.split('@')[1]}>`;
    await require('./mailsmtp').sendRaw(sconn, { to, raw: mimeText({ from: sconn.email, fromName: senderName, to, subject: row.subject, body, messageId, extra }) });
  } else {
    const access = await accessTokenFor(mbId);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildMime({ from: connData.email, fromName: senderName, to, subject: row.subject, body, extra }) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Gmail HTTP ' + r.status));
  }
  await snap.ref.update({ lastTestTo: to, lastTestAt: Date.now() });
  return { ok: true, to, from: connData.email };
}

// ─── deliverability check ────────────────────────────────
// Built in, no outside tester: (1) the draft's text scored against what spam
// filters look at, (2) the sending domain's SPF / DKIM / DMARC and bounce
// rate, (3) an inbox placement test — the draft goes to another Gmail of the
// same person connected in LinkBoard, and the metadata scope (labels and
// headers only, never the text) shows whether it landed in Inbox, Spam or
// Promotions and what Gmail's own SPF / DKIM / DMARC verdict was.
const SPAM_PHRASES = ['free', 'guarantee', 'guaranteed', '100%', 'act now', 'limited time', 'click here', 'buy now', 'risk-free', 'risk free',
  'no obligation', 'winner', 'cash', 'earn money', 'make money', 'cheap', 'discount', 'urgent', 'special offer', 'best price', 'dear friend',
  'congratulations', 'increase your traffic', 'increase traffic', 'rank #1', 'first page of google', 'seo services', 'lowest price', 'order now',
  'once in a lifetime', 'exclusive deal', 'amazing', 'incredible', 'no cost', 'bonus', 'credit card', 'double your', 'apply now'];
const LINK_PHRASES = ['dofollow', 'do-follow', 'do follow', 'link insertion', 'sponsored post', 'paid post', 'paid link', 'buy links', 'link exchange'];
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)\//i;
function contentCheck(subject, body) {
  subject = String(subject || ''); body = String(body || '');
  const issues = []; let pen = 0;
  const add = (p, level, text) => { pen += p; issues.push({ level, text }); };
  const found = (text, list) => list.filter(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i').test(text));
  if (!subject.trim()) add(3, 'bad', 'Subject is empty');
  if (subject.length > 70) add(1, 'warn', `Subject is long (${subject.length} characters) — keep it under 60`);
  if (/!/.test(subject)) add(1, 'warn', 'Exclamation mark in the subject');
  if (/^\s*(re|fwd?)\s*:/i.test(subject)) add(2, 'bad', 'Subject starts with "Re:" / "Fwd:" on a first email — filters treat this as deceptive');
  if ((subject.match(/\b[A-Z]{4,}\b/g) || []).length) add(1, 'warn', 'Words in CAPITALS in the subject');
  const sw = found(subject, SPAM_PHRASES);
  if (sw.length) add(2, 'bad', `Spam-trigger words in the subject: ${sw.join(', ')}`);
  const words = (body.match(/\S+/g) || []).length;
  if (words < 35) add(1, 'warn', `Body is very short (${words} words)`);
  if (words > 250) add(1, 'warn', `Body is long (${words} words) — cold emails do best under 150`);
  const links = body.match(/https?:\/\/\S+|www\.\S+/gi) || [];
  if (links.length > 2) add(1.5, 'warn', `${links.length} links — keep a first email to 1 or none`);
  else if (links.length) issues.push({ level: 'ok', text: `${links.length} link${links.length > 1 ? 's' : ''} — fine` });
  if (SHORTENERS.test(body)) add(2, 'bad', 'Link shortener (bit.ly etc.) — a strong spam signal; use the full address');
  const bw = found(body, SPAM_PHRASES);
  if (bw.length) add(Math.min(3, bw.length * 0.5), 'warn', `Spam-trigger words: ${bw.join(', ')}`);
  const lw = found(body + ' ' + subject, LINK_PHRASES);
  if (lw.length) add(Math.min(2, lw.length), 'warn', `Paid-link wording filters watch for: ${lw.join(', ')} — say it in plain words or leave it for the reply`);
  if ((body.match(/\b[A-Z]{4,}\b/g) || []).length > 2) add(1, 'warn', 'Several words in CAPITALS');
  if (/!!|\?\?/.test(body) || (body.match(/!/g) || []).length > 3) add(1, 'warn', 'Too many exclamation marks');
  if (/[$€£]\s?\d/.test(body)) add(0.5, 'warn', 'A price in the first email — better left for the reply');
  if (/\{\{?\s*\w+\s*\}?\}|\[(first ?name|name|website|site|company)\]/i.test(body + subject)) add(3, 'bad', 'Unfilled placeholder like {name} or [Name]');
  if (!hasOptOut(body)) issues.push({ level: 'ok', text: 'No opt-out line — one is added automatically when it is sent' });
  if (!issues.some(i => i.level !== 'ok')) issues.unshift({ level: 'ok', text: 'No spam signals found in the text' });
  return { score: Math.max(0, Math.round((10 - pen) * 10) / 10), words, links: links.length, issues };
}

async function deliverability(user, { id, from, fromName, seed }) {
  const snap = await db().collection(COLL).doc(String(id || '')).get();
  if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Row not found');
  const row = snap.data();
  if (!row.subject || !row.body) throw new Error('Write the draft first');
  const content = contentCheck(row.subject, row.body);
  const mbId = mailboxId(from);
  const gconn = await db().collection('gmailConnections').doc(mbId).get();
  const sconn = gconn.exists ? null : await require('./mailsmtp').get(mbId);
  const conn = gconn.exists ? gconn.data() : sconn;
  if (!conn || conn.ownerUid !== user.uid) throw new Error('Pick one of your connected mailboxes');
  const [health, bounce] = await Promise.all([domainHealth(conn.email, gconn.exists ? 'gmail' : conn.provider), bounceStats(mbId)]);
  const out = { content, health, bounce, from: conn.email };
  if (seed) {
    const sd = await db().collection('gmailConnections').doc(String(seed)).get();
    if (!sd.exists || sd.data().ownerUid !== user.uid) throw new Error('Pick one of your own Gmail mailboxes as the test inbox');
    if (sd.id === mbId) throw new Error('The test inbox must be a different mailbox than the sender');
    const token = require('crypto').randomUUID();
    await sendTest(user, { id, to: sd.data().email, from, fromName, extra: { 'X-LB-Test': token } });
    Object.assign(out, { token, seed: sd.id, seedEmail: sd.data().email, sentAt: Date.now() });
  }
  return out;
}

// Looks for the test message in the test inbox's newest mail (Spam included).
async function placement(user, { seed, token }) {
  const sd = await db().collection('gmailConnections').doc(String(seed || '')).get();
  if (!sd.exists || sd.data().ownerUid !== user.uid) throw new Error('Test inbox not found');
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw new Error('Bad test id');
  const access = await accessTokenFor(sd.id);
  const list = await gmailGet('messages?maxResults=15&includeSpamTrash=true', access);
  for (const m of list.messages || []) {
    const msg = await gmailGet(`messages/${m.id}?format=metadata&metadataHeaders=X-LB-Test&metadataHeaders=Authentication-Results`, access);
    const hs = (msg.payload && msg.payload.headers) || [];
    if (!hs.some(h => /^x-lb-test$/i.test(h.name) && h.value.trim() === token)) continue;
    const labels = msg.labelIds || [];
    const folder = labels.includes('SPAM') ? 'spam' : labels.includes('TRASH') ? 'trash'
      : labels.includes('CATEGORY_PROMOTIONS') ? 'promotions' : labels.includes('CATEGORY_SOCIAL') ? 'social'
      : labels.includes('CATEGORY_UPDATES') ? 'updates' : labels.includes('INBOX') ? 'inbox' : 'other';
    const ar = hs.filter(h => /^authentication-results$/i.test(h.name)).map(h => h.value).join(' ');
    const verdict = k => ((ar.match(new RegExp('\\b' + k + '=(\\w+)', 'i')) || [])[1] || '').toLowerCase() || null;
    return { found: true, folder, auth: { spf: verdict('spf'), dkim: verdict('dkim'), dmarc: verdict('dmarc') } };
  }
  return { found: false };
}

// Today's emails from a mailbox — first emails and follow-ups both count
// toward its daily limit and the 4-minute spacing.
async function usedToday(tx, mbId, day) {
  const [a, b] = await Promise.all([
    tx.get(db().collection(COLL).where('sentDay', '==', day)),
    tx.get(db().collection(COLL).where('fuDay', '==', day))
  ]);
  const first = a.docs.filter(d => d.data().fromMailbox === mbId), fu = b.docs.filter(d => d.data().fromMailbox === mbId);
  const last = Math.max(0, ...first.map(d => d.data().sentAt || 0), ...fu.map(d => d.data().fuAt || 0));
  return { used: first.length + fu.length, last };
}

async function send(user, { id, email, from, fromName }) {
  // Display name on the From line: the name typed on the page, else the account name unless it's a role like "Admin".
  const senderName = oneLine(fromName).slice(0, 60) || (/^admin$/i.test(user.name || '') ? '' : user.name);
  const ref = db().collection(COLL).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Row not found');
  const row = snap.data();
  const to = String(row.email || '').toLowerCase();
  if (!['draft', 'failed'].includes(row.status)) throw new Error('Only a reviewed draft can be sent (status is ' + row.status + ')');
  // The page sends the address it showed — if the row changed underneath, stop.
  if (!to || to !== String(email || '').toLowerCase()) throw new Error('The recipient changed — review the row again');
  if (!isEmail(to)) throw new Error('Not a valid email address');
  // Only addresses Verify confirmed go out — an unverified one may bounce and hurt the mailbox.
  if (row.smtp === 'invalid') throw new Error('This address failed verification');
  if (row.smtp !== 'valid') throw new Error('Not verified — click Verify first; only verified emails are sent');
  if (!row.subject || !row.body) throw new Error('Draft is empty');

  const block = await contactBlock(ref.id, to, user.uid);
  if (block) { await ref.update({ status: 'skipped', skipReason: block, updatedAt: FieldValue().serverTimestamp() }); throw new Error(block); }

  const mbId = mailboxId(from);
  // Gmail (API) or a Private Email / SMTP mailbox — same quota and pacing.
  const gconn = await db().collection('gmailConnections').doc(mbId).get();
  const sconn = gconn.exists ? null : await require('./mailsmtp').get(mbId);
  const conn = gconn.exists ? gconn : { exists: !!sconn, data: () => sconn || {} };
  if (!conn.exists || conn.data().ownerUid !== user.uid) throw new Error('Pick one of your connected mailboxes');
  if (!conn.data().canSend) throw new Error('This mailbox is connected read-only — click "Connect Gmail for sending"');
  const bounce = await bounceStats(mbId);
  if (isPaused(bounce, conn.data().resumeUntil)) throw new Error(`Sending paused for this mailbox: ${bounce.pct}% of the last ${bounce.sent} emails bounced. Remove bad addresses, then click Resume.`);

  // Claim the row and a slot of today's quota in one transaction, so a double
  // click or two open tabs can never send twice or overshoot the limit.
  const day = today();
  await db().runTransaction(async tx => {
    const cur = await tx.get(ref);
    if (!['draft', 'failed'].includes(cur.data().status)) throw new Error('Already being sent');
    const { used: mineN, last } = await usedToday(tx, mbId, day);
    const limit = limitOf(conn.data());
    if (mineN >= limit) throw new Error(`Daily limit reached for ${conn.data().email} (${limit}/day)`);
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) throw new Error(`Wait ${Math.ceil(wait / 60000)} min before the next email from ${conn.data().email}`);
    tx.update(ref, { status: 'sending', sentDay: day, fromMailbox: mbId, fromEmail: conn.data().email, sentAt: Date.now() });
  });

  const body = hasOptOut(row.body) ? row.body : row.body.trim() + '\n\n' + OPT_OUTS[0];
  try {
    if (sconn) {
      const messageId = `<${require('crypto').randomUUID()}@${sconn.email.split('@')[1]}>`;
      await require('./mailsmtp').sendRaw(sconn, { to, raw: mimeText({ from: sconn.email, fromName: senderName, to, subject: row.subject, body, messageId }) });
      await ref.update({ status: 'sent', body, smtpMessageId: messageId, sentAt: Date.now(), sentBy: user.name, error: null, updatedAt: FieldValue().serverTimestamp() });
    } else {
    const access = await accessTokenFor(mbId);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildMime({ from: conn.data().email, fromName: senderName, to, subject: row.subject, body }) })
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Gmail HTTP ' + r.status));
    await ref.update({ status: 'sent', body, messageId: j.id, threadId: j.threadId, sentAt: Date.now(), sentBy: user.name, error: null, updatedAt: FieldValue().serverTimestamp() });
    }
  } catch (e) {
    // Not sent — free the quota slot and let the admin retry.
    await ref.update({ status: 'failed', error: String(e.message || e).slice(0, 300), sentDay: null, sentAt: null, updatedAt: FieldValue().serverTimestamp() });
    throw e;
  }

  // Log it in the sender's own Domains DB row (never a teammate's row).
  try {
    const dom = await db().collection('domains').where('domain', '==', row.domain).get();
    const note = `Outreach Agent: emailed ${to} on ${day}`;
    const same = dom.docs.find(d => String(d.data().email || '').toLowerCase() === to && d.data().addedBy === (user.name || ''));
    if (same) await same.ref.update({ notes: [same.data().notes, note].filter(Boolean).join(' · ') });
    else await db().collection('domains').add({
      domain: row.domain, email: to, smtp: row.smtp || 'unknown', firstName: row.firstName || '', lastName: '',
      position: row.title || '', dr: '', traffic: '', project: '', notes: note, addedBy: user.name || '', createdAt: FieldValue().serverTimestamp()
    });
  } catch (e) {}
  return { ok: true };
}

// ─── follow-ups ──────────────────────────────────────────
// A follow-up is a reply in the same thread: "Re: <first subject>", sent from
// the mailbox the first email went from, with In-Reply-To / References set to
// the first email's Message-ID (and, for Gmail, the same threadId) so every
// mail app shows it under the first email. Drafts come from short fixed
// texts (free, no AI); the person reviews them and sends through the queue.
const FU_TEMPLATES = {
  1: [
    "Hi {name},\n\nJust bumping this up in case it got buried in your inbox. Would you be open to it?\n\nBest,\n{signature}",
    "Hi {name},\n\nFollowing up on my note below. Is this something you'd consider for {site}?\n\nThanks,\n{signature}",
    "Hello {name},\n\nWanted to make sure my last email didn't slip through the cracks. Let me know what you think.\n\nBest regards,\n{signature}",
    "Hi {name},\n\nQuick follow-up on the email below. Happy to share more details if it helps.\n\nThanks,\n{signature}",
    "Hi {name},\n\nI know inboxes get busy, so I'm bringing this back to the top. Any thoughts?\n\nBest,\n{signature}"
  ],
  2: [
    "Hi {name},\n\nI'll keep this short: is a collaboration with {site} still something you'd look at? A simple yes or no works.\n\nThanks,\n{signature}",
    "Hello {name},\n\nOne last follow-up from me. If the timing isn't right, no problem at all, just let me know.\n\nBest,\n{signature}",
    "Hi {name},\n\nChecking in one more time about {site}. If someone else handles this, I'd appreciate a pointer.\n\nThanks,\n{signature}",
    "Hi {name},\n\nI don't want to crowd your inbox, so this is my last note. If you're open to it later, just reply here.\n\nBest regards,\n{signature}"
  ]
};
const reSubject = s => /^\s*re\s*:/i.test(s || '') ? oneLine(s) : 'Re: ' + oneLine(s);
function fuQuote(x, body) {
  const when = x.sentAt ? new Date(x.sentAt).toUTCString().replace(/:\d\d GMT$/, ' UTC') : 'earlier';
  return `\n\nOn ${when}, ${x.fromEmail || 'I'} wrote:\n` + String(body || '').split('\n').map(l => '> ' + l).join('\n');
}

async function fuDraft(uid, { ids, fromName, signature }) {
  const out = {};
  for (const id of (ids || []).slice(0, 100)) {
    const ref = db().collection(COLL).doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) continue;
    const x = snap.data();
    if (x.ownerUid !== uid || x.status !== 'sent' || x.fuQueue || !x.subject) continue;
    const n = Math.min(2, (x.followUps || 0) + 1);
    const pool = FU_TEMPLATES[n].filter(t => t !== x.fuTemplate);
    const t = pick(pool.length ? pool : FU_TEMPLATES[n]);
    const first = firstNameOf(x);
    const body = t
      .replace(/\{name\}/g, first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there')
      .replace(/\{site\}/g, FREE_MAIL.test(x.domain) ? 'your site' : x.domain)
      .replace(/\{signature\}/g, cleanSignature(signature) || oneLine(fromName) || oneLine(x.sentBy) || 'the LinkBoard team');
    const fu = { fuSubject: reSubject(x.subject), fuBody: body, fuTemplate: t, fuError: null };
    await ref.update({ ...fu, updatedAt: FieldValue().serverTimestamp() });
    out[ref.id] = { fuSubject: fu.fuSubject, fuBody: body };
  }
  return { drafts: out };
}

async function fuQueueRows(uid, { ids, fromName }) {
  const name = oneLine(fromName).slice(0, 60);
  const batch = db().batch();
  const now = Date.now();
  let n = 0;
  for (const id of (ids || []).slice(0, MAX_ROWS)) {
    const ref = db().collection(COLL).doc(String(id));
    const cur = await ref.get();
    if (!cur.exists) continue;
    const x = cur.data();
    if (x.ownerUid !== uid || x.status !== 'sent' || !x.fuBody || x.fuQueue || !x.fromMailbox) continue;
    batch.update(ref, { fuQueue: { fromName: name, at: now + n, from: x.fromEmail || '' }, fuError: null });
    n++;
  }
  if (n) await batch.commit();
  return { queued: n };
}

// What the other messages in a sent email's Gmail thread say: 'bounced' (a
// delivery failure), 'replied' (a real person answered), 'auto' (only an
// out-of-office / auto-responder came back — not a reply), or '' (nothing).
const TRACK_HEADERS = ['From', 'Subject', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'X-Auto-Response-Suppress', 'Precedence', 'Content-Type'];
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?reply|auto:|out of (the )?office|ooo\b|away from (the )?office|i am out|i'm out|on vacation|on leave|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica|thank you for (your )?(email|message|contacting)|thanks for (your )?(email|message|reaching out)|we (have )?received your)/i;
function isAutoReply(get) {
  const as = get('auto-submitted');
  if (as && !/^no$/i.test(as)) return true;
  if (get('x-autoreply') || get('x-autorespond')) return true;
  if (/auto_reply|auto-reply|bulk|junk/i.test(get('precedence'))) return true;
  return AUTO_SUBJECT.test(get('subject'));
}
async function threadStatus(x, access) {
  const t = await gmailGet(`threads/${x.threadId}?format=metadata&${TRACK_HEADERS.map(h => 'metadataHeaders=' + encodeURIComponent(h)).join('&')}&fields=messages(id,labelIds,payload/headers)`, access);
  const own = String(x.fromEmail || '').toLowerCase();
  let status = '';
  for (const m of (t.messages || [])) {
    if (m.id === x.messageId) continue;
    const hs = (m.payload && m.payload.headers) || [];
    const get = n => String((hs.find(h => h.name.toLowerCase() === n) || {}).value || '');
    const f = get('from').toLowerCase();
    if (!f || (own && f.includes(own))) continue; // our own email or follow-up
    if (/mailer-daemon|postmaster|mail delivery|delivery status/.test(f) || /report-type=delivery-status/i.test(get('content-type'))) return 'bounced';
    if (isAutoReply(get)) { if (!status) status = 'auto'; continue; }
    status = 'replied';
  }
  return status;
}
// True when the thread already has a reply or a bounce (auto-replies don't count).
async function threadHasReply(x, access) {
  return ['replied', 'bounced'].includes(await threadStatus(x, access));
}

async function sendFollowUp(user, { id, fromName }) {
  const ref = db().collection(COLL).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Row not found');
  const x = snap.data();
  if (x.status !== 'sent') throw new Error(`Not sent: this contact is ${x.status} now`);
  if (!x.fuBody) throw new Error('Write the follow-up first');
  const to = String(x.email || '').toLowerCase();
  const mbId = x.fromMailbox;
  if (!mbId || !isEmail(to)) throw new Error('This row has no sending mailbox or address');
  const gconn = await db().collection('gmailConnections').doc(mbId).get();
  const sconn = gconn.exists ? null : await require('./mailsmtp').get(mbId);
  const conn = gconn.exists ? gconn.data() : sconn;
  if (!conn || conn.ownerUid !== user.uid) throw new Error(`The mailbox the first email went from (${x.fromEmail || mbId}) isn't connected to your account`);
  if (!conn.canSend) throw new Error('This mailbox is connected read-only — click "Connect Gmail for sending"');
  const bounce = await bounceStats(mbId);
  if (isPaused(bounce, conn.resumeUntil)) throw new Error(`Sending paused for this mailbox: ${bounce.pct}% of the last ${bounce.sent} emails bounced.`);

  // Gmail: look at the thread right before sending — never follow up on a reply.
  let access = null;
  if (!sconn) {
    if (!x.threadId) throw new Error('No Gmail thread stored for this email');
    access = await accessTokenFor(mbId);
    if (await threadHasReply(x, access)) {
      await ref.update({ status: 'replied', repliedAt: Date.now(), fuQueue: FieldValue().delete(), updatedAt: FieldValue().serverTimestamp() });
      throw new Error('They already replied — follow-up not sent');
    }
  }

  const day = today();
  await db().runTransaction(async tx => {
    const cur = await tx.get(ref);
    if (cur.data().fuSending) throw new Error('Already being sent');
    if (cur.data().status !== 'sent') throw new Error(`Not sent: this contact is ${cur.data().status} now`);
    const { used, last } = await usedToday(tx, mbId, day);
    const limit = limitOf(conn);
    if (used >= limit) throw new Error(`Daily limit reached for ${conn.email} (${limit}/day)`);
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) throw new Error(`Wait ${Math.ceil(wait / 60000)} min before the next email from ${conn.email}`);
    tx.update(ref, { fuSending: true, fuDay: day, fuAt: Date.now() });
  });

  const senderName = oneLine(fromName).slice(0, 60) || (/^admin$/i.test(user.name || '') ? '' : user.name);
  const subject = x.fuSubject || reSubject(x.subject);
  const body = String(x.fuBody).trim() + fuQuote(x, x.body);
  try {
    let rootId = x.smtpMessageId || x.rootMessageId || '';
    if (!sconn && !rootId) {
      const m = await gmailGet(`messages/${x.messageId}?format=metadata&metadataHeaders=Message-ID`, access);
      rootId = String((((m.payload && m.payload.headers) || []).find(h => /^message-id$/i.test(h.name)) || {}).value || '').trim();
    }
    const refs = [rootId, ...(Array.isArray(x.fuMsgIds) ? x.fuMsgIds : [])].filter(Boolean);
    const extra = refs.length ? { 'In-Reply-To': refs[refs.length - 1], References: refs.join(' ') } : {};
    let newId = '';
    if (sconn) {
      newId = `<${require('crypto').randomUUID()}@${sconn.email.split('@')[1]}>`;
      await require('./mailsmtp').sendRaw(sconn, { to, raw: mimeText({ from: sconn.email, fromName: senderName, to, subject, body, messageId: newId, extra }) });
    } else {
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: buildMime({ from: conn.email, fromName: senderName, to, subject, body, extra }), threadId: x.threadId })
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || ('Gmail HTTP ' + r.status));
    }
    await ref.update({
      fuSending: FieldValue().delete(), fuQueue: FieldValue().delete(), fuSubject: FieldValue().delete(), fuBody: FieldValue().delete(), fuError: null,
      followUps: FieldValue().increment(1), followedUpAt: Date.now(), fuAt: Date.now(),
      ...(rootId && !x.smtpMessageId ? { rootMessageId: rootId } : {}),
      ...(newId ? { fuMsgIds: FieldValue().arrayUnion(newId) } : {}),
      fuLog: FieldValue().arrayUnion({ at: Date.now(), by: user.name || '', subject }),
      updatedAt: FieldValue().serverTimestamp()
    });
  } catch (e) {
    await ref.update({ fuSending: FieldValue().delete(), fuDay: null, fuAt: null, fuError: String(e.message || e).slice(0, 300), updatedAt: FieldValue().serverTimestamp() });
    throw e;
  }
  return { ok: true };
}

// ─── server-side send queue ──────────────────────────────
// "Send selected" only marks rows with `queue`; tick() sends them one at a
// time per mailbox, 4–5 min apart, so sending goes on with the laptop closed.
// tick() is hit every minute by an outside timer (Bearer OUTREACH_TICK_SECRET
// or CRON_SECRET — Hobby's own cron runs only once a day) and by any open
// Outreach page. Every check in send() still applies at send time.
// outreachQueue/{mailboxId} { nextAt } spaces the emails out.
const QUEUE_COLL = 'outreachQueue';
const MAILBOX_ERR = /mailbox|connect|token|invalid_grant|credential|sign-in|unauthori[sz]ed|read-only/i;

async function queueRows(user, { ids, from, fromName }) {
  const mbId = mailboxId(from);
  const g = await db().collection('gmailConnections').doc(mbId).get();
  const conn = g.exists ? g.data() : await require('./mailsmtp').get(mbId);
  if (!conn || conn.ownerUid !== user.uid) throw new Error('Pick one of your connected mailboxes');
  if (!conn.canSend) throw new Error('This mailbox is connected read-only — click "Connect Gmail for sending"');
  const name = oneLine(fromName).slice(0, 60);
  const batch = db().batch();
  const now = Date.now();
  let n = 0;
  for (const id of (ids || []).slice(0, MAX_ROWS)) {
    const ref = db().collection(COLL).doc(String(id));
    const cur = await ref.get();
    if (!cur.exists) continue;
    const x = cur.data();
    if (x.ownerUid !== user.uid || !['draft', 'failed'].includes(x.status) || !x.email || !x.subject || !x.body || x.queue) continue;
    if (x.smtp !== 'valid') continue; // only verified addresses are sent
    // at keeps the order the rows were picked in.
    batch.update(ref, { queue: { from: conn.email, fromName: name, email: String(x.email).toLowerCase(), at: now + n }, error: null });
    n++;
  }
  if (n) await batch.commit();
  return { queued: n };
}

async function unqueueRows(uid, ids) {
  const snap = await db().collection(COLL).where('ownerUid', '==', uid).get();
  const want = ids && ids.length ? new Set(ids) : null;
  const batch = db().batch();
  let n = 0;
  snap.docs.forEach(d => {
    if (want && !want.has(d.id)) return;
    const del = {};
    if (d.data().queue) del.queue = FieldValue().delete();
    if (d.data().fuQueue) del.fuQueue = FieldValue().delete();
    if (Object.keys(del).length) { batch.update(d.ref, del); n++; }
  });
  if (n) await batch.commit();
  return { unqueued: n };
}

// Next UTC midnight (when sentDay, and so the daily limit, rolls over) plus a few minutes.
const nextDayAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime() + Math.random() * 15 * 60000; };

async function tick() {
  const snap = await db().collection(COLL).where('queue.at', '>', 0).get();
  const fsnap = await db().collection(COLL).where('fuQueue.at', '>', 0).get();
  const byBox = {};
  snap.docs.forEach(d => { const q = d.data().queue; (byBox[mailboxId(q.from)] = byBox[mailboxId(q.from)] || []).push(d); });
  // Follow-ups go from the mailbox of the first email; they share its turn and pacing.
  fsnap.docs.forEach(d => { const m = d.data().fromMailbox; if (m) (byBox[m] = byBox[m] || []).push(d); });
  const qOf = d => d.data().fuQueue && !d.data().queue ? d.data().fuQueue : d.data().queue;
  const deadline = Date.now() + 40000;
  const out = { sent: 0, waiting: 0, failed: 0, queued: snap.size + fsnap.size };
  for (const [mbId, docs] of Object.entries(byBox)) {
    if (Date.now() > deadline) break;
    const slot = db().collection(QUEUE_COLL).doc(mbId);
    // Claim this mailbox's turn, so the timer and an open page can't both send.
    const gap = MIN_GAP_MS + Math.random() * 60000;
    const claimed = await db().runTransaction(async tx => {
      const s = await tx.get(slot);
      if (s.exists && (s.data().nextAt || 0) > Date.now()) return false;
      tx.set(slot, { nextAt: Date.now() + gap }, { merge: true });
      return true;
    });
    if (!claimed) { out.waiting++; continue; }
    docs.sort((a, b) => qOf(a).at - qOf(b).at);
    const d = docs[0], x = d.data(), isFu = !!x.fuQueue && !x.queue, q = qOf(d);
    const u = await db().collection('users').doc(x.ownerUid).get();
    const user = { uid: x.ownerUid, name: (u.exists && u.data().name) || '', role: (u.exists && u.data().role) || 'builder' };
    try {
      if (isFu) await sendFollowUp(user, { id: d.id, fromName: q.fromName });
      else {
        await send(user, { id: d.id, email: q.email, from: q.from, fromName: q.fromName });
        await d.ref.update({ queue: FieldValue().delete() });
      }
      out.sent++;
    } catch (e) {
      const msg = String(e.message || e);
      const wait = /Wait (\d+) min/.exec(msg);
      if (wait) { await slot.set({ nextAt: Date.now() + (+wait[1]) * 60000 + Math.random() * 60000 }, { merge: true }); out.waiting++; continue; }
      // Daily limit: the queue carries on after the day rolls over.
      if (/Daily limit/.test(msg)) { await slot.set({ nextAt: nextDayAt() }, { merge: true }); out.waiting++; continue; }
      out.failed++;
      // A mailbox problem stops that mailbox's whole queue; anything else drops just this row.
      const stop = MAILBOX_ERR.test(msg) ? docs : [d];
      const batch = db().batch();
      stop.forEach(r => {
        if (r.data().fuQueue && !r.data().queue) batch.update(r.ref, { fuQueue: FieldValue().delete(), fuError: msg.slice(0, 300) });
        else batch.update(r.ref, { queue: FieldValue().delete(), ...(r.data().status === 'sending' ? {} : { error: msg.slice(0, 300) }) });
      });
      await batch.commit();
      await slot.set({ nextAt: 0, lastError: msg.slice(0, 300) }, { merge: true });
    }
  }
  return out;
}

function isTickCall(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  return [process.env.OUTREACH_TICK_SECRET, process.env.CRON_SECRET].some(k => k && m[1] === k);
}

// ─── reply / bounce tracking ─────────────────────────────
// Which rows are read (Firestore reads cost money as the team grows):
// - "Check replies" (onlyUid): only that person's sent rows;
// - the 2-hourly run (recentDays): only rows sent or followed up in the last
//   recentDays — the ones replies actually come in on;
// - the nightly run: every sent row in the TRACK_DAYS window.
async function trackAll(onlyUid, budgetMs, recentDays) {
  const col = db().collection(COLL);
  let docs;
  if (onlyUid) docs = (await col.where('ownerUid', '==', onlyUid).where('status', '==', 'sent').get()).docs;
  else if (recentDays) {
    const from = Date.now() - recentDays * DAY;
    const [a, b] = await Promise.all([col.where('sentAt', '>=', from).get(), col.where('followedUpAt', '>=', from).get()]);
    const seen = new Set();
    docs = [...a.docs, ...b.docs].filter(d => d.data().status === 'sent' && !seen.has(d.id) && seen.add(d.id));
  } else docs = (await col.where('status', '==', 'sent').get()).docs;
  const snap = { docs };
  const since = Date.now() - TRACK_DAYS * DAY;
  // "Check replies" also re-reads rows marked Replied before auto-replies were
  // told apart, once each (recheckedAt), and puts an out-of-office back to Sent.
  const old = onlyUid ? (await db().collection(COLL).where('ownerUid', '==', onlyUid).where('status', '==', 'replied').get()).docs
    .filter(d => d.data().threadId && !d.data().recheckedAt && (d.data().sentAt || 0) >= since) : [];
  // Newest first: they're the likeliest to get a reply.
  const rows = [...old, ...snap.docs].filter(d => d.data().threadId && (d.data().sentAt || 0) >= since && (!onlyUid || d.data().ownerUid === onlyUid))
    .sort((p, q) => (q.data().followedUpAt || q.data().sentAt || 0) - (p.data().followedUpAt || p.data().sentAt || 0));
  const tokens = {};
  let replied = 0, bounced = 0, auto = 0, checked = 0, unchecked = 0;
  const deadline = Date.now() + (budgetMs || 45000);
  // Several threads at a time, so every sent email gets checked inside the time limit.
  const work = rows.slice();
  const worker = async () => {
    while (work.length) {
      if (Date.now() > deadline) { unchecked += work.length; work.length = 0; break; }
      const d = work.shift(), x = d.data();
      try {
        if (!(x.fromMailbox in tokens)) tokens[x.fromMailbox] = accessTokenFor(x.fromMailbox).catch(() => null);
        const access = await tokens[x.fromMailbox];
        if (!access) { unchecked++; continue; }
        const st = await threadStatus(x, access);
        checked++;
        if (x.status === 'replied') {
          if (st === 'auto') { await d.ref.update({ status: 'sent', autoReplyAt: x.repliedAt || Date.now(), recheckedAt: Date.now(), updatedAt: FieldValue().serverTimestamp() }); auto++; }
          else await d.ref.update({ recheckedAt: Date.now() });
          continue;
        }
        if (st === 'replied' || st === 'bounced') {
          await d.ref.update({ status: st, [st + 'At']: Date.now(), updatedAt: FieldValue().serverTimestamp() });
          if (st === 'replied') replied++; else bounced++;
        } else if (st === 'auto' && !x.autoReplyAt) { await d.ref.update({ autoReplyAt: Date.now() }); auto++; }
      } catch (e) { unchecked++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // Private Email / SMTP mailboxes: read the inbox over IMAP, one login per mailbox.
  const smtpRows = snap.docs.filter(d => d.data().smtpMessageId && (d.data().sentAt || 0) >= since && (!onlyUid || d.data().ownerUid === onlyUid));
  const byBox = {};
  smtpRows.forEach(d => { (byBox[d.data().fromMailbox] = byBox[d.data().fromMailbox] || []).push({ ref: d.ref, data: d.data() }); });
  const smtp = require('./mailsmtp');
  for (const [box, list] of Object.entries(byBox)) {
    if (Date.now() > deadline) break;
    try {
      const conn = await smtp.get(box);
      if (!conn) continue;
      const r = await smtp.track(conn, list, deadline, (ref, status) => ref.update({ status, [status + 'At']: Date.now(), updatedAt: FieldValue().serverTimestamp() }));
      replied += r.replied; bounced += r.bounced; checked += list.length;
    } catch (e) { unchecked += list.length; }
  }
  return { checked, replied, bounced, auto, unchecked };
}

// ─── verify (Snov SMTP check) ────────────────────────────
// Checks the addresses on up to VERIFY_MAX of the caller's rows and stores the
// result on each row (valid / invalid / unknown). Uses the caller's own Snov
// account if connected, otherwise the shared one — it spends Snov credits.
const VERIFY_MAX = 30;
async function verify(uid, ids) {
  const snov = require('./snov');
  const refs = [];
  for (const id of (ids || []).slice(0, VERIFY_MAX)) {
    const ref = db().collection(COLL).doc(String(id));
    const cur = await ref.get();
    if (!cur.exists || cur.data().ownerUid !== uid) continue;
    const x = cur.data();
    if (!isEmail(x.email) || ['sent', 'sending', 'replied', 'bounced'].includes(x.status)) continue;
    refs.push({ ref, email: x.email.toLowerCase() });
  }
  if (!refs.length) return { results: {} };
  const token = await snov.getSnovToken(await snov.getUserSnovCredentials(uid));
  if (!token) throw new Error('Snov is not connected');
  const statuses = await snov.verifyEmailsWithSnov([...new Set(refs.map(r => r.email))], token);
  const results = {};
  const batch = db().batch();
  refs.forEach(({ ref, email }) => {
    const smtp = statuses.get(email) || 'unknown';
    results[ref.id] = smtp;
    batch.update(ref, { smtp, verifiedAt: Date.now(), updatedAt: FieldValue().serverTimestamp() });
  });
  await batch.commit();
  return { results };
}

// ─── HTTP ────────────────────────────────────────────────
// Same people as the app's canUseAgent(): admins, plus Tatev and these builders by name.
const AGENT_USERS = ['Tatev', 'Armen', 'Tam', 'Nick', 'Syuzi', 'Sofya', 'Gor'];
const canUseAgent = u => u.role === 'admin' || AGENT_USERS.includes(u.name);

async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  // The outside timer: GET or POST /api/outreach?tick=1 with the secret.
  if (req.query && req.query.tick && isTickCall(req)) {
    try {
      const t0 = Date.now();
      const out = await tick();
      // AI Link Builder research left running with the page closed: its steps
      // can take most of a minute, so they run in their own request (the
      // timer's own request has a 30s limit).
      if (Date.now() - t0 < 15000) out.linkBuilder = await require('./linkbuilder').kick(req).catch(e => ({ error: String(e.message || e) }));
      // Replies and bounces for everyone's last 3 weeks of emails, every 2 hours, in the time this request has left (older ones: nightly).
      try {
        const left = 25000 - (Date.now() - t0);
        const slot = db().collection(QUEUE_COLL).doc('_track');
        const go = left > 6000 && await db().runTransaction(async tx => {
          const s = await tx.get(slot);
          if (s.exists && (s.data().nextAt || 0) > Date.now()) return false;
          tx.set(slot, { nextAt: Date.now() + 2 * 3600000 }, { merge: true });
          return true;
        });
        if (go) out.track = await trackAll(null, left - 3000, 21);
      } catch (e) { out.track = { error: String(e.message || e) }; }
      return res.json(out);
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireMember(req, res);
  if (!user) return;
  if (!canUseAgent(user)) return res.status(403).json({ error: 'Outreach Agent is not enabled for your account' });
  const b = req.body || {};
  try {
    switch (b.action) {
      case 'list': return res.json({ rows: await list(user.uid) });
      case 'save': return res.json({ ids: await save(user.uid, b.items) });
      case 'delete': return res.json({ deleted: await remove(user.uid, b.ids) });
      case 'mailboxes': return res.json({ mailboxes: await mailboxes(user.uid), limit: DAILY_LIMIT });
      case 'mailbox-resume': return res.json(await resumeMailbox(user.uid, b));
      case 'mailbox-limit': return res.json(await setMailboxLimit(user.uid, b));
      case 'send-test': return res.json(await sendTest(user, { ...b, extra: undefined }));
      case 'categorize': return res.json(await categorize(user.uid, b));
      case 'deliverability': return res.json(await deliverability(user, b));
      case 'placement': return res.json(await placement(user, b));
      case 'draft': return res.json(await draft(user.uid, b));
      case 'send': return res.json(await send(user, b));
      case 'queue': return res.json(await queueRows(user, b));
      case 'unqueue': return res.json(await unqueueRows(user.uid, b.ids));
      case 'emailed': return res.json(await emailedSites(user.uid, b.domains));
      case 'fu-draft': return res.json(await fuDraft(user.uid, b));
      case 'fu-queue': return res.json(await fuQueueRows(user.uid, b));
      case 'tick': return res.json(await tick());
      case 'track': return res.json(await trackAll(user.uid));
      case 'verify': return res.json(await verify(user.uid, b.ids));
      case 'templates': return res.json(await getTemplates(user.uid));
      case 'templates-save': return res.json(await saveTemplates(user.uid, b));
      case 'folder-color': return res.json(await saveFolderColor(user.uid, b));
      case 'templates-generate': return res.json(await templateVariations(b));
      case 'smtp-connect':
        // Private Email is the admin's own mailbox type; everyone else sends from Gmail.
        if (user.role !== 'admin') return res.status(403).json({ error: 'Private Email mailboxes are admin-only' });
        return res.json(await require('./mailsmtp').connect(user, b));
      case 'smtp-disconnect': return res.json(await require('./mailsmtp').disconnect(user, b));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}

module.exports = handler;
module.exports.trackAll = trackAll;
