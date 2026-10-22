/**
 * "TBR | Link Building working board" -> LinkBoard: bring NEW rows over.
 *
 * Runs a few times a day, scans every project tab, and sends LinkBoard the rows
 * it hasn't sent before. LinkBoard only ever CREATES links it doesn't have yet
 * (matched by project + domain) — it never edits or deletes an existing one, so
 * this can't damage anything already in the tool.
 *
 * STATUS comes from the section a row sits in:
 *     "... live links"  -> live        "Pending" -> pending
 *     "Needs change"    -> needs-change   "Lost" -> lost   "Rejected" -> rejected
 *   Rows under any OTHER band are skipped and listed in the log (never guessed).
 *
 * SAFE BY DESIGN
 *   - Unknown project (typo'd tab name): reported, never created in LinkBoard.
 *   - Domains already in LinkBoard (including ones the pull script put in the
 *     Sheet) are skipped.
 *   - After a successful send the script remembers each row (a short hash in the
 *     document's properties), so normal runs send nothing old and cost nothing.
 *
 * SETUP (once, ~3 minutes)
 *   1. Extensions -> Apps Script -> "+" next to Files -> Script, name it
 *      "Sheet to LinkBoard", paste this whole file.
 *   2. Put the secret in CONFIG (same value as SHEETS_WEBHOOK_SECRET in Vercel).
 *      Set SB_FROM_DATE (e.g. '2026-10-01') so old history isn't pulled in.
 *   3. Run `sbTest` and read the log. It sends NOTHING to be saved — LinkBoard
 *      just reports how many rows it WOULD create, per project.
 *   4. If the numbers look right, run `sbSetup` (installs the daily triggers).
 *   To pull in a row set again from scratch: run `sbReset`.
 */

// ───────────────────────── CONFIG ─────────────────────────
const SB_URL = 'https://linkboard-tbr.vercel.app/api/sheets-import';
const SB_SECRET = 'PASTE_THE_SHEETS_WEBHOOK_SECRET_HERE';

// Only rows dated on/after this day (YYYY-MM-DD) are considered. '' = no limit (the whole history!).
const SB_FROM_DATE = '';

// Hours of the day (script time zone) the sync runs. 5 times a day:
const SB_HOURS = [8, 11, 14, 17, 20];

// Tab name (without trailing count) -> LinkBoard project name, ONLY when they don't match by themselves
// (matching already ignores case, spaces and punctuation: "Novisign 19" -> NoviSign).
const SB_TAB_ALIASES = {
  // 'TheCascadeTravel': 'Cascade Travel',
};
// ───────────────────────────────────────────────────────────

const SB_CHUNK = 400; // rows per request (LinkBoard accepts up to 500)

/** Real run: sends rows not sent before, remembers the ones LinkBoard accepted. */
function sbSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const scan = sbScan_();
    const sent = sbLoadSent_();
    const fresh = scan.rows.filter(r => !sent.has(r.__key));
    Logger.log('%s row(s) scanned, %s new to send.', scan.rows.length, fresh.length);
    if (!fresh.length) return;
    for (const chunk of sbChunkByProject_(fresh)) {
      const res = sbPost_(chunk, false);
      Logger.log('sent %s -> created %s, already there %s, unknown projects: %s', chunk.length, res.created, res.skipped, JSON.stringify(res.unmatchedProjects));
      const bad = new Set((res.unmatchedProjects || []).map(String));
      chunk.forEach(r => { if (!bad.has(String(r.project))) sent.add(r.__key); }); // unknown-project rows stay un-sent and are retried
    }
    sbSaveSent_(sent);
  } finally {
    lock.releaseLock();
  }
}

/** Dry run: asks LinkBoard what it WOULD create. Saves nothing, remembers nothing. */
function sbTest() {
  const scan = sbScan_();
  Logger.log('%s row(s) scanned on %s tab(s). Skipped rows under unknown bands: %s', scan.rows.length, scan.tabs.length, scan.skippedBands.length);
  scan.skippedBands.slice(0, 10).forEach(b => Logger.log('  skipped band "%s" on tab "%s" (%s rows)', b.band, b.tab, b.count));
  let created = 0, skipped = 0; const unknown = new Set();
  for (const chunk of sbChunkByProject_(scan.rows)) {
    const res = sbPost_(chunk, true);
    created += res.created; skipped += res.skipped; (res.unmatchedProjects || []).forEach(p => unknown.add(p));
    (res.sample || []).slice(0, 3).forEach(s => Logger.log('  would create: [%s] %s (%s, %s)', s.project, s.domain, s.status, s.date));
  }
  Logger.log('WOULD CREATE %s link(s); %s already exist in LinkBoard.', created, skipped);
  if (unknown.size) Logger.log('Unknown projects (no such project in LinkBoard — add an alias or create it): %s', JSON.stringify([...unknown]));
}

/** Installs the daily triggers (run once). */
function sbSetup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sbSync').forEach(t => ScriptApp.deleteTrigger(t));
  SB_HOURS.forEach(h => ScriptApp.newTrigger('sbSync').timeBased().everyDays(1).atHour(h).create());
  Logger.log('Installed: sbSync runs daily at hours %s.', JSON.stringify(SB_HOURS));
}

/** Forget what was sent (the next sbSync re-sends everything; LinkBoard still skips what it already has). */
function sbReset() {
  PropertiesService.getDocumentProperties().deleteProperty('sb_sent_n');
  Logger.log('Cleared the sent-rows memory.');
}

// ───────────────────────── scanning ─────────────────────────
const sbNorm_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sbDomain_ = d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();

