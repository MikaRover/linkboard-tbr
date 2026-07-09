// ══════════════════════════════════════════════════════════════
// Snov.io prospecting + email finding — ported 1:1 from the proven
// Google Apps Script Engine, adapted for Vercel serverless (fetch).
// ══════════════════════════════════════════════════════════════

const SNOV_CLIENT_ID = '6b423e67c549ace7c01ed4914935d0c2';
const SNOV_CLIENT_SECRET = '8a864926f4ad1d63c1b8fee73b17f741';

// ── Target roles (same grouping as Engine) ──
const CORE_LINK_BUILDING_ROLES = [
  "Link Builder","Link Building Specialist","Backlink Specialist","Link Acquisition Specialist",
  "SEO Outreach Specialist","Outreach Specialist","Digital Outreach Specialist",
  "Community Outreach Specialist","Content Outreach Manager"
];
const SEO_ROLES = [
  "SEO Specialist","Senior SEO Specialist","Off-Page SEO Specialist","Off-Page SEO Manager",
  "SEO Manager","SEO Consultant","SEO Team Lead","Head of SEO"
];
const PR_COMMUNITY_ROLES = ["PR Specialist","Digital PR Manager","Community Manager"];
const MARKETING_ROLES = [
  "Content Marketing Manager","Growth Marketer","Growth Marketing Manager",
  "Digital Marketing Manager","Marketing Manager"
];
const TARGET_ROLES = [
  ...CORE_LINK_BUILDING_ROLES, ...SEO_ROLES, ...PR_COMMUNITY_ROLES, ...MARKETING_ROLES
];

const ROLE_BATCH_SIZE  = 10;   // Snov positions[] per start request
const EMAIL_BATCH_SIZE = 10;   // Snov emails-by-domain-by-name max rows per request
const POLL_ATTEMPTS    = 6;
const POLL_DELAY_MS    = 3000;

const JUNK_EMAIL_PATTERNS = [
  '.png','.jpg','.jpeg','.gif','.svg','.webp','.css','.js',
  'sentry','wixpress','example.com','domain.com','yourname',
  'noreply','no-reply','donotreply'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOk = code => code >= 200 && code < 300;

// ── Auth ──
async function getToken() {
  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:'client_credentials',
      client_id: SNOV_CLIENT_ID,
      client_secret: SNOV_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!isOk(res.status)) throw new Error('Snov auth failed HTTP ' + res.status);
  const j = await res.json();
  if (!j.access_token) throw new Error('No access_token returned');
  return j.access_token;
}

