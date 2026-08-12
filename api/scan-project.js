const { isSafeHost, browserHeaders } = require('./_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;

  const fetchPage = async (url) => {
    try {
      const r = await fetch(url, {
        headers: browserHeaders(),
        signal: AbortSignal.timeout(6000), redirect: 'follow'
      });
      if (!r.ok) return null;
      const html = await r.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 2000);
    } catch(e) { return null; }
  };

  // Fetch key pages in parallel
  const [home, about, features, blog, pricing] = await Promise.all([
    fetchPage(baseUrl),
    fetchPage(`${baseUrl}/about`),
    fetchPage(`${baseUrl}/features`),
    fetchPage(`${baseUrl}/blog`),
    fetchPage(`${baseUrl}/pricing`),
  ]);

  // Find blog article links
  let blogLinks = [];
  try {
    const blogHtml = await fetch(`${baseUrl}/blog`, {
      headers: browserHeaders(), signal: AbortSignal.timeout(5000)
    }).then(r => r.text()).catch(() => '');

    const linkRe = /href="([^"#?]*\/blog\/[^"#?][^"]*)"/gi;
    let m;
    const found = new Set();
    while ((m = linkRe.exec(blogHtml)) !== null) {
      let href = m[1];
      if (href.startsWith('/')) href = baseUrl + href;
      if (href.startsWith('http') && href !== `${baseUrl}/blog`) found.add(href);
      if (found.size >= 8) break;
    }
    blogLinks = [...found];
  } catch(e) {}

  // Fetch a few blog articles for topic extraction
  const articleTexts = [];
  await Promise.all(blogLinks.slice(0, 4).map(async url => {
    const text = await fetchPage(url);
    if (text) articleTexts.push(text.slice(0, 1000));
  }));

  const allContent = [
    home && `HOME: ${home}`,
    about && `ABOUT: ${about}`,
    features && `FEATURES: ${features}`,
    pricing ? `HAS PRICING PAGE: yes` : '',
    blogLinks.length ? `BLOG ARTICLES FOUND: ${blogLinks.slice(0,6).join(', ')}` : '',
    articleTexts.length ? `BLOG CONTENT SAMPLES:\n${articleTexts.join('\n---\n')}` : ''
  ].filter(Boolean).join('\n\n');

  const prompt = `Analyze this website and extract structured project intelligence for SEO link building.

Website: ${domain}
Content scraped:
${allContent}

Return ONLY a JSON object (no markdown):
{
  "niche": "one-line description (e.g. 'email security SaaS', 'project management tool')",
  "productType": "SaaS|Service|Ecommerce|Blog|Agency|Other",
  "targetAudience": "who uses this (e.g. 'IT admins, security teams')",
  "coreTopics": ["topic1", "topic2", "topic3", "topic4", "topic5"],
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6", "kw7", "kw8"],
  "contentThemes": ["theme1", "theme2", "theme3"],
  "blogUrl": "best blog URL found or null",
  "competitors": ["comp1", "comp2"],
  "linkingContext": "2-3 sentence summary of what this product does and why someone would link to it — used to guide link placement decisions"
}`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(25000)
    });

    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '').trim();

    let siteData = {};
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      siteData = JSON.parse(clean);
    } catch(e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { siteData = JSON.parse(match[0]); } catch(e2) {} }
    }

    siteData.lastScanned = new Date().toISOString().slice(0, 10);
    siteData.domain = domain;

    return res.json({ success: true, siteData });
  } catch(e) {
    return res.json({ success: false, error: e.message });
  }
};
