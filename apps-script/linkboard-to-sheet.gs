/**
 * LinkBoard -> "TBR | Link Building working board": new links appear in the
 * project's tab, at the top of its "Pending" section, automatically.
 *
 * HOW IT WORKS
 *   Every minute this script asks LinkBoard "anything new since last time?",
 *   inserts a row for each new link into the matching project tab (e.g. the
 *   "Renderforest 20" tab for project Renderforest), then tells LinkBoard it
 *   got them. LinkBoard never pushes into the Sheet, so every way a link can be
 *   added is covered, and if the Sheet is unreachable the next run catches up.
 *
 * WHAT IT DOES TO THE BOARD
 *   - New links always go to the TOP of the "Pending" section (that's where
 *     the team starts every link; moving it to "live" stays manual).
 *   - Columns are found by their header names (Domain, DR, Traffic, SS, Price,
 *     Link in, Link to, Anchor text, Invoice link, Builder Name, Comments) and
 *     the Date column is the one headed "Date" (or column A).
 *   - A domain that is ALREADY in that tab (any section) is skipped — so rows
 *     your team typed by hand are never duplicated.
 *   - A project with no matching tab is NOT lost: its row goes to a tab called
 *     "LinkBoard inbox" (created on first use).
 *
 * SETUP (once, ~3 minutes)
 *   1. In the Sheet: Extensions -> Apps Script -> "+" next to Files -> Script,
 *      name it "LinkBoard pull", paste this whole file. (Leave your existing
 *      TBR Tools script alone — nothing here overlaps it.)
 *   2. Put the secret in CONFIG below (same value as SHEETS_WEBHOOK_SECRET in Vercel).
 *   3. Run `testPull` once and approve the permissions. It only LOGS what it
 *      would do — it changes nothing.
 *   4. Run `setup` once. That installs the every-minute trigger. Done.
 *
 * To stop: Triggers (clock icon) -> delete the lbPull trigger.
 */

// ───────────────────────── CONFIG ─────────────────────────
const LB_URL = 'https://linkboard-tbr.vercel.app/api/sheets-import';
const LB_SECRET = 'PASTE_THE_SHEETS_WEBHOOK_SECRET_HERE';

// First run only: also add links created since this date (YYYY-MM-DD). '' = start from "now".
const LB_SINCE = '';

// LinkBoard project name -> tab name (without the trailing number), ONLY for names that
// don't match by themselves. Matching ignores case, spaces, punctuation and the " 20" count.
const LB_TAB_ALIASES = {
  // 'Cascade Travel': 'TheCascadeTravel',
};

const LB_PENDING_HEADER = /^\s*pending/i; // the band row (in column A) that starts the Pending section
const LB_INBOX_TAB = 'LinkBoard inbox';
// ───────────────────────────────────────────────────────────

function lbPull() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // a previous run is still going
  try {
    for (let round = 0; round < 10; round++) { // up to 10 x 100 links per run
      const data = lbFetch_(false);
      if (data.items.length) lbWrite_(data.items, false);
      lbAck_(data.cursor);          // only AFTER the rows are in the sheet (a retry can't duplicate: domains already present are skipped)
      if (!data.more) return;
    }
  } finally {
    lock.releaseLock();
  }
}

/** Dry run: logs where each pending link WOULD go. Changes nothing (no rows, no cursor). */
function testPull() {
  const data = lbFetch_(true);
  Logger.log('%s new link(s) waiting.', data.items.length);
  lbWrite_(data.items, true);
}

/** Installs the every-minute trigger (run once). */
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'lbPull').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('lbPull').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: lbPull runs every minute.');
}