// ══════════════════════════════════════════════════════════════
// LINKEDIN PROSPECTING
// Returns rows: {first_name,last_name,position,source_page,email,smtp_status,source}
// ══════════════════════════════════════════════════════════════
async function fetchProspects(domain, token, maxPeople = 20) {
  const headers = { Authorization: 'Bearer ' + token };

  // Split roles into batches
  const roleBatches = [];
  for (let i = 0; i < TARGET_ROLES.length; i += ROLE_BATCH_SIZE) {
    roleBatches.push(TARGET_ROLES.slice(i, i + ROLE_BATCH_SIZE));
  }

  // Fire all "start" requests in parallel
  const startResponses = await Promise.all(roleBatches.map(async (batch) => {
    const payload = new URLSearchParams({ domain });
    batch.forEach((role, idx) => payload.append(`positions[${idx}]`, role));
    try {
      const r = await fetch('https://api.snov.io/v2/domain-search/prospects/start', {
        method:'POST',
        headers:{ ...headers, 'Content-Type':'application/x-www-form-urlencoded' },
        body: payload.toString(),
        signal: AbortSignal.timeout(9000)
      });
      if (!isOk(r.status)) return null;
      return await r.json();
    } catch(e) { return null; }
  }));

  // Collect polling jobs (each batch → a result link)
  const jobs = [];
  startResponses.forEach((json, batchIndex) => {
    if (json?.links?.result) jobs.push({ link: json.links.result, batchIndex, data: null });
  });
  if (!jobs.length) return [];

  // Poll until all jobs resolve (or attempts exhausted) — parallel per round
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const pending = jobs.filter(j => j.data === null);
    if (!pending.length) break;
    await sleep(POLL_DELAY_MS);
    const polls = await Promise.all(pending.map(async (j) => {
      try {
        const r = await fetch(j.link, { headers, signal: AbortSignal.timeout(9000) });
        if (!isOk(r.status)) return { j, done:false };
        const json = await r.json();
        if (json?.data && json.data.length) return { j, done:true, data:json.data };
        if (json?.status && String(json.status).toLowerCase() !== 'in_progress') return { j, done:true, data:[] };
        return { j, done:false };
      } catch(e) { return { j, done:false }; }
    }));
    polls.forEach(({ j, done, data }) => { if (done) j.data = data || []; });
  }

  // Dedupe by name, keep the one from the most-relevant (lowest) batch index
  const byName = new Map();
  jobs.forEach(job => (job.data || []).forEach(p => {
    if (!p?.first_name || !p?.last_name) return;
    const key = `${p.first_name.trim().toLowerCase()}|${p.last_name.trim().toLowerCase()}`;
    const existing = byName.get(key);
    if (!existing || job.batchIndex < existing.__batchIndex) {
      byName.set(key, Object.assign({}, p, { __batchIndex: job.batchIndex }));
    }
  }));

  const ranked = Array.from(byName.values())
    .sort((a,b) => a.__batchIndex - b.__batchIndex)
    .slice(0, maxPeople);

  if (!ranked.length) return [];

  // Resolve emails in chunks of 10 (parallel chunks)
  const output = [];
  const chunks = [];
  for (let i = 0; i < ranked.length; i += EMAIL_BATCH_SIZE) chunks.push(ranked.slice(i, i + EMAIL_BATCH_SIZE));

  await Promise.all(chunks.map(async (chunk) => {
    const payload = { rows: chunk.map(p => ({ first_name:p.first_name, last_name:p.last_name, domain })) };
    try {
      const startRes = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
        method:'POST',
        headers:{ ...headers, 'Content-Type':'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(9000)
      });
      if (!isOk(startRes.status)) { chunk.forEach(p=>output.push(rowFrom(p,'','unknown','ERROR'))); return; }
      const startJson = await startRes.json();
      if (!startJson?.data?.task_hash) { chunk.forEach(p=>output.push(rowFrom(p,'','unknown','NO_TASK'))); return; }

      // Poll for email result
      let results = [];
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
          const rRes = await fetch(
            `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${startJson.data.task_hash}`,
            { headers, signal: AbortSignal.timeout(9000) }
          );
          if (!isOk(rRes.status)) continue;
          const rd = await rRes.json();
          if (rd?.data && rd.data.length) { results = rd.data; break; }
          if (rd?.status && String(rd.status).toLowerCase() !== 'in_progress') { results = rd.data || []; break; }
        } catch(e) { /* keep polling */ }
      }

      chunk.forEach((p, idx) => {
        let match = results[idx];
        if (match?.first_name && match?.last_name &&
            (match.first_name.toLowerCase() !== p.first_name.toLowerCase() ||
             match.last_name.toLowerCase()  !== p.last_name.toLowerCase())) {
          match = results.find(r =>
            r?.first_name?.toLowerCase() === p.first_name.toLowerCase() &&
            r?.last_name?.toLowerCase()  === p.last_name.toLowerCase()
          ) || match;
        }
        const emailObj = match?.result?.[0];
        const email = emailObj?.email || '';
        const smtp  = emailObj?.smtp_status || 'unknown';
        output.push(rowFrom(p, email, smtp, email ? 'SNOV_DB' : 'NO_EMAIL'));
      });
    } catch(e) {
      chunk.forEach(p=>output.push(rowFrom(p,'','unknown','ERROR')));
    }
  }));

  return output;
}

function rowFrom(p, email, smtp, source) {
  return {
    first_name: p.first_name || '',
    last_name:  p.last_name || '',
    position:   p.position || '',
    source_page:p.source_page || '',
    email, smtp_status: smtp, source
  };
}

// ══════════════════════════════════════════════════════════════
// DEEP WEBSITE SEARCH
// ══════════════════════════════════════════════════════════════
async function deepFetchEmails(domain, token) {
  const foundEmails = new Set();
  const baseUrl = domain.startsWith('http') ? domain : ('https://' + domain);
  const headers = { Authorization: 'Bearer ' + token };

  // 1. Snov domain-search DB (paged)
  try {
    let lastId = 0, page = 0;
    const MAX_PAGES = 5;
    while (page < MAX_PAGES) {
      const r = await fetch(
        `https://api.snov.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=all&limit=10&lastId=${lastId}`,
        { headers, signal: AbortSignal.timeout(8000) }
      );
      if (!isOk(r.status)) break;
      const json = await r.json();
      const emails = json?.emails || [];
      if (!emails.length) break;
      emails.forEach(e => e?.email && foundEmails.add(String(e.email).toLowerCase()));
      lastId = json?.lastId || (lastId + emails.length);
      page++;
      if (emails.length < 10) break;
    }
  } catch(e) { /* fall through */ }

  // 2. If few from DB, scrape homepage
  if (foundEmails.size < 2) {
    (await scrapePage(baseUrl)).forEach(e => foundEmails.add(e.toLowerCase()));
  }

  // 3. If still nothing, find + scrape internal contact/about pages
  if (foundEmails.size === 0) {
    const subPages = await findInternalPages(baseUrl);
    for (const pageUrl of subPages) {
      if (foundEmails.size >= 3) break;
      (await scrapePage(pageUrl)).forEach(e => foundEmails.add(e.toLowerCase()));
    }
  }

  // Verify all found emails (parallel)
  const list = [...foundEmails];
  if (!list.length) {
    return [{ first_name:'N/A', last_name:'', position:'', source_page:'', email:'', smtp_status:'unknown', source:'NOT_FOUND' }];
  }
  const verified = await Promise.all(list.map(async (email) => {
    const status = await verifyEmail(email, token);
    return { first_name:'Deep Scraped', last_name:'Contact', position:'', source_page:'', email, smtp_status:status, source:'DEEP_SCRAPE' };
  }));
  return verified;
}

