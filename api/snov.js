const SNOV_CLIENT_ID = '6b423e67c549ace7c01ed4914935d0c2';
const SNOV_CLIENT_SECRET = '8a864926f4ad1d63c1b8fee73b17f741';

const TARGET_ROLES = [
  // Tier 1 — most relevant
  "Link Builder","Link Building Specialist","Backlink Specialist","Link Acquisition",
  "Off-Page SEO","Off Page SEO","SEO Outreach","Outreach Specialist","Digital Outreach",
  // Tier 2 — SEO
  "SEO Specialist","SEO Manager","SEO Consultant","Senior SEO","Head of SEO","SEO Lead",
  "SEO Analyst","Technical SEO","SEO Director","VP of SEO","SEO Team Lead",
  // Tier 3 — PR/Content
  "Digital PR","PR Manager","PR Specialist","Content Marketing","Content Manager",
  "Growth Marketing","Growth Hacker","Partnerships Manager","Marketing Manager",
  // Tier 4 — broad
  "Marketing Specialist","Digital Marketing","Content Strategist","Brand Manager"
];

async function getToken() {
  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type:'client_credentials',
      client_id: SNOV_CLIENT_ID,
      client_secret: SNOV_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await res.json();
  return j.access_token;
}

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Run one batch of roles for a domain, return prospects[]
async function searchBatch(domain, roles, token) {
  const payload = new URLSearchParams({domain});
  roles.forEach((r,i) => payload.append(`positions[${i}]`, r));
  try {
    const startRes = await fetch('https://api.snov.io/v2/domain-search/prospects/start', {
      method:'POST',
      headers:{Authorization:'Bearer '+token, 'Content-Type':'application/x-www-form-urlencoded'},
      body: payload.toString(),
      signal: AbortSignal.timeout(8000)
    });
    const sj = await startRes.json();
    if (!sj?.links?.result) return [];
    await sleep(4000);
    const resultRes = await fetch(sj.links.result, {
      headers:{Authorization:'Bearer '+token},
      signal: AbortSignal.timeout(8000)
    });
    const rj = await resultRes.json();
    return rj?.data || [];
  } catch(e){ return []; }
}

