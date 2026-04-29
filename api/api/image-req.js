module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 }
            },
            {
              type: 'text',
              text: `Look at this image and extract the anchor requirements table.
RESPOND WITH ONLY A JSON ARRAY. NO OTHER TEXT. NO EXPLANATION. NO MARKDOWN.
Format: [{"anchor":"text","linkto":"url or null","max":3}]
- anchor: exact anchor text from the table
- linkto: the URL from Target page column, or null if not visible
- max: integer from Number of links column
Start your response with [ and end with ]`
            }
          ]
        }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.json({ error: `API error ${resp.status}`, detail: err.slice(0, 200) });
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let rows;
    try { rows = JSON.parse(clean); }
    catch (e) { return res.json({ error: 'Parse error', raw: text.slice(0, 300) }); }

    return res.json({ rows });

  } catch (e) {
    return res.json({ error: e.message.slice(0, 100) });
  }
};
