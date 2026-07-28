const OPENAI_KEY = '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';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const mt = mediaType || 'image/png';

  const prompt = `This image is a screenshot of an anchor / link-building requirements table. It has columns like:
- "Target page" (a URL) → map to "linkto"
- "Keyword" (the anchor text) → map to "anchor"
- "Number of links/monthly" (a number) → map to "max"

Extract EVERY data row. Ignore section headers (like "June 2026") and the column header row.

Return ONLY a raw JSON array, no markdown, no explanation:
[
  { "anchor": "free ai video generator", "linkto": "https://www.renderforest.com/ai-video-generator", "max": 2 }
]

Rules:
- "anchor" = the Keyword column text, lowercased and trimmed
- "linkto" = the Target page URL (full URL if visible)
- "max" = the Number of links value as an integer (default 1 if unclear)
- Skip rows with no keyword.`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mt};base64,${imageBase64}` } }
          ]
        }]
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(500).json({ error: 'OpenAI ' + resp.status + ': ' + err.slice(0, 200) });
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';

    let rows = [];
    try {
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s >= 0 && e > s) rows = JSON.parse(text.slice(s, e + 1));
    } catch (parseErr) {
      return res.status(500).json({ error: 'Could not parse table', raw: text.slice(0, 300) });
    }

    // Normalize
    rows = rows
      .filter(r => r && r.anchor)
      .map(r => ({
        anchor: String(r.anchor || '').toLowerCase().trim(),
        linkto: String(r.linkto || '').trim(),
        max: parseInt(r.max) || 1
      }));

    return res.json({ rows });

  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'Image read timed out — try a smaller/clearer screenshot' });
    return res.status(500).json({ error: e.message });
  }
};
