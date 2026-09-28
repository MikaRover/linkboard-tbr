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

// No corpus to compute real IDF against, so this is deliberately simple and
// explainable rather than a black box: how much of the TARGET page's own
// top topics are echoed near the actual link on the DONOR page (falling
// back to the donor's whole-page vocabulary when the exact link can't be
// located), plus whether the anchor text itself matches either page's
// subject matter.
function scorePair(donorPage, targetPage, anchor, linkToUrl) {
  const donorTF = weightedTF(donorPage);
  const targetTF = weightedTF(targetPage);
  const targetTop = topKeywords(targetTF, 20);
  const donorTop = topKeywords(donorTF, 30);
  const donorTopSet = new Set(donorTop);
  const wholePageShared = targetTop.filter(w => donorTopSet.has(w));
  const wholePageRatio = targetTop.length ? wholePageShared.length / Math.min(20, targetTop.length) : 0;

  const localText = findLinkContext(donorPage.rawHtml, linkToUrl, anchor);
  let overlapRatio = wholePageRatio;
  let shared = wholePageShared;
  let contextFound = false;

  if (localText) {
    contextFound = true;
    const localTokens = new Set(tokenize(localText).filter(w => !STOPWORDS.has(w)));
    const localShared = targetTop.filter(w => localTokens.has(w));
    const localRatio = targetTop.length ? localShared.length / Math.min(20, targetTop.length) : 0;
    // Trust the real surrounding paragraph far more than the donor's overall
    // page topic (a single on-topic mention inside an otherwise-unrelated
    // article is a completely normal, legitimate placement) — but keep a
    // little whole-page signal so a context match on a wildly off-topic
    // page doesn't score identically to a full-topic match.
    overlapRatio = localRatio * 0.8 + wholePageRatio * 0.2;
    shared = localShared.length ? localShared : wholePageShared;
  }

  const anchorWords = tokenize(anchor).filter(w => !STOPWORDS.has(w));
  const anchorMatchesTarget = anchorWords.length ? anchorWords.some(w => targetTF.has(w)) : null;
  const anchorMatchesDonor = anchorWords.length ? anchorWords.some(w => donorTF.has(w)) : null;

  let rate = Math.round(overlapRatio * 100);
  // Actually finding the real link/anchor on the page (instead of guessing
  // from overall page vocabulary) is itself a meaningful confidence signal.
  if (contextFound) rate += 12;
  if (anchorWords.length) {
    if (anchorMatchesTarget) rate += 10; else rate -= 15;
    if (anchorMatchesDonor) rate += 5;
  }
  rate = Math.max(0, Math.min(100, rate));

  // Recalibrated down from the original 70/40 split — once real overlap is
  // measured against the actual link context rather than a whole page, a
  // genuinely good placement still rarely lights up every one of the
  // target's top-20 keywords, so scores naturally cluster lower than a
  // "dedicated article on the exact same topic" would score.
  const tier = rate >= 65 ? 'Strong' : rate >= 35 ? 'Moderate' : 'Weak';
  const kwList = shared.slice(0, 5).join(', ');
  const contextNote = contextFound
    ? ''
    : ' (Could not find the exact link or anchor text on the fetched page — this is a rougher estimate based on the page\'s overall topic, so worth a manual look.)';
  let suggestion;
  if (!targetTop.length || !donorTop.length) {
    suggestion = 'Could not extract enough text from one of the pages to judge topic overlap.';
  } else if (tier === 'Strong') {
    suggestion = `Strong topical overlap (${kwList || 'shared vocabulary'}) — reads as a natural, relevant placement.${contextNote}`;
  } else if (tier === 'Moderate') {
    suggestion = (shared.length
      ? `Some overlap (${kwList}), but not strong — worth a manual look before using this anchor here.`
      : `Little shared vocabulary detected between the two pages — worth a manual look.`) + contextNote;
  } else {
    suggestion = `Little to no topical overlap detected — this donor page doesn't appear to discuss what the target page is about.${contextNote}`;
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
    return { linkFrom, linkTo, anchor, ...scorePair(donorPage, targetPage, anchor, linkTo) };
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
