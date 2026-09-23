// ══════════════════════════════════════════════════════════════
// Snov.io prospecting + email finding — ported 1:1 from the proven
// Google Apps Script Engine, adapted for Vercel serverless (fetch).
// ══════════════════════════════════════════════════════════════

const { browserHeaders, isSafeHost } = require('./_lib/security');
const { verifyEmailsWithSnov } = require('./_lib/snov');

const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;

// ── Target roles (same grouping as Engine) ──
const CORE_LINK_BUILDING_ROLES = [
  "Link Builder","Linkbuilder","Link Building Specialist","Backlink Specialist","Link Acquisition Specialist",
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

// database-search/prospects/start's job_titles.include only accepts exact
// strings from Snov's own internal vocabulary, and even a title that IS
// accepted often isn't the one a real person is actually indexed under —
// confirmed live: a genuine link builder at proprofs.com whose LinkedIn
// headline is "Off-page Link Building Specialist" is indexed by Snov under
// the generic "search engine optimization specialist", and only turned up
// once job_titles filtering was dropped entirely in favor of fetching the
// whole company roster and scoring each person's title ourselves with the
// same roleTier() used for domain-search results below.
const MAX_DB_SEARCH_PAGES = 4;   // 50/page — bounds worst-case latency within Vercel's function duration limit
const MAX_DB_SEARCH_REVEALS = 5; // reveal calls run in parallel but each is its own poll cycle — keep this small so a slow one can't blow the request's total time budget

// Best-effort company display name from a bare domain, for database-search's
// name-based company filter (it does NOT accept a domain string directly —
// verified live: passing "mailtrap.io" as the name returns zero results,
// while "Mailtrap" finds real people there; a company.domain filter was
// also tried live and Snov rejects it outright with a 422, so a name is
// the only option).
function deriveCompanyName(domain) {
  const base = domain.split('.')[0] || domain;
  return base.split(/[-_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// A domain that glues two real words together with no separator (e.g.
// "narrationbox.com" for the real company "Narration Box") can't be split
// by deriveCompanyName() at all — confirmed live that searching "Narration
// Box" finds real people there while "Narrationbox" finds none. A full
// dictionary-based word segmenter is overkill for this; a short list of
// common startup-name suffixes catches the frequent real-world case
// (box/hub/labs/app/...) as a second candidate to try.
const COMPOUND_SUFFIX_WORDS = ['box','hub','labs','lab','app','kit','flow','base','desk','space','works','cloud','tech','soft','wave','loop','stack','sync','grid','core','link','mail','pay','shop','market','media','docs','note','form','chat','board','pilot','scale'];
function deriveCompanyNameCandidates(domain) {
  const primary = deriveCompanyName(domain);
  const candidates = [primary];
  const base = (domain.split('.')[0] || domain).toLowerCase();
  for (const suffix of COMPOUND_SUFFIX_WORDS) {
    if (base.length > suffix.length + 2 && base.endsWith(suffix)) {
      const prefix = base.slice(0, -suffix.length);
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
      const candidate = cap(prefix) + ' ' + cap(suffix);
      if (candidate !== primary) candidates.push(candidate);
      break;
    }
  }
  return candidates;
}

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

// Snov's domain-search/prospects occasionally returns a business/brand
// LinkedIn page instead of a person (e.g. "Black wasp Firm") — these are
// never useful outreach targets, so drop them before they take a ranking
// slot away from a real person.
const JUNK_NAME_WORDS = [
  'llc','inc','ltd','co\\.','corp','company','firm','agency','solutions',
  'group','studio','consulting','consultants','media','marketing','digital',
  'services','enterprises','ventures','partners','collective'
];
const JUNK_NAME_RE = new RegExp('\\b(' + JUNK_NAME_WORDS.join('|') + ')\\b', 'i');
function isJunkProspectName(firstName, lastName) {
  const full = `${firstName} ${lastName}`.trim();
  return JUNK_NAME_RE.test(full);
}

// Link-building relevance of a job title. Split into a categorical tier
// (what the role actually IS) and a seniority bonus (how senior it is) —
// keeping them separate matters because "Marketing Manager" would otherwise
// pick up the same +2 "manager" bonus as "SEO Manager" and end up scoring
// as if it were relevant. A generic "Marketing Manager" exists at nearly
// every company Snov searches, so without a tier-only filter a domain with
// few genuine link-building/SEO/PR people gets padded out with marketing
// noise to fill the results quota.
const MIN_RELEVANT_TIER = 4; // Content Marketing Manager or better
function roleTier(position){
  const pos = (position||'').toLowerCase();
  // "linkbuild..." with no space (confirmed live: snov.io's own Diana
  // Kozodoi is indexed simply as "Linkbuilder", one word) needs its own
  // check — "link build" alone never matches it.
  if (pos.includes('link build')||pos.includes('linkbuild')||pos.includes('backlink')) return 10;
  if (pos.includes('outreach')) return 9;
  if (pos.includes('off-page')||pos.includes('off page')) return 8;
  // database-search's job_title field spells this out in full — never the
  // "SEO" abbreviation a LinkedIn headline would use (confirmed live:
  // proprofs.com's Rinky Sharma is indexed as "search engine optimization
  // specialist", which scored tier 0 and got filtered out entirely until
  // this check was added).
  if (pos.includes('seo')||pos.includes('search engine optimization')) return 7;
  if (pos.includes('digital pr')||pos.includes(' pr ')||pos.includes('public relations')) return 6;
  if (pos.includes('content')) return 4;
  if (pos.includes('marketing')) return 3;
  return 0;
}
function seniorityBonus(position){
  const pos = (position||'').toLowerCase();
  let s = 0;
  if (pos.includes('head ')||pos.includes('director')||pos.includes('vp ')) s+=3;
  if (pos.includes('senior')||pos.includes('lead')||pos.includes('manager')) s+=2;
  return s;
}
function roleRelevanceScore(position){
  return roleTier(position) + seniorityBonus(position);
}

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
// DATABASE SEARCH SUPPLEMENT
// domain-search/prospects above only matches a person whose LinkedIn title
// is close to one of TARGET_ROLES's exact strings — it misses real people
// with a non-standard/combined title (confirmed live: "Outreach & Link
// Building | Product Partnerships" never matched, even though
// database-search finds this exact same person under "Outreach Specialist").
// database-search searches by COMPANY NAME rather than domain, which risks
// a same-named different company (confirmed live: searching "HubSpot"
// once returned a person at "Avidly HubSpot Solutions") — so every result
// here is strictly filtered to company.domain matching the target domain
// before being trusted at all.
// ══════════════════════════════════════════════════════════════
// database-search returns a redacted last name (e.g. "Iv***" — a short
// real prefix, not a fixed-length mask) until the reveal step, so an exact
// "firstname|lastname" match against domain-search's already-full names
// never fires — confirmed live: Daryna and Iryna were both revealed AND
// returned a second time as duplicates because "iv"/"vy" never equalled
// "ivanova"/"vylko". Match on first name + last-name-starts-with instead.
function isAlreadyFound(candidate, existingRows) {
  const fn = (candidate.first_name || '').toLowerCase();
  const lnPrefix = (candidate.last_name || '').toLowerCase().replace(/\*+$/, '');
  if (!fn || !lnPrefix) return false;
  return existingRows.some(e =>
    (e.first_name || '').toLowerCase() === fn &&
    (e.last_name || '').toLowerCase().startsWith(lnPrefix)
  );
}

// Fetches one page of database-search's company roster (no title filter —
// see the comment on MAX_DB_SEARCH_PAGES above for why). Each page is its
// own start+poll cycle since Snov ties the task_hash to a specific page.
async function fetchDatabaseSearchPage(companyName, page, token) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const startRes = await fetch('https://api.snov.io/v2/database-search/prospects/start', {
      method: 'POST', headers,
      body: JSON.stringify({ filters: { company: { name: { include: [companyName] } } }, page }),
      signal: AbortSignal.timeout(9000)
    });
    if (!isOk(startRes.status)) return { prospects: [], totalPages: 0 };
    const startJson = await startRes.json();
    // Unlike every other Snov v2 endpoint used in this file, database-search
    // puts the poll link straight in `links.result` (task_hash lives under
    // `meta`, not `data`) — verified live: reading data.task_hash here was
    // always undefined, so this call silently returned [] on every request.
    const resultLink = startJson?.links?.result;
    if (!resultLink) return { prospects: [], totalPages: 0 };

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_DELAY_MS);
      try {
        const r = await fetch(resultLink, { headers, signal: AbortSignal.timeout(9000) });
        if (!isOk(r.status)) continue;
        const json = await r.json();
        if (json?.data?.prospects?.length || (json?.status && String(json.status).toLowerCase() !== 'in_progress')) {
          return { prospects: json?.data?.prospects || [], totalPages: json?.data?.total_pages || 1 };
        }
      } catch(e) { /* keep polling */ }
    }
    return { prospects: [], totalPages: 0 };
  } catch(e) { return { prospects: [], totalPages: 0 }; }
}

