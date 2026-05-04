module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { linkIn, linkTo, anchor, url } = req.body || {};
  const targetUrl = linkIn || url;

  if (!targetUrl) return res.status(400).json({ error: 'linkIn or url required' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
      redirect: 'follow'
    });

    clearTimeout(timeout);

    const html = await response.text().catch(() => '');
    const status = response.status;

    let found = false;
    if (linkTo && html) {
      const cleanLinkTo = linkTo.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
      found = html.toLowerCase().includes(cleanLinkTo);
    }

    let anchorFound = false;
    if (anchor && html) {
      anchorFound = html.toLowerCase().includes(anchor.toLowerCase());
    }

    let result;
    if (!response.ok) {
      result = `❌ HTTP ${status}`;
    } else if (linkTo && !found) {
      result = `⚠️ Link not found`;
    } else if (anchor && !anchorFound) {
      result = `⚠️ Anchor not found`;
    } else {
      result = `✅ Link found`;
    }

    return res.json({ result, status, ok: response.ok, found, anchorFound });

  } catch (e) {
    if (e.name === 'AbortError') {
      return res.json({ result: '⚠️ Timeout' });
    }
    return res.json({ result: '⚠️ Error: ' + e.message.slice(0, 50) });
  }
};
