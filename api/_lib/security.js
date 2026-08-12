// Shared SSRF guard for endpoints that fetch(`https://${userSuppliedDomain}...`).
// Blocks loopback/private/link-local hosts and requires a plausible public hostname.
// Note: this is a hostname-level heuristic, not DNS-rebinding-proof.

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0)$|^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0)\b/i;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function cleanHost(rawDomain) {
  return String(rawDomain || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .split(':')[0]
    .replace(/^www\./i, '')
    .toLowerCase();
}

function isSafeHost(rawDomain) {
  const host = cleanHost(rawDomain);
  if (!host) return false;
  if (host === '::1' || host === 'metadata.google.internal') return false;
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (!HOSTNAME_RE.test(host)) return false;
  return true;
}

// Realistic browser headers for outbound page fetches. A bare User-Agent
// (or worse, one that self-identifies as a bot, e.g. "SEOBot/1.0") is an easy
// signal for basic bot-detection to key on — this mimics a real top-level
// Chrome navigation closely enough to pass naive checks. It won't get past
// Cloudflare/Akamai JS-challenge or TLS-fingerprint protection; nothing
// short of a real headless browser can, and that's out of scope here.
function browserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  };
}

module.exports = { isSafeHost, cleanHost, browserHeaders };