async function fetchDatabaseSearchSupplement(domain, token, existingRows) {
  try {
    let onDomain = [];
    for (const companyName of deriveCompanyNameCandidates(domain)) {
      const first = await fetchDatabaseSearchPage(companyName, 1, token);
      const totalPages = Math.min(first.totalPages || 1, MAX_DB_SEARCH_PAGES);
      const restPages = await Promise.all(
        Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => fetchDatabaseSearchPage(companyName, i + 2, token))
      );
      const prospects = [first, ...restPages].flatMap(pg => pg.prospects);
      onDomain = prospects.filter(p => (p?.company?.domain || '').toLowerCase() === domain.toLowerCase());
      if (onDomain.length) break; // this spelling of the company name is the one Snov actually indexes
    }

    // Same relevance bar as domain-search — a full company roster is mostly
    // engineers/sales/support, so only bother revealing (a paid-feeling call)
    // whoever actually looks like a link-building/SEO/PR/marketing contact.
    const relevant = onDomain.filter(p => roleTier(p.job_title) >= MIN_RELEVANT_TIER);
    relevant.sort((a, b) => roleTier(b.job_title) - roleTier(a.job_title));
    const fresh = relevant.filter(p => !isAlreadyFound(p, existingRows));
    const toReveal = fresh.filter(p => p.email_and_hidden_info_reveal).slice(0, MAX_DB_SEARCH_REVEALS);

    const revealed = await Promise.all(toReveal.map(async (p) => {
      try {
        const startRes = await fetch(p.email_and_hidden_info_reveal, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(9000) });
        if (!isOk(startRes.status)) return null;
        const startJson = await startRes.json();
        const link = startJson?.links?.result;
        if (!link) return null;
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
          await sleep(POLL_DELAY_MS);
          try {
            const r = await fetch(link, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(9000) });
            if (!isOk(r.status)) continue;
            const json = await r.json();
            if (json?.data || (json?.status && String(json.status).toLowerCase() !== 'in_progress')) {
              const d = json.data;
              if (!d) return null;
              const emailObj = (d.emails || [])[0];
              return {
                first_name: d.first_name || p.first_name || '',
                last_name: d.last_name || '',
                position: p.job_title || '',
                source_page: d.linkedin_url || '',
                email: emailObj?.email || '',
                smtp_status: emailObj?.smtp_status || 'unknown',
                source: 'DATABASE_SEARCH'
              };
            }
          } catch(e) { /* keep polling */ }
        }
        return null;
      } catch(e) { return null; }
    }));

    return revealed.filter(Boolean);
  } catch(e) { return []; }
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
    if (isJunkProspectName(p.first_name, p.last_name)) return;
    const key = `${p.first_name.trim().toLowerCase()}|${p.last_name.trim().toLowerCase()}`;
    const existing = byName.get(key);
    if (!existing || job.batchIndex < existing.__batchIndex) {
      byName.set(key, Object.assign({}, p, { __batchIndex: job.batchIndex }));
    }
  }));

  // Rank by actual role relevance, not which batch happened to find them —
  // a rare title like "Link Builder" naturally returns far fewer LinkedIn
  // matches than "Marketing Manager", so ranking wasn't enough on its own:
  // the old code always padded out to maxPeople, which meant a domain with
  // only 2-3 genuine link-building/SEO/PR people still returned 20 results,
  // 17 of them generic marketing noise. Now: keep only genuinely relevant
  // roles when there are enough of them, and only fall back to including
  // everyone when relevant matches are too scarce to return a useful list.
  const scored = Array.from(byName.values()).map(p => Object.assign({}, p, { _tier: roleTier(p.position), _relevance: roleRelevanceScore(p.position) }));
  scored.sort((a,b) => b._relevance - a._relevance || a.__batchIndex - b.__batchIndex);
  const relevant = scored.filter(p => p._tier >= MIN_RELEVANT_TIER);
  // Set low deliberately: "fewer but more relevant" was the explicit choice
  // here, so even 1-2 genuine link-building/SEO/PR contacts should show on
  // their own — the padded fallback only exists so a domain search never
  // comes back completely empty when Snov found literally no one relevant.
  const MIN_RESULTS = 1;
  const ranked = (relevant.length >= MIN_RESULTS ? relevant : scored).slice(0, maxPeople);

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
        // Snov preserves row order in its response (its own "people" field is
        // just a display string, not something to re-match on), so map back
        // to the request positionally.
        const match = results[idx];
        const candidates = match?.result || [];
        // A name can resolve to emails at more than one company (a past
        // employer, a namesake) — prefer whichever candidate is actually
        // @domain over just taking Snov's first guess.
        const emailObj = candidates.find(c => c?.email?.toLowerCase().endsWith('@' + domain.toLowerCase())) || candidates[0];
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

