// Downloads revenue, operating cash flow, debt and cash from SEC EDGAR (XBRL frames)
// for every company in data/sp500.json and data/watchlist.json, and writes
// data/fundamentals.json ($ millions). Run by .github/workflows/sec.yml twice a day.
import fs from 'node:fs';

const CONTACT = process.env.SEC_CONTACT || '';
if (!CONTACT) { console.error('Set the SEC_CONTACT secret (your e-mail): SEC requires it.'); process.exit(1); }
// SEC wants "Name Surname email@example.com"; a bare e-mail gets a short app name in front.
const UA = {
  'User-Agent': CONTACT.includes(' ') ? CONTACT.trim() : `STOCK-dashboard ${CONTACT.trim()}`,
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate',
};
const EXTRA_CIKS = { XOM: [34088] };

const REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenuesNetOfInterestExpense',
  'RegulatedAndUnregulatedOperatingRevenue', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'];
const OCF = ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'];
const DEBT_A = ['LongTermDebt', 'LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities', 'DebtLongtermAndShorttermCombinedAmount'];
const DEBT_NC = ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'];
const DEBT_CUR = ['LongTermDebtCurrent', 'DebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'];
const CASH = ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let refused = 0;
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 200);
    console.log(`HTTP ${r.status} for ${url} (try ${i + 1}): ${body}`);
    if (r.status === 403 && ++refused >= 6) {
      console.error('SEC keeps answering 403 (forbidden). Check the SEC_CONTACT secret: it must be "Name Surname email@example.com".');
      process.exit(1);
    }
    await sleep(3000 * (i + 1));
  }
  return null;
}
console.log(`User-Agent sent to SEC: ${UA['User-Agent'].replace(/[^@\s]+@/, '***@')}`);

const sp = JSON.parse(fs.readFileSync('data/sp500.json', 'utf8'));
const wl = JSON.parse(fs.readFileSync('data/watchlist.json', 'utf8'));
const tickers = [...new Set([...sp.map((r) => r.Symbol), ...wl.map((r) => r.Symbol)])];
const spCik = Object.fromEntries(sp.map((r) => [r.Symbol, Number(r.CIK)]));

// Ticker -> CIKs (S&P list first, then SEC's own ticker file)
const secTickers = await getJson('https://www.sec.gov/files/company_tickers.json'); // only needed for companies outside the S&P 500 list
const secMap = {};
for (const v of Object.values(secTickers || {})) { const t = String(v.ticker).toUpperCase(); if (!secMap[t]) secMap[t] = v.cik_str; }
const ciksOf = {}, wanted = new Set();
for (const t of tickers) {
  const main = spCik[t] || secMap[t] || secMap[t.replace(/\./g, '-')];
  const list = [...(main ? [main] : []), ...(EXTRA_CIKS[t] || [])];
  ciksOf[t] = list; list.forEach((c) => wanted.add(c));
}

// Periods that move with the calendar
const now = new Date();
const Y = now.getUTCFullYear();
const annual = [`CY${Y}`, `CY${Y - 1}`, `CY${Y - 2}`];
const quarters = [];
{ let y = Y, q = Math.floor(now.getUTCMonth() / 3); if (q === 0) { q = 4; y -= 1; }
  for (let i = 0; i < 2; i++) { quarters.push({ y, q }); q -= 1; if (q === 0) { q = 4; y -= 1; } } }
const qPer = quarters.flatMap((x) => [`CY${x.y}Q${x.q}`, `CY${x.y - 1}Q${x.q}`]);
const iPer = quarters.flatMap((x) => [`CY${x.y}Q${x.q}I`, `CY${x.y - 1}Q${x.q}I`]);
const jobs = [
  ...REV.flatMap((t) => [...annual, ...qPer].map((p) => [t, p])),
  ...OCF.flatMap((t) => annual.map((p) => [t, p])),
  ...[...DEBT_A, ...DEBT_NC, ...DEBT_CUR, ...CASH].flatMap((t) => iPer.map((p) => [t, p])),
];

