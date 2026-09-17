// Free email scraping (no paid API) — deep-crawls the target site's homepage
// plus a handful of likely contact/about/team pages and pulls out real email
// addresses via several extraction methods, not just a plain-text regex.
// Called by the "Free scrape" outreach flow (renderFreeResults / bulk
// free-scrape in app.html). Ported from the team's Google Apps Script
// "Contact Finder" library, which does the same crawl against a spreadsheet.

const { isSafeHost, cleanHost, browserHeaders } = require('./_lib/security');
const { getSnovToken, verifyEmailsWithSnov } = require('./_lib/snov');

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
  '/press','/authors','/leadership','/people','/meet-the-team'
];
// Narrower than LINK_KEYWORDS/CANDIDATE_PATHS above — a URL matching this is
// trustworthy enough to scrape for the company's OWN staff. /contact,
// /press and /authors are excluded here even though they're fetched for
// emails, since a "Press" or "Contact" page is just as likely to feature a
// quoted analyst or a guest author as an actual employee.
const TEAM_PAGE_RE = /\/(team|our-team|about|about-us|staff|leadership|people|meet-the-team)(\/|$|\?)/i;

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

const MAX_TEAM_MEMBERS = 15;

// Job-title keywords used to gate the heading+text heuristic below — without
// this, ANY heading immediately followed by a short paragraph (a blog post
// title + excerpt, a pricing tier name + blurb) would get mistaken for a
// person + role.
const TITLE_KEYWORDS = [
  'specialist','manager','director','lead','head of','officer','founder',
  'co-founder','ceo','coo','cto','cmo','cfo','president','vp','vice president',
  'executive','coordinator','associate','analyst','consultant','engineer',
  'developer','designer','strategist','partnerships','outreach','marketing',
  'sales','support','success','operations','product','growth','content',
  'seo','pr','communications','editor','writer','recruiter','talent'
];
const TITLE_KEYWORD_RE = new RegExp('\\b(' + TITLE_KEYWORDS.join('|') + ')\\b', 'i');

