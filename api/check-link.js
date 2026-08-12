// Smart backlink checker — fetches the page that should contain the backlink,
// looks for the target URL, and reports status. Uses realistic browser headers
// and retries to avoid false "403 / not found" on bot-protected sites.

const { isSafeHost } = require('./_lib/security');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function normUrl(u){
  return String(u||'').trim().replace(/\/+$/,'').replace(/^http:\/\//i,'https://');
}
function domainOf(u){
  return String(u||'').replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].toLowerCase().trim();
}

// Free fallback for bot-protected pages: r.jina.ai is a public reader
// service that fetches + renders the page on its own infrastructure (no
// API key, no cost) and returns cleaned text — often gets through basic
// bot-detection that blocks a plain fetch. Can't recover rel="nofollow"
// etc. since it strips tags, only whether the link is present at all.
async function fetchViaFreeBypass(url){
  try{
    const r = await fetch('https://r.jina.ai/'+url, { signal: AbortSignal.timeout(15000) });
    if(!r.ok) return null;
    const text = await r.text();
    return text && text.trim() ? text : null;
  }catch(e){ return null; }
}

async function fetchPage(url, attempt=0){
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none'
  };
  try {
    const res = await fetch(url, { headers, redirect:'follow', signal: AbortSignal.timeout(15000) });
    return res;
  } catch(e){
    if(attempt < 1){ await new Promise(r=>setTimeout(r,800)); return fetchPage(url, attempt+1); }
    throw e;
  }
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const { linkIn, linkTo, anchor } = req.body || {};
  if(!linkIn || !linkTo) return res.status(400).json({result:'⚠️ Missing linkIn/linkTo'});
  if(!isSafeHost(linkIn)) return res.status(400).json({result:'⚠️ Invalid or disallowed URL'});

  const pageUrl = normUrl(linkIn);
  const targetDomain = domainOf(linkTo);
  const targetPath = normUrl(linkTo).replace(/^https?:\/\/(www\.)?/i,'');

  let response;
  try {
    response = await fetchPage(pageUrl);
  } catch(e){
    return res.json({ result: '⚠️ Unreachable', ok:false, detail:e.message.slice(0,60) });
  }

  const status = response.status;

  // Bot-protected — try the free reader-proxy fallback before giving up
  if(status === 403 || status === 406 || status === 429){
    const bypassText = await fetchViaFreeBypass(pageUrl);
    if(bypassText){
      const bLower = bypassText.toLowerCase();
      const bFound = bLower.includes(targetPath.toLowerCase()) || (targetPath.length<=targetDomain.length+1 && bLower.includes(targetDomain.toLowerCase()));
      if(bFound){
        return res.json({ result: '✅ Live (checked via bot-bypass) — rel/anchor unknown', ok:true, http:status, viaBypass:true });
      }
      return res.json({ result: '⚠️ Checked via bot-bypass — link not found on page', ok:false, http:status, viaBypass:true });
    }
    return res.json({ result: '🔒 Blocked (bot protection) — verify manually', ok:null, http:status });
  }
  if(status === 404 || status === 410){
    return res.json({ result: '❌ Page gone (HTTP '+status+')', ok:false, http:status });
  }
  if(status >= 500){
    return res.json({ result: '⚠️ Server error (HTTP '+status+')', ok:null, http:status });
  }
  if(!(status>=200 && status<300)){
    return res.json({ result: '⚠️ HTTP '+status, ok:null, http:status });
  }

  let html;
  try { html = await response.text(); } catch(e){ return res.json({result:'⚠️ Could not read page', ok:null}); }

  // Look for the target link in the HTML (match by domain+path, tolerant of http/https/www)
  const hLower = html.toLowerCase();
  const needle1 = targetPath.toLowerCase();
  const needle2 = targetDomain.toLowerCase();

  const found = hLower.includes(needle1) || (needle1.length<=needle2.length+1 && hLower.includes(needle2));

  if(!found){
    return res.json({ result: '⚠️ Link not found on page', ok:false, http:status });
  }

  // Found — inspect the <a> tag for rel attributes & anchor text
  let rel = '', foundAnchor = '';
  try {
    // Find an anchor tag whose href contains the target
    const aRegex = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while((m = aRegex.exec(html)) !== null){
      const href = (m[1]||'').toLowerCase();
      if(href.includes(needle2)){
        const tag = m[0].toLowerCase();
        const relMatch = tag.match(/rel\s*=\s*["']([^"']*)["']/);
        rel = relMatch ? relMatch[1] : '';
        foundAnchor = (m[2]||'').replace(/<[^>]*>/g,'').trim().slice(0,60);
        break;
      }
    }
  } catch(e){}

  const isNofollow = /nofollow/i.test(rel);
  const isSponsored = /sponsored/i.test(rel);
  const isUgc = /ugc/i.test(rel);

  let flags = [];
  if(isNofollow) flags.push('nofollow');
  if(isSponsored) flags.push('sponsored');
  if(isUgc) flags.push('ugc');

  // Anchor text match check (optional)
  let anchorNote = '';
  if(anchor && foundAnchor){
    const aMatch = foundAnchor.toLowerCase().includes(String(anchor).toLowerCase().trim());
    anchorNote = aMatch ? '' : ` · anchor differs ("${foundAnchor}")`;
  }

  const linkType = flags.length ? ('⚠️ '+flags.join('+')) : '✅ dofollow';
  return res.json({
    result: `✅ Live · ${linkType}${anchorNote}`,
    ok: true,
    http: status,
    rel,
    nofollow: isNofollow,
    anchor: foundAnchor
  });
};
