// AI Link Builder (phase 1, research only — nothing is emailed from here).
// A client domain → its real organic competitors (Ahrefs) → the page on each
// site that links to those competitors, filtered by the person's requirements
// → sites we already have, already emailed, or that already link to the client
// dropped, plus PBN / link-farm / directory signs → a deep vet of the best ones,
// the way a senior link builder would: the linking page itself (editorial or
// paid, listicle or guest post), 12 months of organic traffic, where that
// traffic comes from, whether the site still publishes, spam topics, and an AI
// verdict with the opportunity type and the pitch angle.
//
// Firestore (server-only, like outreachAgent):
//   linkBuilderJobs/{id}                  the research: client, requirements, status, competitors
//   linkBuilderJobs/{id}/rows/{domain}    one candidate site
//   linkBuilderJobs/{id}/meta/clientRefs  domains that already link to the client
//
// Each step is short (one competitor, the filter pass, or a few deep checks),
// so it fits the 60s limit. The open page drives the steps; tick() lets the
// outside timer (the Outreach send timer) finish a research with the page closed.
//
// Lives in api/_lib (Hobby plan: all 12 function slots are taken) —
// api/sheets-import.js dispatches /api/linkbuilder here.

const { setCors, requireMember } = require('./auth');
const { isSafeHost, cleanHost, browserHeaders } = require('./security');
const { getAdmin } = require('./gmail').internals;

const COLL = 'linkBuilderJobs';
const DAY = 86400000;
const RECONTACT_DAYS = 90;
const MAX_PICKED = 8;
const DEEP_PER_STEP = 4;
const RUNNING = ['collect', 'filter', 'check'];
const DEFAULT_REQ = { drMin: 30, drMax: 90, trafficMin: 1000, perComp: 100, aiTop: 40, country: 'us', language: 'English', skipTypes: true };
const VET_MODEL = 'claude-sonnet-5-5';
// First version: the admin and Tatev only.
const canUseLinkBuilder = u => u.role === 'admin' || u.name === 'Tatev';
// Big platforms show up as "competitors" for almost any site; listed, never preselected.
const GENERIC = /(^|\.)(wikipedia\.org|youtube\.com|reddit\.com|amazon\.[a-z.]+|facebook\.com|linkedin\.com|quora\.com|medium\.com|github\.com|google\.[a-z.]+|apple\.com|microsoft\.com|forbes\.com|pinterest\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|yahoo\.com|nytimes\.com|wordpress\.com|blogspot\.com)$/;
// Names and titles that read like SEO directories / link lists rather than real sites.
const SEO_NAME = /(directory|submit|backlink|seo-?|webdir|bookmark|articlebase|articles?directory|press-?release|linkfarm|guestpost|addurl)/;
const DIRECTORY_PAGE = /director(y|ies)|submit (your )?(site|url|link)|add (your )?(site|url|link)|web ?links|link exchange/i;
// Topics no client wants a link next to.
const SPAM_TOPICS = /\b(casino|betting|sportsbook|poker|slots?|gambling|cbd|cannabis|vape|payday|loans? online|escort|adult|porn|viagra|essay writing|replica)\b/gi;

