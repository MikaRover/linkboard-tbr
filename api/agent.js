const SNOV_CLIENT_ID     = '6b423e67c549ace7c01ed4914935d0c2';
const SNOV_CLIENT_SECRET = '8a864926f4ad1d63c1b8fee73b17f741';
const CLAUDE_KEY         = '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';
const AHREFS_KEY         = '7dNernlzY4mixkKwyIEOVsZK8e0Rx0Hgq3YszXti';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Snov token ──
async function getSnovToken() {
  try {
    const r = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SNOV_CLIENT_ID, client_secret: SNOV_CLIENT_SECRET }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    return j.access_token || null;
  } catch { return null; }
}

// ── Scrape website for emails ──
async function scrapeEmails(domain) {
  const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const SKIP = ['example', 'domain', '.png', '.jpg', 'sentry', 'noreply', 'no-reply', 'wpcf7', 'schema'];
  const PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/team', '/write-for-us', '/advertise'];
  const found = new Set();
  for (const path of PATHS) {
    if (found.size >= 5) break;
    try {
      const r = await fetch(`https://${clean}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkBot/1.0)' },
        signal: AbortSignal.timeout(5000), redirect: 'follow'
      });
      if (!r.ok) continue;
      const html = await r.text();
      (html.match(EMAIL_RE) || [])
        .filter(e => !SKIP.some(s => e.toLowerCase().includes(s)))
        .forEach(e => found.add(e.toLowerCase()));
    } catch {}
  }
  return [...found].slice(0, 5);
}

// ── Snov domain email search ──
async function snovDomainEmails(domain, token) {
  if (!token) return [];
  const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  try {
    const r = await fetch(
      `https://api.snov.io/v2/domain-search?domain=${encodeURIComponent(clean)}&type=all&limit=10&lastId=0`,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(7000) }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.emails || []).map(e => e?.email).filter(Boolean).map(e => e.toLowerCase()).slice(0, 5);
  } catch { return []; }
}

// ── Snov email verification ──
async function verifySnovEmail(email, token) {
  if (!token) return 'unknown';
  try {
    const r = await fetch('https://api.snov.io/v1/get-emails-verification', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'emails[]': email }),
      signal: AbortSignal.timeout(6000)
    });
    const j = await r.json();
    return j?.[0]?.smtp_status || j?.[0]?.status || 'unknown';
  } catch { return 'unknown'; }
}

// ── Find emails for one domain (scrape + Snov) ──
async function findEmailsForDomain(domain, token) {
  const [scraped, snov] = await Promise.all([
    scrapeEmails(domain),
    snovDomainEmails(domain, token)
  ]);
  // Merge + deduplicate, Snov first (higher quality)
  const merged = [...new Set([...snov, ...scraped])].slice(0, 5);
  if (!merged.length) return [];

  // Verify top 3
  const results = [];
  for (const email of merged.slice(0, 3)) {
    const smtp = await verifySnovEmail(email, token);
    results.push({ email, smtp });
    await sleep(300);
  }
  // Add rest unverified
  merged.slice(3).forEach(email => results.push({ email, smtp: 'unknown' }));
  return results;
}

// ── Ahrefs enrichment ──
async function enrichDomain(domain) {
  const today = new Date().toISOString().slice(0, 10);
  const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  const h = { 'Authorization': `Bearer ${AHREFS_KEY}`, 'Accept': 'application/json' };
  try {
    const [drR, mR] = await Promise.all([
      fetch(`https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(clean)}&date=${today}`, { headers: h, signal: AbortSignal.timeout(8000) }),
      fetch(`https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(clean)}&date=${today}&mode=subdomains&select=org_traffic`, { headers: h, signal: AbortSignal.timeout(8000) })
    ]);
    let dr = null, traffic = null;
    if (drR.ok) { const d = await drR.json(); dr = d?.domain_rating?.domain_rating != null ? Math.round(d.domain_rating.domain_rating) : null; }
    if (mR.ok) { const m = await mR.json(); const raw = (m?.metrics || m)?.org_traffic ?? null; traffic = raw > 0 ? Math.round(raw) : null; }
    return { dr, traffic };
  } catch { return { dr: null, traffic: null }; }
}