// ══════════════════════════════════════════════════════════════
// LINKEDIN PROFILE ENRICHMENT
// For contacts found by browsing LinkedIn manually (the domain-search
// prospecting above only matches Snov's own list of standard job titles,
// so it misses anyone with a non-standard/combined title) — given a
// specific profile URL, Snov resolves the person's name and current
// employer, which we then feed into the same name+domain email lookup
// used above.
// ══════════════════════════════════════════════════════════════
const MAX_LINKEDIN_URLS = 20;

async function enrichLinkedInProfiles(urls, token) {
  const headers = { Authorization: 'Bearer ' + token };
  try {
    const startRes = await fetch('https://api.snov.io/v2/li-profiles-by-urls/start', {
      method:'POST', headers:{ ...headers, 'Content-Type':'application/json' },
      body: JSON.stringify({ urls }), signal: AbortSignal.timeout(9000)
    });
    if (!isOk(startRes.status)) return [];
    const startJson = await startRes.json();
    const taskHash = startJson?.data?.task_hash;
    if (!taskHash) return [];

    let results = [];
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_DELAY_MS);
      try {
        const r = await fetch(
          `https://api.snov.io/v2/li-profiles-by-urls/result?task_hash=${taskHash}`,
          { headers, signal: AbortSignal.timeout(9000) }
        );
        if (!isOk(r.status)) continue;
        const json = await r.json();
        if (json?.data && json.data.length) { results = json.data; break; }
        if (json?.status && String(json.status).toLowerCase() !== 'in_progress') { results = json.data || []; break; }
      } catch(e) { /* keep polling */ }
    }

    return results.map(entry => {
      const p = entry?.result;
      const url = entry?.url || '';
      if (!p) return { url, firstName:'', lastName:'', title:'', company:'', domain:'', found:false };
      const current = (p.positions || [])[0];
      const companyUrl = current?.url || '';
      const domain = companyUrl.replace(/^https?:\/\//i,'').replace(/^www\./i,'').replace(/\/.*$/,'').trim();
      return {
        url, firstName: p.first_name||'', lastName: p.last_name||'',
        title: current?.title||'', company: current?.name||'', domain, found:true
      };
    });
  } catch(e) { return []; }
}

