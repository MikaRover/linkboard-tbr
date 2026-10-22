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
 *     Old month bands ("October", "September 2025") -> live (archived live links).
 *   Rows under any OTHER band are skipped and listed in the log (never guessed).
 *   HIDDEN tabs are ignored.
 *
 * STATUS SYNC (new): when a row's section changes in the Sheet (e.g. a link is moved from
 *   "Pending" up to "... live links"), LinkBoard's status for that link follows. It only ever
 *   changes the `status` of a link that already exists (project + domain); it never deletes.
 *   Old month bands ("October", "September 2025", ...) count as live (for new links too). First run =
 *   catch-up (never moves a LinkBoard-live link back to pending); after that only CHANGES in
 *   the Sheet are sent, so a status someone sets in LinkBoard isn't overwritten again and again.
 *   Dry run: `sbStatusTest` (logs what would change, changes nothing).
 *
 * PENDING CHECKER (new): 3x a day LinkBoard itself looks at every PENDING link that has a Link in +
 *   Link to. If the page really links to the target (same test as the "Check link" button) the link
 *   becomes live (goes to the double-check queue of Mika + Tatev like any newly-live link) and Mika,
 *   Tatev and the builder get a bell notification. Not found yet / blocked / error -> left pending, untouched.
 *   Dry run: `pcTest` (checks the first batch, changes nothing). Install: `pcSetup`.
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

// Hours of the day (script time zone) the sync runs (new links + status changes). Once a day, 21:00:
const SB_HOURS = [21];

// Tab name (without trailing count) -> LinkBoard project name, ONLY when they don't match by themselves
// (matching already ignores case, spaces and punctuation: "Novisign 19" -> NoviSign).
const SB_TAB_ALIASES = {
  'Electives': 'Elecitves',            // LinkBoard's project is spelled "Elecitves"
  'TheCascadeTravel': 'Cascade Travel',
};

// Visible Sheet tabs whose project doesn't exist in LinkBoard yet: created (name only) on the first sync,
// so none of their rows are dropped. Exact names only.
const SB_CREATE_PROJECTS = ['Cloudtalk'];
// ───────────────────────────────────────────────────────────

const SB_CHUNK = 400; // rows per request (LinkBoard accepts up to 500)

/** Real run: sends rows not sent before, remembers the ones LinkBoard accepted; then syncs statuses. */
function sbSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const scan = sbScan_(false);
    const sent = sbLoadSent_();
    const fresh = scan.rows.filter(r => !sent.has(r.__key));
    Logger.log('%s row(s) scanned, %s new to send.', scan.rows.length, fresh.length);
    if (fresh.length) {
      for (const chunk of sbChunkByProject_(fresh)) {
        const res = sbPost_(chunk, false);
        Logger.log('sent %s -> created %s, already there %s, unknown projects: %s%s', chunk.length, res.created, res.skipped, JSON.stringify(res.unmatchedProjects), (res.createdProjects || []).length ? ', created project(s): ' + JSON.stringify(res.createdProjects) : '');
        const bad = new Set((res.unmatchedProjects || []).map(String));
        chunk.forEach(r => { if (!bad.has(String(r.project))) sent.add(r.__key); }); // unknown-project rows stay un-sent and are retried
      }
      sbSaveSent_(sent);
    }
    try { sbStatusRun_(false); } catch (e) { Logger.log('Status sync failed: %s', e); }
  } finally {
    lock.releaseLock();
  }
}

/** Dry run: asks LinkBoard what it WOULD create. Saves nothing, remembers nothing. */
function sbTest() {
  const scan = sbScan_(false);
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
  PropertiesService.getDocumentProperties().deleteProperty('sb_stat_n');
  Logger.log('Cleared the sent-rows and status memory.');
}

// ───────────────────────── scanning ─────────────────────────
const sbNorm_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sbDomain_ = d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();

// Old per-month sections of a project tab ("October", "September 2025", "June-July"): archived live links.
const SB_MONTH_BAND = /^\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

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

