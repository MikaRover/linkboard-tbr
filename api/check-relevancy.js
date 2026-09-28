// Automatic relevancy check — fetches the page a backlink sits on (linkin) and
// asks Claude whether it's topically relevant for the anchor/target project,
// mirroring what "Relevancy checker" meant in the team's old spreadsheet.

const { isSafeHost, browserHeaders } = require('./_lib/security');

// Free fallback for bot-protected pages — see api/check-link.js for details.
async function fetchViaFreeBypass(url) {
  try {
    const r = await fetch('https://r.jina.ai/' + url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const text = await r.text();
    return text && text.trim() ? text.slice(0, 6000) : null;
  } catch (e) { return null; }
}

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

// ─── Bulk lexical relevancy (no AI) ──────────────────────────
// A separate, deterministic checker for the "bulk link from / link to /
// anchor" tool — Mika + Tatev only. Scores by keyword overlap between the
// two pages instead of asking an LLM, so it has no Anthropic cost or
// dependency at all (relevant given how the credit-balance outage above
// broke every AI-backed tool at once).
const STOPWORDS = new Set(('the and for with this that from have will your about into more some such than then when where which while what their they them these those http https www com html also '
  + 'been being are was were is are can could would should will just only very much many more most into onto over under between across through during before after above below out off '
  + 'here there our its his her she him page site website read more learn click here home contact privacy policy terms cookie cookies login sign signup subscribe newsletter copyright rights reserved '
  + 'blog post article posted category tag tags author comment comments share follow us menu skip content search results found').split(/\s+/));

function extractWeightedText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const headings = [];
  const hRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let hm;
  while ((hm = hRe.exec(html)) !== null) headings.push(hm[1].replace(/<[^>]+>/g, ' '));
  const body = htmlToText(html).slice(0, 5000);
  return {
    title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
    headings: headings.join(' '),
    body
  };
}

function tokenize(str) {
  return (str || '').toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || [];
}

// Weighted term-frequency map: title mentions count 5x, meta description 3x,
// headings 2x, body 1x — a word in the title is a far stronger topic signal
// than one mentioned once in passing in the body copy.
function weightedTF(page) {
  const tf = new Map();
  const add = (text, weight) => tokenize(text).forEach(w => { if (!STOPWORDS.has(w)) tf.set(w, (tf.get(w) || 0) + weight); });
  add(page.title, 5);
  add(page.description, 3);
  add(page.headings, 2);
  add(page.body, 1);
  return tf;
}

