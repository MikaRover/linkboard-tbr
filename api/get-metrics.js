module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const AHREFS_KEY = '7dNernlzY4mixkKwyIEOVsZK8e0Rx0Hgq3YszXti';

  const cleanDomain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim();

  const today = new Date().toISOString().slice(0, 10);

  const drUrl = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(cleanDomain)}&date=${today}`;
  const metricsUrl = `https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(cleanDomain)}&date=${today}&mode=domain&select=org_traffic`;

  const headers = {
    'Authorization': `Bearer ${AHREFS_KEY}`,
    'Accept': 'application/json'
  };

  try {
    const [drResp, metricsResp] = await Promise.all([
      fetch(drUrl, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(metricsUrl, { headers, signal: AbortSignal.timeout(10000) })
    ]);

    let dr = null, traffic = null;

    if (drResp.ok) {
      const d = await drResp.json();
      dr = d?.domain_rating?.domain_rating ?? null;
      if (dr !== null) dr = Math.round(dr);
    }

    if (metricsResp.ok) {
      const m = await metricsResp.json();
      traffic = m?.metrics?.org_traffic ?? m?.org_traffic ?? null;
      if (traffic !== null) traffic = Math.round(traffic);
    }

    return res.json({ domain: cleanDomain, dr, traffic });

  } catch (e) {
    return res.json({ error: e.message.slice(0, 100) });
  }
};
