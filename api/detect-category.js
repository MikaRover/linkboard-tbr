const { isSafeHost, browserHeaders } = require('./_lib/security');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
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

  let combinedText = '';
  let fetchedUrls = [];
  let homepageHtml = '';

  for (const path of paths) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(base + path, {
        headers: browserHeaders(),
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const html = (await response.text()).slice(0, 40000);
      if (path === '') homepageHtml = html;
      const title = extractTitle(html);
      const meta = extractMeta(html);
      const text = stripHtml(html).slice(0, 2500);
      fetchedUrls.push(base + path);
      combinedText += `\nURL: ${base+path}\nTITLE: ${title}\nMETA: ${meta}\nTEXT: ${text}\n---\n`;
      if (combinedText.length > 30000) break;
    } catch(e) {}
  }

  if (!combinedText.trim()) {
    return res.json({ category: 'Other', method: 'fallback', confidence: 0 });
  }

  const heuristic = heuristicClassify(combinedText, normalizedDomain, homepageHtml);

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
${combinedText.slice(0, 8000)}

Think step by step through the decision rules above, then return ONLY valid JSON: {"category":"SaaS","confidence":95}
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
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(10000)
    });

    const claudeData = await claudeResp.json();
    const raw = (claudeData.content?.[0]?.text || '').trim();
    const obj = JSON.parse(raw.replace(/```json|```/g,'').trim());
    const CATS = ['SaaS','Service','Magazine','General','Other'];
    const cat = CATS.find(c => c.toLowerCase() === (obj.category||'').toLowerCase()) || heuristic.suggestedCategory;
    return res.json({ category: cat, method: 'claude', confidence: obj.confidence || null });
  } catch(e) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }
};

function heuristicClassify(text, domain, homepageHtml) {
  const t = text.toLowerCase();
  const d = domain.toLowerCase();

  // Strong domain-level signals (News + Blog merged into Magazine)
  const magazineDomains = ['news','times','post','herald','tribune','journal','daily','gazette','reporter','press','wire','media','blog','magazine','mag','digest','review','guide','tips','tricks','advice','food','recipe','travel','health','fitness','beauty','fashion','lifestyle','finance','money','invest'];
  const isDomainMagazine = magazineDomains.some(kw => d.includes(kw));

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

  // URL structure bonuses
  if (t.includes('/pricing')) saasScore += 4;
  if (t.includes('/integrations')) saasScore += 3;
  if (t.includes('/dashboard')) saasScore += 3;
  if (t.includes('/api')) saasScore += 2;
  if (t.includes('/blog')) magazineScore += 2;
  if (t.includes('/news')) magazineScore += 2;
  if (t.includes('/articles')) magazineScore += 2;
  if (t.includes('/category/')) magazineScore += 3;
  if (t.includes('/tag/')) magazineScore += 2;
  if (t.includes('/author/')) magazineScore += 2;

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

function countHits(text, kws) {
  return kws.filter(k => text.includes(k)).length;
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
