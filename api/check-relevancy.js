// Automatic relevancy check — fetches the page a backlink sits on (linkin) and
// asks Claude whether it's topically relevant for the anchor/target project,
// mirroring what "Relevancy checker" meant in the team's old spreadsheet.

const { isSafeHost } = require('./_lib/security');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { linkin, anchor, project, niche, coreTopics } = req.body || {};
  if (!linkin) return res.status(400).json({ error: 'linkin required' });
  if (!isSafeHost(linkin)) return res.status(400).json({ error: 'Invalid or disallowed URL' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  let text;
  try {
    const url = /^https?:\/\//i.test(linkin) ? linkin : 'https://' + linkin;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.json({ relevancy: '', reason: `Could not fetch page (HTTP ${r.status})` });
    text = htmlToText(await r.text()).slice(0, 6000);
  } catch (e) {
    if (e.name === 'TimeoutError') return res.json({ relevancy: '', reason: 'Page took too long to load' });
    return res.json({ relevancy: '', reason: 'Could not fetch page: ' + e.message.slice(0, 100) });
  }
  if (!text) return res.json({ relevancy: '', reason: 'Page had no readable content' });

  const context = [
    project ? `Client/target: ${project}` : '',
    niche ? `Client niche: ${niche}` : '',
    coreTopics && coreTopics.length ? `Client core topics: ${coreTopics.join(', ')}` : '',
    anchor ? `Anchor text used: "${anchor}"` : ''
  ].filter(Boolean).join('\n');

  const prompt = `You are reviewing a backlink placement for topical relevance.

${context || '(No client context provided — judge relevance generically based on whether the page reads as a genuine, on-topic piece of content rather than filler/spam.)'}

The backlink is placed on a page with this content:
"""
${text}
"""

Is this a topically relevant, natural placement for the anchor/client above (or, if no context given, does the page look like genuine relevant content rather than spam/filler)?

Return ONLY valid JSON, no markdown: {"relevancy":"Relevant","reason":"one short sentence"} or {"relevancy":"Weak","reason":"one short sentence"}`;

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
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    const aiData = await aiResp.json();
    const raw = (aiData.content?.[0]?.text || '').trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let obj;
    try { obj = JSON.parse(clean); }
    catch (e) {
      const m = clean.match(/\{[\s\S]*\}/);
      obj = m ? JSON.parse(m[0]) : null;
    }
    if (!obj || (obj.relevancy !== 'Relevant' && obj.relevancy !== 'Weak')) {
      return res.json({ relevancy: '', reason: 'Could not determine relevancy' });
    }
    return res.json({ relevancy: obj.relevancy, reason: String(obj.reason || '').slice(0, 200) });
  } catch (e) {
    if (e.name === 'TimeoutError') return res.json({ relevancy: '', reason: 'Relevancy check timed out' });
    return res.json({ relevancy: '', reason: 'Error: ' + e.message.slice(0, 100) });
  }
};
