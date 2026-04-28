module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { linkIn, linkTo, anchor } = req.body || {};
  if (!linkIn || !linkTo) return res.status(400).json({ error: 'linkIn and linkTo required' });

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  ];

  let html = null;

  for (const ua of USER_AGENTS) {
    try {
      const response = await fetch(linkIn, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });

      if (response.ok) {
        html = await response.text();
        break;
      }
      if (response.status === 403) continue;
      return res.json({ result: `❌ HTTP ${response.status}` });

    } catch (e) {
      if (e.name === 'TimeoutError') return res.json({ result: '⚠️ Timeout — site took too long' });
      return res.json({ result: `⚠️ Error: ${e.message.slice(0, 60)}` });
    }
  }

  if (!html) return res.json({ result: '⚠️ HTTP 403 — site blocks crawlers' });

  return res.json({ result: evaluateLinkCheck(html, linkTo, anchor || '') });
};

function normalizeUrl(u) {
  return String(u || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function parseUrlPath(u) {
  try {
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const url = new URL(u);
    return { host: url.hostname.replace(/^www\./i, ''), path: (url.pathname || '/').replace(/\/+$/, '') || '/' };
  } catch { return { host: '', path: '' }; }
}

function anchorMatch(want, got) {
  if (!want) return true;
  const split = s => s.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  const W = split(want), G = split(got);
  return W.filter(w => G.includes(w)).length >= Math.max(1, Math.ceil(W.length * 0.6));
}

function evaluateLinkCheck(html, linkTo, anchor) {
  const lower = (html || '').toLowerCase();
  const targetNorm = normalizeUrl(linkTo);
  const targetParts = parseUrlPath(linkTo);
  const wantAnchor = (anchor || '').trim().toLowerCase();
  const hasAnchorReq = wantAnchor.length > 0;

  // Page-level meta robots
  const pageFlags = [];
  const robotsMatch = lower.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  if (robotsMatch) {
    const r = robotsMatch[1];
    if (/\bnoindex\b/.test(r)) pageFlags.push('noindex');
    if (/\bnofollow\b/.test(r)) pageFlags.push('page-nofollow');
  }

  // Find the link
  const aRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m, found = false, anchorOk = !hasAnchorReq, foundAnchorText = '';
  let nofollow = false, sponsored = false, ugc = false;

  while ((m = aRe.exec(lower))) {
    const rawHref = (m[1] || '').trim();
    const hrefNorm = normalizeUrl(rawHref);
    let match = false;

    if (hrefNorm && hrefNorm.indexOf(targetNorm) !== -1) match = true;
    else if (rawHref.startsWith('/')) {
      const hrefPath = rawHref.replace(/\/+$/, '') || '/';
      if (hrefPath === targetParts.path || targetParts.path.endsWith(hrefPath)) match = true;
    }
    if (!match) continue;

    found = true;
    foundAnchorText = (m[2] || '').replace(/<[^>]*>/g, '').trim();
    if (hasAnchorReq) anchorOk = anchorMatch(wantAnchor, foundAnchorText.toLowerCase());

    const relMatch = /rel\s*=\s*["']([^"']+)["']/.exec(m[0]);
    if (relMatch) {
      const rel = relMatch[1];
      if (/\bnofollow\b/.test(rel)) nofollow = true;
      if (/\bsponsored\b/.test(rel)) sponsored = true;
      if (/\bugc\b/.test(rel)) ugc = true;
    }
    break;
  }

  if (!found) return '❌ Link not found';

  const linkFlags = [];
  if (nofollow) linkFlags.push('nofollow');
  if (sponsored) linkFlags.push('sponsored');
  if (ugc) linkFlags.push('ugc');
  const allFlags = [...linkFlags, ...pageFlags];
  const flagStr = allFlags.length ? ' · ' + allFlags.join(', ') : '';

  if (hasAnchorReq && !anchorOk) {
    const actual = foundAnchorText ? ` (found: "${foundAnchorText.slice(0, 40)}")` : '';
    return `⚠️ Anchor missing${actual}${flagStr}`;
  }

  return allFlags.length ? `✅ Link found${flagStr}` : '✅ Link found';
}
