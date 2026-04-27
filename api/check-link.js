
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { linkIn, linkTo, anchor } = req.body || {};
  if (!linkIn || !linkTo) return res.status(400).json({ error: 'linkIn and linkTo required' });

  try {
    const response = await fetch(linkIn, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.json({ result: `❌ HTTP ${response.status}` });
    }

    const html = await response.text();
    const result = evaluateLinkCheck(html, linkTo, anchor || '');
    return res.json({ result });

  } catch (e) {
    const msg = e.name === 'TimeoutError' ? '⚠️ Timeout' : `⚠️ Error: ${e.message.slice(0, 60)}`;
    return res.json({ result: msg });
  }
}

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
  const hit = W.filter(w => G.includes(w)).length;
  return hit >= Math.max(1, Math.ceil(W.length * 0.6));
}

function evaluateLinkCheck(html, linkTo, anchor) {
  const lower = (html || '').toLowerCase();
  const targetNorm = normalizeUrl(linkTo);
  const targetParts = parseUrlPath(linkTo);
  const wantAnchor = (anchor || '').trim().toLowerCase();

  const aRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m, found = false, anchorOk = !wantAnchor, nofollow = false, sponsored = false, ugc = false;

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
    const inner = (m[2] || '').replace(/<[^>]*>/g, '').trim().toLowerCase();
    if (wantAnchor && inner) anchorOk = anchorMatch(wantAnchor, inner);
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
  if (!anchorOk) return '⚠️ Link found, anchor missing';

  const flags = [];
  if (nofollow) flags.push('nofollow');
  if (sponsored) flags.push('sponsored');
  if (ugc) flags.push('ugc');

  const robotsMatch = lower.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
  if (robotsMatch) {
    const r = robotsMatch[1];
    if (/\bnofollow\b/.test(r)) flags.push('page-nofollow');
    if (/\bnoindex\b/.test(r)) flags.push('noindex');
  }

  return flags.length ? `✅ Link found (${flags.join(', ')})` : '✅ Link found';
}
