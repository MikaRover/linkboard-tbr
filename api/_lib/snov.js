// Shared Snov.io auth + email verification helper — used by any endpoint
// that finds candidate emails via free scraping and wants a real deliverability
// status instead of always reporting 'unknown'.

const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;

async function getSnovToken() {
  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET) return null;
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
    if (!res.ok) return null;
    const j = await res.json();
    return j.access_token || null;
  } catch (e) { return null; }
}

// Verifies a batch of emails in one request. Returns a Map of
// email -> smtp status ('valid'|'invalid'|'risky'|'unknown'). Emails that
// fail to verify (bad token, Snov error, timeout) simply come back 'unknown'
// rather than throwing — verification is a best-effort enhancement, never a
// reason to withhold an already-found email.
async function verifyEmailsWithSnov(emails, token) {
  const statuses = new Map(emails.map(e => [e, 'unknown']));
  if (!token || !emails.length) return statuses;
  try {
    const body = new URLSearchParams();
    emails.forEach(e => body.append('emails[]', e));
    const r = await fetch('https://api.snov.io/v1/get-emails-verification', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) return statuses;
    const json = await r.json();
    (Array.isArray(json) ? json : []).forEach(entry => {
      const email = (entry?.email || '').toLowerCase();
      const status = entry?.smtp_status || entry?.status;
      if (email && status) statuses.set(email, status);
    });
  } catch (e) { /* keep everything 'unknown' */ }
  return statuses;
}

module.exports = { getSnovToken, verifyEmailsWithSnov };
