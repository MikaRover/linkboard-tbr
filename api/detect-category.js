
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
    '/product', '/platform', '/solutions', '/integrations', '/login', '/signup', '/demo'];

  let combinedText = '';
  let fetchedUrls = [];

  // Fetch multiple pages
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
      const title = extractTitle(html);
      const meta = extractMeta(html);
      const text = stripHtml(html).slice(0, 2500);
      fetchedUrls.push(base + path);
      combinedText += `\nURL: ${base+path}\nTITLE: ${title}\nMETA: ${meta}\nTEXT: ${text}\n---\n`;
      if (combinedText.length > 20000) break;
    } catch(e) { /* skip failed pages */ }
  }

  if (!combinedText.trim()) {
    return res.json({ category: 'Other', method: 'fallback', confidence: 0 });
  }

  // Heuristic classification
  const heuristic = heuristicClassify(combinedText);

  // If no OpenAI key, return heuristic result
  if (!openaiKey) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }

  // GPT classification
  try {
    const prompt = `Classify this website into exactly one category: SaaS, Service, Blog/Magazine, News, Agency, or Other.

SaaS = software product/platform people use online, with pricing, signup, login, dashboard, API, integrations, free trial, demo.
Service = agency, consultancy, done-for-you business, outsourcing, professional services.
Blog/Magazine = publisher, editorial, news site, content-first website, online magazine.
News = news outlet, media company.
Agency = marketing/design/dev agency.
Other = anything else.

Rules:
- If the site has pricing, login, signup, demo, dashboard, integrations, API → strongly prefer SaaS.
- Only classify as Service if core business is selling services, not software.
- Only classify as Blog/Magazine if primarily a publisher.

Heuristic pre-analysis:
Suggested: ${heuristic.suggestedCategory}
SaaS score: ${heuristic.saasScore} | Service score: ${heuristic.serviceScore} | Blog score: ${heuristic.blogScore}

Return ONLY valid JSON: {"category":"SaaS","confidence":95}

Domain: ${normalizedDomain}
Fetched URLs: ${fetchedUrls.slice(0,5).join(', ')}
Website data:
${combinedText.slice(0, 4000)}`;

    const gptResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a website classifier. Return only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 30,
        temperature: 0
      }),
      signal: AbortSignal.timeout(10000)
    });

    const gptData = await gptResp.json();
    const raw = (gptData.choices[0].message.content || '').trim();
    const obj = JSON.parse(raw);
    const CATS = ['SaaS','Service','Blog/Magazine','News','Agency','Other'];
    const cat = CATS.find(c => c.toLowerCase() === (obj.category||'').toLowerCase()) || heuristic.suggestedCategory;
    return res.json({ category: cat, method: 'gpt', confidence: obj.confidence || null });
  } catch(e) {
    return res.json({ category: heuristic.suggestedCategory, method: 'heuristic', confidence: null });
  }
};

function heuristicClassify(text) {
  const t = text.toLowerCase();
  const saasKw = ['free trial','start free','sign up','signup','log in','login','book demo',
    'request demo','get started','pricing','pricing plans','product','platform','software',
    'tool','dashboard','workspace','integrations','integration','api','extension',
    'automation','saas','app','subscription'];
  const serviceKw = ['agency','consulting','consultancy','our services','done for you',
    'done-for-you','managed services','hire us','outsourcing','professional services','service provider'];
  const blogKw = ['latest news','editorial','magazine','newsroom','journal','articles',
    'article archive','stories','press release','press','news','blog post'];

  let ss = countHits(t, saasKw);
  let sv = countHits(t, serviceKw);
  let bl = countHits(t, blogKw);

  if (t.includes('/pricing')) ss += 3;
  if (t.includes('/login')) ss += 3;
  if (t.includes('/signup')) ss += 3;
  if (t.includes('/integrations')) ss += 2;
  if (t.includes('/demo')) ss += 2;
  if (t.includes('our services')) sv += 3;
  if (t.includes('managed services')) sv += 3;
  if (t.includes('/blog')) bl += 2;
  if (t.includes('newsroom')) bl += 2;

  const strongSaas = ['free trial','book demo','sign up','login','integrations','api','dashboard'];
  if (countHits(t, strongSaas) >= 3) return { suggestedCategory: 'SaaS', saasScore: ss, serviceScore: sv, blogScore: bl };

  if (ss >= sv && ss >= bl) return { suggestedCategory: 'SaaS', saasScore: ss, serviceScore: sv, blogScore: bl };
  if (sv >= ss && sv >= bl) return { suggestedCategory: 'Service', saasScore: ss, serviceScore: sv, blogScore: bl };
  return { suggestedCategory: 'Blog/Magazine', saasScore: ss, serviceScore: sv, blogScore: bl };
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
