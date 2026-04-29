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

  const target = 'https://' + cleanDomain;

  try {
    // Ahrefs v3 API — domain-overview
    const url = `https://api.ahrefs.com/v3/site-explorer/overview?target=${encodeURIComponent(target)}&mode=domain&date_to=today&date_from=today`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AHREFS_KEY}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const err = await response.text();
      return res.json({ error: `Ahrefs API error: ${response.status}`, detail: err.slice(0, 200) });
    }

    const data = await response.json();
    const overview = data?.domain_overview || data?.overview || data;

    const dr = overview?.domain_rating ?? overview?.dr ?? null;
    const traffic = overview?.org_traffic ?? overview?.traffic ?? overview?.organic_traffic ?? null;

    return res.json({
      domain: cleanDomain,
      dr: dr !== null ? Math.round(dr) : null,
      traffic: traffic !== null ? Math.round(traffic) : null
    });

  } catch (e) {
    return res.json({ error: e.message.slice(0, 100) });
  }
};
