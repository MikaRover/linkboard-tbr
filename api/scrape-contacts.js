// Free email scraping (no paid API) — deep-crawls the target site's homepage
// plus a handful of likely contact/about/team pages and pulls out real email
// addresses via several extraction methods, not just a plain-text regex.
// Called by the "Free scrape" outreach flow (renderFreeResults / bulk
// free-scrape in app.html). Ported from the team's Google Apps Script
// "Contact Finder" library, which does the same crawl against a spreadsheet.

const { isSafeHost, cleanHost, browserHeaders } = require('./_lib/security');

const MAX_EMAILS_PER_DOMAIN = 10;
const MAX_INTERNAL_PAGES = 6;
const PAGE_TIMEOUT_MS = 5000;

// A page whose target site is one of these is never worth scraping for
// emails — skip the fetch entirely instead of wasting the request budget.
const SOCIAL_DOMAINS = [
  'facebook.com','instagram.com','linkedin.com','twitter.com','x.com',
  'tiktok.com','youtube.com','pinterest.com','snapchat.com','reddit.com',
  'threads.net','telegram.org','t.me','whatsapp.com','wa.me',
  'discord.com','discord.gg','tumblr.com','vk.com','quora.com'
];

// Internal pages likely to list a real person's contact info, matched
// against homepage link text/href — plus a fixed fallback list tried even
// when no matching link was found on the homepage.
const LINK_KEYWORDS = [
  'contact','about','team','staff','author','editorial',
  'write-for-us','writeforus','contribute','guest-post','guestpost',
  'advertise','press','media-kit','mediakit','get-in-touch'
];
const CANDIDATE_PATHS = [
  '/contact','/contact-us','/about','/about-us','/team','/our-team',
  '/staff','/write-for-us','/contribute','/guest-post','/advertise',
  '/press','/authors'
];

// Substring matches on the full email — file extensions picked up from
// image/font URLs, and known third-party/boilerplate addresses.
const JUNK_EMAIL_SUBSTRINGS = [
  '.png','.jpg','.jpeg','.svg','.webp','.gif','.bmp',
  'sentry','wixpress','godaddy','cloudflare','schema.org','w3.org','wpcf7',
  'example.com','example.org','example.net','domain.com','yourdomain',
  'yoursite','mysite.com','website.com','company.com','email.com',
  'test.com','placeholder','wordpress.org','gstatic.com','googleapis.com',
  'fontawesome','sample.com','demo.com','noreply','no-reply','donotreply'
];
// Exact local-part matches — template/placeholder addresses theme builders
// leave behind (e.g. "you@company.com", "john.doe@example.com").
const JUNK_LOCAL_PARTS = [
  'you','your','yourname','youremail','name','test','test123','example',
  'sample','demo','someone','user','username','firstname','lastname',
  'firstname.lastname','john.doe','jane.doe','asdf','abc','xxx',
  'placeholder','foo','foo.bar'
];
// Generic role inboxes — real and worth keeping, but not a named contact.
const GENERIC_LOCAL_PARTS = [
  'info','contact','hello','hi','support','admin','sales','team',
  'office','mail','press','media','marketing','pr','editor',
  'careers','jobs','hr','webmaster','help'
];

function classifyWebsiteType(host) {
  const d = host.toLowerCase();
  if (SOCIAL_DOMAINS.some(s => d === s || d.endsWith('.' + s))) return 'Social';
  return 'Other';
}

function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) && email.length < 100;
}

function isJunkEmail(email) {
  if (JUNK_EMAIL_SUBSTRINGS.some(s => email.includes(s))) return true;
  const local = email.split('@')[0];
  return JUNK_LOCAL_PARTS.includes(local);
}

// Best-effort first/last name from the local part (e.g. "jane.doe" -> Jane/Doe).
// Generic role inboxes intentionally get no name.
function guessNameFromEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if (GENERIC_LOCAL_PARTS.includes(local)) return { firstName: '', lastName: '' };
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2) return { firstName: '', lastName: '' };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return { firstName: cap(parts[0]), lastName: cap(parts[parts.length - 1]) };
}

// Cloudflare's XOR-based "protected" email obfuscation (data-cfemail="...").
function cfDecodeEmail(encoded) {
  try {
    let email = '';
    const r = parseInt(encoded.substr(0, 2), 16);
    for (let n = 2; n < encoded.length; n += 2) {
      email += String.fromCharCode(parseInt(encoded.substr(n, 2), 16) ^ r);
    }
    return email;
  } catch (e) { return null; }
}

