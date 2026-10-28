const { setCors, requireMember } = require('./_lib/auth');
const { isSafeHost, browserHeaders } = require('./_lib/security');

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await requireMember(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  const normalizedDomain = domain.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].trim();
  const base = 'https://' + normalizedDomain;

  const paths = ['', '/pricing', '/about', '/services', '/blog', '/features',
    '/product', '/platform', '/solutions', '/integrations', '/login', '/signup', '/demo',
    '/news', '/articles', '/category', '/plans', '/enterprise', '/contact'];

  // Fetch all candidate pages in parallel — sequentially, 19 paths × 4s
  // could blow the function's time budget before Claude was even asked.
  const pages = await Promise.all(paths.map(async (path) => {
    try {
      const response = await fetch(base + path, {
        headers: browserHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return null;
      const html = (await response.text()).slice(0, 40000);
      return { path, url: base + path, html, title: extractTitle(html), meta: extractMeta(html), text: stripHtml(html).slice(0, 2500) };
    } catch(e) { return null; }
  }));

  // Many sites answer every path with the homepage (SPAs, soft 404s). Those
  // copies used to count as "has /pricing", "has /blog" etc. and pushed real
  // pages out of the prompt — keep only pages with their own content.
  const seen = new Set();
  const realPages = pages.filter(p => {
    if (!p || !p.text) return false;
    const key = p.title + '|' + p.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const fetchedUrls = realPages.map(p => p.url);
  // Homepage gets more room than sub-pages — it says the most about what the site is
  const combinedText = realPages.map((p, i) =>
    `\nURL: ${p.url}\nTITLE: ${p.title}\nMETA: ${p.meta}\nTEXT: ${p.text.slice(0, i === 0 ? 2500 : 1000)}\n---\n`
  ).join('').slice(0, 14000);
  const pageText = realPages.map(p => `${p.title} ${p.meta} ${p.text}`).join(' ');

  if (!combinedText.trim()) {
    return res.json({ category: 'Other', method: 'fallback', confidence: 0 });
  }

  const heuristic = heuristicClassify(pageText, normalizedDomain, fetchedUrls.map(u => u.slice(base.length)));

  if (!anthropicKey) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }

  try {
    const prompt = `You are an expert website classifier with 10+ years of experience in digital marketing and SEO.

Classify this website into exactly ONE category. The categories are deliberately
ordered so each one only applies once the ones above it have been ruled out —
apply the decision rules below in order and stop at the first match.

CATEGORIES:
- SaaS: The core business IS the software product itself — visitors pay (or sign up) to USE the software. Requires BOTH: pricing/plans for the software, AND a login/dashboard/app the customer works inside. Examples: Ahrefs, HubSpot, Slack, Notion, Figma, cPanel, Shopify (as a platform for merchants).
- Service: The core business is HUMAN-DELIVERED work for clients — agencies, consultancies, freelancers, contractors, outsourcing firms, professional services (legal, accounting, design, marketing, dev shops). The thing being sold is people doing work, not software.
- Magazine: The core business is PUBLISHING content — blogs, online magazines, news outlets, editorial sites. Revenue is ads/sponsorships/affiliate, not selling software or services. Examples: TechCrunch, Backlinko, a food blog, a local news site, Forbes, Reuters.
- General: A real, functioning website that is clearly NONE of the above — e.g. an e-commerce store, a physical-product brand, a local business (restaurant, clinic, gym), a non-profit, a government/institutional site, a personal portfolio, a community/forum, a marketplace. Use this whenever the site is obviously real but doesn't fit SaaS/Service/Magazine.
- Other: Use ONLY when the site could NOT be meaningfully classified at all — a parked/for-sale domain, an empty or broken page, a login wall with no visible public content, or content genuinely too sparse/ambiguous to judge.

DECISION RULES (apply in order, stop at the first match):
1. Does the site sell access to SOFTWARE it built — pricing plans AND a dashboard/app the customer logs into? → SaaS
2. Is the core offering PEOPLE doing work for clients (agency, consulting, freelance, outsourced service)? → Service
3. Is the primary content PUBLISHED ARTICLES (blog, magazine, news, editorial)? → Magazine
4. Is the site clearly a real, functioning business or organization that is none of the above? → General
5. Only if the page is empty, parked, broken, paywalled with nothing visible, or truly unreadable → Other

COMMON MISTAKES TO AVOID — check these before finalizing:
- A blog section on an otherwise-SaaS site does NOT make it Magazine — classify by what the site SELLS, not every page it has.
- An e-commerce store selling physical goods is General, not SaaS, even if it has a customer account area — an account page is not a software product.
- An agency that showcases "our platform" or "our tool" is still Service if THEY use it to deliver client work, rather than selling it as a product to others — only call it SaaS if outside customers pay to use that tool directly.
- Do not default to Other just because classification feels hard — Other is reserved for pages with no real content to judge, not for sites that are simply hard to categorize (use General instead).
- "Sign up for our newsletter" alone does not indicate SaaS.

Domain: ${normalizedDomain}
Fetched pages: ${fetchedUrls.join(', ')}

Website content:
${combinedText}

Apply the decision rules above, then return ONLY valid JSON: {"category":"SaaS","confidence":95}
No explanation, no markdown, just JSON.`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 200,
        // Adaptive thinking would eat the whole token budget and leave no
        // answer block — every call then fell back to the keyword heuristic.
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(20000)
    });

    const claudeData = await claudeResp.json();
    const textBlock = Array.isArray(claudeData.content) && claudeData.content.find(b => typeof b?.text === 'string');
    if (!claudeResp.ok || !textBlock) throw new Error(claudeData?.error?.message || `Claude API error (HTTP ${claudeResp.status})`);
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : textBlock.text);
    const CATS = ['SaaS','Service','Magazine','General','Other'];
    const cat = CATS.find(c => c.toLowerCase() === (obj.category||'').toLowerCase()) || heuristic.suggestedCategory;
    return res.json({ category: cat, method: 'claude', confidence: obj.confidence || null });
  } catch(e) {
    console.error('detect-category: Claude failed for', normalizedDomain, e.message);
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }
};