// Same emails-by-domain-by-name lookup used in fetchProspects above, but
// generalized to a per-row domain (each row here) since enriched LinkedIn
// profiles can each work at a different company, unlike a single-domain
// prospect search.
async function resolveEmailsByNameAndDomain(people, token) {
  const headers = { Authorization: 'Bearer ' + token };
  const results = new Array(people.length).fill(null);
  const chunks = [];
  for (let i = 0; i < people.length; i += EMAIL_BATCH_SIZE) chunks.push({ start:i, items: people.slice(i, i+EMAIL_BATCH_SIZE) });

  await Promise.all(chunks.map(async ({ start, items }) => {
    try {
      const payload = { rows: items.map(p => ({ first_name:p.firstName, last_name:p.lastName, domain:p.domain })) };
      const startRes = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
        method:'POST', headers:{ ...headers, 'Content-Type':'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(9000)
      });
      if (!isOk(startRes.status)) return;
      const startJson = await startRes.json();
      const taskHash = startJson?.data?.task_hash;
      if (!taskHash) return;

      let matches = [];
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
          const r = await fetch(
            `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${taskHash}`,
            { headers, signal: AbortSignal.timeout(9000) }
          );
          if (!isOk(r.status)) continue;
          const rd = await r.json();
          if (rd?.data && rd.data.length) { matches = rd.data; break; }
          if (rd?.status && String(rd.status).toLowerCase() !== 'in_progress') { matches = rd.data || []; break; }
        } catch(e) { /* keep polling */ }
      }

      items.forEach((p, idx) => {
        const match = matches[idx];
        const candidates = match?.result || [];
        const emailObj = candidates.find(c => c?.email?.toLowerCase().endsWith('@' + p.domain.toLowerCase())) || candidates[0];
        if (emailObj?.email) results[start+idx] = { email: emailObj.email, smtp: emailObj.smtp_status || 'unknown' };
      });
    } catch(e) { /* leave as null for this chunk */ }
  }));

  return results;
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

  // Verify all found emails (batched)
  const list = [...foundEmails];
  if (!list.length) {
    return [{ first_name:'N/A', last_name:'', position:'', source_page:'', email:'', smtp_status:'unknown', source:'NOT_FOUND' }];
  }
  const statuses = await verifyEmailsWithSnov(list, token);
  return list.map(email => ({
    first_name:'Deep Scraped', last_name:'Contact', position:'', source_page:'', email,
    smtp_status: statuses.get(email) || 'unknown', source:'DEEP_SCRAPE'
  }));
}

