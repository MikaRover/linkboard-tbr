// Best-effort PayPal invoice payment-status checker — fetches the invoice
// page (with a bot-bypass fallback, same approach as check-link.js) and
// looks for paid/unpaid wording in the rendered text. PayPal's hosted
// invoice pages are JS-rendered, so a plain server-side fetch often only
// gets the app shell — the r.jina.ai reader-proxy renders the page first,
// which is what actually makes this work in most cases. Never treated as
// authoritative: always reported as a suggestion the user can override.

const { isSafeHost, browserHeaders } = require('./_lib/security');

function normUrl(u){
  return String(u||'').trim().replace(/\/+$/,'').replace(/^http:\/\//i,'https://');
}

async function fetchViaFreeBypass(url){
  try{
    const r = await fetch('https://r.jina.ai/'+url, { signal: AbortSignal.timeout(15000) });
    if(!r.ok) return null;
    const text = await r.text();
    return text && text.trim() ? text : null;
  }catch(e){ return null; }
}

async function fetchPage(url, attempt=0){
  try {
    const res = await fetch(url, { headers: browserHeaders(), redirect:'follow', signal: AbortSignal.timeout(15000) });
    return res;
  } catch(e){
    if(attempt < 1){ await new Promise(r=>setTimeout(r,800)); return fetchPage(url, attempt+1); }
    throw e;
  }
}

// Negative phrases checked first — "not paid" contains "paid" as a
// substring, so a naive positive-only search would misread it.
const UNPAID_PHRASES = [
  'not been paid','not paid','unpaid','payment due','awaiting payment',
  'outstanding balance','past due','pending payment','payment pending',
  'due on receipt','balance due'
];
const PAID_PHRASES = [
  'paid in full','you paid','payment completed','invoice paid',
  'marked as paid','payment received','paid on ',' paid $','status: paid',
  'this invoice is paid'
];

function detectPaidStatus(text){
  const t = text.toLowerCase();
  for(const p of UNPAID_PHRASES){ if(t.includes(p)) return {paid:false, matched:p}; }
  for(const p of PAID_PHRASES){ if(t.includes(p)) return {paid:true, matched:p}; }
  return {paid:null, matched:null};
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const { invoiceUrl } = req.body || {};
  if(!invoiceUrl) return res.status(400).json({result:'⚠️ Missing invoice link', paid:null});
  if(!isSafeHost(invoiceUrl)) return res.status(400).json({result:'⚠️ Invalid or disallowed URL', paid:null});

  const url = normUrl(invoiceUrl);
  let response;
  try {
    response = await fetchPage(url);
  } catch(e){
    return res.json({ result:'⚠️ Unreachable — verify manually', paid:null });
  }

  const status = response.status;

  if(status === 403 || status === 406 || status === 429){
    const bypassText = await fetchViaFreeBypass(url);
    if(bypassText){
      const d = detectPaidStatus(bypassText);
      if(d.paid===true) return res.json({ result:'✅ Paid (checked via bot-bypass)', paid:true, viaBypass:true });
      if(d.paid===false) return res.json({ result:'⏳ Not paid yet (checked via bot-bypass)', paid:false, viaBypass:true });
      return res.json({ result:'🔒 Blocked — could not determine status, verify manually', paid:null, viaBypass:true });
    }
    return res.json({ result:'🔒 Blocked (bot protection) — verify manually', paid:null });
  }
  if(status === 404 || status === 410){
    return res.json({ result:'❌ Invoice page gone (HTTP '+status+')', paid:null });
  }
  if(!(status>=200 && status<300)){
    return res.json({ result:'⚠️ HTTP '+status+' — verify manually', paid:null });
  }

  let html;
  try { html = await response.text(); } catch(e){ return res.json({result:'⚠️ Could not read page', paid:null}); }

  const d = detectPaidStatus(html);
  if(d.paid===true) return res.json({ result:'✅ Paid', paid:true });
  if(d.paid===false) return res.json({ result:'⏳ Not paid yet', paid:false });

  // A plain fetch usually just gets PayPal's JS app shell — no visible
  // payment-status text yet, not blocked, just not rendered. Retry through
  // the same reader-proxy bypass used for blocked responses, since that
  // actually executes the page's JS before handing back text.
  const bypassText = await fetchViaFreeBypass(url);
  if(bypassText){
    const d2 = detectPaidStatus(bypassText);
    if(d2.paid===true) return res.json({ result:'✅ Paid (checked via bot-bypass)', paid:true, viaBypass:true });
    if(d2.paid===false) return res.json({ result:'⏳ Not paid yet (checked via bot-bypass)', paid:false, viaBypass:true });
  }
  return res.json({ result:'⚠️ Could not determine status — verify manually', paid:null });
};