// ── Claude call ──
async function callClaude(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(body)
    });
    if (r.status === 429 && attempt < 2) { await sleep(6000); continue; }
    return r;
  }
}

// ══════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword, count = 20, project = '', findEmails = false } = req.body || {};
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  // ── STEP 1: Claude finds prospects ──
  let prospects = [];
  try {
    const response = await callClaude({
      model: 'claude-sonnet-4-5',
      max_tokens: 5000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `You are an expert link building specialist. Find high-quality backlink opportunities for the topic: "${keyword}"${project ? ` (product/service: "${project}")` : ''}.

Search using multiple smart queries:
1. Articles that explain or discuss "${keyword}" as a concept (guides, tutorials, explainers)
2. Comparison/best-of lists that include "${keyword}" or related tools
3. Industry blog posts that naturally mention "${keyword}"
4. Resource roundups and "tools for X" posts
5. Case studies or "how we use X" posts

STRICT RULES:
- ONLY include pages that already discuss "${keyword}" as a topic in their content
- Do NOT include direct competitors (companies selling the same service as "${project || keyword}")
- Skip huge media sites: Forbes, TechCrunch, HubSpot, G2, Capterra, Gartner, Entrepreneur
- Skip company homepages — blog posts and articles only
- Target mid-tier independent sites (DR 20-70): niche blogs, SaaS blogs, newsletters, industry publications
- Assign relevancyScore 0-100: how naturally a link would fit, topical relevance, site reachability

Return ONLY a raw JSON array (no markdown):
[
  {
    "domain": "example.com",
    "title": "Exact article title",
    "url": "https://example.com/full-article-url",
    "reason": "Why this is a great opportunity and exactly how a link fits naturally in the content",
    "relevancyScore": 85
  }
]

Return ${count} unique high-quality prospect domains.`
      }]
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error ' + response.status, detail: err.slice(0, 300) });
    }
    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try {
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s >= 0 && e > s) prospects = JSON.parse(text.slice(s, e + 1));
    } catch { return res.status(500).json({ error: 'Parse error', raw: text.slice(0, 500) }); }
  } catch (err) { return res.status(500).json({ error: err.message }); }

  if (!prospects.length) return res.json({ prospects: [] });

  // Deduplicate by domain
  const seen = new Set();
  prospects = prospects.filter(p => {
    const d = (p.domain || '').toLowerCase().replace(/^www\./, '');
    if (seen.has(d)) return false;
    seen.add(d); return true;
  });

  // ── STEP 2: Ahrefs DR + Traffic (batches of 5) ──
  for (let i = 0; i < prospects.length; i += 5) {
    const batch = prospects.slice(i, i + 5);
    const results = await Promise.all(batch.map(p => enrichDomain(p.domain)));
    results.forEach((r, j) => { prospects[i + j].dr = r.dr; prospects[i + j].traffic = r.traffic; });
  }

  // ── STEP 3: Email finding (optional) ──
  if (findEmails) {
    const token = await getSnovToken();
    // Process in batches of 3 (scraping is slow)
    for (let i = 0; i < prospects.length; i += 3) {
      const batch = prospects.slice(i, i + 3);
      const results = await Promise.all(batch.map(p => findEmailsForDomain(p.domain, token)));
      results.forEach((emails, j) => { prospects[i + j].emails = emails; });
      if (i + 3 < prospects.length) await sleep(500);
    }
  }

  // Sort by relevancyScore
  prospects.sort((a, b) => (b.relevancyScore || 0) - (a.relevancyScore || 0));

  return res.json({ prospects });
};
