// Google Sheets -> LinkBoard one-way sync webhook.
// Called from an Apps Script bound to the team's Google Sheet (see the
// "LinkBoard > Send row" menu item set up there). Writes straight to
// Firestore using the Admin SDK, bypassing client auth entirely, so it
// needs its own secret check instead of relying on a logged-in user.

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-webhook-secret'] || (req.body && req.body.secret);
  if (!process.env.SHEETS_WEBHOOK_SECRET || secret !== process.env.SHEETS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    domain, anchor, project, dr, traffic, ss, price,
    linkin, linkto, builder, date, status, invoice, comments
  } = req.body || {};

  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!project) return res.status(400).json({ error: 'project required' });

  try {
    const db = getDb();

    // Skip if this exact domain+project pair already exists — the sheet
    // may get re-synced (e.g. re-running the menu action on old rows).
    const dup = await db.collection('links')
      .where('domain', '==', String(domain).trim())
      .where('project', '==', String(project).trim())
      .limit(1)
      .get();
    if (!dup.empty) {
      return res.json({ ok: true, skipped: true, reason: 'Already exists', id: dup.docs[0].id });
    }

    const docRef = await db.collection('links').add({
      domain: String(domain).trim(),
      anchor: String(anchor || '').trim(),
      project: String(project).trim(),
      dr: dr || '',
      traffic: traffic || '',
      ss: ss || '',
      price: String(price || '').replace(/^\$+/, '').trim(),
      linkin: linkin || '',
      linkto: linkto || '',
      builder: builder || '',
      status: status || 'pending',
      invoice: invoice || '',
      comments: comments || '',
      relevancy: '',
      linkcheck: '',
      check: '',
      source: 'google-sheets',
      date: date || new Date().toLocaleDateString('en-GB'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, id: docRef.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
