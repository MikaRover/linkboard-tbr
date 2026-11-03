// AI Link Builder (phase 1, research only — nothing is emailed from here).
// A client domain → its real organic competitors (Ahrefs) → the sites that
// link to those competitors, filtered by the person's requirements → sites we
// already have, already emailed or that already link to the client dropped →
// an AI look at the best ones (type, relevance, "write for us" page).
//
// Firestore (server-only, like outreachAgent):
//   linkBuilderJobs/{id}            the research: client, requirements, status, competitors
//   linkBuilderJobs/{id}/rows/{dom} one candidate site per referring domain
//   linkBuilderJobs/{id}/meta/clientRefs  domains that already link to the client
//
// Each step is short (one competitor, the filter pass, or a few AI checks), so
// it fits the 60s limit. The open page drives the steps; tick() lets the
// outside timer (the Outreach send timer) finish a research with the page closed.
//
// Lives in api/_lib (Hobby plan: all 12 function slots are taken) —
// api/sheets-import.js dispatches /api/linkbuilder here.

const { setCors, requireMember } = require('./auth');
const { isSafeHost, cleanHost, browserHeaders } = require('./security');
const { getAdmin } = require('./gmail').internals;
const { canUseAgent } = require('./outreach');

const COLL = 'linkBuilderJobs';
const DAY = 86400000;
const RECONTACT_DAYS = 90;
const MAX_PICKED = 8;
const RUNNING = ['collect', 'filter', 'check'];
const DEFAULT_REQ = { drMin: 30, drMax: 90, trafficMin: 1000, perComp: 100, aiTop: 60, country: 'us', language: 'English', skipTypes: true };
// Big platforms show up as "competitors" for almost any site; listed, never preselected.
const GENERIC = /(^|\.)(wikipedia\.org|youtube\.com|reddit\.com|amazon\.[a-z.]+|facebook\.com|linkedin\.com|quora\.com|medium\.com|github\.com|google\.[a-z.]+|apple\.com|microsoft\.com|forbes\.com|pinterest\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|yahoo\.com|nytimes\.com|wordpress\.com|blogspot\.com)$/;
// Names that read like SEO directories / link lists rather than real sites.
const SEO_NAME = /(directory|submit|backlink|seo-?|webdir|bookmark|articlebase|articles?directory|press-?release|linkfarm|guestpost|addurl)/;

const db = () => getAdmin().firestore();
const FieldValue = () => require('./firebase-admin').firestore.FieldValue;
const host = d => (cleanHost(d) || '').replace(/^www\./, '');
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };

function cleanReq(r) {
  r = r || {};
  const out = {
    drMin: num(r.drMin, DEFAULT_REQ.drMin, 0, 100), drMax: num(r.drMax, DEFAULT_REQ.drMax, 0, 100),
    trafficMin: num(r.trafficMin, DEFAULT_REQ.trafficMin, 0, 1e9),
    perComp: num(r.perComp, DEFAULT_REQ.perComp, 10, 300), aiTop: num(r.aiTop, DEFAULT_REQ.aiTop, 0, 150),
    country: /^[a-z]{2}$/i.test(r.country || '') ? r.country.toLowerCase() : DEFAULT_REQ.country,
    language: String(r.language ?? DEFAULT_REQ.language).trim().slice(0, 30),
    skipTypes: r.skipTypes !== false
  };
  if (out.drMax < out.drMin) out.drMax = out.drMin;
  return out;
}

// ─── Ahrefs ──────────────────────────────────────────────
async function ahrefs(path, params) {
  const key = process.env.AHREFS_API_KEY;
  if (!key) throw new Error('Ahrefs API key not configured');
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://api.ahrefs.com/v3/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Ahrefs: ' + ((j && (j.error || j.message)) || ('HTTP ' + r.status)));
  return j;
}
// Units this key has spent this month (free call) — read before and after a research.
async function keyUnits() {
  try { const j = await ahrefs('subscription-info/limits-and-usage', {}); return j.limits_and_usage?.units_usage_api_key ?? null; }
  catch (e) { return null; }
}
const today = () => new Date().toISOString().slice(0, 10);

// ─── page reading + AI ───────────────────────────────────
const textOf = html => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const WFU = /write[\s-]*for[\s-]*us|guest[\s-]*post|contribut(e|or)|submit[\s-]*(an[\s-]*)?(article|post)|become[\s-]*a[\s-]*(writer|contributor)/i;

