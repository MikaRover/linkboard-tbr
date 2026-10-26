// Site tools behind /api/check-link (POST {action:...}) — the Vercel Hobby plan
// caps serverless functions and every slot is taken, so these share that one.
//
//   safety      Google Safe Browsing: is the site flagged for malware/phishing?
//   pagerank    Open PageRank (DomCop): free 0-10 authority score, up to 100 domains
//   screenshot  ApiFlash: screenshot of the Link-in page, scrolled to the backlink
//               and outlined, returned as a JPEG data URL (the app stores it)
//   dns         SPF / DMARC / MX / DKIM of a sending domain (Node dns, no API)
//
// safety/pagerank/screenshot spend paid API credits, so they need a signed-in
// LinkBoard user (Firebase ID token). Env: SAFE_BROWSING_KEY, OPR_API_KEY,
// APIFLASH_KEY, FIREBASE_SERVICE_ACCOUNT. A missing key only disables that tool.

const admin = require('firebase-admin');
const dns = require('dns').promises;
const { isSafeHost, cleanHost } = require('./security');
const { normUrl } = require('./linkcheck');

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

async function signedIn(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  try { await getAdmin().auth().verifyIdToken(m[1]); return true; } catch (e) { return false; }
}

function domainList(body) {
  const raw = Array.isArray(body.domains) ? body.domains : (body.domain ? [body.domain] : []);
  return [...new Set(raw.map(cleanHost).filter(isSafeHost))].slice(0, 100);
}

// Lookup API v4. Google asks commercial products to use Web Risk instead; at
// LinkBoard's volume (an internal tool, a few checks a day) v4 is what fits.
async function safety(body) {
  const key = process.env.SAFE_BROWSING_KEY;
  if (!key) return { status: 500, json: { error: 'SAFE_BROWSING_KEY not configured' } };
  const domains = domainList(body);
  if (!domains.length) return { status: 400, json: { error: 'domain(s) required' } };
  const r = await fetch('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client: { clientId: 'linkboard-tbr', clientVersion: '1.0' },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: domains.flatMap(d => [{ url: 'https://' + d + '/' }, { url: 'http://' + d + '/' }])
      }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) return { status: 502, json: { error: (json.error && json.error.message) || ('Safe Browsing HTTP ' + r.status) } };
  const threats = {};
  (json.matches || []).forEach(m => {
    const d = cleanHost(m.threat && m.threat.url);
    (threats[d] = threats[d] || new Set()).add(m.threatType);
  });
  const results = domains.map(d => ({ domain: d, safe: !threats[d], threats: threats[d] ? [...threats[d]] : [] }));
  return { status: 200, json: { results } };
}