function sbScan_(forStatus) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [], tabs = [], skippedBands = [];
  const from = SB_FROM_DATE ? new Date(SB_FROM_DATE + 'T00:00:00') : null;

  ss.getSheets().forEach(sh => {
    if (sh.isSheetHidden()) return; // hidden tabs are not part of the live board
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
        // Sheets turns a typed "April 2024" band into a real date; a row whose ONLY content is such a date is a month band.
        let bandText = a;
        if (row[dateCol] instanceof Date) {
          const onlyDate = row.every((c, ci) => ci === dateCol || String(c == null ? '' : c).trim() === '');
          bandText = onlyDate ? Utilities.formatDate(row[dateCol], Session.getScriptTimeZone(), 'MMMM yyyy') : '';
        }
        if (/^\s*blog article/i.test(bandText)) continue; // a sub-label inside a section: keeps the section's status
        if (bandText && !/^\d/.test(bandText)) {
          if (skippedHere) { skippedBands.push({ tab: sh.getName(), band, count: skippedHere }); skippedHere = 0; }
          band = bandText; status = sbStatusForBand_(bandText) || (SB_MONTH_BAND.test(bandText) ? 'live' : null);
        }
        continue;
      }
      if (!/\./.test(domain) || /\s/.test(domain)) continue; // not a real domain cell
      if (!status) { skippedHere++; continue; }
      const date = sbDateStr_(row[dateCol]);
      if (!forStatus && from && date) { const [dd, mm, yy] = date.split('/'); if (new Date(Number(yy), Number(mm) - 1, Number(dd)) < from) continue; }
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
    payload: JSON.stringify({ action: 'import-rows', dry: !!dry, rows: payload, createProjects: SB_CREATE_PROJECTS }), muteHttpExceptions: true
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

// ───────────────────────── status sync ─────────────────────────
const SB_STATUS_CODE = { 'live': 'l', 'pending': 'p', 'needs-change': 'n', 'lost': 'x', 'rejected': 'r' };

/** Dry run: logs which LinkBoard statuses WOULD change (per project). Changes and remembers nothing. */
function sbStatusTest() { sbStatusRun_(true); }

function sbStatusRun_(dry) {
  const scan = sbScan_(true);
  const by = {};
  scan.rows.forEach(r => (by[r.__key] = by[r.__key] || []).push(r));
  const rows = [], conflicts = [];
  Object.keys(by).forEach(k => {
    const list = by[k], sts = [...new Set(list.map(r => r.status))];
    if (sts.length > 1) conflicts.push(list[0].project + ' / ' + list[0].domain + ' (' + sts.join(' vs ') + ')');
    else rows.push(list[0]);
  });

  const mem = sbLoadStat_();
  const cand = [];
  rows.forEach(r => {
    const h = sbHash_(r.__key), c = SB_STATUS_CODE[r.status];
    if (mem[h] === c) return; // unchanged since the last run
    cand.push({ project: r.project, domain: r.domain, status: r.status, anchor: r.anchor, linkin: r.linkin, delta: mem[h] !== undefined, __h: h, __c: c });
  });
  Logger.log('%s link row(s) in the Sheet, %s with a status to check (%s unchanged since last run).', rows.length, cand.length, rows.length - cand.length);
  if (conflicts.length) Logger.log('Same domain under DIFFERENT sections (skipped, fix in the Sheet): %s', JSON.stringify(conflicts.slice(0, 15)));

  const totals = {}, trans = {}, unknown = new Set();
  const perProject = {};
  for (const chunk of sbChunkByProject_(cand)) {
    chunk.forEach((r, i) => { r.i = i; });
    const res = sbPostStatus_(chunk.map(r => ({ i: r.i, project: r.project, domain: r.domain, status: r.status, anchor: r.anchor, linkin: r.linkin, delta: r.delta })), dry);
    (res.results || []).forEach(x => {
      const src = chunk[x.i]; if (!src) return;
      totals[x.result] = (totals[x.result] || 0) + 1;
      if (x.result === 'unknown-project') unknown.add(src.project);
      if (x.result === 'updated' || x.result === 'would-update') {
        const t = src.project + ': ' + x.from + ' -> ' + x.to;
        trans[t] = (trans[t] || 0) + 1;
        const pp = perProject[src.project] = perProject[src.project] || [];
        if (pp.length < 3) pp.push(src.domain);
      }
      if (!dry && (x.result === 'updated' || x.result === 'same' || x.result === 'protected')) mem[src.__h] = src.__c;
    });
  }
  if (!dry && cand.length) sbSaveStat_(mem);
  Object.keys(trans).sort().forEach(t => Logger.log('  %s : %s', t, trans[t]));
  Object.keys(perProject).forEach(p => Logger.log('  e.g. %s: %s', p, perProject[p].join(', ')));
  Logger.log('%s %s', dry ? 'DRY RUN, nothing changed. Result:' : 'Status sync result:', JSON.stringify(totals));
  if (totals['not-found']) Logger.log('not-found = in the Sheet but not (yet) in LinkBoard; sbSync creates those, then the next run aligns them.');
  if (totals['protected']) Logger.log('protected = LinkBoard has it live but the Sheet row is still under Pending; left alone on the first (catch-up) run.');
  if (unknown.size) Logger.log('Unknown projects (not in LinkBoard): %s', JSON.stringify([...unknown]));
}

function sbPostStatus_(rows, dry) {
  const res = UrlFetchApp.fetch(SB_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Webhook-Secret': SB_SECRET },
    payload: JSON.stringify({ action: 'update-status', dry: !!dry, rows: rows }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard status sync failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

// "Last status we saw per row": hash(project|domain) + 1-letter status code, spread over document properties.
function sbLoadStat_() {
  const props = PropertiesService.getDocumentProperties();
  const n = Number(props.getProperty('sb_stat_n') || 0), map = {};
  for (let i = 0; i < n; i++) (props.getProperty('sb_stat_' + i) || '').split(',').filter(Boolean).forEach(t => { map[t.slice(0, -1)] = t.slice(-1); });
  return map;
}

function sbSaveStat_(map) {
  const props = PropertiesService.getDocumentProperties();
  const all = Object.keys(map).map(h => h + map[h]);
  const per = 500, n = Math.ceil(all.length / per);
  for (let i = 0; i < n; i++) props.setProperty('sb_stat_' + i, all.slice(i * per, (i + 1) * per).join(','));
  props.setProperty('sb_stat_n', String(n));
}

// ───────────────────────── pending-link checker ─────────────────────────
// Uses SB_URL / SB_SECRET above. Hours of the day (script time zone):
const PC_HOURS = [9, 14, 19];
const PC_LIMIT = 40; // links checked per request (LinkBoard allows up to 80)

function pcPost_(payload) {
  const res = UrlFetchApp.fetch(SB_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Webhook-Secret': SB_SECRET },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard pending check failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

/** Real run: checks all pending links (in batches) and marks the live ones. */
function pcRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const since = Date.now(); // links already checked in THIS run are skipped
    const live = []; let checked = 0;
    for (let round = 0; round < 12; round++) {
      const r = pcPost_({ action: 'check-pending', since: since, limit: PC_LIMIT });
      checked += r.checked;
      (r.live || []).forEach(l => live.push(l.project + ' / ' + l.domain));
      Logger.log('round %s: checked %s, live %s, not found yet %s, blocked %s, errors %s; %s left', round + 1, r.checked, r.counts.live, r.counts['not-found'], r.counts.blocked, r.counts.error, r.remaining);
      if (r.remaining <= 0 || r.checked === 0) break;
    }
    Logger.log('Pending check done: %s checked, %s now live%s', checked, live.length, live.length ? ': ' + live.join(', ') : '');
  } finally {
    lock.releaseLock();
  }
}

/** Dry run: checks the first batch of pending links and logs what WOULD turn live. Changes nothing. */
function pcTest() {
  const r = pcPost_({ action: 'check-pending', since: Date.now(), limit: PC_LIMIT, dry: true });
  Logger.log('%s pending link(s), %s checkable (have Link in + Link to). First batch of %s: live %s, not found yet %s, blocked %s, errors %s.', r.pending, r.eligible, r.checked, r.counts.live, r.counts['not-found'], r.counts.blocked, r.counts.error);
  (r.live || []).forEach(l => Logger.log('  would turn live: %s / %s  (%s)', l.project, l.domain, l.linkin));
}

/** Installs the 3 daily triggers (run once). */
function pcSetup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pcRun').forEach(t => ScriptApp.deleteTrigger(t));
  PC_HOURS.forEach(h => ScriptApp.newTrigger('pcRun').timeBased().everyDays(1).atHour(h).create());
  Logger.log('Installed: pcRun runs daily at hours %s.', JSON.stringify(PC_HOURS));
}
