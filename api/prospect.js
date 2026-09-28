const { isSafeHost, browserHeaders } = require('./_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors, siteData, hint } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}`;

  const fetchHtml = async (url, timeout = 7000) => {
    try {
      const r = await fetch(url, {
        headers: browserHeaders(),
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      if (!r.ok) return null;
      return await r.text();
    } catch(e) { return null; }
  };

  const htmlToText = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // STEP 1: Find article links.
  // Was a sequential loop over 11 candidate index pages (up to 11×7s=77s in
  // the worst case) — comfortably longer than this function's own 60s Vercel
  // limit, so a site whose blog lived at, say, the 8th URL tried would get
  // silently killed by the platform with no response at all. Checking every
  // candidate at once bounds this step by the single slowest request
  // (~5s) instead of their sum.
  const indexUrls = [
    `${baseUrl}/blog`, `${baseUrl}/guides`, `${baseUrl}/articles`,
    `${baseUrl}/resources`, `${baseUrl}/learn`, `${baseUrl}/news`,
    `${baseUrl}/insights`, `${baseUrl}/tutorials`, `${baseUrl}/library`,
    `${baseUrl}/posts`, `${baseUrl}`
  ];

  const extractArticleLinks = (html) => {
    const found = new Set();
    const linkRe = /href="([^"#?][^"]*)"/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      if (href.startsWith('/')) href = baseUrl + href;
      if (!href.startsWith('http')) continue;
      if (!href.includes(domain.replace(/^www\./, ''))) continue;

      const path = href.replace(/^https?:\/\/[^\/]+/, '');
      const segments = path.split('/').filter(Boolean);
      if (segments.length < 2) continue;
      if (/\.(css|js|png|jpg|svg|pdf|zip|xml|gif|webp)$/i.test(href)) continue;

      // Must be article-like path
      const hasArticlePath = /\/(blog|article|articles|post|posts|news|resources|learn|guides|guide|insights|knowledge|tutorials|tutorial|library|content)\//i.test(path);
      if (!hasArticlePath) continue;

      // Skip pagination, tags, categories
      if (/\/(tag|category|author|page\/\d+|wp-|feed|cart|checkout|login|signup|search)\//i.test(path)) continue;

      // Slug must look like an article (has hyphens)
      const lastSeg = segments[segments.length - 1];
      if (!lastSeg.includes('-') && lastSeg.length < 8) continue;

      found.add(href);
      if (found.size >= 30) break;
    }
    return found;
  };

  const indexResults = await Promise.all(indexUrls.map(async (url) => {
    const html = await fetchHtml(url, 5000);
    return { url, links: html ? extractArticleLinks(html) : new Set() };
  }));

  // Preserve the original priority order (dedicated /blog etc. over the
  // homepage) — first one that found a healthy batch wins.
  let blogLinks = [];
  for (const r of indexResults) {
    if (r.links.size >= 5) { blogLinks = [...r.links]; break; }
  }
  // Nothing hit the 5-link bar — still use whichever page found the most,
  // rather than failing outright on a site with a thin blog.
  if (!blogLinks.length) {
    const best = indexResults.reduce((a, b) => (b.links.size > a.links.size ? b : a), { links: new Set() });
    blogLinks = [...best.links];
  }

  if (!blogLinks.length) {
    return res.json({ domain, suggestions: [], error: 'No blog articles found on this website.' });
  }

  // STEP 2: Score articles by content relevance — fetch & read them, plus
  // the actual target page itself (in parallel with everything else).
  const anchorList = (anchors && anchors.length) ? anchors.slice(0, 10) : [];
  const anchorStr = anchorList.join(', ') || 'relevant topics';

  const targetPagePromise = linkTo ? (async () => {
    const html = await fetchHtml(linkTo);
    if (!html) return null;
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const text = htmlToText(html);
    return {
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '',
      description: descMatch ? descMatch[1].trim() : '',
      h1: h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '',
      excerpt: text.slice(0, 1200)
    };
  })() : Promise.resolve(null);

  // Build TWO keyword tiers instead of one flat word bag: multi-word phrases
  // from the client's own coreTopics/keywords are what actually signal real
  // topical overlap ("customer data platform" as a unit) — splitting them
  // into individual words ("customer", "data", "platform") let any article
  // that merely mentioned "data" once outscore one that's a genuine fit,
  // which is why past results skewed toward superficial matches.
  const phraseSet = new Set();
  const wordSet = new Set();
  const addPhrase = (p) => { const t = p.toLowerCase().trim(); if (t.length > 3) { phraseSet.add(t); t.split(/\s+/).filter(w => w.length > 3).forEach(w => wordSet.add(w)); } };
  anchorList.forEach(addPhrase);
  if (siteData?.coreTopics) siteData.coreTopics.forEach(addPhrase);
  if (siteData?.keywords) siteData.keywords.forEach(addPhrase);
  // A free-text hint ("find listicle articles about marketing tools") is an
  // instruction, not a phrase to match verbatim — pull out its meaningful
  // words (past a small instructional-word list) so an article genuinely
  // about that topic is more likely to even reach the candidate pool Claude
  // sees, instead of relying on Claude to notice it in whatever 8 articles
  // the keyword scorer happened to already rank highest.
  if (hint && hint.trim()) {
    const STOP = new Set(['find','look','looking','search','searching','article','articles','post','posts','about','that','this','with','from','where','which','talk','talks','talking','prefer','preferably','like','want','need','please','into','over','only','more','less','best','good','some','such','have','been','will']);
    hint.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !STOP.has(w)).forEach(w => wordSet.add(w));
  }
  const phrases = [...phraseSet], words = [...wordSet];
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Fetch all articles and score by actual content
  const scoredArticles = [];
  await Promise.all(blogLinks.slice(0, 25).map(async (url) => {
    const html = await fetchHtml(url);
    if (!html) return;

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().replace(/\s*[\|\-–]\s*.+$/, '') : '';

    // Extract h1/h2 headings for topic signals
    const headings = [];
    const hRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
    let hm;
    while ((hm = hRe.exec(html)) !== null) {
      headings.push(hm[1].replace(/<[^>]+>/g, '').trim());
    }

    const text = htmlToText(html);

    // Score: phrase matches count for far more than individual-word matches
    const searchable = `${title} ${headings.join(' ')} ${text}`.toLowerCase();
    let score = 0;
    phrases.forEach(p => { score += ((searchable.match(new RegExp(escRe(p), 'gi')) || []).length) * 6; });
    words.forEach(w => { score += (searchable.match(new RegExp(escRe(w), 'gi')) || []).length; });

    // Bonus for title/heading match — a phrase actually in the title is a
    // much stronger relevance signal than one buried somewhere in the body.
    phrases.forEach(p => { if (title.toLowerCase().includes(p)) score += 15; else if (headings.some(h => h.toLowerCase().includes(p))) score += 8; });

    // Extract clean paragraphs (sentences 40-300 chars)
    const sentences = text.match(/[A-Z][^.!?]{40,300}[.!?]/g) || [];
    const content = sentences.slice(0, 30).join(' ');

    if (content.length > 200) {
      scoredArticles.push({ url, title, headings: headings.slice(0, 5), content, score });
    }
  }));

  const targetPage = await targetPagePromise;

  if (!scoredArticles.length) {
    return res.json({ domain, suggestions: [], error: 'Could not read article content.' });
  }

  // Pick top 8 by score — was top 5, which on a thin or loosely-matching
  // blog meant Claude only ever saw a handful of mediocre keyword-frequency
  // "winners" with nothing better to compare against. More raw material
  // gives it an actual choice, without the prompt getting unmanageably long.
  scoredArticles.sort((a, b) => b.score - a.score);
  const topArticles = scoredArticles.slice(0, 8);

  // STEP 3: Claude deep analysis
  const projectCtx = siteData ? `
CLIENT CONTEXT (what we're linking TO):
- Product: ${siteData.niche || project}
- Type: ${siteData.productType || ''}
- Audience: ${siteData.targetAudience || ''}
- Core topics: ${(siteData.coreTopics || []).join(', ')}
- Keywords: ${(siteData.keywords || []).join(', ')}
- Why link here: ${siteData.linkingContext || ''}
` : `Client: ${project || 'unknown'}`;

  // The site-wide niche is often too broad to match against — a page-level
  // summary of the *actual* URL being linked lets Claude judge fit against
  // what that specific page is about, not just "the company in general".
  const targetPageCtx = targetPage ? `
TARGET PAGE ITSELF (${linkTo}):
- Title: ${targetPage.title}
- H1: ${targetPage.h1}
- Meta description: ${targetPage.description}
- Page excerpt: ${targetPage.excerpt.slice(0, 600)}
` : '';

  const articlesText = topArticles.map((a, i) => `
ARTICLE ${i+1}:
URL: ${a.url}
Title: ${a.title}
Headings: ${a.headings.join(' | ')}
Content:
${a.content.slice(0, 2500)}
`).join('\n---\n');

  // Free-text steer from whoever's running the search — e.g. "find listicle
  // articles about marketing tools" or "prefer older evergreen posts, not
  // news". A human reading the donor articles can act on this kind of
  // instruction directly; the keyword scorer above can't, so it only
  // reaches Claude, not the candidate-selection step.
  const hintCtx = hint && hint.trim() ? `
TEAM GUIDANCE FOR THIS SEARCH (follow this — it's a deliberate instruction from the person running the search):
${hint.trim()}
` : '';

  const prompt = `You are a senior SEO link builder. Your job is to find places in EXISTING blog articles where a link can be naturally inserted.

${projectCtx}${targetPageCtx}${hintCtx}
Target URL: ${linkTo || 'not specified'}
Anchors to place: ${anchorStr}

DONOR ARTICLES TO ANALYZE:
${articlesText}

YOUR TASK:
1. Read each article carefully
2. Find sentences where the anchor fits NATURALLY based on topic overlap with what the TARGET PAGE ITSELF is about (not just the client's product in general — a specific feature page needs a specific match, not a generic one)${hintCtx ? '\n2b. Apply the TEAM GUIDANCE above when deciding which articles/placements to prefer' : ''}
3. Either edit an existing sentence to include the anchor, or suggest adding a new sentence
4. The reader should NOT notice it's a paid link — it must add genuine value
5. Only suggest placements scoring 70+ on the relevancy scale below — a technically-possible but generic or forced fit is worse than no suggestion at all
6. If nothing on this site clears that bar for a given anchor — skip it, don't force it. Returning fewer (even zero) suggestions is the correct answer when the fit isn't genuinely there.

For each suggestion return:
- The EXACT existing sentence you're modifying (copy it word for word from the content)
- Your edited version with the anchor naturally embedded
- Where exactly in the article it goes
- A relevancy score 0-100 (how natural the placement is — score honestly; do not inflate a mediocre fit to clear the bar)

Return ONLY valid JSON array:
[
  {
    "articleUrl": "url",
    "articleTitle": "title",
    "anchor": "anchor text",
    "type": "edit",
    "originalSentence": "exact original sentence from the article",
    "editedSentence": "modified sentence with anchor naturally embedded",
    "placement": "specific location, e.g. 'Under the H2 heading X, second paragraph'",
    "reason": "why this is topically relevant and natural, specifically to the target page's own content",
    "relevancy": 85
  }
]

Up to 6 suggestions, all scoring 70+. An empty array is a valid, honest answer.`;

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
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(45000)
    });

    const aiData = await aiResp.json();
    // A failed call (bad key, no credit balance, rate limit, etc.) has no
    // `content` block at all and used to fall straight through to an empty
    // "suggestions: []" with no error — indistinguishable from Claude
    // genuinely finding no natural placement. Surface it as a real failure
    // instead. Checked as "no text block present", not "text is falsy" — a
    // legitimately empty string is still a real (if useless) response, not
    // an API failure, and must not be misreported as one.
    const textBlock = Array.isArray(aiData.content) && aiData.content.find(b => typeof b?.text === 'string');
    if (!aiResp.ok || !textBlock) {
      return res.json({ domain, suggestions: [], error: aiData?.error?.message || `Claude API error (HTTP ${aiResp.status})` });
    }
    const text = textBlock.text.trim();

    let suggestions = [];
    try {
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      suggestions = JSON.parse(clean);
    } catch(e) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) { try { suggestions = JSON.parse(match[0]); } catch(e2) {} }
    }

    // Safety net — the prompt asks Claude to self-filter at 70+, but a
    // model doesn't always hold a numeric bar perfectly; drop anything that
    // slipped through under it rather than trust the instruction alone.
    const filtered = suggestions.filter(s => (s.relevancy == null || s.relevancy >= 70));
    return res.json({ domain, suggestions: filtered.slice(0, 6) });
  } catch(e) {
    return res.json({ error: e.message, suggestions: [] });
  }
};
