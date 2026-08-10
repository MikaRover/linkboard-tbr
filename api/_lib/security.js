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

module.exports = { isSafeHost, cleanHost };
