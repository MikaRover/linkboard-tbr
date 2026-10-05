const { isSafeHost, browserHeaders } = require('./_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, project, linkTo, anchors, siteData, hint, debug } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const bareDomain = cleaned.split('/')[0].toLowerCase();
  const baseUrl = `https://${bareDomain}`;
  // Someone may paste a specific blog section (forms.app/en/blog) — keep it as an extra index page.
  const pastedPath = cleaned.includes('/') ? `${baseUrl}/${cleaned.split('/').slice(1).join('/').replace(/\/+$/, '')}` : '';

  const fetchHtml = async (url, timeout = 6000) => {
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

  // STEP 0: understand the TARGET first. Everything downstream (which articles to
  // read, what counts as a natural fit) is judged against this understanding
  // instead of just the anchor words — so for "ai video maker" the search is
  // driven by what the page actually is and which kinds of articles/readers
  // would link to it, not only by whether an article contains the literal words.
  // Runs in parallel with article discovery below, so it adds no wall-clock time.
  const callHaiku = async (prompt, maxTokens, timeout) => {
    if (!ANTHROPIC_KEY) return '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(timeout)
      });
      const j = await r.json();
      const tb = Array.isArray(j.content) && j.content.find(b => typeof b?.text === 'string');
      return (r.ok && tb) ? tb.text : '';
    } catch(e) { return ''; }
  };
  let profileRaw = '';
  const targetProfilePromise = (async () => {
    const tp = await targetPagePromise;
    if (!tp && !siteData && !anchorList.length) return null;
    const prompt = `You help an SEO link builder. First UNDERSTAND the page we want a backlink to, then say what kind of articles on OTHER websites would naturally link to it.

${tp ? `TARGET PAGE (${linkTo}):\nTitle: ${tp.title}\nH1: ${tp.h1}\nDescription: ${tp.description}\nExcerpt: ${tp.excerpt}\n` : `Target URL: ${linkTo || 'not given'}\n`}
${siteData ? `Client: ${siteData.niche || project || ''}. Audience: ${siteData.targetAudience || ''}. Core topics: ${(siteData.coreTopics || []).join(', ')}.\n` : (project ? `Client project: ${project}\n` : '')}Anchors we want to use: ${anchorStr}
${hint && hint.trim() ? `Team guidance: ${hint.trim()}\n` : ''}
Return ONLY JSON:
{
  "summary": "2 sentences: what this page is, who it is for, what problem it solves",
  "topics": ["5-8 short topic phrases that describe the page itself"],
  "searchPhrases": ["10-14 SHORT phrases (1-3 words) a relevant donor article's title or URL would likely contain — include the page's own topic AND adjacent subjects its readers care about (e.g. for an AI video maker: video marketing, social media content, product demos, explainer videos, content creation, repurposing content, small business marketing)"],
  "goodArticleTypes": ["3-5 kinds of articles where a link to this page would read as genuinely useful, e.g. 'tool roundups', 'how-to guides on creating video content'"]
}`;
    // one retry: a transient overload/timeout on this small call used to silently drop the whole
    // "understand the target first" step for that search (profile came back null once in testing)
    let txt = await callHaiku(prompt, 700, 8000);
    if (!txt) txt = await callHaiku(prompt, 700, 7000);
    profileRaw = txt || '(empty — call failed or timed out)';
    const m = txt && txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch(e) { return null; }
  })();

  // STEP 1: Find candidate article URLs.
  // Two sources, fetched all at once (bounded by the slowest request, not
  // their sum — an earlier sequential version could exceed this function's
  // own 60s limit):
  //   a) blog index pages / homepage links, and
  //   b) the site's XML sitemap — the reliable source for WordPress-style
  //      sites whose posts live at the root (site.com/some-long-slug/), which
  //      the old path-pattern-only discovery could never recognise. That's
  //      exactly the shape of most guest-post donor sites, and it made the
  //      tool answer "No blog articles found" for them.
  const indexUrls = [
    `${baseUrl}/blog`, `${baseUrl}/guides`, `${baseUrl}/articles`,
    `${baseUrl}/resources`, `${baseUrl}/learn`, `${baseUrl}/news`,
    `${baseUrl}/insights`, `${baseUrl}/tutorials`, `${baseUrl}/library`,
    `${baseUrl}/posts`, `${baseUrl}`
  ];
  if (pastedPath) indexUrls.unshift(pastedPath);

  const NON_ARTICLE_SEG = /^(tag|tags|category|categories|author|authors|page|wp-[a-z-]+|feed|cart|checkout|login|signup|search|privacy|privacy-policy|terms|terms-of-service|about|about-us|contact|contact-us|disclaimer|cookie-policy|advertise|advertising|write-for-us|guest-post|sitemap|shop|product|products|my-account)$/i;
  const isArticleUrl = (href, loose) => {
    let u; try { u = new URL(href); } catch(e) { return false; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== bareDomain && !host.endsWith('.' + bareDomain)) return false;
    if (/\.(css|js|png|jpg|jpeg|svg|pdf|zip|xml|gif|webp|ico|mp4|woff2?)$/i.test(u.pathname)) return false;
    const segments = u.pathname.split('/').filter(Boolean);
    if (!segments.length) return false;
    if (segments.some(sg => NON_ARTICLE_SEG.test(sg))) return false;
    if (/\/(page\/\d+|wp-|feed|cart|checkout|login|signup)\b/i.test(u.pathname)) return false;
    const last = segments[segments.length - 1];
    const words = last.split('-').filter(Boolean).length;
    // classic /blog/slug, /guides/slug ... (any hyphenated-ish slug)
    const hasArticlePath = segments.length >= 2 && /^(blog|blogs|article|articles|post|posts|news|resources|learn|guides|guide|insights|knowledge|tutorials|tutorial|library|content|stories|story|magazine)$/i.test(segments[segments.length - 2]) || /\/(blog|blogs|article|articles|post|posts|news|resources|learn|guides|guide|insights|knowledge|tutorials|tutorial|library|content)\//i.test(u.pathname);
    if (hasArticlePath && (last.includes('-') || last.length >= 8)) return true;
    // dated permalinks: /2025/05/slug/
    if (segments.length >= 3 && /^\d{4}$/.test(segments[0]) && /^\d{1,2}$/.test(segments[1]) && last.includes('-')) return true;
    // root-level / topic-level slugs (WordPress "post name" permalinks). Sitemap
    // URLs are posts by construction so a hyphenated slug is enough; links scraped
    // from a page need a longer, headline-like slug to avoid picking up nav pages.
    return loose ? (last.includes('-') && last.length >= 10) : (words >= 4 && last.length >= 20);
  };

  const extractArticleLinks = (html) => {
    const found = new Set();
    const linkRe = /href\s*=\s*["']([^"'#][^"']*)["']/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let abs; try { abs = new URL(m[1], baseUrl + '/').href; } catch(e) { continue; }
      abs = abs.split('#')[0].split('?')[0];
      if (!isArticleUrl(abs, false)) continue;
      found.add(abs);
      if (found.size >= 40) break;
    }
    return found;
  };

  const xmlLocs = (xml) => [...xml.matchAll(/<url>[\s\S]*?<\/url>|<sitemap>[\s\S]*?<\/sitemap>/gi)].map(blk => {
    const loc = (/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i.exec(blk[0]) || [])[1];
    const lm = (/<lastmod>\s*([^<\s]+)/i.exec(blk[0]) || [])[1] || '';
    return loc ? { loc, lastmod: lm } : null;
  }).filter(Boolean);
  const fetchXml = async (url, timeout = 5000) => {
    const t = await fetchHtml(url, timeout);
    return t && /<(urlset|sitemapindex)[\s>]/i.test(t.slice(0, 3000)) ? t : null;
  };

  const sitemapRoots = [`${baseUrl}/sitemap_index.xml`, `${baseUrl}/sitemap.xml`, `${baseUrl}/wp-sitemap.xml`];
  const [indexResults, robotsTxt, ...rootXmls] = await Promise.all([
    Promise.all(indexUrls.map(async (url) => {
      const html = await fetchHtml(url, 5000);
      return { url, links: html ? extractArticleLinks(html) : new Set() };
    })),
    fetchHtml(`${baseUrl}/robots.txt`, 4000),
    ...sitemapRoots.map(u => fetchXml(u))
  ]);

  // Sitemap URLs: follow a sitemap *index* down to its post/blog/news children (a few at once).
  let sitemapEntries = [];
  try {
    const roots = rootXmls.filter(Boolean);
    const extraRoots = ((robotsTxt || '').match(/^\s*Sitemap:\s*(\S+)/gim) || []).map(l => l.replace(/^\s*Sitemap:\s*/i, '').trim()).filter(u => !sitemapRoots.includes(u)).slice(0, 2);
    if (!roots.length && extraRoots.length) { const extra = await Promise.all(extraRoots.map(u => fetchXml(u))); roots.push(...extra.filter(Boolean)); }
    const childUrls = [];
    for (const xml of roots) {
      if (/<sitemapindex[\s>]/i.test(xml)) {
        const kids = xmlLocs(xml).map(e => e.loc);
        const wanted = kids.filter(k => /post|blog|article|news|stor|content/i.test(k) && !/page|categor|tag|author|product|attach|image|video|local|taxonom/i.test(k));
        // big sites split posts across dozens of sitemap files (blogbuz.co.uk: 58) — read them all (up to 80) in parallel; slug-ranking below picks the relevant ones
        childUrls.push(...(wanted.length ? wanted : kids.slice(0, 1)).slice(-80));
      } else {
        sitemapEntries.push(...xmlLocs(xml));
      }
    }
    if (childUrls.length) {
      // Waves of 20, newest sitemaps first, with a time budget. Firing ~60 at once
      // got throttled (median 4s, tail >5s, some refused) and then the host stopped
      // answering at all for a while; a few small waves is gentler and still covers
      // a big archive. The budget keeps this whole step inside the 60s function limit.
      const uniqKids = [...new Set(childUrls)].slice(0, 80).reverse();
      const t0 = Date.now();
      const kidXmls = [];
      for (let i = 0; i < uniqKids.length; i += 20) {
        if (i > 0 && Date.now() - t0 > 8000) break;
        kidXmls.push(...await Promise.all(uniqKids.slice(i, i + 20).map(u => fetchXml(u, 6000))));
      }
      kidXmls.filter(Boolean).forEach(x => sitemapEntries.push(...xmlLocs(x)));
    }
  } catch(e) { /* sitemap is a bonus source — never fail the whole search over it */ }

  const sitemapLinks = sitemapEntries
    .filter(e => isArticleUrl(e.loc.split('#')[0], true))
    .sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || '')) // newest first
    .map(e => e.loc.split('#')[0]);

  // Page-scraped candidates keep their old priority (dedicated /blog first); a
  // thin index page no longer ends the search — sitemap URLs are merged in.
  let scraped = [];
  for (const r of indexResults) { if (r.links.size >= 5) { scraped = [...r.links]; break; } }
  if (!scraped.length) {
    const best = indexResults.reduce((a, b) => (b.links.size > a.links.size ? b : a), { links: new Set() });
    scraped = [...best.links];
  }
  const blogLinks = [...new Set([...scraped, ...sitemapLinks])].slice(0, 30000);

  if (!blogLinks.length) {
    return res.json({ domain, suggestions: [], error: 'No blog articles found on this website.' });
  }

  // STEP 2: Score articles by content relevance — fetch & read them, plus
  // the actual target page itself (in parallel with everything else).
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
  // Everything we learned about the target in STEP 0 joins the keyword pool (phrases
  // count 6x in article scoring and rank slugs too).
  const profile = await targetProfilePromise;
  if (profile) {
    (profile.searchPhrases || []).forEach(x => typeof x === 'string' && addPhrase(x));
    (profile.topics || []).forEach(x => typeof x === 'string' && addPhrase(x));
  }
  // Project never scanned (no siteData)? The target page itself still says what we're linking to.
  try {
    const tpEarly = await targetPagePromise;
    // (skip the brand name itself — it never appears in OTHER sites' slugs and would just dilute the ranking)
    let brand = ''; try { brand = new URL(linkTo).hostname.replace(/^www\./, '').split('.')[0].toLowerCase(); } catch(e) {}
    if (tpEarly) `${tpEarly.title} ${tpEarly.h1}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && w !== brand && !['free','online','best','with','from','your','that','this'].includes(w)).forEach(w => wordSet.add(w));
  } catch(e) {}
  const phrases = [...phraseSet], words = [...wordSet];
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Fetch all articles and score by actual content
  const scoredArticles = [];
  // With a sitemap there can be hundreds of posts — fetching only the first 25
  // would score a tiny, arbitrary slice. Pre-rank every candidate by how well
  // its URL slug matches the client's topics/anchors/hint (free, no fetch), read
  // the best 25, and top up with the newest posts if few slugs match.
  // Cheap semantic pass: a small, fast model reads the slug list (no fetching) and
  // picks the articles most likely to have a natural spot for a link to this
  // target — topically ADJACENT counts. Pure keyword/slug matching can't do this:
  // for an "ai video maker" anchor on a QA-testing site, nothing contains "video",
  // yet a post about AI-generated content or marketing assets might still fit.
  const semanticPick = async (slugList, tp) => {
    if (!slugList.length) return [];
    const list = slugList.map((sl, n) => `${n}. ${sl}`).join('\n');
    const prompt = `We want to insert a link into an EXISTING article on ${domain}.
Target: ${linkTo || project || 'unknown'}${tp ? ` — "${tp.title}" / ${tp.h1} / ${tp.description}` : ''}
${profile ? `What the target page is: ${profile.summary || ''}\nArticle types where a link to it fits: ${(profile.goodArticleTypes || []).join('; ')}\n` : ''}Anchors to place: ${anchorStr}${hint && hint.trim() ? `\nTeam guidance: ${hint.trim()}` : ''}

Below are article URL slugs from that site. Pick up to 20 whose articles are MOST likely to contain a paragraph where a link like this could be placed naturally. Topically adjacent counts (the article doesn't have to be mainly about the target topic), but skip articles that are clearly unrelated.
Return ONLY a JSON array of the slug numbers, e.g. [3, 17, 42].

${list}`;
    const txt = await callHaiku(prompt, 200, 7000);
    const m = txt && txt.match(/\[[\s\d,]*\]/);
    try { return m ? JSON.parse(m[0]).filter(n => Number.isInteger(n) && n >= 0 && n < slugList.length) : []; } catch(e) { return []; }
  };

  let semanticCount = 0;
  const semanticUrls = new Set(); // articles the semantic pass picked — must not be dropped by the keyword top-N below
  const pickCandidates = async () => {
    if (blogLinks.length <= 25) return blogLinks;
    const slugOf = (u) => { try { return decodeURIComponent(u.split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase().replace(/-/g, ' '); } catch(e) { return ''; } };
    const slugs = blogLinks.map(slugOf);
    // Weight each term by how RARE it is across this site's slugs (IDF). Flat
    // weights let generic words win: for "laboratory management software" on a
    // 11k-post site, 15 unrelated "…management software" posts outscored the
    // single real "…laboratory-management" article because "laboratory" counted
    // the same as "management". Rare terms are the discriminating ones.
    const N = slugs.length;
    const idf = {};
    [...phrases, ...words].forEach(t => {
      let df = 0; for (const sl of slugs) if (sl.includes(t)) df++;
      idf[t] = Math.log((N + 1) / (df + 1));
    });
    const score = (sl) => {
      let sc = 0;
      phrases.forEach(ph => { if (sl.includes(ph)) sc += 3 * idf[ph]; });
      words.forEach(w => { if (sl.includes(w)) sc += idf[w]; });
      return sc;
    };
    const ranked = slugs.map((sl, i) => ({ i, sc: score(sl) }));
    const matchedAll = ranked.filter(r => r.sc > 0).sort((a, b) => b.sc - a.sc || a.i - b.i).map(r => r.i);
    const matchedSet = new Set(matchedAll);
    const rest = ranked.map(r => r.i).filter(i => !matchedSet.has(i)); // already newest-first

    // Semantic pass over up to 400 slugs (best keyword matches first, then newest).
    const poolIdx = [...matchedAll.slice(0, 150), ...rest].slice(0, 400);
    const picked = (await semanticPick(poolIdx.map(i => slugs[i]), await targetPagePromise)).map(n => poolIdx[n]);
    semanticCount = picked.length;
    picked.forEach(i => semanticUrls.add(blogLinks[i]));

    const chosen = [...new Set([...matchedAll.slice(0, 10), ...picked, ...matchedAll, ...rest])].slice(0, 25);
    return chosen.map(i => blogLinks[i]);
  };
  await Promise.all((await pickCandidates()).map(async (url) => {
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
  // Claude sees a MIX: the best keyword matches AND the best of what the semantic
  // pass picked. Taking only the keyword top-8 threw the semantic picks away — on
  // blog.loopcv.pro the one article about verification/spam ("How LoopCV Prevents
  // Spam Applications") was read but ranked ~19th by keyword score, so Claude
  // never got to judge it.
  const semanticRead = scoredArticles.filter(a => semanticUrls.has(a.url));
  const topArticles = [...new Map([...scoredArticles.slice(0, 5), ...semanticRead.slice(0, 7), ...scoredArticles.slice(5)].map(a => [a.url, a])).values()].slice(0, 11);

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
  const understandingCtx = profile ? `
WHAT WE UNDERSTAND ABOUT THE TARGET (judge every placement against this):
- Summary: ${profile.summary || ''}
- Topics: ${(profile.topics || []).join(', ')}
- Articles where a link to it fits: ${(profile.goodArticleTypes || []).join('; ')}
` : '';
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

${projectCtx}${targetPageCtx}${understandingCtx}${hintCtx}
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
      signal: AbortSignal.timeout(30000)
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
    // stats let the UI say WHY the list is empty ("read 25 of 3,200 articles, none cleared 70")
    // instead of one generic message for every kind of empty result.
    return res.json({ domain, suggestions: filtered.slice(0, 6), stats: { candidates: blogLinks.length, read: scoredArticles.length, considered: topArticles.length, suggestedBeforeFilter: suggestions.length, semanticPicked: semanticCount, ...(debug ? { profile, profileRaw: profileRaw.slice(0, 600), picked: scoredArticles.map(a => ({ url: a.url, title: a.title, score: a.score })), rawModelText: text.slice(0, 1500) } : {}) } });
  } catch(e) {
    return res.json({ error: e.message, suggestions: [] });
  }
};
