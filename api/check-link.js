module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)'
      },
      redirect: 'follow'
    });

    clearTimeout(timeout);

    return res.json({
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      finalUrl: response.url
    });

  } catch (e) {
    if (e.name === 'AbortError') {
      return res.json({ status: 0, ok: false, statusText: 'Timeout', error: 'Request timed out' });
    }
    return res.json({ status: 0, ok: false, statusText: 'Error', error: e.message });
  }
};