const db = () => getAdmin().firestore();
const FieldValue = () => require('./firebase-admin').firestore.FieldValue;
const host = d => (cleanHost(d) || '').replace(/^www\./, '');
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function cleanReq(r) {
  r = r || {};
  const out = {
    drMin: num(r.drMin, DEFAULT_REQ.drMin, 0, 100), drMax: num(r.drMax, DEFAULT_REQ.drMax, 0, 100),
    trafficMin: num(r.trafficMin, DEFAULT_REQ.trafficMin, 0, 1e9),
    perComp: num(r.perComp, DEFAULT_REQ.perComp, 10, 300), aiTop: num(r.aiTop, DEFAULT_REQ.aiTop, 0, 100),
    country: /^[a-z]{2}$/i.test(r.country || '') ? r.country.toLowerCase() : DEFAULT_REQ.country,
    language: clip(r.language ?? DEFAULT_REQ.language, 30),
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
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const today = () => isoDay(Date.now());

// 12 months of organic traffic: change of the last 3 months against the first 3.
async function trafficTrend(domain) {
  try {
    const j = await ahrefs('site-explorer/metrics-history', {
      target: domain, mode: 'subdomains', date_from: isoDay(Date.now() - 365 * DAY), history_grouping: 'monthly', select: 'date,org_traffic'
    });
    const t = (j.metrics || []).map(m => m.org_traffic || 0);
    if (t.length < 6) return null;
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const first = avg(t.slice(0, 3)), last = avg(t.slice(-3)), peak = Math.max(...t);
    return {
      changePct: first > 0 ? Math.round((last - first) / first * 100) : null,
      fromPeakPct: peak > 0 ? Math.round((t[t.length - 1] - peak) / peak * 100) : null,
      series: t
    };
  } catch (e) { return null; }
}
// Where the traffic comes from: the share in the client's country, and the top three.
async function trafficCountries(domain, country) {
  try {
    const j = await ahrefs('site-explorer/metrics-by-country', { target: domain, mode: 'subdomains', date: today(), select: 'country,org_traffic', limit: 50 });
    const rows = (j.metrics || []).filter(m => m.country && m.country !== 'OTHER').sort((a, b) => (b.org_traffic || 0) - (a.org_traffic || 0));
    const total = (j.metrics || []).reduce((s, m) => s + (m.org_traffic || 0), 0);
    if (!total) return null;
    const own = rows.find(m => m.country === country.toUpperCase());
    return { share: Math.round((own ? own.org_traffic : 0) / total * 100), top: rows.slice(0, 3).map(m => `${m.country} ${Math.round(m.org_traffic / total * 100)}%`) };
  } catch (e) { return null; }
}

// ─── page reading + AI ───────────────────────────────────
const textOf = html => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const WFU = /write[\s-]*for[\s-]*us|guest[\s-]*post|contribut(e|or)|submit[\s-]*(an[\s-]*)?(article|post)|become[\s-]*a[\s-]*(writer|contributor)/i;
const ADV = /advertis|sponsor|media[\s-]*kit|partner[\s-]*with[\s-]*us/i;

async function fetchText(url, ms) {
  const r = await fetch(url, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) return '';
  return (await r.text()).slice(0, 400000);
}
function linkMatching(html, re, base) {
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (re.test(m[1]) || re.test(textOf(m[2]))) { try { return new URL(m[1], base).href; } catch (e) {} }
  }
  return '';
}

async function readSite(domain) {
  if (!isSafeHost(domain)) return null;
  try {
    const base = 'https://' + domain;
    const html = await fetchText(base, 8000);
    if (!html) return null;
    const title = textOf((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const lang = (html.match(/<html[^>]+lang=["']([a-z-]+)["']/i) || [])[1] || '';
    const text = textOf(html);
    const spam = [...new Set((text.match(SPAM_TOPICS) || []).map(w => w.toLowerCase()))];
    // Recent posts and how fresh they are, from the feed most blogs publish.
    let lastPost = null, recent = [];
    try {
      const feedUrl = (html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i) || [])[1];
      const feed = await fetchText(feedUrl ? new URL(feedUrl, base).href : base + '/feed', 6000);
      if (/<(rss|feed)\b/i.test(feed)) {
        const dates = [...feed.matchAll(/<(?:pubDate|updated|published)>([^<]+)</gi)].map(m => Date.parse(m[1])).filter(Boolean);
        if (dates.length) lastPost = Math.max(...dates);
        recent = [...feed.matchAll(/<item\b[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>|<entry\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/gi)]
          .map(m => clip(textOf(m[1] || m[2] || ''), 120)).filter(Boolean).slice(0, 6);
      }
    } catch (e) {}
    return {
      title: clip(title, 200), desc: clip(textOf(desc), 300), lang, text: text.slice(0, 1500), spam, lastPost, recent,
      writeForUs: linkMatching(html, WFU, base), advertise: linkMatching(html, ADV, base)
    };
  } catch (e) { return null; }
}

async function claude(model, prompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) return '';
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  } catch (e) { return ''; }
}
const parseJson = raw => { try { return JSON.parse((String(raw).match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch (e) { return {}; } };

async function nicheOf(client) {
  const s = await readSite(client);
  if (!s) return '';
  const out = await claude('claude-haiku-5-5', `In one or two sentences (under 45 words), say what this website or product is, who it is for, and its main topics.\n\nSite: ${client}\nTitle: ${s.title}\nDescription: ${s.desc}\nText: ${s.text}\n\nAnswer with the sentences only.`, 160);
  return clip(out, 400);
}

const TYPES = ['blog', 'media', 'saas', 'ecommerce', 'agency', 'directory', 'forum', 'other'];
const OPPS = ['guest_post', 'listicle', 'resource_page', 'review', 'news', 'interview', 'integration', 'paid', 'directory', 'other'];
const VERDICTS = ['strong', 'good', 'maybe', 'skip'];

// The deep vet of one candidate: everything a senior link builder would look
// at before spending a pitch on it, then one verdict.
async function vet(row, job) {
  const [site, trend, countries] = await Promise.all([readSite(row.domain), trafficTrend(row.domain), trafficCountries(row.domain, job.req.country)]);
  const links = (row.links || []).slice(0, 4);
  const linkLines = links.map(l => `- to ${l.comp}: "${clip(l.title, 140)}" ${l.url}\n  anchor "${clip(l.anchor, 80)}"; ${l.inContent ? 'in the article body' : 'not in the body (sidebar/footer/list)'}; ${l.sponsored ? 'marked sponsored' : 'not marked sponsored'}; page type ${l.pageType || 'unknown'}; published ${l.published || 'unknown'}; ${l.extLinks ?? '?'} external links on that page`).join('\n');
  const prompt = `You are a link builder with 10 years of experience. Vet this website as an outreach prospect for our client, exactly as you would before spending a pitch on it. Be strict: a weak or risky link is worse than no link.

OUR CLIENT: ${job.client}
What it is: ${job.niche || 'unknown'}
Target market: ${job.req.country.toUpperCase()}${job.req.language ? `, ${job.req.language}-language sites` : ''}

PROSPECT: ${row.domain}
Domain Rating ${row.dr}; organic traffic ${row.traffic}/month; ranks for ${row.keywords ?? '?'} keywords; links out to ${row.linkedDomains ?? '?'} domains${row.tld && row.tld !== 'normal' ? `; .${row.tld} site` : ''}
Traffic trend over 12 months: ${trend ? `${trend.changePct ?? '?'}% (last 3 months vs first 3); now ${trend.fromPeakPct ?? '?'}% from the peak` : 'unknown'}
Traffic by country: ${countries ? `${countries.share}% from ${job.req.country.toUpperCase()}; top ${countries.top.join(', ')}` : 'unknown'}

HOW IT LINKS TO OUR CLIENT'S COMPETITORS (${(row.comps || []).length} of ${job.picked.length} competitors):
${linkLines || '- no page details'}

THE SITE TODAY:
Title: ${site ? site.title : 'did not load'}
Description: ${site ? site.desc : ''}
HTML lang: ${site ? site.lang || 'not set' : ''}
Latest post: ${site && site.lastPost ? isoDay(site.lastPost) : 'unknown'}
Recent post titles: ${site && site.recent.length ? site.recent.join(' | ') : 'unknown'}
"Write for us" page: ${site && site.writeForUs ? site.writeForUs : 'none found'}
Advertise / sponsored page: ${site && site.advertise ? site.advertise : 'none found'}
Spam topics on the homepage: ${site && site.spam.length ? site.spam.join(', ') : 'none'}
Homepage text: ${site ? site.text.slice(0, 1200) : ''}

Judge: topical fit with our client and its audience; whether the competitor links are editorial or bought; how the link was most likely won (guest post, inclusion in a listicle / "best X tools" roundup, resource page, review, news/PR mention, interview, integration/partner page, paid placement, directory); site health (traffic trend, real readers in our market, still publishing); and risks (PBN or link-farm signs, link selling, spam topics, thin content, wrong language or country).

Return ONLY a JSON object:
{"verdict":"${VERDICTS.join('|')}","score":<0-100 overall worth of pitching>,"relevance":<0-100 topical fit>,"type":"${TYPES.join('|')}","language":"<main language, in English>","opportunity":"${OPPS.join('|')}","pitch":"<one sentence: the concrete angle to win this link, naming the page or section to target>","greenFlags":["<short>"],"redFlags":["<short>"],"why":"<under 20 words>"}`;
  const ai = parseJson(await claude(VET_MODEL, prompt, 700));
  const list = a => (Array.isArray(a) ? a : []).map(x => clip(x, 80)).filter(Boolean).slice(0, 5);
  return {
    deep: {
      trendPct: trend ? trend.changePct : null, fromPeakPct: trend ? trend.fromPeakPct : null, series: trend ? trend.series : null,
      countryShare: countries ? countries.share : null, topCountries: countries ? countries.top : [],
      lastPost: site ? site.lastPost : null, recent: site ? site.recent : [], spam: site ? site.spam : [],
      advertise: site ? site.advertise : '', loaded: !!site
    },
    ai: {
      verdict: VERDICTS.includes(ai.verdict) ? ai.verdict : 'maybe',
      score: Number.isFinite(+ai.score) ? Math.max(0, Math.min(100, Math.round(+ai.score))) : null,
      relevance: Number.isFinite(+ai.relevance) ? Math.max(0, Math.min(100, Math.round(+ai.relevance))) : null,
      type: TYPES.includes(ai.type) ? ai.type : 'other',
      language: clip(ai.language, 30),
      opportunity: OPPS.includes(ai.opportunity) ? ai.opportunity : 'other',
      pitch: clip(ai.pitch, 240), greenFlags: list(ai.greenFlags), redFlags: list(ai.redFlags), why: clip(ai.why, 160)
    },
    writeForUs: site ? site.writeForUs : ''
  };
}

// Hard rules on top of the AI verdict: things an expert never overlooks.
function hardRule(job, deep, ai) {
  if (!deep.loaded) return 'Site did not load';
  if (deep.spam.length >= 2) return 'Spam topics on the site: ' + deep.spam.slice(0, 3).join(', ');
  if (deep.trendPct != null && deep.trendPct <= -60) return `Organic traffic down ${-deep.trendPct}% in 12 months`;
  if (deep.lastPost && Date.now() - deep.lastPost > 365 * DAY) return 'No new posts for over a year';
  if (job.req.skipTypes && (ai.type === 'directory' || ai.type === 'forum')) return 'AI: ' + ai.type;
  const lang = (job.req.language || '').toLowerCase();
  if (lang && ai.language && !ai.language.toLowerCase().includes(lang)) return `Not in ${job.req.language} (${ai.language})`;
  if (ai.verdict === 'skip') return 'AI: ' + (ai.why || 'not worth pitching');
  return '';
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
    common: x.keywords_common || 0, share: x.share != null ? Math.round(x.share * 10) / 10 : null, generic: GENERIC.test(host(x.competitor_domain))
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
// One linking page per referring domain, already filtered on Ahrefs' side by
// the requirements, so rows that would be dropped anyway cost no units.
function linkWhere(r) {
  const and = [
    { field: 'domain_rating_source', is: ['gte', r.drMin] }, { field: 'domain_rating_source', is: ['lte', r.drMax] },
    { field: 'is_dofollow', is: ['eq', true] }, { field: 'is_spam', is: ['eq', false] }, { field: 'is_lost', is: ['eq', false] }
  ];
  if (r.trafficMin > 0) and.push({ field: 'traffic_domain', is: ['gte', r.trafficMin] });
  return JSON.stringify({ and });
}

async function stepCollect(ref, job) {
  const comp = job.picked[job.collectIdx];
  if (comp) {
    const j = await ahrefs('site-explorer/all-backlinks', {
      target: comp, mode: 'subdomains', history: 'live', aggregation: '1_per_domain', where: linkWhere(job.req),
      select: 'name_source,url_from,title,anchor,domain_rating_source,traffic_domain,is_content,is_sponsored,page_type_source,source_page_publish_date,first_seen_link,links_external,linked_domains_source_domain,positions_source_domain,languages,tld_class_source',
      order_by: 'traffic_domain:desc', limit: job.req.perComp
    });
    const skip = new Set([job.client, ...job.picked]);
    const rows = (j.backlinks || []).map(x => ({ ...x, domain: host(x.name_source || x.url_from) }))
      .filter(x => x.domain && !skip.has(x.domain) && !job.picked.some(p => x.domain.endsWith('.' + p)) && !x.domain.endsWith('.' + job.client));
    for (let i = 0; i < rows.length; i += 400) {
      const b = db().batch();
      rows.slice(i, i + 400).forEach(x => b.set(ref.collection('rows').doc(x.domain), {
        domain: x.domain, dr: Math.round(x.domain_rating_source || 0), traffic: x.traffic_domain || 0,
        linkedDomains: x.linked_domains_source_domain ?? null, keywords: x.positions_source_domain ?? null,
        tld: x.tld_class_source || 'normal', languages: (x.languages || []).slice(0, 3),
        comps: FieldValue().arrayUnion(comp),
        links: FieldValue().arrayUnion({
          comp, url: clip(x.url_from, 500), title: clip(x.title, 200), anchor: clip(x.anchor, 120),
          inContent: !!x.is_content, sponsored: !!x.is_sponsored, pageType: clip(x.page_type_source, 120),
          published: x.source_page_publish_date || '', firstSeen: String(x.first_seen_link || '').slice(0, 10), extLinks: x.links_external ?? null
        })
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

// Why a site is out before any deep check, or ''.
function quickRule(r, sets) {
  const links = r.links || [];
  if (sets.clientRefs.has(r.domain)) return 'Already links to the client';
  if (sets.inLinkBoard.has(r.domain)) return 'Already in LinkBoard';
  if (sets.emailed.has(r.domain)) return 'Emailed in the last 90 days';
  if (r.linkedDomains > 3000 && r.traffic < 5000) return `Links out to ${r.linkedDomains.toLocaleString('en-US')} sites (link farm)`;
  if (r.dr >= 40 && r.keywords != null && r.keywords < 100) return `DR ${r.dr} but ranks for only ${r.keywords} keywords (PBN risk)`;
  if (SEO_NAME.test(r.domain)) return 'Looks like a directory or SEO site';
  if (links.length && links.every(l => DIRECTORY_PAGE.test(l.title) || /directory/i.test(l.pageType))) return 'Directory listing';
  if (links.length && links.every(l => (l.extLinks || 0) > 200)) return 'Link sits in a page with 200+ outgoing links';
  return '';
}

async function stepFilter(ref, job) {
  const rows = (await ref.collection('rows').get()).docs.map(d => d.data());
  const since = Date.now() - RECONTACT_DAYS * DAY;
  const sets = {
    clientRefs: new Set(((await ref.collection('meta').doc('clientRefs').get()).data() || {}).domains || []),
    // Sites already in LinkBoard and sites the team emailed in the last 90 days.
    inLinkBoard: new Set((await db().collection('links').select('domain').get()).docs.map(d => host(d.data().domain)).filter(Boolean)),
    emailed: new Set((await db().collection('outreachAgent').where('sentAt', '>=', since).select('domain').get()).docs.map(d => host(d.data().domain)).filter(Boolean))
  };
  const out = rows.map(r => {
    const reason = quickRule(r, sets);
    const count = (r.comps || []).length;
    const editorial = (r.links || []).some(l => l.inContent && !l.sponsored);
    // Before the deep check: link intersect first, editorial links next, then traffic.
    return { domain: r.domain, count, state: reason ? 'excluded' : 'kept', reason, score: count * 1e9 + (editorial ? 5e8 : 0) + Math.min(r.traffic || 0, 4.9e8) };
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
  const snap = await ref.collection('rows').where('toCheck', '==', true).where('checked', '==', false).limit(DEEP_PER_STEP).get();
  if (snap.empty) { await ref.update({ status: 'done', ...(await finishFields(job)) }); return; }
  let dropped = 0;
  await Promise.all(snap.docs.map(async d => {
    const row = d.data();
    const { deep, ai, writeForUs } = await vet(row, job);
    const reason = hardRule(job, deep, ai);
    // After the deep check the AI score leads; link intersect still breaks ties.
    const patch = { deep, ai, writeForUs, checked: true, score: 2e10 + (ai.score || 0) * 1e8 + (row.count || 0) * 1e7 + Math.min(row.traffic || 0, 9e6) };
    if (reason) { patch.state = 'excluded'; patch.reason = reason; dropped++; }
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

// The Outreach send timer calls kick(): if a research is running, it starts
// /api/linkbuilder?tick=1 as its own request and does not wait for it — a
// function keeps running after its caller hangs up.
function isTickCall(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && [process.env.OUTREACH_TICK_SECRET, process.env.CRON_SECRET].some(k => k && m[1] === k);
}
async function kick(req) {
  const snap = await db().collection(COLL).where('status', 'in', RUNNING).limit(1).get();
  if (snap.empty) return { running: 0 };
  const key = process.env.OUTREACH_TICK_SECRET || process.env.CRON_SECRET;
  const selfHost = req.headers['x-forwarded-host'] || req.headers.host;
  if (!key || !selfHost) return { running: snap.size, kicked: false };
  try { await fetch(`https://${selfHost}/api/linkbuilder?tick=1`, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(1500) }); } catch (e) {}
  return { running: snap.size, kicked: true };
}

// Starts steps until budgetMs has passed (a step itself may run longer).
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
  if (req.query && req.query.tick && isTickCall(req)) {
    try { return res.json(await tick(5000)); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await requireMember(req, res);
  if (!user) return;
  if (!canUseLinkBuilder(user)) return res.status(403).json({ error: 'AI Link Builder is not enabled for your account' });
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
module.exports.kick = kick;