// ───────────────────────── LinkBoard API ─────────────────────────
function lbFetch_(dry) {
  const url = LB_URL + '?pull=1' + (LB_SINCE ? '&since=' + encodeURIComponent(LB_SINCE) : '') + (dry ? '&dry=1' : '');
  const res = UrlFetchApp.fetch(url, { method: 'get', headers: { 'X-Webhook-Secret': LB_SECRET }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard pull failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function lbAck_(cursor) {
  if (!cursor) return;
  const res = UrlFetchApp.fetch(LB_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Webhook-Secret': LB_SECRET },
    payload: JSON.stringify({ action: 'ack', cursor: cursor }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard ack failed: HTTP ' + res.getResponseCode());
}

// ───────────────────────── Sheet writing ─────────────────────────
const lbNorm_ = s => String(s || '').toLowerCase().replace(/\s+\d+\s*$/, '').replace(/[^a-z0-9]/g, '');
const lbDomain_ = d => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();

function lbTabFor_(ss, project) {
  const want = lbNorm_(LB_TAB_ALIASES[project] || project);
  return ss.getSheets().find(sh => lbNorm_(sh.getName()) === want) || null;
}

function lbWrite_(items, dry) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  items.forEach(item => {
    const sh = lbTabFor_(ss, item.project);
    if (!sh) {
      Logger.log('[%s] %s -> no tab for project "%s" -> goes to "%s"', item.id, item.domain, item.project, LB_INBOX_TAB);
      if (!dry) lbInbox_(ss, item);
      return;
    }
    if (lbHasDomain_(sh, item.domain)) { Logger.log('[%s] %s -> already in "%s" — skipped', item.id, item.domain, sh.getName()); return; }
    Logger.log('[%s] %s -> "%s", top of Pending', item.id, item.domain, sh.getName());
    if (!dry) lbAddPending_(sh, item);
  });
}

function lbHeaderMap_(sh) {
  const headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { const k = String(h || '').toLowerCase().replace(/[^a-z]/g, ''); if (k && !(k in map)) map[k] = i + 1; });
  return map;
}

function lbHasDomain_(sh, domain) {
  const map = lbHeaderMap_(sh);
  const col = map.domain || 2;
  const last = sh.getLastRow();
  if (last < 2) return false;
  const vals = sh.getRange(2, col, last - 1, 1).getValues();
  const want = lbDomain_(domain);
  return vals.some(r => lbDomain_(r[0]) === want);
}

function lbPendingRow_(sh) {
  const last = sh.getLastRow();
  if (last < 1) return 0;
  const colA = sh.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < colA.length; i++) if (LB_PENDING_HEADER.test(String(colA[i][0]))) return i + 1;
  return 0;
}

function lbParseDate_(s) {
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, Number(m[2]) - 1, Number(m[1]));
}

function lbAddPending_(sh, item) {
  const map = lbHeaderMap_(sh);
  const lastCol = sh.getLastColumn();
  const pendingRow = lbPendingRow_(sh);
  let r;
  if (pendingRow) { sh.insertRowAfter(pendingRow); r = pendingRow + 1; }
  else { r = sh.getLastRow() + 1; }

  const rng = sh.getRange(r, 1, 1, lastCol);
  rng.clearFormat(); // an inserted row inherits the orange "Pending" band — start plain

  const set = (key, value, fmt) => {
    const col = map[key]; if (!col || value === '' || value == null) return;
    const c = sh.getRange(r, col);
    c.setValue(value);
    if (fmt) c.setNumberFormat(fmt);
  };
  const d = lbParseDate_(item.date);
  if (d) { sh.getRange(r, map.date || 1).setValue(d).setNumberFormat('dd.mm.yyyy'); }
  else if (item.date) { sh.getRange(r, map.date || 1).setValue(item.date); }
  set('domain', item.domain);
  const num = v => (v === '' || v == null || isNaN(Number(String(v).replace(/[,%$\s]/g, '')))) ? v : Number(String(v).replace(/[,%$\s]/g, ''));
  set('dr', num(item.dr));
  set('traffic', num(item.traffic));
  const ss = num(item.ss); // LinkBoard stores spam score as 2 = 2%; the sheet shows 2% (value 0.02)
  set('ss', (typeof ss === 'number' && ss > 0 && ss <= 100) ? ss / 100 : ss, '0%');
  const price = num(item.price);
  set('price', price, typeof price === 'number' ? '$#,##0.##' : null);
  set('linkin', item.linkin);
  set('linkto', item.linkto);
  set('anchortext', item.anchor);
  set('invoicelink', item.invoice);
  set('buildername', item.builder);
  set('comments', item.comments);

  // Builder Name is a dropdown — give the new row the same validation as its neighbour below.
  try {
    const bc = map.buildername;
    if (bc && pendingRow && r + 1 <= sh.getLastRow()) sh.getRange(r + 1, bc).copyTo(sh.getRange(r, bc), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  } catch (e) { /* cosmetic only */ }
}

function lbInbox_(ss, item) {
  const header = ['Date', 'Project', 'Domain', 'Anchor text', 'DR', 'Traffic', 'SS', 'Price', 'Link in', 'Link to', 'Builder', 'Status', 'LinkBoard id'];
  let sh = ss.getSheetByName(LB_INBOX_TAB);
  if (!sh) { sh = ss.insertSheet(LB_INBOX_TAB); sh.appendRow(header); sh.setFrozenRows(1); }
  sh.appendRow([item.date, item.project, item.domain, item.anchor, item.dr, item.traffic, item.ss, item.price, item.linkin, item.linkto, item.builder, item.status, item.id]);
}