// "name [at] domain [dot] com" / "name (at) domain (dot) com" / bare "at"/"dot".
function deobfuscateEmails(text) {
  const pattern = /([a-zA-Z0-9._-]+)\s*(?:\[at\]|\(at\)|\{at\}|\bat\b)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b)\s*(com|net|org|io|co|biz|info)\b/gi;
  const out = [];
  let m;
  while ((m = pattern.exec(text)) !== null) out.push(`${m[1]}@${m[2]}.${m[3]}`);
  return out;
}

// Pulls candidate emails from one page via mailto: links, Cloudflare
// obfuscation, plain text, and "at/dot" human-obfuscated text.
function extractEmailsFromHtml(html, pageUrl) {
  const found = new Map(); // email -> source page
  const add = raw => {
    if (!raw) return;
    const email = String(raw).trim().toLowerCase();
    if (!isValidEmail(email) || isJunkEmail(email) || found.has(email)) return;
    found.set(email, pageUrl);
  };

  const mailtoRe = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    try { add(decodeURIComponent(m[1])); } catch (e) { add(m[1]); }
  }

  const cfRe = /data-cfemail\s*=\s*["']([a-f0-9]+)["']/gi;
  while ((m = cfRe.exec(html)) !== null) add(cfDecodeEmail(m[1]));

  (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).forEach(add);

  deobfuscateEmails(html).forEach(add);

  return found;
}

function resolveUrl(base, link) {
  try {
    if (/^https?:\/\//i.test(link)) return link;
    if (link.startsWith('//')) return 'https:' + link;
    const b = base.replace(/\/$/, '');
    if (link.startsWith('/')) return b + link;
    return b + '/' + link;
  } catch (e) { return null; }
}

// Internal pages worth checking: links on the homepage whose href/text
// matches a contact-ish keyword, plus a fixed fallback list tried even if
// nothing matched (many sites have a /contact page with no homepage link).
function findInternalPages(baseUrl, html, host) {
  const pages = new Set();
  if (html) {
    const linkRe = /href\s*=\s*["']([^"'#?]+)/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const link = String(m[1] || '').trim();
      const l = link.toLowerCase();
      if (!LINK_KEYWORDS.some(k => l.includes(k))) continue;
      const resolved = resolveUrl(baseUrl, link);
      if (resolved && resolved.toLowerCase().includes(host)) pages.add(resolved);
    }
  }
  const trimmedBase = baseUrl.replace(/\/$/, '');
  CANDIDATE_PATHS.forEach(p => pages.add(trimmedBase + p));
  return Array.from(pages).slice(0, MAX_INTERNAL_PAGES);
}

async function fetchPage(url) {
  try {
    const r = await fetch(url, {
      headers: browserHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    });
    if (!r.ok) return null;
    return { url, html: await r.text() };
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain required' });
  if (!isSafeHost(domain)) return res.status(400).json({ error: 'Invalid or disallowed domain' });

  const host = cleanHost(domain);
  const linkedinSearchUrl = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(host);

  if (classifyWebsiteType(host) === 'Social') {
    return res.json({ domain: host, emails: [], guessedEmails: [], linkedinProfiles: [], linkedinSearchUrl });
  }

  const baseUrl = 'https://' + host;
  const found = new Map(); // email -> source page

  // 1) Homepage.
  const home = await fetchPage(baseUrl);
  if (home) {
    extractEmailsFromHtml(home.html, home.url).forEach((page, email) => {
      if (!found.has(email)) found.set(email, page);
    });
  }

  // 2) Still thin? Fan out to contact/about/team/etc. pages in parallel —
  // no external rate limit to respect here, unlike Ahrefs/Snov.
  if (found.size < MAX_EMAILS_PER_DOMAIN) {
    const candidates = findInternalPages(baseUrl, home ? home.html : '', host);
    const pages = (await Promise.all(candidates.map(fetchPage))).filter(Boolean);
    for (const page of pages) {
      extractEmailsFromHtml(page.html, page.url).forEach((src, email) => {
        if (!found.has(email)) found.set(email, src);
      });
    }
  }

  // 3) Prioritize on-domain addresses over incidental off-domain ones
  // (a linked partner's email, an ad-network contact, etc.), then cap.
  const sorted = Array.from(found.entries()).sort((a, b) => {
    const aOn = a[0].endsWith('@' + host) ? 0 : 1;
    const bOn = b[0].endsWith('@' + host) ? 0 : 1;
    return aOn - bOn;
  }).slice(0, MAX_EMAILS_PER_DOMAIN);

  const emails = sorted.map(([email, source]) => {
    const { firstName, lastName } = guessNameFromEmail(email);
    return { email, smtp: 'unknown', source, firstName, lastName };
  });

  return res.json({ domain: host, emails, guessedEmails: [], linkedinProfiles: [], linkedinSearchUrl });
};
