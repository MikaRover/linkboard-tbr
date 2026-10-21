/**
 * LinkBoard -> Google Sheet: automatically add new links as rows.
 *
 * HOW IT WORKS
 *   Every minute this script asks LinkBoard "anything new since last time?",
 *   appends the answer as rows, then tells LinkBoard it got them. Nothing is
 *   pushed into the Sheet by LinkBoard, so every way a link can be added is
 *   covered, and if the Sheet is unreachable the next run just catches up.
 *
 * SETUP (once, ~3 minutes)
 *   1. In the Sheet: Extensions -> Apps Script. Delete the sample code, paste this file.
 *   2. Edit the CONFIG block below (secret, columns, tab).
 *   3. Run `testPull` once (Run button) and approve the permissions. It only
 *      LOGS what would be added — it changes nothing.
 *   4. Run `setup` once. That installs the every-minute trigger. Done.
 *
 * To stop: Triggers (clock icon) -> delete the pullLinkBoard trigger.
 */

// ───────────────────────── CONFIG ─────────────────────────
const LINKBOARD_URL = 'https://linkboard-tbr.vercel.app/api/sheets-import';
const SECRET = 'PASTE_THE_SHEETS_WEBHOOK_SECRET_HERE'; // same value as SHEETS_WEBHOOK_SECRET in Vercel

// Which tab receives the rows:
//   TAB_PER_PROJECT = false -> everything goes to the tab named SHEET_NAME
//   TAB_PER_PROJECT = true  -> each project goes to the tab with the project's name (created if missing)
const TAB_PER_PROJECT = false;
const SHEET_NAME = 'Links';

// Column order of the sheet, left to right. Use any of:
//   date, project, domain, anchor, dr, traffic, ss, price, category,
//   linkin, linkto, builder, status, invoice, comments, paid, id
// Put '' for a column you want left empty.
const COLUMNS = ['date', 'project', 'domain', 'anchor', 'dr', 'traffic', 'price', 'linkin', 'linkto', 'builder', 'status'];

// First run only: also add links created since this date (YYYY-MM-DD). Leave '' to start from "now".
const SINCE = '';
// ───────────────────────────────────────────────────────────

function pullLinkBoard() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // a previous run is still going
  try {
    for (let round = 0; round < 10; round++) { // up to 10 x 100 links per run
      const data = fetchPage_(false);
      if (!data.items.length && !data.cursor) return;
      if (data.items.length) appendRows_(data.items);
      ack_(data.cursor);          // only AFTER the rows are in the sheet
      if (!data.more) return;
    }
  } finally {
    lock.releaseLock();
  }
}

/** Dry run: logs what the next pull would add. Changes nothing (no rows, no cursor). */
function testPull() {
  const data = fetchPage_(true);
  Logger.log('Would add %s link(s):', data.items.length);
  data.items.slice(0, 20).forEach(i => Logger.log(JSON.stringify(rowFor_(i))));
}

/** Installs the every-minute trigger (run once). */
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pullLinkBoard').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pullLinkBoard').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: pullLinkBoard runs every minute.');
}

function fetchPage_(dry) {
  const url = LINKBOARD_URL + '?pull=1' + (SINCE ? '&since=' + encodeURIComponent(SINCE) : '') + (dry ? '&dry=1' : '');
  const res = UrlFetchApp.fetch(url, { method: 'get', headers: { 'X-Webhook-Secret': SECRET }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard pull failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function ack_(cursor) {
  if (!cursor) return;
  const res = UrlFetchApp.fetch(LINKBOARD_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Webhook-Secret': SECRET },
    payload: JSON.stringify({ action: 'ack', cursor: cursor }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('LinkBoard ack failed: HTTP ' + res.getResponseCode());
}

function rowFor_(item) {
  return COLUMNS.map(c => (c && item[c] !== undefined && item[c] !== null) ? item[c] : '');
}

function appendRows_(items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const byTab = {};
  items.forEach(i => { const tab = TAB_PER_PROJECT ? (i.project || 'No project') : SHEET_NAME; (byTab[tab] = byTab[tab] || []).push(rowFor_(i)); });
  Object.keys(byTab).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(COLUMNS); } // new tab gets a header row
    const rows = byTab[name];
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLUMNS.length).setValues(rows);
  });
}