function topKeywords(tf, n) {
  return [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// No corpus to compute real IDF against, so this is deliberately simple and
// explainable rather than a black box: how much of the TARGET page's own
// top topics are echoed on the DONOR page, plus whether the anchor text
// itself actually matches either page's subject matter.
function scorePair(donorPage, targetPage, anchor) {
  const donorTF = weightedTF(donorPage);
  const targetTF = weightedTF(targetPage);
  const targetTop = topKeywords(targetTF, 20);
  const donorTop = topKeywords(donorTF, 30);
  const donorTopSet = new Set(donorTop);
  const shared = targetTop.filter(w => donorTopSet.has(w));
  const overlapRatio = targetTop.length ? shared.length / Math.min(20, targetTop.length) : 0;

  const anchorWords = tokenize(anchor).filter(w => !STOPWORDS.has(w));
  const anchorMatchesTarget = anchorWords.length ? anchorWords.some(w => targetTF.has(w)) : null;
  const anchorMatchesDonor = anchorWords.length ? anchorWords.some(w => donorTF.has(w)) : null;

  let rate = Math.round(overlapRatio * 100);
  if (anchorWords.length) {
    if (anchorMatchesTarget) rate += 8; else rate -= 12;
    if (anchorMatchesDonor) rate += 4;
  }
  rate = Math.max(0, Math.min(100, rate));

  const tier = rate >= 70 ? 'Strong' : rate >= 40 ? 'Moderate' : 'Weak';
  const kwList = shared.slice(0, 5).join(', ');
  let suggestion;
  if (!targetTop.length || !donorTop.length) {
    suggestion = 'Could not extract enough text from one of the pages to judge topic overlap.';
  } else if (tier === 'Strong') {
    suggestion = `Strong topical overlap (${kwList || 'shared vocabulary'}) — reads as a natural, relevant placement.`;
  } else if (tier === 'Moderate') {
    suggestion = shared.length
      ? `Some overlap (${kwList}), but not strong — worth a manual look before using this anchor here.`
      : `Little shared vocabulary detected between the two pages — worth a manual look.`;
  } else {
    suggestion = `Little to no topical overlap detected — this donor page doesn't appear to discuss what the target page is about.`;
  }
  if (anchorWords.length && anchorMatchesTarget === false) {
    suggestion += ' Also: the anchor text itself doesn\'t match the target page\'s own topic — double-check the anchor is appropriate.';
  }

  return { rate, tier, sharedKeywords: shared.slice(0, 8), suggestion };
}

async function fetchPageForScoring(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
  try {
    const r = await fetch(url, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.ok) return extractWeightedText(await r.text());
    if (r.status === 403 || r.status === 406 || r.status === 429) {
      const bypassed = await fetchViaFreeBypass(url);
      if (bypassed) return extractWeightedText(bypassed);
    }
    return null;
  } catch (e) { return null; }
}

const MAX_BULK_ROWS = 60;
async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

async function handleBulkLexical(req, res) {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, MAX_BULK_ROWS) : [];
  if (!rows.length) return res.status(400).json({ error: 'rows required' });

  const pageCache = new Map(); // a URL reused across rows (common: same target page) is only fetched once
  const getPage = async (url) => {
    if (!url) return null;
    if (!isSafeHost(url)) return { __invalid: true };
    if (!pageCache.has(url)) pageCache.set(url, fetchPageForScoring(url));
    return pageCache.get(url);
  };

  const results = await inChunks(rows, 10, async (row) => {
    const linkFrom = (row.linkFrom || '').trim();
    const linkTo = (row.linkTo || '').trim();
    const anchor = (row.anchor || '').trim();
    if (!linkFrom || !linkTo) return { linkFrom, linkTo, anchor, error: 'Both link-from and link-to are required' };
    const [donorPage, targetPage] = await Promise.all([getPage(linkFrom), getPage(linkTo)]);
    if (donorPage?.__invalid || targetPage?.__invalid) return { linkFrom, linkTo, anchor, error: 'Invalid or disallowed URL' };
    if (!donorPage) return { linkFrom, linkTo, anchor, error: 'Could not fetch the link-from page' };
    if (!targetPage) return { linkFrom, linkTo, anchor, error: 'Could not fetch the link-to page' };
    return { linkFrom, linkTo, anchor, ...scorePair(donorPage, targetPage, anchor) };
  });

  return res.json({ results });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.body && req.body.mode === 'bulk-lexical') return handleBulkLexical(req, res);

  const { linkin, anchor, project, niche, coreTopics } = req.body || {};
  if (!linkin) return res.status(400).json({ error: 'linkin required' });
  if (!isSafeHost(linkin)) return res.status(400).json({ error: 'Invalid or disallowed URL' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  let text;
  try {
    const url = /^https?:\/\//i.test(linkin) ? linkin : 'https://' + linkin;
    const r = await fetch(url, {
      headers: browserHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      if (r.status === 403 || r.status === 406 || r.status === 429) {
        text = await fetchViaFreeBypass(url);
      }
      if (!text) return res.json({ relevancy: '', reason: `Could not fetch page (HTTP ${r.status})` });
    } else {
      text = htmlToText(await r.text()).slice(0, 6000);
    }
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
    if (!aiResp.ok) {
      console.error('Anthropic API error', aiResp.status, JSON.stringify(aiData));
      return res.json({ relevancy: '', reason: 'AI error: ' + (aiData.error?.message || ('HTTP ' + aiResp.status)) });
    }
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