// Resolve + verify email for one prospect
async function resolveEmail(domain, p, token) {
  if (!p.first_name || !p.last_name) return {...p, email:'', smtp:'unknown'};
  try {
    const startRes = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
      method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body: JSON.stringify({rows:[{first_name:p.first_name, last_name:p.last_name, domain}]}),
      signal: AbortSignal.timeout(7000)
    });
    const sj = await startRes.json();
    if (!sj?.data?.task_hash) return {...p, email:'', smtp:'unknown'};
    await sleep(5000);
    const rRes = await fetch(
      `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${sj.data.task_hash}`,
      {headers:{Authorization:'Bearer '+token}, signal:AbortSignal.timeout(7000)}
    );
    const rd = await rRes.json();
    const emailObj = rd?.data?.[0]?.result?.[0];
    return {...p, email: emailObj?.email||'', smtp: emailObj?.smtp_status||'unknown'};
  } catch(e){ return {...p, email:'', smtp:'unknown'}; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const {domain, action} = req.body||{};
  if (!domain) return res.status(400).json({error:'domain required'});

  const cleanDomain = domain.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*/,'').trim();

  try {
    const token = await getToken();
    if (!token) return res.status(500).json({error:'Snov.io auth failed'});

    // ── PROSPECTS (LinkedIn search)
    if (!action || action==='prospects') {
      const seen = new Map(); // key → prospect

      // Run ALL role batches sequentially (to avoid rate limit), 6 roles each
      const BATCH_SIZE = 6;
      for (let i=0; i<TARGET_ROLES.length; i+=BATCH_SIZE) {
        const batch = TARGET_ROLES.slice(i, i+BATCH_SIZE);
        const found = await searchBatch(cleanDomain, batch, token);
        for (const p of found) {
          const key = `${(p.first_name||'').toLowerCase()}_${(p.last_name||'').toLowerCase()}`;
          if (!seen.has(key)) seen.set(key, p);
        }
        await sleep(1000); // rate limit gap
      }

      // Score prospects
      const scoreProspect = (p) => {
        const pos = (p.position||'').toLowerCase();
        let s = 0;
        if (pos.includes('link build')||pos.includes('backlink')) s+=10;
        else if (pos.includes('outreach')) s+=9;
        else if (pos.includes('off-page')||pos.includes('off page')) s+=8;
        else if (pos.includes('seo')) s+=7;
        else if (pos.includes('digital pr')||pos.includes(' pr ')) s+=6;
        else if (pos.includes('content')) s+=4;
        else if (pos.includes('marketing')) s+=3;
        if (pos.includes('head ')||pos.includes('director')||pos.includes('vp ')) s+=3;
        if (pos.includes('senior')||pos.includes('lead')||pos.includes('manager')) s+=2;
        return s;
      };

      const sorted = [...seen.values()]
        .map(p=>({...p, _score:scoreProspect(p)}))
        .sort((a,b)=>b._score-a._score)
        .slice(0, 25);

      // Resolve emails for top 8 sequentially
      const withEmail = [];
      for (const p of sorted.slice(0,8)) {
        const resolved = await resolveEmail(cleanDomain, p, token);
        withEmail.push(resolved);
      }
      const rest = sorted.slice(8).map(p=>({...p,email:'',smtp:'unknown'}));
      const final = [...withEmail, ...rest];

      return res.json({
        domain: cleanDomain,
        prospects: final,
        total: final.length,
        withEmail: final.filter(p=>p.email&&p.smtp!=='invalid').length,
        verified: final.filter(p=>p.smtp==='valid').length
      });
    }

    // ── SCRAPE (website emails)
    if (action==='scrape') {
      const baseUrl = `https://${cleanDomain}`;
      const foundEmails = new Set();

      // 1. Snov domain search DB
      try {
        const r = await fetch(
          `https://api.snov.io/v2/domain-search?domain=${encodeURIComponent(cleanDomain)}&type=all&limit=15&lastId=0`,
          {headers:{Authorization:'Bearer '+token}, signal:AbortSignal.timeout(7000)}
        );
        const j = await r.json();
        (j?.emails||[]).forEach(e=>e?.email&&foundEmails.add(e.email.toLowerCase()));
      } catch(e){}

      // 2. Scrape pages
      const pages = [baseUrl, `${baseUrl}/contact`, `${baseUrl}/about`, `${baseUrl}/about-us`, `${baseUrl}/team`, `${baseUrl}/write-for-us`];
      for (const url of pages) {
        if (foundEmails.size>=8) break;
        try {
          const r = await fetch(url, {
            headers:{'User-Agent':'Mozilla/5.0'},
            signal:AbortSignal.timeout(5000), redirect:'follow'
          });
          if (!r.ok) continue;
          const html = await r.text();
          const emails = (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)||[])
            .filter(e=>!['png','jpg','svg','sentry','example','noreply','no-reply'].some(x=>e.toLowerCase().includes(x)));
          emails.forEach(e=>foundEmails.add(e.toLowerCase()));
        } catch(e){}
      }

      // 3. Verify all
      const results = [];
      for (const email of [...foundEmails].slice(0,10)) {
        try {
          const r = await fetch('https://api.snov.io/v1/get-emails-verification',{
            method:'POST',
            headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-www-form-urlencoded'},
            body: new URLSearchParams({'emails[]':email}),
            signal: AbortSignal.timeout(6000)
          });
          const j = await r.json();
          const status = j?.[0]?.smtp_status||j?.[0]?.status||'unknown';
          results.push({email, smtp:status});
        } catch(e){ results.push({email, smtp:'unknown'}); }
      }

      return res.json({domain:cleanDomain, emails:results});
    }

    return res.status(400).json({error:'Unknown action'});

  } catch(e) {
    return res.status(500).json({error:e.message});
  }
};
