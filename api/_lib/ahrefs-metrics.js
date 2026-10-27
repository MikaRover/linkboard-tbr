// Server-side DR/traffic lookup for code that creates links without a browser
// (the Google Sheets webhook). Same Ahrefs calls and the same "traffic only
// when > 0" rule as api/ahrefs.js, minus the HTTP layer and the cache.

async function fetchWithRetry(url, headers, retries = 1, delay = 1500) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (resp.ok) return resp;
    } catch (e) {
      if (i === retries) return null;
    }
    if (i < retries) await new Promise(r => setTimeout(r, delay));
  }
  return null;
}

// -> { dr, traffic } with null for whatever Ahrefs couldn't give. Never throws.
async function lookupMetrics(domain) {
  const key = process.env.AHREFS_API_KEY;
  const target = String(domain || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  if (!key || !target) return { dr: null, traffic: null };
  const today = new Date().toISOString().slice(0, 10);
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const call = (url) => fetchWithRetry(url, headers);
  try {
    const [drResp, mResp] = await Promise.all([
      call(`https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(target)}&date=${today}`),
      call(`https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(target)}&date=${today}&mode=subdomains&select=org_traffic,org_keywords,paid_traffic`)
    ]);
    let dr = null, traffic = null;
    if (drResp) {
      const d = await drResp.json();
      const v = d?.domain_rating?.domain_rating;
      if (v != null) dr = Math.round(v);
    }
    if (mResp) {
      const m = await mResp.json();
      const metrics = m?.metrics || m || {};
      const raw = metrics.org_traffic ?? metrics.paid_traffic ?? metrics.org_keywords ?? null;
      if (raw != null && raw > 0) traffic = Math.round(raw);
    }
    return { dr, traffic };
  } catch (e) {
    return { dr: null, traffic: null };
  }
}

// Fills dr/traffic on link docs that lack them (mutates `docs`). Runs `concurrency`
// lookups at a time and stops starting new ones after `budgetMs`, so a big import
// can't blow the function's time limit — whatever is left stays blank.
async function fillMissingMetrics(docs, { concurrency = 5, budgetMs = 40000 } = {}) {
  const todo = docs.filter(d => d.domain && (!d.dr || !d.traffic));
  const deadline = Date.now() + budgetMs;
  let filled = 0, next = 0;
  async function worker() {
    while (next < todo.length && Date.now() < deadline) {
      const d = todo[next++];
      const m = await lookupMetrics(d.domain);
      let got = false;
      if (!d.dr && m.dr != null) { d.dr = String(m.dr); got = true; }
      if (!d.traffic && m.traffic != null) { d.traffic = String(m.traffic); got = true; }
      if (got) filled++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { checked: Math.min(next, todo.length), pending: todo.length - Math.min(next, todo.length), filled };
}

module.exports = { lookupMetrics, fillMissingMetrics };
