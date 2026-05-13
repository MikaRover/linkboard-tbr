const SNOV_CLIENT_ID     = '6b423e67c549ace7c01ed4914935d0c2';
const SNOV_CLIENT_SECRET = '8a864926f4ad1d63c1b8fee73b17f741';
const OPENAI_KEY         = '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';
const AHREFS_KEY         = '7dNernlzY4mixkKwyIEOVsZK8e0Rx0Hgq3YszXti';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── GPT Chat Completions — fast, no web search ──
async function askGPT(prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_KEY
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4000,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: 'You are an expert link building specialist with deep knowledge of the internet, blogs, and online publications. You know thousands of niche blogs, SaaS publications, and industry websites across all topics.'
        },
        { role: 'user', content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error('OpenAI ' + r.status + ': ' + err.slice(0, 200));
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
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

// ── Scrape emails from website ──
async function scrapeEmails(domain) {
  const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const SKIP = ['example', 'domain', '.png', '.jpg', 'sentry', 'noreply', 'no-reply', 'wpcf7', 'schema'];
  const PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/write-for-us'];
  const found = new Set();
  for (const path of PATHS) {
    if (found.size >= 3) break;
    try {
      const r = await fetch(`https://${clean}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(4000), redirect: 'follow'
      });
      if (!r.ok) continue;
      const html = await r.text();
      (html.match(EMAIL_RE) || [])
        .filter(e => !SKIP.some(s => e.toLowerCase().includes(s)))
        .forEach(e => found.add(e.toLowerCase()));
    } catch {}
  }
  return [...found].slice(0, 3);
}

// ── Snov domain emails ──
async function snovDomainEmails(domain, token) {
  if (!token) return [];
  const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  try {
    const r = await fetch(
      `https://api.snov.io/v2/domain-search?domain=${encodeURIComponent(clean)}&type=all&limit=5&lastId=0`,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j?.emails || []).map(e => e?.email).filter(Boolean).map(e => e.toLowerCase()).slice(0, 3);
  } catch { return []; }
}

// ── Find emails for domain ──
async function findEmailsForDomain(domain, token) {
  const [scraped, snov] = await Promise.all([scrapeEmails(domain), snovDomainEmails(domain, token)]);
  const merged = [...new Set([...snov, ...scraped])].slice(0, 4);
  return merged.map(email => ({ email, smtp: 'unknown' }));
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

  // ── STEP 1: GPT generates prospect list ──
  let prospects = [];
  try {
    const prompt = `Find ${count} real websites/blogs that have published articles discussing "${keyword}" — these are backlink outreach targets${project ? ' for ' + project : ''}.

REQUIREMENTS:
- Real existing websites that actually write about "${keyword}" or closely related topics
- Niche blogs, SaaS blogs, industry newsletters, tech publications, independent writers
- NOT competitors (companies that sell the same product/service as "${project || keyword}")
- NOT huge generic sites: Forbes, HubSpot, TechCrunch, G2, Capterra, Gartner, Entrepreneur
- NOT company homepages — only content-publishing sites
- Prefer DR 20-70 independent sites that are reachable for outreach
- Be specific and realistic — only suggest sites you know actually exist and publish this type of content

Return ONLY a JSON array, no markdown, no explanation:
[
  {
    "domain": "example.com",
    "title": "A specific article title that could exist on this site about ${keyword}",
    "url": "https://example.com/relevant-article-path",
    "reason": "Why this site is a good backlink target and how a link would fit naturally",
    "relevancyScore": 85
  }
]`;

    const text = await askGPT(prompt);
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s >= 0 && e > s) {
      prospects = JSON.parse(text.slice(s, e + 1));
    } else {
      return res.status(500).json({ error: 'No prospects returned', raw: text.slice(0, 300) });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!prospects.length) return res.json({ prospects: [] });

  // Deduplicate
  const seen = new Set();
  prospects = prospects.filter(p => {
    const d = (p.domain || '').toLowerCase().replace(/^www\./, '');
    if (seen.has(d)) return false;
    seen.add(d); return true;
  });

  // ── STEP 2: Ahrefs DR + Traffic in parallel batches of 5 ──
  for (let i = 0; i < prospects.length; i += 5) {
    const batch = prospects.slice(i, i + 5);
    const results = await Promise.all(batch.map(p => enrichDomain(p.domain)));
    results.forEach((r, j) => { prospects[i + j].dr = r.dr; prospects[i + j].traffic = r.traffic; });
  }

  // ── STEP 3: Emails (optional) ──
  if (findEmails) {
    const token = await getSnovToken();
    for (let i = 0; i < prospects.length; i += 3) {
      const batch = prospects.slice(i, i + 3);
      const results = await Promise.all(batch.map(p => findEmailsForDomain(p.domain, token)));
      results.forEach((emails, j) => { prospects[i + j].emails = emails; });
    }
  }

  // Sort by relevancyScore
  prospects.sort((a, b) => (b.relevancyScore || 0) - (a.relevancyScore || 0));

  return res.json({ prospects });
};