async function readSite(domain) {
  if (!isSafeHost(domain)) return null;
  try {
    const r = await fetch('https://' + domain, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    const title = textOf((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const lang = (html.match(/<html[^>]+lang=["']([a-z-]+)["']/i) || [])[1] || '';
    let writeForUs = '';
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      if (WFU.test(m[1]) || WFU.test(textOf(m[2]))) {
        try { writeForUs = new URL(m[1], 'https://' + domain).href; } catch (e) {}
        if (writeForUs) break;
      }
    }
    return { title, desc: textOf(desc), lang, writeForUs, text: textOf(html).slice(0, 1500) };
  } catch (e) { return null; }
}

async function haiku(prompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: maxTokens, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return '';
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  } catch (e) { return ''; }
}

async function nicheOf(client) {
  const s = await readSite(client);
  if (!s) return '';
  const out = await haiku(`In one sentence (under 30 words), say what this website or product is and its main topics.\n\nSite: ${client}\nTitle: ${s.title}\nDescription: ${s.desc}\nText: ${s.text}\n\nAnswer with the sentence only.`, 120);
  return out.replace(/\s+/g, ' ').slice(0, 300);
}

const TYPES = ['blog', 'media', 'saas', 'ecommerce', 'agency', 'directory', 'forum', 'other'];
async function classify(row, niche) {
  const s = await readSite(row.domain);
  if (!s) return { ai: { type: 'other', relevance: null, language: '', why: 'Site did not load' }, writeForUs: '' };
  const raw = await haiku(`You are vetting a website for link-building outreach.

Our client: ${niche || 'unknown'}
Website: ${row.domain}
Title: ${s.title}
Description: ${s.desc}
HTML lang: ${s.lang || 'not set'}
Homepage text: ${s.text}

Return ONLY a JSON object:
{"type":"${TYPES.join('|')}","relevance":<0-100, how topically related this site's audience is to our client>,"language":"<main language of the site in English, e.g. English>","why":"<under 15 words>"}`, 200);
  let ai = null;
  try { ai = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch (e) {}
  ai = ai || {};
  return {
    ai: {
      type: TYPES.includes(ai.type) ? ai.type : 'other',
      relevance: Number.isFinite(+ai.relevance) ? Math.max(0, Math.min(100, Math.round(+ai.relevance))) : null,
      language: String(ai.language || '').slice(0, 30),
      why: String(ai.why || '').replace(/\s+/g, ' ').slice(0, 140)
    },
    writeForUs: s.writeForUs
  };
}

// ─── jobs ────────────────────────────────────────────────
const jobRef = id => db().collection(COLL).doc(String(id || ''));
async function ownJob(user, id) {
  const snap = await jobRef(id).get();
  if (!snap.exists) throw new Error('Research not found');
  const j = snap.data();
  if (j.ownerUid !== user.uid && user.role !== 'admin') throw new Error('Research not found');
  return { ref: snap.ref, job: j };
}
// Ahrefs units are only shown to admins.
const publicJob = (id, j, user) => {
  const { lockUntil, ...rest } = j;
  if (user.role !== 'admin') { delete rest.unitsStart; delete rest.unitsSpent; }
  return { id, ...rest, createdAt: j.createdAt?.toMillis?.() || j.createdAt || null };
};

async function list(user) {
  const q = user.role === 'admin' ? db().collection(COLL) : db().collection(COLL).where('ownerUid', '==', user.uid);
  const snap = await q.get();
  return snap.docs.map(d => publicJob(d.id, d.data(), user)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
}

async function get(user, id) {
  const { ref, job } = await ownJob(user, id);
  const rows = (await ref.collection('rows').get()).docs.map(d => d.data());
  return { job: publicJob(ref.id, job, user), rows };
}

async function create(user, { client, req }) {
  const c = host(client);
  if (!c || !isSafeHost(c)) throw new Error('Enter the client’s domain, e.g. client.com');
  const r = cleanReq(req);
  const [comp, niche] = await Promise.all([
    ahrefs('site-explorer/organic-competitors', {
      target: c, country: r.country, date: today(), mode: 'subdomains',
      select: 'competitor_domain,domain_rating,keywords_common,share,traffic', order_by: 'keywords_common:desc', limit: 15
    }),
    nicheOf(c)
  ]);
  const competitors = (comp.competitors || []).map(x => ({
    domain: host(x.competitor_domain), dr: Math.round(x.domain_rating || 0), traffic: x.traffic || 0,
    common: x.keywords_common || 0, generic: GENERIC.test(host(x.competitor_domain))
  })).filter(x => x.domain && x.domain !== c);
  const picked = competitors.filter(x => !x.generic).slice(0, 5).map(x => x.domain);
  const ref = db().collection(COLL).doc();
  const job = {
    ownerUid: user.uid, ownerName: user.name || '', client: c, niche, req: r, status: 'pick',
    competitors, picked, collectIdx: 0, counts: { collected: 0, kept: 0, excluded: 0, toCheck: 0, checked: 0 },
    createdAt: FieldValue().serverTimestamp()
  };
  await ref.set(job);
  return { job: publicJob(ref.id, { ...job, createdAt: Date.now() }, user) };
}

async function start(user, { id, picked }) {
  const { ref, job } = await ownJob(user, id);
  if (job.status !== 'pick') throw new Error('This research already started');
  const list = [...new Set((picked || []).map(host).filter(d => d && isSafeHost(d) && d !== job.client))].slice(0, MAX_PICKED);
  if (!list.length) throw new Error('Pick at least one competitor');
  await ref.update({ picked: list, status: 'collect', collectIdx: 0, unitsStart: await keyUnits(), startedAt: Date.now() });
  return { ok: true };
}

async function remove(user, { id }) {
  const { ref } = await ownJob(user, id);
  const rows = await ref.collection('rows').get();
  for (let i = 0; i < rows.docs.length; i += 400) {
    const b = db().batch(); rows.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
  }
  await ref.collection('meta').doc('clientRefs').delete().catch(() => {});
  await ref.delete();
  return { ok: true };
}

// ─── steps ───────────────────────────────────────────────
function refWhere(r) {
  const and = [
    { field: 'domain_rating', is: ['gte', r.drMin] }, { field: 'domain_rating', is: ['lte', r.drMax] },
    { field: 'dofollow_links', is: ['gt', 0] }, { field: 'is_spam', is: ['eq', false] }
  ];
  if (r.trafficMin > 0) and.push({ field: 'traffic_domain', is: ['gte', r.trafficMin] });
  return JSON.stringify({ and });
}

async function stepCollect(ref, job) {
  const comp = job.picked[job.collectIdx];
  if (comp) {
    const j = await ahrefs('site-explorer/refdomains', {
      target: comp, mode: 'subdomains', history: 'live',
      select: 'domain,domain_rating,traffic_domain,dofollow_linked_domains', where: refWhere(job.req),
      order_by: 'traffic_domain:desc', limit: job.req.perComp
    });
    const skip = new Set([job.client, ...job.picked]);
    const rows = (j.refdomains || []).map(x => ({ ...x, domain: host(x.domain) })).filter(x => x.domain && !skip.has(x.domain) && !job.picked.some(p => x.domain.endsWith('.' + p)));
    for (let i = 0; i < rows.length; i += 400) {
      const b = db().batch();
      rows.slice(i, i + 400).forEach(x => b.set(ref.collection('rows').doc(x.domain), {
        domain: x.domain, dr: Math.round(x.domain_rating || 0), traffic: x.traffic_domain || 0,
        linkedDomains: x.dofollow_linked_domains || 0, comps: FieldValue().arrayUnion(comp)
      }, { merge: true }));
      await b.commit();
    }
    await ref.update({ collectIdx: job.collectIdx + 1, 'counts.collected': FieldValue().increment(rows.length) });
    return;
  }
  // All competitors done: the client's own referring domains, so sites that
  // already link to the client drop out.
  let refs = [];
  try {
    const j = await ahrefs('site-explorer/refdomains', {
      target: job.client, mode: 'subdomains', history: 'live', select: 'domain',
      where: JSON.stringify({ field: 'domain_rating', is: ['gte', job.req.drMin] }), order_by: 'domain_rating:desc', limit: 2000
    });
    refs = (j.refdomains || []).map(x => host(x.domain)).filter(Boolean);
  } catch (e) {}
  await ref.collection('meta').doc('clientRefs').set({ domains: refs });
  await ref.update({ status: 'filter' });
}

async function stepFilter(ref, job) {
  const rows = (await ref.collection('rows').get()).docs.map(d => d.data());
  const clientRefs = new Set(((await ref.collection('meta').doc('clientRefs').get()).data() || {}).domains || []);
  // Sites already in LinkBoard and sites the team emailed in the last 90 days.
  const inLinkBoard = new Set((await db().collection('links').select('domain').get()).docs.map(d => host(d.data().domain)).filter(Boolean));
  const since = Date.now() - RECONTACT_DAYS * DAY;
  const emailed = new Set((await db().collection('outreachAgent').where('sentAt', '>=', since).select('domain').get()).docs.map(d => host(d.data().domain)).filter(Boolean));
  const out = rows.map(r => {
    const count = (r.comps || []).length;
    let reason = '';
    if (clientRefs.has(r.domain)) reason = 'Already links to the client';
    else if (inLinkBoard.has(r.domain)) reason = 'Already in LinkBoard';
    else if (emailed.has(r.domain)) reason = 'Emailed in the last 90 days';
    else if (r.linkedDomains > 3000 && r.traffic < 5000) reason = `Links out to ${r.linkedDomains.toLocaleString('en-US')} sites (link farm)`;
    else if (SEO_NAME.test(r.domain)) reason = 'Looks like a directory or SEO site';
    return { domain: r.domain, count, state: reason ? 'excluded' : 'kept', reason, score: count * 1e9 + (r.traffic || 0) };
  });
  const kept = out.filter(r => r.state === 'kept').sort((a, b) => b.score - a.score);
  const check = new Set(kept.slice(0, job.req.aiTop).map(r => r.domain));
  for (let i = 0; i < out.length; i += 400) {
    const b = db().batch();
    out.slice(i, i + 400).forEach(r => b.set(ref.collection('rows').doc(r.domain), { ...r, toCheck: check.has(r.domain), checked: false }, { merge: true }));
    await b.commit();
  }
  await ref.update({ status: check.size ? 'check' : 'done', 'counts.kept': kept.length, 'counts.excluded': out.length - kept.length, 'counts.toCheck': check.size, ...(check.size ? {} : await finishFields(job)) });
}

async function finishFields(job) {
  const now = await keyUnits();
  return { finishedAt: Date.now(), unitsSpent: now != null && job.unitsStart != null ? Math.max(0, now - job.unitsStart) : null };
}

async function stepCheck(ref, job) {
  const snap = await ref.collection('rows').where('toCheck', '==', true).where('checked', '==', false).limit(6).get();
  if (snap.empty) { await ref.update({ status: 'done', ...(await finishFields(job)) }); return; }
  const lang = (job.req.language || '').toLowerCase();
  let dropped = 0;
  await Promise.all(snap.docs.map(async d => {
    const { ai, writeForUs } = await classify(d.data(), job.niche);
    const patch = { ai, writeForUs, checked: true };
    if (job.req.skipTypes && (ai.type === 'directory' || ai.type === 'forum')) { patch.state = 'excluded'; patch.reason = 'AI: ' + ai.type; }
    else if (lang && ai.language && !ai.language.toLowerCase().includes(lang)) { patch.state = 'excluded'; patch.reason = `Not in ${job.req.language} (${ai.language})`; }
    if (patch.state) dropped++;
    await d.ref.update(patch);
  }));
  await ref.update({ 'counts.checked': FieldValue().increment(snap.size), ...(dropped ? { 'counts.kept': FieldValue().increment(-dropped), 'counts.excluded': FieldValue().increment(dropped) } : {}) });
}

// One step, claimed so the page and the timer never run the same research at once.
async function step(ref) {
  const claimed = await db().runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const j = s.data();
    if (!RUNNING.includes(j.status) || (j.lockUntil || 0) > Date.now()) return null;
    tx.update(ref, { lockUntil: Date.now() + 55000 });
    return j;
  });
  if (!claimed) return false;
  try {
    if (claimed.status === 'collect') await stepCollect(ref, claimed);
    else if (claimed.status === 'filter') await stepFilter(ref, claimed);
    else await stepCheck(ref, claimed);
    await ref.update({ lockUntil: 0, error: null });
  } catch (e) {
    await ref.update({ lockUntil: 0, status: 'failed', error: String(e.message || e).slice(0, 300) });
  }
  return true;
}

async function stepFor(user, { id }) {
  const { ref } = await ownJob(user, id);
  await step(ref);
  return get(user, id);
}

// Called by the Outreach send timer with whatever time it has left.
async function tick(budgetMs) {
  const deadline = Date.now() + budgetMs;
  const snap = await db().collection(COLL).where('status', 'in', RUNNING).limit(5).get();
  let steps = 0;
  for (const d of snap.docs) {
    if (Date.now() > deadline) break;
    if (await step(d.ref)) steps++;
  }
  return { steps };
}

// ─── HTTP ────────────────────────────────────────────────
async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireMember(req, res);
  if (!user) return;
  if (!canUseAgent(user)) return res.status(403).json({ error: 'AI Link Builder is not enabled for your account' });
  const b = req.body || {};
  try {
    switch (b.action) {
      case 'list': return res.json({ jobs: await list(user), defaults: DEFAULT_REQ });
      case 'get': return res.json(await get(user, b.id));
      case 'create': return res.json(await create(user, b));
      case 'start': return res.json(await start(user, b));
      case 'step': return res.json(await stepFor(user, b));
      case 'delete': return res.json(await remove(user, b));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
}

module.exports = handler;
module.exports.tick = tick;
