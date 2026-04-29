module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const AHREFS_KEY = '7dNernlzY4mixkKwyIEOVsZK8e0Rx0Hgq3YszXti';

  // Normalize domain
  const cleanDomain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim();

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const drUrl = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(cleanDomain)}&date=${today}`;
    const metricsUrl = `https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(cleanDomain)}&date=${today}&mode=domain&select=org_traffic`;

    const headers = {
      'Authorization': `Bearer ${AHREFS_KEY}`,
      'Accept': 'application/json'
    };

    const [drResp, metricsResp] = await Promise.all([
      fetch(drUrl, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(metricsUrl, { headers, signal: AbortSignal.timeout(10000) })
    ]);

    let dr = null, traffic = null;
    let drRaw = null, metricsRaw = null;

    if (drResp.ok) {
      drRaw = await drResp.json();
      dr = drRaw?.domain_rating?.domain_rating ?? drRaw?.domain_rating ?? null;
    } else {
      drRaw = { status: drResp.status, text: await drResp.text() };
    }

    if (metricsResp.ok) {
      metricsRaw = await metricsResp.json();
      traffic = metricsRaw?.metrics?.org_traffic ?? metricsRaw?.org_traffic ?? null;
    } else {
      metricsRaw = { status: metricsResp.status, text: await metricsResp.text() };
    }

    return res.json({ domain: cleanDomain, dr, traffic, _debug: { drRaw, metricsRaw } });

  } catch (e) {
    return res.json({ error: e.message.slice(0, 100) });
  }
};
