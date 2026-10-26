// Shared access control for every /api endpoint.
//
// 1. CORS: only the app's own origin (plus any listed in ALLOWED_ORIGINS,
//    comma-separated) gets CORS headers. Other websites can no longer call
//    these endpoints from a visitor's browser.
// 2. requireMember(): the caller must send a valid Firebase ID token
//    (Authorization: Bearer <token>) AND have a document in the `users`
//    collection — i.e. be someone an admin added to the team. A Firebase
//    account alone (self sign-up, random Google sign-in) is not enough.
//
// CORS is only a browser convenience; requireMember() is the real lock —
// a script calling the URL directly gets 401 without a team member's token.

const admin = require('./firebase-admin');

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin;
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  let host;
  try { host = new URL(origin).host; } catch (e) { return null; }
  const selfHost = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && selfHost && host === selfHost) return origin;
  const extra = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

function setCors(req, res, { methods = 'POST, OPTIONS', headers = 'Content-Type, Authorization' } = {}) {
  const origin = allowedOrigin(req);
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
  }
}

// Small per-instance cache so a burst of calls (e.g. checking 200 links in a
// loop) doesn't re-read the users doc every time. Role/removal changes take
// effect within USER_CACHE_MS.
const USER_CACHE_MS = 60 * 1000;
const userCache = new Map();

async function memberFromRequest(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const a = getAdmin();
  let decoded;
  try { decoded = await a.auth().verifyIdToken(m[1]); } catch (e) { return null; }
  const hit = userCache.get(decoded.uid);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const snap = await a.firestore().collection('users').doc(decoded.uid).get();
  const user = snap.exists
    ? { uid: decoded.uid, email: decoded.email || '', name: snap.data().name || '', role: snap.data().role || 'builder' }
    : null;
  userCache.set(decoded.uid, { at: Date.now(), user });
  return user;
}

// Returns the member, or sends 401 and returns null.
async function requireMember(req, res) {
  let user = null;
  try { user = await memberFromRequest(req); } catch (e) { user = null; }
  if (!user) {
    res.status(401).json({ error: 'Sign-in required' });
    return null;
  }
  return user;
}

module.exports = { getAdmin, setCors, requireMember, memberFromRequest };