function heuristicClassify(text, domain, realPaths) {
  const t = text.toLowerCase();
  const d = domain.toLowerCase();

  // Strong domain-level signals (News + Blog merged into Magazine)
  // Only unambiguous publishing words — 'mag', 'post', 'health', 'money' etc.
  // matched inside "image", "postman", "healthcare clinic", "moneygram".
  const magazineDomains = ['news','times','herald','tribune','journal','daily','gazette','blog','magazine','digest'];
  const isDomainMagazine = magazineDomains.some(kw => d.split('.')[0].includes(kw));

  // SaaS signals — only strong ones
  const strongSaasKw = [
    'free trial', 'start your free trial', 'book a demo', 'request a demo',
    'pricing plans', 'monthly plan', 'annual plan', 'per month', 'per year',
    'dashboard', 'api documentation', 'integrations', 'our platform',
    'saas', 'software as a service', 'cloud software', 'enterprise plan',
    'upgrade plan', 'cancel anytime', 'no credit card required'
  ];
  const weakSaasKw = ['sign up', 'log in', 'login', 'signup', 'get started', 'app', 'software', 'tool', 'platform', 'product'];

  // Magazine signals (Blog + News merged — the taxonomy no longer splits them)
  const magazineKw = [
    'latest articles', 'read more', 'published by', 'written by', 'author',
    'editorial', 'magazine', 'subscribe to newsletter', 'latest posts',
    'trending articles', 'popular posts', 'category:', 'tags:', 'by staff',
    'news & updates', 'blog post', 'guest post', 'sponsored content',
    'advertise with us', 'write for us', 'submit article',
    'breaking news', 'latest news', 'newsroom', 'press release',
    'journalism', 'reporter', 'editor', 'correspondent', 'wire service',
    'news agency', 'media company', 'broadcast', 'coverage'
  ];

  // Service signals (Agency folded in — the taxonomy no longer splits them)
  const serviceKw = [
    'our services', 'hire us', 'work with us', 'get a quote', 'request a quote',
    'consulting', 'consultancy', 'agency', 'outsourcing', 'done for you',
    'managed services', 'professional services', 'we help businesses'
  ];

  let saasScore = countHits(t, strongSaasKw) * 3 + countHits(t, weakSaasKw);
  let magazineScore = countHits(t, magazineKw) * 2;
  let serviceScore = countHits(t, serviceKw) * 2;

  // Domain bonus
  if (isDomainMagazine) magazineScore += 5;

  // URL structure bonuses — only for paths that returned their own page
  const has = p => realPaths.includes(p);
  if (has('/pricing') || has('/plans')) saasScore += 4;
  if (has('/integrations')) saasScore += 3;
  if (has('/services')) serviceScore += 2;
  if (has('/news') || has('/articles') || has('/category')) magazineScore += 2;

  // Strong SaaS only if clearly a software product
  const strongSaasHits = countHits(t, strongSaasKw);
  if (strongSaasHits >= 3 && saasScore > magazineScore * 2 && saasScore > serviceScore * 2) {
    return { suggestedCategory: 'SaaS', saasScore, magazineScore, serviceScore };
  }

  // A minimum score is required before committing to Magazine/Service —
  // weak, ambiguous signals fall through to General instead of a wrong
  // specific label ("General" and "Other" are no longer the same bucket:
  // General means "real site, just not one of the three specific types").
  if (magazineScore >= saasScore && magazineScore >= serviceScore && magazineScore >= 4) {
    return { suggestedCategory: 'Magazine', saasScore, magazineScore, serviceScore };
  }
  if (serviceScore >= saasScore && serviceScore >= magazineScore && serviceScore >= 4) {
    return { suggestedCategory: 'Service', saasScore, magazineScore, serviceScore };
  }
  if (saasScore >= 6) {
    return { suggestedCategory: 'SaaS', saasScore, magazineScore, serviceScore };
  }

  return { suggestedCategory: 'General', saasScore, magazineScore, serviceScore };
}

// Whole-word matching — plain substring matching counted 'app' in "happy",
// 'tool' in "stool", 'editor' in "creditor", etc.
function countHits(text, kws) {
  return kws.filter(k => new RegExp('(^|[^a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(text)).length;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g,' ').trim().slice(0,200) : '';
}

function extractMeta(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i);
  return m ? m[1].replace(/\s+/g,' ').trim().slice(0,300) : '';
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}
