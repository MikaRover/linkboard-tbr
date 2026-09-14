// TEMPORARY diagnostic endpoint — not linked from the UI. Deletes itself
// once the Snov verification issue is diagnosed. Do not leave in prod.
module.exports = async function handler(req, res) {
  const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
  const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;
  const out = { hasClientId: !!SNOV_CLIENT_ID, hasClientSecret: !!SNOV_CLIENT_SECRET };

  if (!SNOV_CLIENT_ID || !SNOV_CLIENT_SECRET) return res.json(out);

  try {
    const authRes = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SNOV_CLIENT_ID,
        client_secret: SNOV_CLIENT_SECRET
      }),
      signal: AbortSignal.timeout(8000)
    });
    out.authStatus = authRes.status;
    const authJson = await authRes.json();
    out.authBody = authJson;
    const token = authJson.access_token;
    if (!token) return res.json(out);

    const startRes = await fetch('https://api.snov.io/v2/email-verification/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'emails[]': 'test@ahrefs.com' }),
      signal: AbortSignal.timeout(9000)
    });
    out.startStatus = startRes.status;
    out.startBody = await startRes.text();
  } catch (e) {
    out.error = e.message;
  }

  return res.json(out);
};
