// Shared Snov.io auth + email verification helper — used by any endpoint
// that finds candidate emails via free scraping and wants a real deliverability
// status instead of always reporting 'unknown'.
//
// Snov credentials: falls back to one shared SNOV_CLIENT_ID/SECRET account
// (the original setup — everyone's usage drew from one person's credit
// balance) but a team member can now connect their OWN Snov.io account
// (Client ID + Secret from their own API Settings page) so their searches
// spend their own credits instead. Stored encrypted per-uid in
// `snovSecrets`, same AES-256-GCM approach as Gmail's refresh tokens in
// api/_lib/gmail.js, keyed off SNOV_TOKEN_KEY (falls back to GMAIL_TOKEN_KEY
// so this works without adding a new Vercel env var first).

const crypto = require('crypto');

const SNOV_CLIENT_ID = process.env.SNOV_CLIENT_ID;
const SNOV_CLIENT_SECRET = process.env.SNOV_CLIENT_SECRET;

const VERIFY_BATCH_SIZE = 10; // Snov's v2 verifier max emails per start request
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 3000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOk = code => code >= 200 && code < 300;

function getAdmin() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

// Identifies which LinkBoard user is calling, from the Firebase ID token the
// frontend sends as a Bearer header — same pattern as api/_lib/gmail.js's
// userFromRequest, duplicated (not imported) so this file has no dependency
// on gmail.js and a change to one can't break the other.
async function userFromRequest(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const decoded = await getAdmin().auth().verifyIdToken(m[1]);
    return { uid: decoded.uid };
  } catch (e) { return null; }
}

function cryptoKey() {
  const secret = process.env.SNOV_TOKEN_KEY || process.env.GMAIL_TOKEN_KEY;
  if (!secret) throw new Error('SNOV_TOKEN_KEY (or GMAIL_TOKEN_KEY) not configured');
  return crypto.createHash('sha256').update(secret).digest();
}
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decryptSecret(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

async function getUserSnovCredentials(uid) {
  if (!uid) return null;
  try {
    const snap = await getAdmin().firestore().collection('snovSecrets').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data();
    return { clientId: decryptSecret(d.clientIdEnc), clientSecret: decryptSecret(d.clientSecretEnc) };
  } catch (e) { return null; }
}

async function saveUserSnovCredentials(uid, clientId, clientSecret) {
  await getAdmin().firestore().collection('snovSecrets').doc(uid).set({
    clientIdEnc: encryptSecret(clientId),
    clientSecretEnc: encryptSecret(clientSecret),
    updatedAt: getAdmin().firestore.FieldValue.serverTimestamp()
  });
}

async function deleteUserSnovCredentials(uid) {
  await getAdmin().firestore().collection('snovSecrets').doc(uid).delete();
}

// `creds` (optional): { clientId, clientSecret } — a user's own connected
// Snov account. Falls back to the shared env-var account when omitted or
// when the user hasn't connected one, so nothing breaks for anyone who
// hasn't set up their own yet.
async function getSnovToken(creds) {
  const clientId = (creds && creds.clientId) || SNOV_CLIENT_ID;
  const clientSecret = (creds && creds.clientSecret) || SNOV_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[snov] no Snov credentials available (neither user-specific nor shared env)');
    return null;
  }
  try {
    const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
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
      if (email && statuses.has(email)) statuses.set(email, normalizeStatus(entry?.result?.smtp_status));
    });
  }));

  return statuses;
}

module.exports = {
  getSnovToken, verifyEmailsWithSnov, userFromRequest,
  getUserSnovCredentials, saveUserSnovCredentials, deleteUserSnovCredentials
};
