// Shared Snov.io auth + email verification helper — used by any endpoint
// that finds candidate emails via free scraping and wants a real deliverability
// status instead of always reporting 'unknown'.

const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;

const VERIFY_BATCH_SIZE = 10; // Snov's v2 verifier max emails per start request
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 3000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOk = code => code >= 200 && code < 300;

async function getSnovToken() {
  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET) {
    console.error('[snov] SNOV_CLIENT_ID/SNOV_CLIENT_SECRET not set');
    return null;
  }
  try {
    const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SNOV_CLIENT_ID,
        client_secret: SNOV_CLIENT_SECRET
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.error('[snov] auth failed', res.status, await res.text());
      return null;
    }
    const j = await res.json();
    return j.access_token || null;
  } catch (e) { console.error('[snov] auth error', e.message); return null; }
}

// Snov's smtp_status values are 'valid' | 'not_valid' | 'unknown' — map
// 'not_valid' to this app's existing 'invalid' badge so it renders as a
// clear rejection rather than falling into the ambiguous "Unknown" bucket.
function normalizeStatus(smtpStatus) {
  if (smtpStatus === 'valid') return 'valid';
  if (smtpStatus === 'not_valid') return 'invalid';
  return 'unknown';
}

async function verifyBatch(batch, token) {
  const headers = { Authorization: 'Bearer ' + token };
  try {
    const startBody = new URLSearchParams();
    batch.forEach(e => startBody.append('emails[]', e));
    const startRes = await fetch('https://api.snov.io/v2/email-verification/start', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: startBody,
      signal: AbortSignal.timeout(9000)
    });
    if (!isOk(startRes.status)) return null;
    const startJson = await startRes.json();
    const taskHash = startJson?.data?.task_hash || startJson?.task_hash;
    if (!taskHash) return null;

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_DELAY_MS);
      try {
        const r = await fetch(
          `https://api.snov.io/v2/email-verification/result?task_hash=${encodeURIComponent(taskHash)}`,
          { headers, signal: AbortSignal.timeout(9000) }
        );
        if (!isOk(r.status)) continue;
        const json = await r.json();
        const data = json?.data;
        if (Array.isArray(data) && data.length) return data;
        if (json?.status && String(json.status).toLowerCase() !== 'in_progress') return data || [];
      } catch (e) { /* keep polling */ }
    }
    return null;
  } catch (e) { return null; }
}

// Verifies a list of emails (chunked into batches of 10, run in parallel).
// Returns a Map of email -> smtp status ('valid'|'invalid'|'unknown'). Any
// email that fails to verify (bad token, Snov error, timeout, exhausted
// polling) simply comes back 'unknown' rather than throwing — verification
// is a best-effort enhancement, never a reason to withhold an already-found
// email.
async function verifyEmailsWithSnov(emails, token) {
  const statuses = new Map(emails.map(e => [e, 'unknown']));
  if (!token || !emails.length) return statuses;

  const chunks = [];
  for (let i = 0; i < emails.length; i += VERIFY_BATCH_SIZE) chunks.push(emails.slice(i, i + VERIFY_BATCH_SIZE));

  await Promise.all(chunks.map(async (chunk) => {
    const results = await verifyBatch(chunk, token);
    if (!results) return;
    results.forEach(entry => {
      const email = (entry?.email || '').toLowerCase();
      if (email && statuses.has(email)) statuses.set(email, normalizeStatus(entry?.smtp_status));
    });
  }));

  return statuses;
}

module.exports = { getSnovToken, verifyEmailsWithSnov };