function looksLikePersonName(text) {
  const t = text.trim();
  if (t.length < 4 || t.length > 40) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(w => /^[A-Z][a-zA-ZÀ-ÖØ-öø-ÿ'.-]*$/.test(w));
}

// A name+title pair sitting inside a testimonial/quote/case-study block is
// a CUSTOMER (or an external analyst quoted in marketing copy), never this
// company's own staff — e.g. mailtrap.io's homepage has a Twitter-testimonial
// slider whose card markup ("single-testimonial__icon", "single-tweeter")
// otherwise looks exactly like a team-grid card to the heuristic below.
const TESTIMONIAL_CONTEXT_RE = /testimonial|tweet|review|quote|case-stud|customer-stor|success-stor|client-stor/i;

// Best-effort "Name" + "Job Title" extraction from a team/about page's raw
// HTML — no DOM parser here (matches this file's existing regex-on-html-string
// style), so this only catches common layouts: structured schema.org Person
// markup, or a heading immediately followed by a short role-bearing text
// block (how most team-grid page templates render a person card). It won't
// catch every layout, same tradeoff as the email extraction above.
function extractTeamMembers(html) {
  const found = new Map(); // name -> title
  // A testimonial card's icon/avatar markup before the name+role text can
  // run to several KB of inline SVG (verified against a real example: ~3KB
  // between a "single-tweeter" class marker and the name it labels), so the
  // lookback window has to be generous to reliably catch it.
  const hasTestimonialContext = (idx) => TESTIMONIAL_CONTEXT_RE.test(html.slice(Math.max(0, idx - 4000), idx));

  const microRe = /itemprop=["']name["'][^>]*>\s*([^<]{3,50})\s*<[\s\S]{0,300}?itemprop=["']jobTitle["'][^>]*>\s*([^<]{3,60})\s*</gi;
  let m;
  while ((m = microRe.exec(html)) !== null) {
    const name = m[1].trim(), title = m[2].trim();
    if (!looksLikePersonName(name) || found.has(name) || hasTestimonialContext(m.index)) continue;
    found.set(name, title);
  }

  const headingRe = /<h[2-5][^>]*>\s*([^<]{4,50}?)\s*<\/h[2-5]>\s*(?:<[^>]*>\s*)*?([^<]{4,80}?)\s*</gi;
  while ((m = headingRe.exec(html)) !== null) {
    const name = m[1].trim(), title = m[2].trim();
    if (found.has(name) || !looksLikePersonName(name) || !TITLE_KEYWORD_RE.test(title)) continue;
    if (hasTestimonialContext(m.index)) continue;
    found.set(name, title);
  }

  return found;
}

// Infers this domain's email-naming convention from an email already found
// on the site that we could confidently attribute to a named person (e.g.
// "jane.doe@x.com" -> Jane/Doe via guessNameFromEmail) — so a team member's
// guessed address can follow the SAME pattern instead of trying all of them.
function detectEmailPattern(emailEntries, host) {
  for (const [email] of emailEntries) {
    if (!email.toLowerCase().endsWith('@' + host)) continue;
    const local = email.split('@')[0].toLowerCase();
    const { firstName, lastName } = guessNameFromEmail(email);
    if (!firstName || !lastName) continue;
    const f = firstName.toLowerCase(), l = lastName.toLowerCase();
    if (local === `${f}.${l}`) return 'first.last';
    if (local === `${f[0]}${l}`) return 'flast';
    if (local === `${f}${l}`) return 'firstlast';
    if (local === f) return 'first';
  }
  return null;
}

function candidateEmailsForName(firstName, lastName, host, pattern) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l) return [];
  const byPattern = {
    'first.last': `${f}.${l}@${host}`,
    'flast': `${f[0]}${l}@${host}`,
    'firstlast': `${f}${l}@${host}`,
    'first': `${f}@${host}`
  };
  if (pattern) return [byPattern[pattern]];
  // No confirmed pattern for this domain — try the two most common
  // professional conventions and let Snov verification pick the real one.
  return [byPattern['first.last'], byPattern['flast']];
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
    return res.json({ domain: host, emails: [], teamMembers: [], guessedEmails: [], linkedinProfiles: [], linkedinSearchUrl });
  }

  const baseUrl = 'https://' + host;
  const found = new Map(); // email -> source page
  const teamByName = new Map(); // name -> title

  // 1) Homepage. Deliberately NOT scanned for team members — homepages very
  // commonly carry customer-testimonial/press-quote sliders whose card
  // markup (name + role heading) is indistinguishable from a real team-grid
  // card to the heuristic below; only dedicated team/about/leadership pages
  // are trustworthy enough for that.
  const home = await fetchPage(baseUrl);
  if (home) {
    extractEmailsFromHtml(home.html, home.url).forEach((page, email) => {
      if (!found.has(email)) found.set(email, page);
    });
  }

  // 2) Fan out to contact/about/team/etc. pages in parallel — no external
  // rate limit to respect here, unlike Ahrefs/Snov. Always checked (not
  // gated on email count) since a team page is worth scraping for names
  // even when the homepage alone already found enough emails.
  const candidates = findInternalPages(baseUrl, home ? home.html : '', host);
  const pages = (await Promise.all(candidates.map(fetchPage))).filter(Boolean);
  for (const page of pages) {
    extractEmailsFromHtml(page.html, page.url).forEach((src, email) => {
      if (!found.has(email)) found.set(email, src);
    });
    // Team extraction only on pages that are actually about the company's
    // own people — not /contact, /press, /authors etc., which are just as
    // likely to carry a quoted outsider as a real employee.
    if (TEAM_PAGE_RE.test(page.url)) {
      extractTeamMembers(page.html).forEach((title, name) => {
        if (!teamByName.has(name)) teamByName.set(name, title);
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

  // 4) Team members found on the site itself have a name+title but no
  // listed email — guess one from this domain's naming convention (learned
  // from a real email above, or the two most common patterns otherwise)
  // and let the same Snov verification pass below confirm which guess, if
  // any, is real.
  const pattern = detectEmailPattern(sorted, host);
  const team = Array.from(teamByName.entries()).slice(0, MAX_TEAM_MEMBERS).map(([name, title]) => {
    const words = name.split(/\s+/);
    const firstName = words[0], lastName = words[words.length - 1];
    return { name, firstName, lastName, title, candidates: candidateEmailsForName(firstName, lastName, host, pattern) };
  });

  // Verify deliverability via Snov before returning — the scrape itself
  // stays free, this just upgrades 'unknown' to a real valid/invalid/risky
  // status. Best-effort: if Snov creds are missing or the call fails, every
  // email just falls back to 'unknown' rather than blocking the response.
  const token = await getSnovToken();
  const emailsToVerify = [...sorted.map(([email]) => email), ...team.flatMap(t => t.candidates)];
  const smtpByEmail = await verifyEmailsWithSnov(emailsToVerify, token);

  const emails = sorted.map(([email, source]) => {
    const { firstName, lastName } = guessNameFromEmail(email);
    return { email, smtp: smtpByEmail.get(email) || 'unknown', source, firstName, lastName };
  });

  const teamMembers = team.map(t => {
    const validCandidate = t.candidates.find(c => smtpByEmail.get(c) === 'valid');
    return {
      name: t.name, firstName: t.firstName, lastName: t.lastName, title: t.title,
      email: validCandidate || '', smtp: validCandidate ? 'valid' : 'unknown', guessed: !!validCandidate
    };
  });

  return res.json({ domain: host, emails, teamMembers, guessedEmails: [], linkedinProfiles: [], linkedinSearchUrl });
};
