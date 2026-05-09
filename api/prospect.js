module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors, siteData, openaiKey } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const ANTHROPIC_KEY = openaiKey || process.env.ANTHROPIC_KEY || '';
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;

  const fetchHtml = async (url, timeout = 7000) => {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      if (!r.ok) return null;
      return await r.text();
    } catch(e) { return null; }
  };

  const htmlToText = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // STEP 1: Find article links
  const indexUrls = [
    `${baseUrl}/blog`, `${baseUrl}/guides`, `${baseUrl}/articles`,
    `${baseUrl}/resources`, `${baseUrl}/learn`, `${baseUrl}/news`,
    `${baseUrl}/insights`, `${baseUrl}/tutorials`, `${baseUrl}/library`,
    `${baseUrl}/posts`, `${baseUrl}`
  ];

  let blogLinks = [];
  for (const url of indexUrls) {
    const html = await fetchHtml(url);
    if (!html) continue;

    const found = new Set();
    const linkRe = /href="([^"#?][^"]*)"/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      if (href.startsWith('/')) href = baseUrl + href;
      if (!href.startsWith('http')) continue;
      if (!href.includes(domain.replace(/^www\./, ''))) continue;

      const path = href.replace(/^https?:\/\/[^\/]+/, '');
      const segments = path.split('/').filter(Boolean);
      if (segments.length < 2) continue;
      if (/\.(css|js|png|jpg|svg|pdf|zip|xml|gif|webp)$/i.test(href)) continue;

      // Must be article-like path
      const hasArticlePath = /\/(blog|article|articles|post|posts|news|resources|learn|guides|guide|insights|knowledge|tutorials|tutorial|library|content)\//i.test(path);
      if (!hasArticlePath) continue;

      // Skip pagination, tags, categories
      if (/\/(tag|category|author|page\/\d+|wp-|feed|cart|checkout|login|signup|search)\//i.test(path)) continue;

      // Slug must look like an article (has hyphens)
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg.includes('-') && lastSeg.length < 8) continue;

      found.add(href);
      if (found.size >= 30) break;
    }

    if (found.size >= 5) {
      blogLinks = [...found];
      break;
    }
  }

  if (!blogLinks.length) {
    return res.json({ domain, suggestions: [], error: 'No blog articles found on this website.' });
  }

  // STEP 2: Score articles by content relevance — fetch & read them
  const anchorList = (anchors && anchors.length) ? anchors.slice(0, 10) : [];
  const anchorStr = anchorList.join(', ') || 'relevant topics';

  // Build keyword set from anchors + siteData
  const kwSet = new Set();
  anchorList.forEach(a => a.toLowerCase().split(/\s+/).filter(w => w.length > 3).forEach(w => kwSet.add(w)));
  if (siteData?.coreTopics) siteData.coreTopics.forEach(t => t.toLowerCase().split(/\s+/).filter(w => w.length > 3).forEach(w => kwSet.add(w)));
  if (siteData?.keywords) siteData.keywords.forEach(k => k.toLowerCase().split(/\s+/).filter(w => w.length > 3).forEach(w => kwSet.add(w)));
  const keywords = [...kwSet];

  // Fetch all articles and score by actual content
  const scoredArticles = [];
  await Promise.all(blogLinks.slice(0, 20).map(async (url) => {
    const html = await fetchHtml(url);
    if (!html) return;

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().replace(/\s*[\|\-–]\s*.+$/, '') : '';

    // Extract h1/h2 headings for topic signals
    const headings = [];
    const hRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
    let hm;
    while ((hm = hRe.exec(html)) !== null) {
      headings.push(hm[1].replace(/<[^>]+>/g, '').trim());
    }

    const text = htmlToText(html);

    // Score: count keyword matches in title + headings + content
    const searchable = `${title} ${headings.join(' ')} ${text}`.toLowerCase();
    let score = 0;
    keywords.forEach(kw => {
      const count = (searchable.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
      score += count;
    });

    // Bonus for title match
    keywords.forEach(kw => {
      if (title.toLowerCase().includes(kw)) score += 5;
    });

    // Extract clean paragraphs (sentences 40-300 chars)
    const sentences = text.match(/[A-Z][^.!?]{40,300}[.!?]/g) || [];
    const content = sentences.slice(0, 30).join(' ');

    if (content.length > 200) {
      scoredArticles.push({ url, title, headings: headings.slice(0, 5), content, score });
    }
  }));

  if (!scoredArticles.length) {
    return res.json({ domain, suggestions: [], error: 'Could not read article content.' });
  }

  // Pick top 5 by score
  scoredArticles.sort((a, b) => b.score - a.score);
  const topArticles = scoredArticles.slice(0, 5);

  // STEP 3: Claude deep analysis
  const projectCtx = siteData ? `
CLIENT CONTEXT (what we're linking TO):
- Product: ${siteData.niche || project}
- Type: ${siteData.productType || ''}
- Audience: ${siteData.targetAudience || ''}
- Core topics: ${(siteData.coreTopics || []).join(', ')}
- Keywords: ${(siteData.keywords || []).join(', ')}
- Why link here: ${siteData.linkingContext || ''}
` : `Client: ${project || 'unknown'}`;

  const articlesText = topArticles.map((a, i) => `
ARTICLE ${i+1}:
URL: ${a.url}
Title: ${a.title}
Headings: ${a.headings.join(' | ')}
Content:
${a.content.slice(0, 2500)}
`).join('\n---\n');

  const prompt = `You are a senior SEO link builder. Your job is to find places in EXISTING blog articles where a link can be naturally inserted.

${projectCtx}
Target URL: ${linkTo || 'not specified'}
Anchors to place: ${anchorStr}

DONOR ARTICLES TO ANALYZE:
${articlesText}

YOUR TASK:
1. Read each article carefully
2. Find sentences where the anchor fits NATURALLY based on topic overlap
3. Either edit an existing sentence to include the anchor, or suggest adding a new sentence
4. The reader should NOT notice it's a paid link — it must add genuine value
5. Only suggest placements where there is REAL topical relevance
6. If an anchor doesn't fit naturally anywhere — skip it, don't force it

For each suggestion return:
- The EXACT existing sentence you're modifying (copy it word for word from the content)
- Your edited version with the anchor naturally embedded
- Where exactly in the article it goes
- A relevancy score 0-100 (how natural the placement is)

Return ONLY valid JSON array:
[
  {
    "articleUrl": "url",
    "articleTitle": "title",
    "anchor": "anchor text",
    "type": "edit",
    "originalSentence": "exact original sentence from the article",
    "editedSentence": "modified sentence with anchor naturally embedded",
    "placement": "specific location, e.g. 'Under the H2 heading X, second paragraph'",
    "reason": "why this is topically relevant and natural",
    "relevancy": 85
  }
]

Return 4-6 suggestions. Quality over quantity.`;

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
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(45000)
    });

    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '').trim();

    let suggestions = [];
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch(e) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) { try { suggestions = JSON.parse(match[0]); } catch(e2) {} }
    }

    return res.json({ domain, suggestions: suggestions.slice(0, 6) });
  } catch(e) {
    return res.json({ error: e.message, suggestions: [] });
  }
};
