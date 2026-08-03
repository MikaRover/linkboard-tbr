const DAPA_API_KEY = 'e218e97a1e5a48456991555d3245498581a7aa9f';

function cleanDomain(raw){
  return String(raw||'').trim().replace(/^https?:\/\//i,'').replace(/^www\./i,'').replace(/\/.*$/,'').replace(/\/$/,'').toLowerCase();
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  let { domain, domains } = req.body || {};
  let list = Array.isArray(domains) ? domains : (domain ? [domain] : []);
  if(!list.length) return res.status(400).json({error:'domain(s) required'});
  const cleaned = list.map(cleanDomain).filter(Boolean);

  try {
    const resp = await fetch('https://www.dapachecker.org/api/user/dapa-checker', {
      method: 'POST',
      headers: { 'Accept':'application/json', 'Content-Type':'application/json', 'Authorization':'Bearer '+DAPA_API_KEY },
      body: JSON.stringify({ urls: cleaned }),
      signal: AbortSignal.timeout(20000)
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch(e){ return res.status(502).json({error:'Bad response', raw:text.slice(0,200)}); }
    if(!resp.ok || (json.status && json.status !== 200)) return res.status(resp.status||500).json({error: json.message||('HTTP '+resp.status)});

    const rows = (json.data||[]).map(d=>({ domain:d.domain, da:d.site_da??null, pa:d.site_pa??null, mozrank:d.site_mr??null, spam_score:d.spam_score??null }));
    if(list.length === 1){ const r = rows[0]||{}; return res.json({ ...r, results: rows }); }
    return res.json({ results: rows });
  } catch(e){
    if(e.name==='TimeoutError') return res.status(504).json({error:'dapachecker timed out'});
    return res.status(500).json({error:e.message});
  }
};
