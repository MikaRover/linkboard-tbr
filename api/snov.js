const SNOV_CLIENT_ID = '6b423e67c549ace7c01ed4914935d0c2';
const SNOV_CLIENT_SECRET = '8a864926f4ad1d63c1b8fee73b17f741';

const TARGET_ROLES = [
  "Link Builder","Link Building Specialist","Backlink Specialist","Link Acquisition Specialist",
  "Off-Page SEO Specialist","SEO Outreach Specialist","Outreach Specialist","Digital Outreach Specialist",
  "SEO Specialist","Senior SEO Specialist","Off-Page SEO Manager","SEO Manager","SEO Consultant",
  "PR Specialist","Digital PR Manager","Content Marketing Manager","Growth Marketing Manager",
  "Digital Marketing Manager","Head of SEO","SEO Team Lead","Content Manager","Marketing Manager"
];

async function getToken() {
  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SNOV_CLIENT_ID,
      client_secret: SNOV_CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await res.json();
  return j.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, action } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  try {
    const token = await getToken();
    if (!token) return res.status(500).json({ error: 'Auth failed' });

    // ── ACTION: find prospects (LinkedIn search)
    if (action === 'prospects' || !action) {
      const allProspects = [];
      const seen = new Set();

      // Run role batches in parallel (3 batches of ~7 roles)
      const batches = [];
      for (let i = 0; i < TARGET_ROLES.length; i += 8) {
        batches.push(TARGET_ROLES.slice(i, i + 8));
      }

      const batchResults = await Promise.allSettled(batches.map(async batch => {
        const payload = new URLSearchParams({ domain });
        batch.forEach((role, idx) => payload.append(`positions[${idx}]`, role));

        const startRes = await fetch('https://api.snov.io/v2/domain-search/prospects/start', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: payload.toString(),
          signal: AbortSignal.timeout(6000)
        });
        const startJson = await startRes.json();
        if (!startJson?.links?.result) return [];

        await new Promise(r => setTimeout(r, 3000));

        const resultRes = await fetch(startJson.links.result, {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(6000)
        });
        const data = await resultRes.json();
        return data?.data || [];
      }));

      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          for (const p of r.value) {
            const key = `${p.first_name}_${p.last_name}_${p.position}`;
            if (!seen.has(key)) { seen.add(key); allProspects.push(p); }
          }
        }
      }

      // Score & sort prospects by relevance
      const scored = allProspects.map(p => {
        const pos = (p.position || '').toLowerCase();
        let score = 0;
        if (pos.includes('link build') || pos.includes('backlink')) score += 10;
        else if (pos.includes('outreach')) score += 9;
        else if (pos.includes('off-page') || pos.includes('offpage')) score += 8;
        else if (pos.includes('seo')) score += 7;
        else if (pos.includes('pr')) score += 6;
        else if (pos.includes('content') || pos.includes('marketing')) score += 5;
        if (pos.includes('head') || pos.includes('manager') || pos.includes('director')) score += 2;
        if (pos.includes('senior') || pos.includes('lead')) score += 1;
        return { ...p, _score: score };
      }).sort((a, b) => b._score - a._score).slice(0, 20);

      // Resolve emails for top 10
      const withEmails = await Promise.allSettled(scored.slice(0, 10).map(async p => {
        if (!p.first_name || !p.last_name) return { ...p, email: '', smtp: 'unknown' };
        try {
          const startRes = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: [{ first_name: p.first_name, last_name: p.last_name, domain }] }),
            signal: AbortSignal.timeout(6000)
          });
          const sj = await startRes.json();
          if (!sj?.data?.task_hash) return { ...p, email: '', smtp: 'unknown' };

          await new Promise(r => setTimeout(r, 4000));

          const resultRes = await fetch(
            `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${sj.data.task_hash}`,
            { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }
          );
          const rd = await resultRes.json();
          const emailObj = rd?.data?.[0]?.result?.[0];
          return { ...p, email: emailObj?.email || '', smtp: emailObj?.smtp_status || 'unknown' };
        } catch (e) {
          return { ...p, email: '', smtp: 'unknown' };
        }
      }));

      const resolved = withEmails.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { ...scored[i], email: '', smtp: 'unknown' }
      );

      // Merge: resolved top10 + rest without email
      const final = [
        ...resolved,
        ...scored.slice(10).map(p => ({ ...p, email: '', smtp: 'unknown' }))
      ];

      return res.json({ domain, prospects: final, total: final.length });
    }

    // ── ACTION: deep scrape (website emails)
    if (action === 'scrape') {
      const baseUrl = `https://${domain}`;
      const foundEmails = new Set();

      // Snov domain search
      try {
        const r = await fetch(
          `https://api.snov.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=all&limit=10&lastId=0`,
          { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(6000) }
        );
        const j = await r.json();
        (j?.emails || []).forEach(e => e?.email && foundEmails.add(e.email.toLowerCase()));
      } catch (e) {}

      // Scrape homepage + contact/about
      const urlsToScrape = [baseUrl, `${baseUrl}/contact`, `${baseUrl}/about`, `${baseUrl}/write-for-us`];
      for (const url of urlsToScrape) {
        if (foundEmails.size >= 5) break;
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(4000), redirect: 'follow'
          });
          const html = await r.text();
          const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          matches
            .filter(e => !['png','jpg','svg','sentry','example'].some(x => e.includes(x)))
            .forEach(e => foundEmails.add(e.toLowerCase()));
        } catch (e) {}
      }

      // Verify each
      const verified = await Promise.allSettled([...foundEmails].slice(0, 8).map(async email => {
        try {
          const r = await fetch('https://api.snov.io/v1/get-emails-verification', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ 'emails[]': email }),
            signal: AbortSignal.timeout(6000)
          });
          const j = await r.json();
          const status = j?.[0]?.smtp_status || j?.[0]?.status || 'unknown';
          return { email, smtp: status };
        } catch (e) {
          return { email, smtp: 'unknown' };
        }
      }));

      return res.json({
        domain,
        emails: verified.map(r => r.status === 'fulfilled' ? r.value : { email: '', smtp: 'unknown' })
          .filter(e => e.email)
      });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
