// Outreach Agent mailboxes that aren't Gmail: Namecheap Private Email (and the
// same shape works for any SMTP + IMAP host). Sending goes over SMTP, a copy is
// saved to the mailbox's Sent folder over IMAP, and replies/bounces are read
// from the inbox over IMAP.
//
// Firestore (server-only, like gmailConnections/gmailSecrets):
//   smtpConnections/{mailboxId}  { ownerUid, name, email, provider, canSend, createdAt }
//   smtpSecrets/{mailboxId}      { passwordEnc }   — AES-GCM with GMAIL_TOKEN_KEY
//
// nodemailer / imapflow are required lazily, so a problem with either can only
// break these mailboxes, never the rest of /api/sheets-import.

const { getAdmin, encrypt, decrypt, mailboxId } = require('./gmail').internals;

const PROVIDERS = {
  privateemail: { label: 'Private Email', smtpHost: 'mail.privateemail.com', smtpPort: 465, imapHost: 'mail.privateemail.com', imapPort: 993 }
};
const db = () => getAdmin().firestore();
const isEmail = e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(String(e || ''));

function transport(p, email, password) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: p.smtpHost, port: p.smtpPort, secure: p.smtpPort === 465,
    auth: { user: email, pass: password },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
  });
}
function imapClient(p, email, password) {
  const { ImapFlow } = require('imapflow');
  return new ImapFlow({ host: p.imapHost, port: p.imapPort, secure: true, auth: { user: email, pass: password }, logger: false, socketTimeout: 20000 });
}

// Checks the password with a real SMTP login before anything is stored.
async function connect(user, { email, password, provider }) {
  email = String(email || '').trim().toLowerCase();
  const p = PROVIDERS[provider || 'privateemail'];
  if (!p) throw new Error('Unknown mail provider');
  if (!isEmail(email)) throw new Error('Enter the full email address');
  if (!password) throw new Error('Enter the mailbox password');
  try { await transport(p, email, password).verify(); }
  catch (e) { throw new Error('Could not sign in to ' + email + ' — check the address and password (' + String(e.message || e).slice(0, 120) + ')'); }
  const id = mailboxId(email);
  const g = await db().collection('gmailConnections').doc(id).get();
  if (g.exists) throw new Error(email + ' is already connected as a Gmail mailbox');
  const cur = await db().collection('smtpConnections').doc(id).get();
  if (cur.exists && cur.data().ownerUid !== user.uid) throw new Error(email + ' is connected by someone else');
  await db().collection('smtpSecrets').doc(id).set({ passwordEnc: encrypt(password) });
  await db().collection('smtpConnections').doc(id).set({
    ownerUid: user.uid, name: user.name || '', email, provider: provider || 'privateemail', canSend: true, lastError: null, createdAt: Date.now()
  });
  return { ok: true, id, email };
}

async function disconnect(user, { id }) {
  const ref = db().collection('smtpConnections').doc(String(id || ''));
  const cur = await ref.get();
  if (!cur.exists || cur.data().ownerUid !== user.uid) throw new Error('Mailbox not found');
  await db().collection('smtpSecrets').doc(ref.id).delete();
  await ref.delete();
  return { ok: true };
}

async function list(uid) {
  const snap = await db().collection('smtpConnections').where('ownerUid', '==', uid).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function get(id) {
  const c = await db().collection('smtpConnections').doc(String(id || '')).get();
  return c.exists ? { id: c.id, ...c.data() } : null;
}

async function creds(conn) {
  const s = await db().collection('smtpSecrets').doc(conn.id).get();
  if (!s.exists) throw new Error('Mailbox password missing — connect it again');
  return { p: PROVIDERS[conn.provider] || PROVIDERS.privateemail, password: decrypt(s.data().passwordEnc) };
}

// raw = the full RFC 2822 message (with its own Message-ID header).
async function sendRaw(conn, { to, raw }) {
  const { p, password } = await creds(conn);
  try {
    await transport(p, conn.email, password).sendMail({ envelope: { from: conn.email, to: [to] }, raw });
  } catch (e) {
    if (/auth|535|credentials/i.test(String(e.message || e))) await db().collection('smtpConnections').doc(conn.id).set({ lastError: 'Sign-in failed — connect again', lastErrorAt: Date.now() }, { merge: true });
    throw e;
  }
  // Best effort: a copy in Sent so the mailbox's own webmail shows it.
  try {
    const c = imapClient(p, conn.email, password);
    await c.connect();
    try {
      const boxes = await c.list();
      const sent = boxes.find(b => b.specialUse === '\\Sent') || boxes.find(b => /^(sent|sent items|sent messages)$/i.test(b.name));
      if (sent) await c.append(sent.path, raw, ['\\Seen']);
    } finally { await c.logout().catch(() => {}); }
  } catch (e) {}
}

// rows: [{ ref, data }] all from this mailbox. Returns { replied, bounced }.
// Same rule as outreach.js isAutoReply: auto-responders and out-of-office aren't replies.
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?reply|auto:|out of (the )?office|ooo\b|away from (the )?office|i am out|i'm out|on vacation|on leave|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica|thank you for (your )?(email|message|contacting)|thanks for (your )?(email|message|reaching out)|we (have )?received your)/i;
function isAuto(get) {
  const as = get('auto-submitted');
  if (as && !/^no$/i.test(as)) return true;
  if (get('x-autoreply') || get('x-autorespond')) return true;
  if (/auto_reply|auto-reply|bulk|junk/i.test(get('precedence'))) return true;
  return AUTO_SUBJECT.test(get('subject'));
}

async function track(conn, rows, deadline, onStatus) {
  const { p, password } = await creds(conn);
  const c = imapClient(p, conn.email, password);
  await c.connect();
  let replied = 0, bounced = 0;
  try {
    const lock = await c.getMailboxLock('INBOX');
    try {
      for (const { ref, data: x } of rows) {
        if (Date.now() > deadline) break;
        // IMAP SINCE is day-granular, so start a day early; search() gives
        // false on no match, hence the `|| []`.
        const since = new Date((x.sentAt || Date.now()) - 86400000);
        const uids = async q => (await c.search({ since, ...q }).catch(() => false)) || [];
        const found = async q => (await uids(q)).length > 0;
        let status = '';
        if (await found({ from: 'mailer-daemon', body: x.email }) || await found({ from: 'postmaster', body: x.email })) status = 'bounced';
        else {
          // A reply only if at least one of their messages isn't an out-of-office / auto-responder.
          const ids = [...new Set([...(x.smtpMessageId ? await uids({ header: { 'in-reply-to': x.smtpMessageId } }) : []), ...(await uids({ from: x.email }))])].slice(-10);
          for (const uid of ids) {
            const m = await c.fetchOne(uid, { headers: ['subject', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence'] }, { uid: true }).catch(() => null);
            const h = m && m.headers ? m.headers.toString('utf8') : '';
            const get = n => ((new RegExp('^' + n + ':\\s*(.*)$', 'im').exec(h) || [])[1] || '').trim();
            if (!m || !isAuto(get)) { status = 'replied'; break; }
          }
        }
        if (status) { await onStatus(ref, status); status === 'replied' ? replied++ : bounced++; }
      }
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
  return { replied, bounced };
}

module.exports = { PROVIDERS, connect, disconnect, list, get, sendRaw, track };
