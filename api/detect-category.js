module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, openaiKey } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

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
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CategoryBot/1.0)' },
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

  if (!openaiKey) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }

  try {
    const prompt = `You are an expert website classifier with 10+ years of experience in digital marketing and SEO.

Classify this website into exactly ONE category:

CATEGORIES:
- SaaS: Core business IS the software product. Users pay to use it. Must have: pricing/plans, user accounts/dashboard, the software IS the product. Examples: Ahrefs, HubSpot, Slack, Shopify, CyberPanel, cPanel, Notion, Figma.
- Service: Sells human-delivered services. Core business = people doing work for clients. Examples: marketing agency, SEO agency, consulting firm, outsourcing company, freelancer site.
- Blog/Magazine: Primary purpose is publishing content. Revenue = ads/sponsored content/affiliate. Examples: Moz Blog, Search Engine Journal, Backlinko, food blogs, travel blogs, TechCrunch (editorial).
- News: News outlet, breaking news, journalism. Examples: BBC, Reuters, TechCrunch (news), Forbes, Bloomberg.
- Agency: Specifically a creative/digital/marketing/development agency selling project-based work.
- Other: Ecommerce stores, forums, communities, non-profits, personal sites, government sites, anything that doesn't fit above.

DECISION RULES (in priority order):
1. Does the site have PRICING PLANS for SOFTWARE? → SaaS
2. Does the site have a LOGIN/DASHBOARD for a SOFTWARE PRODUCT? → SaaS  
3. Does the site primarily SELL SERVICES (not software)? → Service or Agency
4. Does the site primarily PUBLISH ARTICLES/CONTENT? → Blog/Magazine or News
5. Is it a NEWS outlet with reporters/journalists? → News
6. Everything else → Other

IMPORTANT:
- A blog section on a SaaS site does NOT make it Blog/Magazine
- "Sign up for newsletter" does NOT mean SaaS
- Hosting control panels, web servers, CMS platforms = SaaS
- If site primarily has articles/posts with authors/dates = Blog/Magazine

Domain: ${normalizedDomain}
Fetched pages: ${fetchedUrls.join(', ')}

Website content:
${combinedText.slice(0, 8000)}

Think step by step, then return ONLY valid JSON: {"category":"SaaS","confidence":95}
No explanation, no markdown, just JSON.`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': openaiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(10000)
    });

    const claudeData = await claudeResp.json();
    const raw = (claudeData.content?.[0]?.text || '').trim();
    const obj = JSON.parse(raw.replace(/```json|```/g,'').trim());
    const CATS = ['SaaS','Service','Blog/Magazine','News','Agency','Other'];
    const cat = CATS.find(c => c.toLowerCase() === (obj.category||'').toLowerCase()) || heuristic.suggestedCategory;
    return res.json({ category: cat, method: 'claude', confidence: obj.confidence || null });
  } catch(e) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }
};

function heuristicClassify(text, domain, homepageHtml) {
  const t = text.toLowerCase();
  const d = domain.toLowerCase();

  // Strong domain-level signals
  const newsDomains = ['news','times','post','herald','tribune','journal','daily','gazette','reporter','press','wire','media'];
  const blogDomains = ['blog','magazine','mag','digest','review','guide','tips','tricks','advice','food','recipe','travel','health','fitness','beauty','fashion','lifestyle','finance','money','invest'];

  const isDomainNews = newsDomains.some(kw => d.includes(kw));
  const isDomainBlog = blogDomains.some(kw => d.includes(kw));

  // SaaS signals — only strong ones
  const strongSaasKw = [
    'free trial', 'start your free trial', 'book a demo', 'request a demo',
    'pricing plans', 'monthly plan', 'annual plan', 'per month', 'per year',
    'dashboard', 'api documentation', 'integrations', 'our platform',
    'saas', 'software as a service', 'cloud software', 'enterprise plan',
    'upgrade plan', 'cancel anytime', 'no credit card required'
  ];
  const weakSaasKw = ['sign up', 'log in', 'login', 'signup', 'get started', 'app', 'software', 'tool', 'platform', 'product'];

  // Blog/Magazine signals
  const blogKw = [
    'latest articles', 'read more', 'published by', 'written by', 'author',
    'editorial', 'magazine', 'subscribe to newsletter', 'latest posts',
    'trending articles', 'popular posts', 'category:', 'tags:', 'by staff',
    'news & updates', 'blog post', 'guest post', 'sponsored content',
    'advertise with us', 'write for us', 'submit article'
  ];

  // News signals
  const newsKw = [
    'breaking news', 'latest news', 'newsroom', 'press release',
    'journalism', 'reporter', 'editor', 'correspondent', 'wire service',
    'news agency', 'media company', 'broadcast', 'coverage'
  ];

  // Service signals
  const serviceKw = [
    'our services', 'hire us', 'work with us', 'get a quote', 'request a quote',
    'consulting', 'consultancy', 'agency', 'outsourcing', 'done for you',
    'managed services', 'professional services', 'we help businesses'
  ];

  let saasScore = countHits(t, strongSaasKw) * 3 + countHits(t, weakSaasKw);
  let blogScore = countHits(t, blogKw) * 2;
  let newsScore = countHits(t, newsKw) * 2;
  let serviceScore = countHits(t, serviceKw) * 2;

  // Domain bonuses
  if (isDomainNews) newsScore += 5;
  if (isDomainBlog) blogScore += 5;

  // URL structure bonuses
  if (t.includes('/pricing')) saasScore += 4;
  if (t.includes('/integrations')) saasScore += 3;
  if (t.includes('/dashboard')) saasScore += 3;
  if (t.includes('/api')) saasScore += 2;
  if (t.includes('/blog')) blogScore += 2;
  if (t.includes('/news')) newsScore += 2;
  if (t.includes('/articles')) blogScore += 2;
  if (t.includes('/category/')) blogScore += 3;
  if (t.includes('/tag/')) blogScore += 2;
  if (t.includes('/author/')) blogScore += 2;

  // Strong SaaS only if clearly a software product
  const strongSaasHits = countHits(t, strongSaasKw);
  if (strongSaasHits >= 3 && saasScore > blogScore * 2 && saasScore > newsScore * 2) {
    return { suggestedCategory: 'SaaS', saasScore, blogScore, newsScore, serviceScore };
  }

  if (newsScore >= blogScore && newsScore >= saasScore && newsScore >= serviceScore) {
    return { suggestedCategory: 'News', saasScore, blogScore, newsScore, serviceScore };
  }
  if (blogScore >= saasScore && blogScore >= newsScore && blogScore >= serviceScore) {
    return { suggestedCategory: 'Blog/Magazine', saasScore, blogScore, newsScore, serviceScore };
  }
  if (serviceScore >= saasScore && serviceScore >= blogScore && serviceScore >= newsScore) {
    return { suggestedCategory: 'Service', saasScore, blogScore, newsScore, serviceScore };
  }
  if (saasScore >= 6) {
    return { suggestedCategory: 'SaaS', saasScore, blogScore, newsScore, serviceScore };
  }

  return { suggestedCategory: 'Other', saasScore, blogScore, newsScore, serviceScore };
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