const cache = {};
for (const [t, p] of jobs) {
  const j = await getJson(`https://data.sec.gov/api/xbrl/frames/us-gaap/${t}/USD/${p}.json`);
  const m = new Map();
  for (const d of (j && j.data) || []) if (wanted.has(d.cik)) m.set(d.cik, { val: d.val, end: d.end });
  cache[`${t}|${p}`] = m;
  await sleep(250); // SEC allows at most 10 requests per second
}

const get = (t, p, ciks) => { const m = cache[`${t}|${p}`]; if (!m) return null; for (const c of ciks) if (m.has(c)) return m.get(c); return null; };
const bestPair = (tags, a, b, ciks) => {
  let best = null;
  for (const t of tags) { const x = get(t, a, ciks), y = get(t, b, ciks); if (x && y && (!best || x.val > best.x.val)) best = { t, x, y }; }
  return best;
};
const fyPair = (tags, ciks) => {
  const cur = bestPair(tags, annual[0], annual[1], ciks);
  if (cur && cur.x.end > `${Y}-01-01`) return cur;
  return bestPair(tags, annual[1], annual[2], ciks);
};
const debtAt = (ciks, p) => {
  for (const t of DEBT_A) { const v = get(t, p, ciks); if (v) return { val: v.val, end: v.end, how: t }; }
  for (const t of DEBT_NC) {
    const v = get(t, p, ciks);
    if (v) { let cur = 0; for (const c of DEBT_CUR) { const w = get(c, p, ciks); if (w) { cur = w.val; break; } } return { val: v.val + cur, end: v.end, how: `${t}+current` }; }
  }
  return null;
};
const M = (v) => (v == null ? '' : String(Math.round(v / 1e5) / 10));

let filled = 0;
const rows = tickers.map((t) => {
  const ciks = ciksOf[t];
  const rf = ciks.length ? fyPair(REV, ciks) : null, of = ciks.length ? fyPair(OCF, ciks) : null;
  let rq = null;
  for (const x of quarters) { if (rq || !ciks.length) break; rq = bestPair(REV, `CY${x.y}Q${x.q}`, `CY${x.y - 1}Q${x.q}`, ciks); }
  let d = null, dp = null, cash = null;
  for (const x of quarters) {
    if (!ciks.length) break;
    const p = `CY${x.y}Q${x.q}I`, pp = `CY${x.y - 1}Q${x.q}I`;
    const dd = debtAt(ciks, p);
    let cc = null; for (const c of CASH) { const w = get(c, p, ciks); if (w) { cc = w.val; break; } }
    if (dd || cc != null) { d = dd; cash = cc; dp = dd ? debtAt(ciks, pp) : null; if (d && dp && d.how !== dp.how) dp = null; break; }
  }
  if (rf || of || rq || d) filled++;
  return {
    Symbol: t,
    rev_fy: M(rf?.x.val), rev_fy_prev: M(rf?.y.val), fy_end: rf?.x.end || '',
    rev_q: M(rq?.x.val), rev_q_prev: M(rq?.y.val), q_end: rq?.x.end || '',
    ocf_fy: M(of?.x.val), ocf_fy_prev: M(of?.y.val), ocf_fy_end: of?.x.end || '',
    debt: M(d?.val), debt_prev: M(dp?.val), cash: M(cash), bs_date: d?.end || '',
  };
});
if (filled < tickers.length / 3) { console.error(`Only ${filled} of ${tickers.length} companies got data; file left unchanged.`); process.exit(1); }
const updated = now.toISOString().slice(0, 16) + 'Z';
if (rows.length) rows[0].updated = updated;
fs.writeFileSync('data/fundamentals.json', JSON.stringify(rows));
console.log(`Fundamentals updated: ${filled} of ${tickers.length} companies, ${updated}`);
