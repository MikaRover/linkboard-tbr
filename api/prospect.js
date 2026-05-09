module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors, openaiKey } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const ANTHROPIC_KEY = openaiKey || process.env.ANTHROPIC_KEY || '';
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;

  // STEP 1: Find article links
  let blogLinks = [];
  const indexUrls = [
    `${baseUrl}/blog`, `${baseUrl}/articles`, `${baseUrl}/resources`,
    `${baseUrl}/learn`, `${baseUrl}/news`, `${baseUrl}/insights`, `${baseUrl}`
  ];

  for (const url of indexUrls) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)' },
        signal: AbortSignal.timeout(6000), redirect: 'follow'
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const linkRe = /href="([^"#?][^"]*)"/gi;
      let m;
      const found = new Set();
      while ((m = linkRe.exec(html)) !== null) {
        let href = m[1];
        if (href.startsWith('/')) href = baseUrl + href;
        if (!href.startsWith('http')) continue;
        if (!href.includes(domain.replace(/^www\./, ''))) continue;
        const path = href.replace(baseUrl, '');
        const segments = path.split('/').filter(Boolean);
        if (segments.length < 1) continue;
        if (/\.(css|js|png|jpg|svg|pdf|zip)$/i.test(href)) continue;
        if (/\/(tag|category|author|page\/\d|wp-|feed|cart|checkout|login|signup|account)/i.test(href)) continue;
        found.add(href);
        if (found.size >= 20) break;
      }
      blogLinks = [...found];
      if (blogLinks.length >= 5) break;
    } catch (e) { continue; }
  }

  if (!blogLinks.length) {
    return res.json({ domain, blogLinks: [], suggestions: [], error: 'Could not find any articles on this website.' });
  }

  // STEP 2: Score and fetch top articles
  const anchorList = (anchors && anchors.length) ? anchors.slice(0, 8).join(', ') : 'relevant SEO terms';
  const anchorWords = anchorList.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);

  const scoredLinks = blogLinks.map(url => {
    const score = anchorWords.filter(w => url.toLowerCase().includes(w)).length;
    return { url, score };
  }).sort((a, b) => b.score - a.score);

  const topLinks = scoredLinks.slice(0, 5).map(l => l.url);
  const articleContents = [];

  await Promise.all(topLinks.map(async (url) => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)' },
        signal: AbortSignal.timeout(6000), redirect: 'follow'
      });
      if (!resp.ok) return;
      const html = await resp.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim().slice(0,100) : '';
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const sentences = bodyText.match(/[A-Z][^.!?]{20,200}[.!?]/g) || [];
      const content = sentences.slice(0, 20).join(' ').slice(0, 2500);
      if (content.length > 100) articleContents.push({ url, title, content });
    } catch (e) {}
  }));

  if (!articleContents.length) {
    return res.json({ domain, blogLinks, suggestions: [], error: 'Could not read article content.' });
  }

  // STEP 3: Claude deep analysis with exact placement
  const targetInfo = linkTo ? `Target URL to link to: ${linkTo}` : '';
  const articlesText = articleContents.map((a, i) =>
    `ARTICLE ${i+1}:\nURL: ${a.url}\nTitle: ${a.title}\nContent excerpt: ${a.content}`
  ).join('\n\n---\n\n');

  const prompt = `You are an expert SEO link builder. Analyze these real articles and suggest specific, natural link placements.

Client project: ${project || 'unknown'}
${targetInfo}
Anchor texts needed: ${anchorList}

ARTICLES TO ANALYZE:
${articlesText}

For each suggestion:
- Use ONLY real URLs from the articles above
- Find a SPECIFIC existing sentence that can be naturally edited to include the anchor
- OR suggest adding a new sentence in a specific location
- The link must be 100% topically relevant and natural
- Do not force irrelevant anchors into articles

Return ONLY a JSON array:
[
  {
    "articleUrl": "exact URL",
    "articleTitle": "title",
    "anchor": "anchor text",
    "type": "edit",
    "originalSentence": "the exact existing sentence to modify",
    "editedSentence": "modified sentence with anchor naturally embedded",
    "placement": "specific location description",
    "reason": "why this is topically relevant"
  }
]

Generate 4-5 high-quality suggestions. Prioritize natural fit over keyword forcing.`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '').trim();

    let suggestions = [];
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch (e) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) { try { suggestions = JSON.parse(match[0]); } catch (e2) {} }
    }

    return res.json({ domain, blogLinks: topLinks, suggestions: suggestions.slice(0, 5) });
  } catch (e) {
    return res.json({ error: e.message, suggestions: [], blogLinks: topLinks });
  }
};
