/**
 * Recovery Terminal: Google Apps Script for the STOCK app.
 *
 * 1. doGet: gives the app cells of the "Prices" and "Fundamentals" tabs as JSON.
 * 2. refreshFundamentals: copies fundamentals.json from your GitHub Pages site
 *    (GitHub refreshes it from SEC twice a day) into the "Fundamentals" tab.
 * 3. setupTriggers: runs refreshFundamentals twice a day (07:00 and 19:00, script time zone).
 */
const SPREADSHEET_ID = '1X8IkpTcwoSuArteakh-gV4prm7xfIYPdgeTqmvg5R5g';

// Your site's address + /fundamentals.json, e.g. 'https://gochamosashvili.github.io/stockGM/fundamentals.json'
const FUND_URL = 'https://gochamosashvili.github.io/stockGM/fundamentals.json';

const HEADER = ['Symbol', 'rev_fy', 'rev_fy_prev', 'fy_end', 'rev_q', 'rev_q_prev', 'q_end', 'ocf_fy', 'ocf_fy_prev',
  'ocf_fy_end', 'debt', 'debt_prev', 'cash', 'bs_date', 'updated'];

// ---------------------------------------------------------------- web app
function doGet(e) {
  const range = String((e && e.parameter && e.parameter.range) || 'Prices!A1:N521');
  const ok = /^Prices!A[1-9]\d{0,2}:[A-O][1-9]\d{0,2}$/.test(range) || /^Fundamentals!A1:[A-O][1-9]\d{0,2}$/.test(range);
  if (!ok) return json_({ error: 'Range not allowed: ' + range });
  try {
    const values = SpreadsheetApp.openById(SPREADSHEET_ID).getRange(range).getDisplayValues();
    return json_({ range: range, values: values });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- fundamentals
function refreshFundamentals() {
  if (!FUND_URL) throw new Error('Fill FUND_URL at the top of the script first.');
  const r = UrlFetchApp.fetch(FUND_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('GitHub answered HTTP ' + r.getResponseCode() + '; existing data kept.');
  const data = JSON.parse(r.getContentText());
  if (!Array.isArray(data) || data.length < 100) throw new Error('Unexpected file content; existing data kept.');
  const rows = data.map(function (o) { return HEADER.map(function (k) { return o[k] == null ? '' : o[k]; }); });

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('Fundamentals') || ss.insertSheet('Fundamentals');
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), HEADER.length).clearContent();
  sh.getRange(2, 1, rows.length, HEADER.length).setNumberFormat('@').setValues(rows);
  Logger.log('Fundamentals copied: ' + rows.length + ' companies, SEC data from ' + (data[0].updated || '?'));
}

// ---------------------------------------------------------------- setup and tests
/** Run once: copies the fundamentals at 07:00 and 19:00 every day. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshFundamentals') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshFundamentals').timeBased().atHour(7).everyDays(1).create();
  ScriptApp.newTrigger('refreshFundamentals').timeBased().atHour(19).everyDays(1).create();
  Logger.log('Triggers set: 07:00 and 19:00 (' + Session.getScriptTimeZone() + ')');
}

/** Checks that the web app part works. */
function test() {
  Logger.log(doGet({ parameter: { range: 'Prices!A1:N3' } }).getContent());
}
