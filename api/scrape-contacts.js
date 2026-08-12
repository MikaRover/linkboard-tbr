// Free email scraping (no paid API) — hits common contact/about pages on the
// target site and regex-extracts emails. Called by the "Free scrape" outreach
// flow (renderFreeResults / bulk free-scrape in app.html).

const { isSafeHost, cleanHost, browserHeaders } = require('./_lib/security');

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const SKIP = ['example', 'domain', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', 'sentry', 'wixpress', 'noreply', 'no-reply', 'donotreply', 'wpcf7', 'schema'];
const PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/write-for-us', '/advertise'];

async function scrapePage(url) {
  try {
    const r = await fetch(url, {
      headers: browserHeaders(),
      signal: AbortSignal.timeout(5000),
      redirect: 'follow'
    });
    if (!r.ok) return [];
    const html = await r.text();
    return (html.match(EMAIL_RE) || [])
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 5 && e.length < 100)
      .filter(e => !SKIP.some(s => e.includes(s)));
  } catch (e) { return []; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const host = cleanHost(domain);
  const found = new Set();

  const results = await Promise.all(PATHS.map(path => scrapePage(`https://${host}${path}`)));
  results.forEach(emails => emails.forEach(e => found.add(e)));

  const emails = [...found].slice(0, 5).map(email => ({ email, smtp: 'unknown' }));
  return res.json({ domain: host, emails, guessedEmails: [] });
};
