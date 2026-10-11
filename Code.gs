/**
 * Recovery Terminal: Google Apps Script for the STOCK app.
 *
 * 1. doGet: gives the app cells of the "Prices" and "Fundamentals" tabs as JSON.
 * 2. refreshFundamentals: downloads revenue, operating cash flow, debt and cash from
 *    SEC EDGAR (XBRL frames) and writes them to the "Fundamentals" tab.
 * 3. setupTriggers: runs refreshFundamentals twice a day (07:00 and 19:00, script time zone).
 */
const SPREADSHEET_ID = '1X8IkpTcwoSuArteakh-gV4prm7xfIYPdgeTqmvg5R5g';

// SEC asks every program to identify itself with a contact e-mail. Put yours here.
const CONTACT_EMAIL = '';

// Extra CIKs to look in when a company changed its SEC registrant (older periods live there).
const EXTRA_CIKS = { XOM: [34088] };

const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenuesNetOfInterestExpense',
  'RegulatedAndUnregulatedOperatingRevenue', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'];
const OCF = ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'];
const DEBT_A = ['LongTermDebt', 'LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities', 'DebtLongtermAndShorttermCombinedAmount'];
const DEBT_NC = ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'];
const DEBT_CUR = ['LongTermDebtCurrent', 'DebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'];
const CASH = ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'];
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

// ---------------------------------------------------------------- SEC refresh
function refreshFundamentals() {
  if (!CONTACT_EMAIL) throw new Error('Fill CONTACT_EMAIL at the top of the script first (SEC requires it).');
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tickers = ss.getSheetByName('Prices').getRange('A2:A1000').getDisplayValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (t) { return t && t.indexOf(':') < 0; });

  // Ticker -> CIK list
  const secMap = tickerMap_();
  const ciksOf = {};
  const wanted = {};
  tickers.forEach(function (t) {
    const list = [];
    const main = secMap[t] || secMap[t.replace(/\./g, '-')];
    if (main) list.push(main);
    (EXTRA_CIKS[t] || []).forEach(function (c) { list.push(c); });
    ciksOf[t] = list;
    list.forEach(function (c) { wanted[c] = true; });
  });

  // Periods that move with the calendar
  const now = new Date();
  const Y = now.getUTCFullYear();
  const annual = ['CY' + Y, 'CY' + (Y - 1), 'CY' + (Y - 2)];
  const quarters = lastQuarters_(now, 2); // newest first, e.g. [{y:2026,q:3},{y:2026,q:2}]
  const qPer = [], iPer = [];
  quarters.forEach(function (x) {
    qPer.push('CY' + x.y + 'Q' + x.q, 'CY' + (x.y - 1) + 'Q' + x.q);
    iPer.push('CY' + x.y + 'Q' + x.q + 'I', 'CY' + (x.y - 1) + 'Q' + x.q + 'I');
  });
  const jobs = [];
  REV.forEach(function (t) { annual.concat(qPer).forEach(function (p) { jobs.push([t, p]); }); });
  OCF.forEach(function (t) { annual.forEach(function (p) { jobs.push([t, p]); }); });
  DEBT_A.concat(DEBT_NC, DEBT_CUR, CASH).forEach(function (t) { iPer.forEach(function (p) { jobs.push([t, p]); }); });

  const cache = {};
  let failed = 0;
  for (let i = 0; i < jobs.length; i += 8) {
    const chunk = jobs.slice(i, i + 8);
    const res = UrlFetchApp.fetchAll(chunk.map(function (j) {
      return { url: 'https://data.sec.gov/api/xbrl/frames/us-gaap/' + j[0] + '/USD/' + j[1] + '.json', headers: secHeaders_(), muteHttpExceptions: true };
    }));
    res.forEach(function (r, k) {
      const key = chunk[k][0] + '|' + chunk[k][1];
      const m = {};
      const code = r.getResponseCode();
      if (code === 200) {
        JSON.parse(r.getContentText()).data.forEach(function (d) { if (wanted[d.cik]) m[d.cik] = { val: d.val, end: d.end }; });
      } else if (code !== 404) {
        failed++;
      }
      cache[key] = m;
    });
    Utilities.sleep(1100); // SEC allows at most 10 requests per second
  }
  if (failed > jobs.length / 3) throw new Error('SEC refused ' + failed + ' of ' + jobs.length + ' requests; existing data kept.');

  const get = function (t, p, ciks) {
    const m = cache[t + '|' + p] || {};
    for (let i = 0; i < ciks.length; i++) if (m[ciks[i]]) return m[ciks[i]];
    return null;
  };
  // Best tag = the largest current value among tags present in both periods (avoids a sub-line).
  const bestPair = function (tags, a, b, ciks) {
    let best = null;
    tags.forEach(function (t) {
      const x = get(t, a, ciks), y = get(t, b, ciks);
      if (x && y && (!best || x.val > best.x.val)) best = { t: t, x: x, y: y };
    });
    return best;
  };
  const fyPair = function (tags, ciks) {
    const cur = bestPair(tags, annual[0], annual[1], ciks);
    if (cur && cur.x.end > Y + '-01-01') return cur;
    return bestPair(tags, annual[1], annual[2], ciks);
  };
  const debtAt = function (ciks, p) {
    for (let i = 0; i < DEBT_A.length; i++) { const v = get(DEBT_A[i], p, ciks); if (v) return { val: v.val, end: v.end, how: DEBT_A[i] }; }
    for (let i = 0; i < DEBT_NC.length; i++) {
      const v = get(DEBT_NC[i], p, ciks);
      if (v) {
        let cur = 0;
        for (let k = 0; k < DEBT_CUR.length; k++) { const w = get(DEBT_CUR[k], p, ciks); if (w) { cur = w.val; break; } }
        return { val: v.val + cur, end: v.end, how: DEBT_NC[i] + '+current' };
      }
    }
    return null;
  };
  const M = function (v) { return v == null ? '' : Math.round(v / 1e5) / 10; };

  const stamp = Utilities.formatDate(now, 'UTC', "yyyy-MM-dd'T'HH:mm'Z'");
  let filled = 0;
  const rows = tickers.map(function (t) {
    const ciks = ciksOf[t];
    if (!ciks.length) return [t, '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    const rf = fyPair(REV, ciks), of = fyPair(OCF, ciks);
    let rq = null;
    for (let i = 0; i < quarters.length && !rq; i++) {
      const x = quarters[i];
      rq = bestPair(REV, 'CY' + x.y + 'Q' + x.q, 'CY' + (x.y - 1) + 'Q' + x.q, ciks);
    }
    let d = null, dp = null, cash = null;
    for (let i = 0; i < quarters.length; i++) {
      const x = quarters[i], p = 'CY' + x.y + 'Q' + x.q + 'I', pp = 'CY' + (x.y - 1) + 'Q' + x.q + 'I';
      const dd = debtAt(ciks, p);
      let cc = null;
      for (let k = 0; k < CASH.length; k++) { const w = get(CASH[k], p, ciks); if (w) { cc = w.val; break; } }
      if (dd || cc != null) {
        d = dd; cash = cc;
        dp = dd ? debtAt(ciks, pp) : null;
        if (d && dp && d.how !== dp.how) dp = null;
        break;
      }
    }
    if (rf || of || rq || d) filled++;
    return [t,
      M(rf && rf.x.val), M(rf && rf.y.val), rf ? rf.x.end : '',
      M(rq && rq.x.val), M(rq && rq.y.val), rq ? rq.x.end : '',
      M(of && of.x.val), M(of && of.y.val), of ? of.x.end : '',
      M(d && d.val), M(dp && dp.val), M(cash), d ? d.end : '', ''];
  });
  if (filled < tickers.length / 3) throw new Error('Only ' + filled + ' companies got data; existing data kept.');
  if (rows.length) rows[0][14] = stamp;

  const sh = ss.getSheetByName('Fundamentals') || ss.insertSheet('Fundamentals');
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), HEADER.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
  Logger.log('Fundamentals updated: ' + filled + ' of ' + tickers.length + ' companies, ' + failed + ' failed requests, ' + stamp);
}

