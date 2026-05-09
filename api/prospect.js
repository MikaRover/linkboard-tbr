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

  // STEP 1: Find BLOG/ARTICLE links only
  let blogLinks = [];
  const indexUrls = [
    `${baseUrl}/blog`, `${baseUrl}/articles`, `${baseUrl}/resources`,
    `${baseUrl}/learn`, `${baseUrl}/news`, `${baseUrl}/insights`,
    `${baseUrl}/guides`, `${baseUrl}/posts`, `${baseUrl}`
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

        // STRICT: only accept URLs that look like actual articles
        const path = href.replace(/^https?:\/\/[^\/]+/, '');
        const segments = path.split('/').filter(Boolean);

        // Must have at least 2 path segments (e.g. /blog/article-name)
        if (segments.length < 2) continue;

        // Must contain a blog/article indicator in the path
        const hasBlogPath = /\/(blog|article|articles|post|posts|news|resources|learn|guides|insights|knowledge)\//i.test(path);
        if (!hasBlogPath) continue;

        // Skip obvious non-articles
        if (/\.(css|js|png|jpg|svg|pdf|zip|xml)$/i.test(href)) continue;
        if (/\/(tag|category|author|page\/\d+|wp-|feed|cart|checkout|login|signup|account|search)\//i.test(path)) continue;

        // Last segment should look like a slug (has hyphens, not just numbers)
        const lastSeg = segments[segments.length - 1];
        if (lastSeg.includes('-') || lastSeg.length > 10) {
          found.add(href);
        }
        if (found.size >= 25) break;
      }
      if (found.size > 0) {
        blogLinks = [...found];
        break;
      }
    } catch (e) { continue; }
  }

  if (!blogLinks.length) {
    return res.json({ domain, blogLinks: [], suggestions: [], error: 'Could not find blog articles on this website. Make sure the domain has a /blog or /articles section.' });
  }

  // STEP 2: Score articles by anchor relevance
  const anchorList = (anchors && anchors.length) ? anchors.slice(0, 8).join(', ') : 'relevant SEO terms';
  const anchorWords = anchorList.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);

  const scoredLinks = blogLinks.map(url => {
    const score = anchorWords.filter(w => url.toLowerCase().includes(w)).length;
    return { url, score };
  }).sort((a, b) => b.score - a.score);

  // Take top 6 — mix of relevant + diverse
  const topLinks = [
    ...scoredLinks.filter(l => l.score > 0).slice(0, 3),
    ...scoredLinks.filter(l => l.score === 0).slice(0, 3)
  ].slice(0, 6).map(l => l.url);

  // STEP 3: Fetch article content
  const articleContents = [];
  await Promise.all(topLinks.map(async (url) => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)' },
        signal: AbortSignal.timeout(7000), redirect: 'follow'
      });
      if (!resp.ok) return;
      const html = await resp.text();

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim().slice(0,120) : '';

      // Extract article body — remove nav, header, footer, sidebar
      let body = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();

      // Extract meaningful sentences (not too short, not too long)
      const sentences = body.match(/[A-Z][^.!?]{30,250}[.!?]/g) || [];
      const content = sentences.slice(0, 25).join(' ').slice(0, 3000);

      if (content.length > 150) {
        articleContents.push({ url, title, content });
      }
    } catch (e) {}
  }));

  if (!articleContents.length) {
    return res.json({ domain, blogLinks, suggestions: [], error: 'Could not read article content. The site may block scrapers.' });
  }

  // STEP 4: Claude analysis
  const targetInfo = linkTo ? `Target URL to link to: ${linkTo}` : '';
  const projectContext = siteData ? `
PROJECT INTELLIGENCE (use this to find relevant placements):
- Niche: ${siteData.niche || ''}
- Product type: ${siteData.productType || ''}
- Target audience: ${siteData.targetAudience || ''}
- Core topics: ${(siteData.coreTopics||[]).join(', ')}
- Keywords: ${(siteData.keywords||[]).join(', ')}
- Content themes: ${(siteData.contentThemes||[]).join(', ')}
- Linking context: ${siteData.linkingContext || ''}

Use this context to identify donor articles where the client's topics appear naturally.
Prioritize placements where the donor article discusses topics related to: ${(siteData.coreTopics||[]).slice(0,3).join(', ')}.
` : '';
  const articlesText = articleContents.map((a, i) =>
    `ARTICLE ${i+1}:\nURL: ${a.url}\nTitle: ${a.title}\nContent:\n${a.content}`
  ).join('\n\n---\n\n');

  const prompt = `You are an expert SEO link builder. Analyze these BLOG ARTICLES and suggest natural link placements.

Client: ${project || 'unknown'}
${targetInfo}
Anchor texts to place: ${anchorList}

${projectContext}

IMPORTANT RULES:
- Only suggest placements in EDITORIAL/BLOG content, never in nav menus or footers
- The anchor must fit NATURALLY — readers should not notice it's a paid link
- Find sentences that are TOPICALLY RELEVANT to the anchor
- Prefer "edit existing sentence" over "add new sentence" when possible
- If an anchor doesn't fit naturally in ANY article, skip it — don't force it

ARTICLES:
${articlesText}

Return ONLY a JSON array (no markdown):
[
  {
    "articleUrl": "exact URL from above",
    "articleTitle": "article title",
    "anchor": "anchor text",
    "type": "edit",
    "originalSentence": "exact sentence from the article to modify",
    "editedSentence": "naturally modified sentence with anchor embedded",
    "placement": "where in the article (e.g. 'In the introduction, 2nd paragraph')",
    "reason": "why this anchor fits naturally here",
    "relevancy": 85
  }
]

relevancy is 0-100 score: how naturally the anchor fits in context (100 = perfect topical match, 0 = forced).

Generate 4-5 high-quality, natural suggestions only.`;

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

    // Fetch DR/Traffic for the domain
    let dr = null, traffic = null;
    try {
      const ahrefsResp = await fetch(`https://${req.headers.host || 'localhost'}/api/ahrefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain })
      });
      const ahrefsData = await ahrefsResp.json();
      dr = ahrefsData.dr ?? null;
      traffic = ahrefsData.traffic ?? null;
    } catch(e) {}

    // Add DR/Traffic to each suggestion
    const enriched = suggestions.slice(0, 5).map(s => ({ ...s, dr, traffic }));
    return res.json({ domain, blogLinks: topLinks, suggestions: enriched });
  } catch (e) {
    return res.json({ error: e.message, suggestions: [], blogLinks: topLinks });
  }
};
