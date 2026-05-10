module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword, count = 20, project = '' } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const apiKey = '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';
  const AHREFS_KEY = '7dNernlzY4mixkKwyIEOVsZK8e0Rx0Hgq3YszXti';
  const today = new Date().toISOString().slice(0, 10);

  // Step 1: Get prospects from Claude
  const callClaude = async (body) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        body: JSON.stringify(body)
      });
      if (r.status === 429) {
        if (attempt < 2) { await new Promise(x => setTimeout(x, 5000)); continue; }
      }
      return r;
    }
  };

  let prospects = [];
  try {
    const response = await callClaude({

        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `You are a link building specialist finding backlink opportunities for: "${project || keyword}".

Search for articles about: "${keyword}"

STRICT RULES:
1. Do NOT include websites that sell or provide the same service as "${project || keyword}". Skip all direct competitors.
2. Prefer mid-tier sites (DR 20-70) — avoid huge media sites like Forbes, TechCrunch, HubSpot, G2, Capterra that almost never give backlinks to unknown products.
3. Focus on niche blogs, independent writers, small-medium SaaS blogs, industry newsletters, and resource sites that are actually reachable for outreach.

Return ONLY non-competitor sites: niche blogs, independent review sites, industry publications, resource pages.

Return ONLY a JSON array, no markdown:
[
  {
    "domain": "example.com",
    "title": "Article title",
    "url": "https://example.com/article",
    "reason": "why good for backlink"
  }
]

Return ${count} unique prospect domains.`
        }]
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error ' + response.status, detail: err.slice(0, 300) });
    }

    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    try {
      const s = text.indexOf('[');
      const e = text.lastIndexOf(']');
      if (s >= 0 && e > s) prospects = JSON.parse(text.slice(s, e + 1));
    } catch (err) {
      return res.status(500).json({ error: 'Parse error', raw: text.slice(0, 500) });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!prospects.length) return res.json({ prospects: [] });

  // Step 2: Enrich with Ahrefs DR + Traffic in parallel (batches of 5)
  const ahrefsHeaders = {
    'Authorization': `Bearer ${AHREFS_KEY}`,
    'Accept': 'application/json'
  };

  const enrichDomain = async (domain) => {
    const clean = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
    try {
      const [drResp, metricsResp] = await Promise.all([
        fetch(`https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(clean)}&date=${today}`, { headers: ahrefsHeaders, signal: AbortSignal.timeout(8000) }),
        fetch(`https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(clean)}&date=${today}&mode=subdomains&select=org_traffic,org_keywords`, { headers: ahrefsHeaders, signal: AbortSignal.timeout(8000) })
      ]);

      let dr = null, traffic = null;

      if (drResp.ok) {
        const d = await drResp.json();
        dr = d?.domain_rating?.domain_rating ?? null;
        if (dr !== null) dr = Math.round(dr);
      }

      if (metricsResp.ok) {
        const m = await metricsResp.json();
        const metrics = m?.metrics || m || {};
        const raw = metrics.org_traffic ?? null;
        traffic = raw !== null && raw > 0 ? Math.round(raw) : null;
      }

      return { dr, traffic };
    } catch (e) {
      return { dr: null, traffic: null };
    }
  };

  // Process in batches of 5 to avoid rate limits
  const enriched = [...prospects];
  for (let i = 0; i < enriched.length; i += 5) {
    const batch = enriched.slice(i, i + 5);
    const results = await Promise.all(batch.map(p => enrichDomain(p.domain)));
    results.forEach((r, j) => {
      enriched[i + j].dr = r.dr;
      enriched[i + j].traffic = r.traffic;
    });
  }

  return res.json({ prospects: enriched });
};