function tickerMap_() {
  const r = UrlFetchApp.fetch('https://www.sec.gov/files/company_tickers.json', { headers: secHeaders_(), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('SEC ticker list: HTTP ' + r.getResponseCode());
  const out = {};
  const j = JSON.parse(r.getContentText());
  Object.keys(j).forEach(function (k) { const t = String(j[k].ticker).toUpperCase(); if (!out[t]) out[t] = j[k].cik_str; });
  return out;
}

function secHeaders_() {
  return { 'User-Agent': 'STOCK dashboard ' + CONTACT_EMAIL };
}

// The last n calendar quarters that have ended, newest first.
function lastQuarters_(now, n) {
  let y = now.getUTCFullYear(), q = Math.floor(now.getUTCMonth() / 3); // q = current quarter - 1 = last ended quarter
  if (q === 0) { q = 4; y -= 1; }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ y: y, q: q });
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

// ---------------------------------------------------------------- setup and tests
/** Run once: refreshes the fundamentals at 07:00 and 19:00 every day. */
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

/** Checks that SEC answers this script. */
function testSec() {
  if (!CONTACT_EMAIL) throw new Error('Fill CONTACT_EMAIL first.');
  const r = UrlFetchApp.fetch('https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025.json', { headers: secHeaders_(), muteHttpExceptions: true });
  Logger.log('SEC answered HTTP ' + r.getResponseCode() + (r.getResponseCode() === 200 ? ', companies: ' + JSON.parse(r.getContentText()).data.length : ''));
}
