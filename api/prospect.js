module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors, openaiKey } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const OPENAI_KEY = openaiKey || process.env.OPENAI_KEY || '';
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;

  let pageContent = '';
  let blogLinks = [];

  // Step 1: Fast fetch — 5s timeout max
  const urlsToTry = [`${baseUrl}/blog`, `${baseUrl}/articles`, `${baseUrl}`];

  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)' },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow'
      });
      if (!resp.ok) continue;
      const html = await resp.text();

      // Extract blog links
      const linkRe = /href="([^"]*(?:blog|article|post|guide|resource|learn|news)[^"]*)"/gi;
      let m;
      const found = new Set();
      while ((m = linkRe.exec(html)) !== null) {
        let href = m[1];
        if (href.startsWith('/')) href = baseUrl + href;
        if (href.startsWith('http') && !href.includes('#')) found.add(href);
        if (found.size >= 8) break;
      }
      blogLinks = [...found];

      // Clean text
      pageContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
      break;
    } catch (e) { continue; }
  }

  // Step 2: AI suggestions — 8s timeout
  const anchorList = (anchors && anchors.length) ? anchors.slice(0, 5).join(', ') : 'any relevant anchor';

  const prompt = `SEO link building expert. Suggest 3 link insertion opportunities.

Website: ${domain}
Client: ${project || 'unknown'}
Target URL: ${linkTo || 'not specified'}
Anchors needed: ${anchorList}
Blog pages found: ${blogLinks.slice(0, 6).join('\n') || 'none'}
Site content: ${pageContent.slice(0, 800)}

Return ONLY a JSON array, no markdown:
[{"articleUrl":"url","anchor":"text","insertion":"sentence with anchor","reason":"why"}]`;

  try {
    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(8000)
    });

    const aiData = await aiResp.json();
    const text = aiData.choices?.[0]?.message?.content || '[]';

    let suggestions = [];
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch (e) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) { try { suggestions = JSON.parse(match[0]); } catch (e2) {} }
    }

    return res.json({ domain, blogLinks, suggestions: suggestions.slice(0, 4) });

  } catch (e) {
    return res.json({ error: e.message, suggestions: [] });
  }
};
