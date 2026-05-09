const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || require('../index.html') && '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keyword, count = 20, project = '' } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  // Get API key from env or fallback to hardcoded (same as other api files)
  const apiKey = process.env.ANTHROPIC_KEY || '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';

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `You are a link building specialist. Find ${count} websites that would be good backlink prospects for the keyword: "${keyword}"${project ? ` for the product: ${project}` : ''}.

Search Google for this keyword and related terms. Find blogs, resource pages, comparison articles, and informational content (NOT direct competitors, NOT product pages).

Return ONLY a JSON array, no markdown, no extra text:
[
  {"domain":"example.com","title":"Article title","url":"https://example.com/article","reason":"why good prospect"}
]

Return ${count} unique domains. Focus on blogs, resource sites, listicles, comparison articles.`
        }]
      })
    });

    const data = await response.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    // Extract text blocks (skip tool_use blocks)
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response
    let prospects = [];
    try {
      const s = text.indexOf('[');
      const e = text.lastIndexOf(']');
      if (s >= 0 && e > s) prospects = JSON.parse(text.slice(s, e + 1));
    } catch (err) {
      return res.status(500).json({ error: 'Failed to parse prospects', raw: text.slice(0, 500) });
    }

    return res.json({ prospects });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
