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

// ─── Bulk AI relevancy ────────────────────────────────────────
// A separate checker for the "bulk link from / link to / anchor" tool —
// Mika + Tatev only. This used to be a pure keyword-overlap score with no
// Anthropic dependency, but a side-by-side comparison against how Mika
// actually reviews placements by hand in Claude — reading the real article,
// checking whether the link is actually live, judging Low/Medium/High/Very
// High by how the piece is written, flagging link-farm/paid-insertion
// patterns — showed the deterministic version was missing exactly the
// judgment calls that matter (e.g. a great, dedicated mention scored "Weak"
// just because the rest of a 35-item listicle was about other tools). So:
// this now does the actual fact-finding itself in plain JS (fetch both
// pages, locate the real link, count other outbound links as a spam
// signal) — all free — and hands that pre-digested context to Claude to
// make the one call a script genuinely can't: is this a natural, relevant
// placement, and how would a careful reviewer rate it.
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
    body,
    // Kept only for the donor side, to locate the actual outbound link's
    // surrounding paragraph (see findLinkContext) — capped well above any
    // real page size we'd realistically fetch, just as a memory backstop.
    rawHtml: html.slice(0, 500000)
  };
}

// A backlink almost never sits on a page that is ITSELF about the target's
// exact topic — it's usually one mention inside a broader article (a "best
// tools" listicle, a how-to post that name-drops a resource). Comparing the
// donor's WHOLE-page vocabulary to the target's therefore misses the plot:
// 34 unrelated items in a listicle drown out the one paragraph that
// actually matters. So: find the real <a> tag pointing at the target URL
// (or, failing that, the literal anchor text) on the donor page, and pull
// the text immediately around it — that's what a human reviewer would
// actually read to judge the placement.
function findLinkContext(rawHtml, targetUrl, anchorText) {
  if (!rawHtml || !targetUrl) return null;
  const norm = (u) => (u || '').trim()
    .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    .replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const targetNorm = norm(targetUrl);
  if (!targetNorm) return null;

  let matchIndex = -1;
  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = aRe.exec(rawHtml)) !== null) {
    const href = norm(m[1]);
    if (!href) continue;
    if (href === targetNorm || href.startsWith(targetNorm + '/') || targetNorm.startsWith(href + '/')) {
      matchIndex = m.index;
      break;
    }
  }
  if (matchIndex === -1 && anchorText && anchorText.trim().length >= 3) {
    const pos = rawHtml.toLowerCase().indexOf(anchorText.trim().toLowerCase());
    if (pos !== -1) matchIndex = pos;
  }
  if (matchIndex === -1) return null;

  const WINDOW = 900;
  const start = Math.max(0, matchIndex - WINDOW);
  const end = Math.min(rawHtml.length, matchIndex + WINDOW);
  const text = htmlToText(rawHtml.slice(start, end));
  return text && text.length > 20 ? text : null;
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

// A cheap, deterministic proxy for "does this page look like a link-farm /
// paid-insertion piece" — Claude's judgment is better at reading the prose,
// but handing it a hard count of how many other third-party domains this
// page links out to (the signal that kept showing up in manual reviews —
// "dozens of unrelated inserted links") grounds that judgment in a fact
// instead of an impression.
function countExternalLinks(rawHtml, donorUrl) {
  if (!rawHtml) return 0;
  const donorHost = (donorUrl || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  const seen = new Set();
  const aRe = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  let m;
  while ((m = aRe.exec(rawHtml)) !== null) {
    let host;
    try { host = new URL(m[1]).hostname.replace(/^www\./i, '').toLowerCase(); } catch (e) { continue; }
    if (host && host !== donorHost) seen.add(host);
  }
  return seen.size;
}

function summarizeTargetPage(page) {
  const topKw = topKeywords(weightedTF(page), 12);
  return { title: page.title, description: page.description, topKeywords: topKw };
}

// One Claude call judges a whole batch of rows at once (each row's context
// already pre-built in plain JS) — keeps this within Vercel's time limit
// for a bulk run instead of one round-trip per row.
async function callClaudeForBatch(ANTHROPIC_KEY, blocks) {
  const prompt = `You are a meticulous SEO reviewer assessing backlink placements — exactly the way an experienced link-building lead reviews a report by hand: read the actual surrounding content, decide if it's a natural and relevant placement, and flag anything that looks like a paid/spammy link-insertion pattern.

Guidance:
- A link buried in one sentence of an otherwise-unrelated article can still be a fine placement IF that sentence is genuinely on-topic — don't penalize it just for being a small part of a bigger page.
- Pages that link out to many unrelated third-party domains show a link-farm / paid-insertion pattern — that should lower the rating even when the one sentence itself reads fine.
- If the target link was NOT found on the donor page, judge the HYPOTHETICAL relevancy from the page's actual content and say so in your notes.
- "Very High" = dedicated, substantive, on-topic section on a clean page. "High" = clearly on-topic paragraph, page reasonably clean. "Medium" = on-topic but diluted by other inserted links, or a plausible-but-secondary fit. "Low" = topic mismatch, throwaway one-liner, or heavy link-farm signals.

ITEMS TO REVIEW:
${blocks.map((b, i) => `[${i + 1}]\n${b}`).join('\n\n')}

Return ONLY a JSON array (no markdown), one object per item in the exact same order:
[{"relevancy":"Low"|"Medium"|"High"|"Very High","rating":1-10,"notes":"1-2 sentences specific to this item"}]`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1800, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(45000)
    });
    const aiData = await aiResp.json();
    // Same "presence of a text block" check as scan-project.js / prospect.js
    // use — a falsy check on the text string itself would wrongly treat a
    // real, successful-but-empty response as an API failure.
    const textBlock = Array.isArray(aiData.content) && aiData.content.find(b => typeof b?.text === 'string');
    if (!aiResp.ok || !textBlock) {
      const msg = aiData?.error?.message || `Claude API error (HTTP ${aiResp.status})`;
      return blocks.map(() => ({ error: msg }));
    }
    const clean = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let arr;
    try { arr = JSON.parse(clean); }
    catch (e) { const m = clean.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : null; }
    if (!Array.isArray(arr)) return blocks.map(() => ({ error: 'Could not parse Claude\'s response for this batch' }));

    return blocks.map((_, i) => {
      const o = arr[i];
      if (!o || !o.relevancy) return { error: 'Missing a result for this row' };
      const relevancy = ['Low', 'Medium', 'High', 'Very High'].includes(o.relevancy) ? o.relevancy : 'Medium';
      const rating = Math.max(1, Math.min(10, Math.round(Number(o.rating)) || 5));
      return { relevancy, rating, notes: String(o.notes || '').slice(0, 400) };
    });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Claude request timed out' : ('Error: ' + e.message.slice(0, 150));
    return blocks.map(() => ({ error: msg }));
  }
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

