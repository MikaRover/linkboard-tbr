// Simple in-memory cache (persists for serverless function lifetime)
const cache = {};
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 500;

function cachePrune() {
  const keys = Object.keys(cache);
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  keys
    .map(k => [k, cache[k].ts])
    .sort((a, b) => a[1] - b[1])
    .slice(0, keys.length - CACHE_MAX_ENTRIES)
    .forEach(([k]) => delete cache[k]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain || typeof domain !== 'string') return res.status(400).json({ error: 'domain required' });

  const cleanDomain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim()
    .toLowerCase();

  // Check cache first
  const cached = cache[cleanDomain];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const AHREFS_KEY = process.env.AHREFS_API_KEY;
  if (!AHREFS_KEY) return res.status(500).json({ error: 'Ahrefs API key not configured' });
  const today = new Date().toISOString().slice(0, 10);
  const headers = {
    'Authorization': `Bearer ${AHREFS_KEY}`,
    'Accept': 'application/json'
  };

  const drUrl = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(cleanDomain)}&date=${today}`;
  // Use subdomains mode — matches Ahrefs dashboard default and returns traffic for more domains
  const metricsUrl = `https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(cleanDomain)}&date=${today}&mode=subdomains&select=org_traffic,org_keywords,paid_traffic`;

  try {
    // Helper to fetch metrics with retry
    const fetchWithRetry = async (url, opts, retries=2, delay=2000) => {
      for(let i=0; i<=retries; i++){
        try{
          const resp = await fetch(url, opts);
          if(resp.ok) return resp;
          if(i < retries) await new Promise(r=>setTimeout(r, delay));
        } catch(e){
          if(i < retries) await new Promise(r=>setTimeout(r, delay));
          else throw e;
        }
      }
      return null;
    };

    const [drResp, metricsResp] = await Promise.all([
      fetchWithRetry(drUrl, { headers, signal: AbortSignal.timeout(10000) }),
      fetchWithRetry(metricsUrl, { headers, signal: AbortSignal.timeout(10000) })
    ]);

    let dr = null, traffic = null;

    if (drResp && drResp.ok) {
      const d = await drResp.json();
      dr = d?.domain_rating?.domain_rating ?? null;
      if (dr !== null) dr = Math.round(dr);
    }

    if (metricsResp && metricsResp.ok) {
      const m = await metricsResp.json();
      const metrics = m?.metrics || m || {};
      const raw = metrics.org_traffic ?? metrics.paid_traffic ?? metrics.org_keywords ?? null;
      traffic = (raw !== null && raw > 0) ? Math.round(raw) : null;
    } else if (metricsResp) {
      const errText = await metricsResp.text().catch(() => '');
      console.log('Metrics error:', metricsResp.status, errText.slice(0, 200));
    }

    const result = { domain: cleanDomain, dr, traffic, usTrafficPct: null, topCountries: [] };

    // Only cache if we got valid data
    if (dr !== null || traffic !== null) {
      cache[cleanDomain] = { ts: Date.now(), data: result };
      cachePrune();
    }

    return res.json(result);
  } catch (e) {
    // Return cached data if available (even if expired) on error
    if (cached) {
      return res.json({ ...cached.data, stale: true });
    }
    return res.json({ domain: cleanDomain, dr: null, traffic: null, error: e.message.slice(0, 100) });
  }
};