function sbStatusForBand_(text) {
  const t = String(text || '').toLowerCase();
  if (/live/.test(t)) return 'live';
  if (/pending/.test(t)) return 'pending';
  if (/need.*change|needs.*change/.test(t)) return 'needs-change';
  if (/lost/.test(t)) return 'lost';
  if (/reject/.test(t)) return 'rejected';
  return null;
}

function sbDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(String(v || '').trim());
  if (!m) return '';
  return ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + (m[3].length === 2 ? '20' + m[3] : m[3]);
}

function sbScan_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [], tabs = [], skippedBands = [];
  const from = SB_FROM_DATE ? new Date(SB_FROM_DATE + 'T00:00:00') : null;

  ss.getSheets().forEach(sh => {
    const last = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (last < 2 || lastCol < 2) return;
    const values = sh.getRange(1, 1, last, lastCol).getValues();
    const map = {};
    values[0].forEach((h, i) => { const k = String(h || '').toLowerCase().replace(/[^a-z]/g, ''); if (k && !(k in map)) map[k] = i; });
    if (map.domain == null || map.anchortext == null) return; // not a project tab (Link Checker, inbox, ...)
    tabs.push(sh.getName());

    const tabBase = sh.getName().replace(/\s+\d+\s*$/, '').trim();
    const project = SB_TAB_ALIASES[tabBase] || tabBase;
    const dateCol = map.date != null ? map.date : 0;
    const col = k => map[k];
    let status = null, band = '', skippedHere = 0;
    const get = (row, k) => (col(k) != null ? row[col(k)] : '');

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const domain = String(get(row, 'domain') || '').trim();
      const a = String(row[dateCol] || '').trim();
      if (!domain) { // a band row: text in column A, nothing in Domain
        if (a && !(row[dateCol] instanceof Date) && !/^\d/.test(a)) {
          if (skippedHere) { skippedBands.push({ tab: sh.getName(), band, count: skippedHere }); skippedHere = 0; }
          band = a; status = sbStatusForBand_(a);
        }
        continue;
      }
      if (!/\./.test(domain) || /\s/.test(domain)) continue; // not a real domain cell
      if (!status) { skippedHere++; continue; }
      const date = sbDateStr_(row[dateCol]);
      if (from && date) { const [dd, mm, yy] = date.split('/'); if (new Date(Number(yy), Number(mm) - 1, Number(dd)) < from) continue; }
      const num = v => (v === '' || v == null || isNaN(Number(String(v).replace(/[,%$\s]/g, '')))) ? '' : Number(String(v).replace(/[,%$\s]/g, ''));
      const ssv = num(get(row, 'ss'));
      rows.push({
        project, domain, status, date,
        dr: num(get(row, 'dr')), traffic: num(get(row, 'traffic')),
        ss: (typeof ssv === 'number' && ssv > 0 && ssv <= 1) ? Math.round(ssv * 100) : ssv,
        price: String(get(row, 'price') || '').replace(/[$,\s]/g, ''),
        linkin: String(get(row, 'linkin') || '').trim(), linkto: String(get(row, 'linkto') || '').trim(),
        anchor: String(get(row, 'anchortext') || '').trim(), invoice: String(get(row, 'invoicelink') || '').trim(),
        builder: String(get(row, 'buildername') || '').trim(), comments: String(get(row, 'comments') || '').trim(),
        __key: sbNorm_(project) + '|' + sbDomain_(domain)
      });
    }
    if (skippedHere) skippedBands.push({ tab: sh.getName(), band, count: skippedHere });
  });
  return { rows, tabs, skippedBands };
}

// ───────────────────────── sending ─────────────────────────
function sbChunkByProject_(rows) {
  const byProject = {};
  rows.forEach(r => (byProject[r.project] = byProject[r.project] || []).push(r));
  const chunks = [];
  Object.keys(byProject).forEach(p => { const list = byProject[p]; for (let i = 0; i < list.length; i += SB_CHUNK) chunks.push(list.slice(i, i + SB_CHUNK)); });
  return chunks;
}

function sbPost_(rows, dry) {
  const payload = rows.map(r => { const o = Object.assign({}, r); delete o.__key; return o; });
  const res = UrlFetchApp.fetch(SB_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Webhook-Secret': SB_SECRET },
    payload: JSON.stringify({ action: 'import-rows', dry: !!dry, rows: payload }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard import failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

// ───────────────────── "already sent" memory ─────────────────────
// Short hash per row, spread over several document properties (each value is limited to ~9 KB).
// Two independent 32-bit hashes joined (~64 bits) so two different rows can't realistically collide
// and make a NEW row look "already sent".
function sbHash_(s) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = ((h1 << 5) + h1 + c) >>> 0; h2 = ((h2 * 33) ^ c) >>> 0; }
  return h1.toString(36) + h2.toString(36);
}

function sbLoadSent_() {
  const props = PropertiesService.getDocumentProperties();
  const n = Number(props.getProperty('sb_sent_n') || 0);
  const set = new Set();
  for (let i = 0; i < n; i++) (props.getProperty('sb_sent_' + i) || '').split(',').filter(Boolean).forEach(h => set.add(h));
  const wrapper = { has: key => set.has(sbHash_(key)), add: key => set.add(sbHash_(key)), _set: set };
  return wrapper;
}

function sbSaveSent_(sent) {
  const props = PropertiesService.getDocumentProperties();
  const all = [...sent._set];
  const per = 500; // ~13 chars each -> ~7 KB per property
  const n = Math.ceil(all.length / per);
  for (let i = 0; i < n; i++) props.setProperty('sb_sent_' + i, all.slice(i * per, (i + 1) * per).join(','));
  props.setProperty('sb_sent_n', String(n));
}