async function pagerank(body) {
  const key = process.env.OPR_API_KEY;
  if (!key) return { status: 500, json: { error: 'OPR_API_KEY not configured' } };
  const domains = domainList(body);
  if (!domains.length) return { status: 400, json: { error: 'domain(s) required' } };
  const qs = domains.map(d => 'domains%5B%5D=' + encodeURIComponent(d)).join('&');
  const r = await fetch('https://openpagerank.com/api/v1.0/getPageRank?' + qs, { headers: { 'API-OPR': key }, signal: AbortSignal.timeout(15000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.status_code !== 200) return { status: 502, json: { error: json.error || ('Open PageRank HTTP ' + r.status) } };
  const results = (json.response || []).map(x => ({
    domain: x.domain,
    pagerank: x.status_code === 200 ? Number(x.page_rank_decimal) : null,
    rank: x.status_code === 200 && x.rank ? Number(x.rank) : null
  }));
  return { status: 200, json: { results } };
}

// The injected script finds the <a> pointing at the target (same needle as the
// link checker), scrolls it to the middle of the viewport and outlines it, so
// the shot shows the backlink itself rather than the top of the article.
async function screenshot(body) {
  const key = process.env.APIFLASH_KEY;
  if (!key) return { status: 500, json: { error: 'APIFLASH_KEY not configured' } };
  const { linkIn, linkTo } = body;
  if (!linkIn || !isSafeHost(linkIn)) return { status: 400, json: { error: 'Invalid Link in URL' } };
  const needle = normUrl(linkTo || '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
  const js = needle ? `(function(){var n=${JSON.stringify(needle)};var a=[].slice.call(document.querySelectorAll('a[href]')).find(function(x){return x.href.toLowerCase().indexOf(n)>-1;});if(a){a.scrollIntoView({block:'center'});a.style.outline='3px solid #ff3b30';a.style.outlineOffset='2px';}})();` : '';
  const params = new URLSearchParams({
    access_key: key, url: normUrl(linkIn), format: 'jpeg', quality: '62', width: '1280', height: '900',
    delay: '2', fresh: 'true', no_ads: 'true', no_cookie_banners: 'true', fail_on_status: '400-599'
  });
  if (js) params.set('js', js);
  const r = await fetch('https://api.apiflash.com/v1/urltoimage?' + params, { signal: AbortSignal.timeout(50000) });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { status: 502, json: { error: 'ApiFlash HTTP ' + r.status + (t ? ': ' + t.slice(0, 120) : '') } };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  // Stored in a Firestore doc (1 MiB cap, base64 adds a third) — refuse rather than fail the write.
  if (buf.length > 700000) return { status: 502, json: { error: 'Screenshot too large to store (' + Math.round(buf.length / 1024) + ' KB)' } };
  return { status: 200, json: { image: 'data:image/jpeg;base64,' + buf.toString('base64'), bytes: buf.length } };
}

async function txt(name) {
  try { return (await dns.resolveTxt(name)).map(parts => parts.join('')); } catch (e) { return []; }
}

const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'mail', 'dkim'];

async function dnsCheck(body) {
  const domain = cleanHost(body.domain);
  if (!isSafeHost(domain)) return { status: 400, json: { error: 'domain required' } };
  const [root, dmarcTxt, mx] = await Promise.all([
    txt(domain), txt('_dmarc.' + domain),
    dns.resolveMx(domain).catch(() => [])
  ]);
  const spf = root.filter(t => /^v=spf1/i.test(t));
  const dmarc = dmarcTxt.find(t => /^v=dmarc1/i.test(t)) || '';
  const dmarcPolicy = (/;\s*p=(\w+)/i.exec(dmarc) || [])[1] || '';
  const dkimHits = (await Promise.all(DKIM_SELECTORS.map(async s => ((await txt(s + '._domainkey.' + domain)).some(t => /p=/i.test(t)) ? s : null)))).filter(Boolean);

  const checks = [
    { name: 'MX', ok: mx.length > 0, detail: mx.length ? mx.sort((a, b) => a.priority - b.priority).map(m => m.exchange).slice(0, 3).join(', ') : 'No MX records' },
    { name: 'SPF', ok: spf.length === 1, detail: spf.length === 1 ? spf[0] : (spf.length ? 'More than one SPF record — receivers treat this as an error' : 'No SPF record') },
    { name: 'DKIM', ok: dkimHits.length > 0, detail: dkimHits.length ? 'Selector: ' + dkimHits.join(', ') : 'Not found on common selectors (google, selector1…) — may still exist under a custom one' },
    { name: 'DMARC', ok: !!dmarc && dmarcPolicy.toLowerCase() !== 'none', warn: !!dmarc && dmarcPolicy.toLowerCase() === 'none', detail: dmarc ? 'p=' + (dmarcPolicy || '?') + (dmarcPolicy.toLowerCase() === 'none' ? ' — monitoring only, consider quarantine' : '') : 'No DMARC record' }
  ];
  return { status: 200, json: { domain, checks } };
}

const TOOLS = { safety, pagerank, screenshot, dns: dnsCheck };
const NEEDS_AUTH = new Set(['safety', 'pagerank', 'screenshot']);

async function handleSiteTool(req, res, action) {
  const tool = TOOLS[action];
  if (!tool) return res.status(400).json({ error: 'Unknown action' });
  if (NEEDS_AUTH.has(action) && !(await signedIn(req))) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const out = await tool(req.body || {});
    return res.status(out.status).json(out.json);
  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(504).json({ error: action + ' timed out' });
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { handleSiteTool };
