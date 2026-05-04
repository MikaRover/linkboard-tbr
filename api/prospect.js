const OPENAI_KEY = process.env.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 || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const openaiKey = req.body.openaiKey || OPENAI_KEY;

  try {
    // Step 1: Fetch the website
    const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;
    
    let pageContent = '';
    let blogLinks = [];

    // Try to fetch sitemap or blog page first
    const urlsToTry = [
      `${baseUrl}/blog`,
      `${baseUrl}/blog/`,
      `${baseUrl}/articles`,
      `${baseUrl}/resources`,
      `${baseUrl}`,
    ];

    for (const url of urlsToTry) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkProspector/1.0)' },
          signal: AbortSignal.timeout(8000),
          redirect: 'follow'
        });
        if (resp.ok) {
          const html = await resp.text();
          pageContent = html.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000);

          // Extract article/blog links from HTML
          const linkMatches = html.match(/href="([^"]*(?:blog|article|post|guide|resource|learn)[^"]*)"/gi) || [];
          blogLinks = [...new Set(
            linkMatches
              .map(m => m.replace(/href="/i, '').replace(/"$/, ''))
              .filter(l => l.startsWith('/') || l.startsWith('http'))
              .map(l => l.startsWith('/') ? baseUrl + l : l)
              .filter(l => !l.includes('#'))
              .slice(0, 10)
          )];
          break;
        }
      } catch (e) { continue; }
    }

    if (!pageContent && !blogLinks.length) {
      return res.json({
        error: 'Could not fetch website content',
        suggestions: []
      });
    }

    // Step 2: Use AI to find anchor opportunities
    const prompt = `You are an SEO link building expert. 

Website: ${domain}
Project/Client: ${project || 'unknown'}
Target page (link to): ${linkTo || 'not specified'}
Required anchors: ${anchors && anchors.length ? anchors.join(', ') : 'any relevant'}

Blog/article pages found on the website:
${blogLinks.length ? blogLinks.slice(0, 8).join('\n') : 'none found'}

Website content preview:
${pageContent.slice(0, 1500)}

Based on this information, suggest 3-5 specific link insertion opportunities. For each suggestion provide:
1. The best article URL to insert the link into (from the blog links above, or suggest a likely URL)
2. The anchor text to use (from the required anchors if provided)
3. A natural sentence showing WHERE and HOW to insert the link in the article
4. Why this placement makes sense

Return ONLY a JSON array like this (no markdown, no explanation):
[
  {
    "articleUrl": "https://example.com/blog/article-name",
    "anchor": "anchor text here",
    "insertion": "This is the sentence where [anchor text] would naturally fit, linking to the target page.",
    "reason": "Why this works for SEO"
  }
]`;

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(25000)
    });

    const aiData = await aiResp.json();
    const text = aiData.choices?.[0]?.message?.content || '[]';

    // Parse JSON from response
    let suggestions = [];
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch (e) {
      // Try to extract JSON array
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try { suggestions = JSON.parse(match[0]); } catch (e2) {}
      }
    }

    return res.json({
      domain,
      blogLinks: blogLinks.slice(0, 8),
      suggestions: suggestions.slice(0, 5)
    });

  } catch (e) {
    return res.json({ error: e.message, suggestions: [] });
  }
};