const BULK_AI_MAX_ROWS = 40; // lower than the old lexical cap — each row now costs a real Anthropic call
const BULK_AI_BATCH_SIZE = 8; // rows per Claude call; batches run in parallel so this bounds prompt size, not total rows

async function handleBulkAI(req, res) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, BULK_AI_MAX_ROWS) : [];
  if (!rows.length) return res.status(400).json({ error: 'rows required' });

  const pageCache = new Map(); // a URL reused across rows (common: same target page) is only fetched once
  const getPage = async (url) => {
    if (!url) return null;
    if (!isSafeHost(url)) return { __invalid: true };
    if (!pageCache.has(url)) pageCache.set(url, fetchPageForScoring(url));
    return pageCache.get(url);
  };

  // Fetch pages + build each row's context block in plain JS first — this
  // part is free and deterministic (locate the real link, count outbound
  // domains, summarize the target topic), so Claude only has to spend
  // tokens on the actual judgment call, not on re-deriving facts.
  const prepared = await Promise.all(rows.map(async (row) => {
    const linkFrom = (row.linkFrom || '').trim();
    const linkTo = (row.linkTo || '').trim();
    const anchor = (row.anchor || '').trim();
    if (!linkFrom || !linkTo) return { linkFrom, linkTo, anchor, error: 'Both link-from and link-to are required' };

    const [donorPage, targetPage] = await Promise.all([getPage(linkFrom), getPage(linkTo)]);
    if (donorPage?.__invalid || targetPage?.__invalid) return { linkFrom, linkTo, anchor, error: 'Invalid or disallowed URL' };
    if (!donorPage) return { linkFrom, linkTo, anchor, error: 'Could not fetch the link-from page' };
    if (!targetPage) return { linkFrom, linkTo, anchor, error: 'Could not fetch the link-to page' };

    const localText = findLinkContext(donorPage.rawHtml, linkTo, anchor);
    const linkFound = !!localText;
    const contextText = (localText || donorPage.body || '').slice(0, 1200);
    const externalLinkCount = countExternalLinks(donorPage.rawHtml, linkFrom);
    const targetSummary = summarizeTargetPage(targetPage);

    const block = [
      `DONOR ARTICLE: ${donorPage.title || linkFrom} (${linkFrom})`,
      `TARGET PAGE: ${targetSummary.title || linkTo} (${linkTo})${targetSummary.topKeywords.length ? ' — topics: ' + targetSummary.topKeywords.join(', ') : ''}${targetSummary.description ? '\nTARGET DESCRIPTION: ' + targetSummary.description : ''}`,
      `ANCHOR TEXT: "${anchor || '(none given)'}"`,
      `TARGET LINK FOUND ON DONOR PAGE: ${linkFound ? 'YES' : 'NO — judge hypothetically from the page\'s actual content below'}`,
      `OTHER THIRD-PARTY DOMAINS LINKED FROM THIS DONOR PAGE: ${externalLinkCount}`,
      `DONOR PAGE ${linkFound ? 'TEXT AROUND THE ACTUAL LINK' : 'CONTENT SAMPLE'}:\n"""\n${contextText || '(no readable text extracted)'}\n"""`
    ].join('\n');

    return { linkFrom, linkTo, anchor, linkFound, block };
  }));

  const toCheck = prepared.filter(p => !p.error);
  const batches = [];
  for (let i = 0; i < toCheck.length; i += BULK_AI_BATCH_SIZE) batches.push(toCheck.slice(i, i + BULK_AI_BATCH_SIZE));

  const batchResults = await Promise.all(batches.map(b => callClaudeForBatch(ANTHROPIC_KEY, b.map(x => x.block))));
  const verdictByRow = new Map();
  batches.forEach((batch, bi) => batch.forEach((row, ri) => verdictByRow.set(row, batchResults[bi][ri])));

  const results = prepared.map(p => {
    if (p.error) return { linkFrom: p.linkFrom, linkTo: p.linkTo, anchor: p.anchor, error: p.error };
    const v = verdictByRow.get(p) || { error: 'No result returned' };
    if (v.error) return { linkFrom: p.linkFrom, linkTo: p.linkTo, anchor: p.anchor, linkFound: p.linkFound, error: v.error };
    return { linkFrom: p.linkFrom, linkTo: p.linkTo, anchor: p.anchor, linkFound: p.linkFound, relevancy: v.relevancy, rating: v.rating, notes: v.notes };
  });

  return res.json({ results });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.body && req.body.mode === 'bulk-ai') return handleBulkAI(req, res);

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