async function scrapePage(url) {
  try {
    const r = await fetch(url, {
      headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(6000), redirect:'follow'
    });
    if (!isOk(r.status)) return [];
    const html = await r.text();
    const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    return [...new Set(matches)]
      .map(e => e.trim())
      .filter(e => e.length > 5 && e.length < 100)
      .filter(e => !/^\d+$/.test(e.split('@')[0]))
      .filter(e => !JUNK_EMAIL_PATTERNS.some(s => e.toLowerCase().includes(s)));
  } catch(e) { return []; }
}

async function findInternalPages(url) {
  try {
    const r = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(6000), redirect:'follow' });
    if (!isOk(r.status)) return [];
    const html = await r.text();
    const linkRegex = /href\s*=\s*["']([^"']+)["']/gi;
    const pages = new Set();
    let m;
    while ((m = linkRegex.exec(html)) !== null) {
      let link = String(m[1]||'').trim();
      const l = link.toLowerCase();
      if (!(l.includes('contact')||l.includes('about')||l.includes('write-for-us')||l.includes('advertise'))) continue;
      if (link.startsWith('//')) link = 'https:' + link;
      else if (link.startsWith('/')) link = url.replace(/\/$/,'') + link;
      else if (link.startsWith('../')) continue;
      if (link.startsWith('http')) pages.add(link);
    }
    return [...pages].slice(0, 3);
  } catch(e) { return []; }
}

async function verifyEmail(email, token) {
  try {
    const r = await fetch('https://api.snov.io/v1/get-emails-verification', {
      method:'POST',
      headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'emails[]': email }),
      signal: AbortSignal.timeout(7000)
    });
    if (!isOk(r.status)) return 'unknown';
    const json = await r.json();
    return json?.[0]?.smtp_status || json?.[0]?.status || 'unknown';
  } catch(e) { return 'unknown'; }
}

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const { domain, action } = req.body || {};
  if (!domain) return res.status(400).json({error:'domain required'});

  const cleanDomain = domain.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*/,'').trim();

  try {
    const token = await getToken();

    if (!action || action === 'prospects') {
      const rows = await fetchProspects(cleanDomain, token, 20);
      // Score for sorting (link-building relevance)
      const score = p => {
        const pos = (p.position||'').toLowerCase();
        let s = 0;
        if (pos.includes('link build')||pos.includes('backlink')) s+=10;
        else if (pos.includes('outreach')) s+=9;
        else if (pos.includes('off-page')||pos.includes('off page')) s+=8;
        else if (pos.includes('seo')) s+=7;
        else if (pos.includes('digital pr')||pos.includes(' pr ')) s+=6;
        else if (pos.includes('content')) s+=4;
        else if (pos.includes('marketing')) s+=3;
        if (pos.includes('head ')||pos.includes('director')||pos.includes('vp ')) s+=3;
        if (pos.includes('senior')||pos.includes('lead')||pos.includes('manager')) s+=2;
        return s;
      };
      const prospects = rows
        .map(p => ({ ...p, smtp: p.smtp_status, _score: score(p) }))
        .sort((a,b) => b._score - a._score);

      return res.json({
        domain: cleanDomain,
        prospects,
        total: prospects.length,
        withEmail: prospects.filter(p=>p.email && p.smtp_status!=='invalid').length,
        verified:  prospects.filter(p=>p.smtp_status==='valid').length
      });
    }

    if (action === 'scrape') {
      const rows = await deepFetchEmails(cleanDomain, token);
      // Shape for renderScrapedEmails: {email, smtp}
      const emails = rows
        .filter(r => r.email)
        .map(r => ({ email: r.email, smtp: r.smtp_status }));
      return res.json({ domain: cleanDomain, emails });
    }

    return res.status(400).json({error:'Unknown action'});

  } catch(e) {
    return res.status(500).json({error: e.message});
  }
};
