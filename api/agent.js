module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword, count = 20, project = '' } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const apiKey = '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';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `You are a link building specialist finding backlink opportunities for the product: "${project || keyword}".

Search for articles about: "${keyword}"

For each result, classify it as:
- "prospect" = blog, resource page, comparison article, educational content, news site, directory — sites that MENTION tools/providers but are NOT themselves a tool/provider
- "competitor" = a direct competing product/service that offers the same thing as ${project || 'the client'}

IMPORTANT RULES:
- A site that writes ABOUT SMS APIs is a prospect
- A site that SELLS SMS API is a competitor
- Educational blogs, tech media, comparison sites = prospects
- SaaS products in the same category = competitors

Return ONLY a JSON array, no markdown:
[
  {
    "domain": "example.com",
    "title": "Article title",
    "url": "https://example.com/article",
    "reason": "why good for backlink",
    "is_competitor": false
  }
]

STRICT RULE: Do NOT include any website that sells or provides the same type of service/product as '${project || keyword}'. If a site is a direct competitor, skip it entirely. Return ONLY ${count} non-competitor prospects: blogs, media sites, resource pages, listicles, comparison articles, directories. Mark is_competitor: false for all returned results.`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Anthropic API error ' + response.status, detail: err.slice(0, 300) });
    }

    const data = await response.json();

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    let prospects = [];
    try {
      const s = text.indexOf('[');
      const e = text.lastIndexOf(']');
      if (s >= 0 && e > s) prospects = JSON.parse(text.slice(s, e + 1));
    } catch (err) {
      return res.status(500).json({ error: 'Parse error', raw: text.slice(0, 500) });
    }

    return res.json({ prospects });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