async function scrapePage(url) {
  try {
    const r = await fetch(url, {
      headers: browserHeaders(),
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
    const r = await fetch(url, { headers: browserHeaders(), signal:AbortSignal.timeout(6000), redirect:'follow' });
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

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const { domain, action, urls } = req.body || {};
  if (action !== 'enrich-linkedin' && !domain) return res.status(400).json({error:'domain required'});
  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET) return res.status(500).json({error:'Snov credentials not configured'});

  const cleanDomain = domain ? domain.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*/,'').trim() : '';

  try {
    const token = await getToken();

    if (!action || action === 'prospects') {
      const rows = await fetchProspects(cleanDomain, token, 20);

      // Supplement with database-search — catches real people domain-search's
      // title-matching misses (non-standard/combined titles). Every result
      // is domain-verified before being trusted, and anyone domain-search
      // already found is excluded so the same person can't appear twice.
      const supplement = await fetchDatabaseSearchSupplement(cleanDomain, token, rows);
      const allRows = [...rows, ...supplement];

      // Snov's name+domain database lookup only surfaces an email it already
      // has indexed — a real person with no indexed email otherwise shows up
      // with nothing actionable. Guess the two most common professional
      // patterns and let Snov's separate SMTP-probe verification (checks
      // mailbox existence directly, not a database lookup) confirm whether
      // either is real, same fallback used for LinkedIn-URL enrichment.
      const noEmailRows = allRows.filter(p => !p.email && p.first_name && p.last_name);
      if (noEmailRows.length) {
        const guessesByRow = new Map();
        const allGuesses = [];
        noEmailRows.forEach(p => {
          const f = p.first_name.toLowerCase().replace(/[^a-z]/g,'');
          const l = p.last_name.toLowerCase().replace(/[^a-z]/g,'');
          if (!f || !l) return;
          const guesses = [`${f}.${l}@${cleanDomain}`, `${f[0]}${l}@${cleanDomain}`];
          guessesByRow.set(p, guesses);
          allGuesses.push(...guesses);
        });
        if (allGuesses.length) {
          const verified = await verifyEmailsWithSnov(allGuesses, token);
          noEmailRows.forEach(p => {
            const guesses = guessesByRow.get(p) || [];
            const validGuess = guesses.find(g => verified.get(g) === 'valid');
            if (validGuess) { p.email = validGuess; p.smtp_status = 'valid'; p.source = 'GUESSED'; }
          });
        }
      }

      const prospects = allRows
        .map(p => ({ ...p, smtp: p.smtp_status, _score: roleRelevanceScore(p.position) }))
        .sort((a,b) => b._score - a._score);

      return res.json({
        domain: cleanDomain,
        prospects,
        total: prospects.length,
        withEmail: prospects.filter(p=>p.email && p.smtp_status!=='invalid').length,
        verified:  prospects.filter(p=>p.smtp_status==='valid').length
      });
    }

    if (action === 'enrich-linkedin') {
      const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, MAX_LINKEDIN_URLS);
      if (!list.length) return res.status(400).json({ error: 'urls required' });

      const profiles = await enrichLinkedInProfiles(list, token);

      const resolvable = profiles.filter(p => p.found && p.firstName && p.lastName && p.domain);
      const resolved = await resolveEmailsByNameAndDomain(resolvable, token);
      const emailByUrl = new Map();
      resolvable.forEach((p, i) => { if (resolved[i]) emailByUrl.set(p.url, resolved[i]); });

      // Snov's name+domain database lookup above only surfaces an email it
      // already has indexed — it can miss someone real. As a fallback, guess
      // the two most common professional patterns and let Snov's separate
      // SMTP-probe verification (checks mailbox existence directly, not a
      // database lookup) confirm whether either one is actually real.
      const stillUnresolved = resolvable.filter(p => !emailByUrl.has(p.url));
      if (stillUnresolved.length) {
        const guessesByUrl = new Map();
        const allGuesses = [];
        stillUnresolved.forEach(p => {
          const f = p.firstName.toLowerCase().replace(/[^a-z]/g,'');
          const l = p.lastName.toLowerCase().replace(/[^a-z]/g,'');
          if (!f || !l) return;
          const guesses = [`${f}.${l}@${p.domain}`, `${f[0]}${l}@${p.domain}`];
          guessesByUrl.set(p.url, guesses);
          allGuesses.push(...guesses);
        });
        if (allGuesses.length) {
          const verified = await verifyEmailsWithSnov(allGuesses, token);
          stillUnresolved.forEach(p => {
            const guesses = guessesByUrl.get(p.url) || [];
            const validGuess = guesses.find(g => verified.get(g) === 'valid');
            if (validGuess) emailByUrl.set(p.url, { email: validGuess, smtp: 'valid' });
          });
        }
      }

      const contacts = profiles.map(p => {
        const e = emailByUrl.get(p.url);
        return {
          url: p.url, firstName: p.firstName, lastName: p.lastName,
          name: [p.firstName, p.lastName].filter(Boolean).join(' '),
          title: p.title, company: p.company, domain: p.domain,
          email: e?.email || '', smtp: e?.smtp || 'unknown', found: p.found
        };
      });

      return res.json({ contacts });
    }

    if (action === 'scrape') {
      if (!isSafeHost(cleanDomain)) return res.status(400).json({error:'Invalid or disallowed domain'});
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
