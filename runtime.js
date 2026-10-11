// Recovery Terminal PWA runtime.
// Provides the small `dash` API the dashboard code expects (loaders, calculations, data,
// parameters), loads prices and SEC fundamentals from your Google Apps Script web app,
// and, when a Finnhub key is set, streams live prices for the companies on screen.
(function () {
  'use strict';

  var DEFAULTS = {
    mine: true, sector: null, sub: null, q: null, pick: null,
    dd_min: 30, dd_max: null, up_min: null, up_max: 50,
    share_max: 25, weeks_min: 8, health: 'ok', hist_range: 'Prices!A4:O4'
  };
  var PRICES_RANGE = 'Prices!A1:N521';
  var FUND_RANGE = 'Fundamentals!A1:O600';
  var PRICE_MS = 30 * 1000;            // prices from Google every 30 seconds while the app is open
  var FUND_MS = 30 * 60 * 1000;        // fundamentals tab every 30 minutes (SEC refresh runs twice a day)
  var LIVE_APPLY_MS = 5 * 1000;        // live Finnhub prices are applied at most every 5 seconds
  var LIVE_MAX = 50;                   // symbols streamed at once
  var LS_PARAMS = 'rt.params', LS_URL = 'rt.apiUrl', LS_KEY = 'rt.finnhub', LS_CACHE = 'rt.cache.';

  // ---------- storage helpers (storage can be unavailable) ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function apiUrl() {
    var fromCfg = (window.STOCK_CONFIG && window.STOCK_CONFIG.API_URL) || '';
    return (lsGet(LS_URL) || fromCfg || '').trim();
  }
  function finnhubKey() {
    var fromCfg = (window.STOCK_CONFIG && window.STOCK_CONFIG.FINNHUB_KEY) || '';
    return (lsGet(LS_KEY) || fromCfg || '').trim();
  }

  var P = Object.assign({}, DEFAULTS);
  try { Object.assign(P, JSON.parse(lsGet(LS_PARAMS) || '{}')); } catch (e) { /* ignore */ }

  var loaders = {}, calcs = [], subs = [], D = {}, meta = { prices: null, fund: null };
  var FILES = { sp500: 'sp500.json', watchlist: 'watchlist.json', fundamentals: 'fundamentals.json' };

  // ---------- notify (coalesced) ----------
  var pending = false;
  function notify() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      recompute();
      subs.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
      status();
    }, 0);
  }

  // ---------- calculations ----------
  function recompute() {
    calcs.forEach(function (c) {
      var ins = c.inputs.map(function (id) { return D[id] || { status: 'loading' }; });
      if (ins.some(function (x) { return x.status === 'error'; })) { D[c.id] = { status: 'error', data: [] }; return; }
      if (!ins.every(function (x) { return x.status === 'ok'; })) { D[c.id] = { status: 'loading', data: [] }; return; }
      var key = ins.map(function (x) { return x.rev; }).join('|');
      if (D[c.id] && D[c.id].key === key) return;
      try {
        var out = c.fn.apply(null, ins.map(function (x) { return x.data; }));
        D[c.id] = { status: 'ok', data: out, key: key, rev: key + '>' + c.id };
      } catch (e) {
        console.error('calc ' + c.id, e);
        D[c.id] = { status: 'error', data: [], key: key };
      }
    });
  }
  var revN = 0;
  function setData(id, obj) { obj.rev = ++revN; D[id] = obj; notify(); }

  // ---------- fetching from the Apps Script ----------
  function fetchSheet(range) {
    var url = apiUrl();
    if (!url) return Promise.reject(new Error('NO_URL'));
    var u = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'range=' + encodeURIComponent(range) + '&t=' + Date.now();
    return fetch(u, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      var j = JSON.parse(text);
      if (j && j.error) throw new Error(j.error);
      return j;
    });
  }

  function loadFile(id) {
    fetch(FILES[id]).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rows) {
        if (id === 'fundamentals' && rows[0] && rows[0].updated && (!meta.fund || rows[0].updated > meta.fund)) meta.fund = rows[0].updated;
        setData(id, { status: 'ok', data: rows });
      })
      .catch(function (e) { console.error(id, e); setData(id, { status: 'error', data: [] }); });
  }

  // ---------- prices (Google) + live overrides (Finnhub) ----------
  var basePrices = null;   // rows as the sheet gives them
  var live = {};           // symbol -> { p: last price, pc: previous close, at: ms }
  function publishPrices() {
    if (!basePrices) return;
    var n = 0;
    var rows = basePrices.map(function (r) {
      var l = live[r.Symbol];
      if (!l || !(l.p > 0) || typeof r.price !== 'number') return r;
      n++;
      var o = Object.assign({}, r), p = l.p;
      var hi = typeof r.high_52w === 'number' ? Math.max(r.high_52w, p) : null;
      var lo = typeof r.low_52w === 'number' ? Math.min(r.low_52w, p) : null;
      o.price = p;
      if (hi) { o.high_52w = hi; o.from_high = p / hi - 1; }
      if (lo) { o.low_52w = lo; o.from_low = p / lo - 1; }
      var prev = l.pc > 0 ? l.pc : (typeof r.day_change === 'number' ? r.price / (1 + r.day_change) : null);
      if (prev) o.day_change = p / prev - 1;
      if (typeof r.ret_1y === 'number') o.ret_1y = p / (r.price / (1 + r.ret_1y)) - 1;
      o.live = 'Yes';
      return o;
    });
    meta.liveCount = n;
    setData('prices', { status: 'ok', data: rows });
  }

  var loadingPrices = false, lastError = null;
  function usePricesJson(json) {
    basePrices = loaders.prices.fn({ answer: json }).rows;
    publishPrices();
  }
  function loadPrices(force) {
    if (loadingPrices || !loaders.prices) return;
    if (!basePrices) {
      var cached = lsGet(LS_CACHE + 'prices');
      if (cached) {
        try { var c = JSON.parse(cached); meta.prices = { at: c.at, offline: true }; usePricesJson(c.json); } catch (e) { lsDel(LS_CACHE + 'prices'); }
      }
    }
    if (!force && meta.prices && !meta.prices.offline && Date.now() - meta.prices.at < PRICE_MS / 2) return;
    loadingPrices = true; status();
    fetchSheet(PRICES_RANGE).then(function (json) {
      var at = Date.now();
      lsSet(LS_CACHE + 'prices', JSON.stringify({ at: at, json: json }));
      var first = !meta.prices || meta.prices.offline;
      meta.prices = { at: at, offline: false };
      lastError = null;
      usePricesJson(json);
      if (first) loadHistory();
    }).catch(function (e) {
      lastError = e.message === 'NO_URL' ? 'NO_URL' : 'OFFLINE';
      if (meta.prices) meta.prices.offline = true;
      if (!D.prices) setData('prices', { status: 'error', data: [] });
    }).then(function () { loadingPrices = false; status(); });
  }

  // ---------- fundamentals tab (SEC, refreshed by the Apps Script) ----------
  function loadFund() {
    if (!loaders.fundamentals_live) { setData('fundamentals_live', { status: 'ok', data: [] }); return; }
    var use = function (json) {
      var res = loaders.fundamentals_live.fn({ answer: json });
      var upd = (res.meta || []).filter(function (m) { return m.label === 'Updated'; })[0];
      if (upd && upd.value && (!meta.fund || upd.value > meta.fund)) meta.fund = upd.value;
      setData('fundamentals_live', { status: 'ok', data: res.rows });
    };
    var cached = lsGet(LS_CACHE + 'fund');
    if (!D.fundamentals_live) {
      if (cached) { try { use(JSON.parse(cached)); } catch (e) { lsDel(LS_CACHE + 'fund'); } }
      if (!D.fundamentals_live) setData('fundamentals_live', { status: 'ok', data: [] });
    }
    fetchSheet(FUND_RANGE).then(function (json) {
      lsSet(LS_CACHE + 'fund', JSON.stringify(json));
      use(json);
    }).catch(function () { /* keep the snapshot */ });
  }

  // ---------- history of the picked company ----------
  var histToken = 0;
  function loadHistory() {
    if (!loaders.history) return;
    var range = P.hist_range;
    var my = ++histToken;
    var key = LS_CACHE + 'h.' + range;
    var cached = lsGet(key);
    var use = function (json) {
      var res = loaders.history.fn({ answer: json });
      setData('history', { status: 'ok', data: res.data, meta: res.meta || [] });
    };
    if (cached) {
      try { use(JSON.parse(cached)); } catch (e) { lsDel(key); }
    } else {
      setData('history', { status: 'loading', data: [], meta: [] });
    }
    fetchSheet(range).then(function (json) {
      if (my !== histToken) return;
      saveHistory(key, json);
      use(json);
    }).catch(function () {
      if (my !== histToken) return;
      if (!cached) setData('history', { status: 'error', data: [], meta: [] });
    });
  }
  // keep at most 12 company histories on the device
  function saveHistory(key, json) {
    var list = [];
    try { list = JSON.parse(lsGet(LS_CACHE + 'h.list') || '[]'); } catch (e) { list = []; }
    list = list.filter(function (k) { return k !== key; });
    list.push(key);
    while (list.length > 12) lsDel(list.shift());
    lsSet(key, JSON.stringify(json));
    lsSet(LS_CACHE + 'h.list', JSON.stringify(list));
  }

  // ---------- Finnhub: live prices for the symbols on screen ----------
  var ws = null, wsOpen = false, wsRetry = 0, subscribed = {}, wanted = [], quoteQueue = [], quoteBusy = false, lastApply = 0, applyTimer = null;
  function fhSymbol(s) { return /^[A-Z][A-Z.]{0,6}$/.test(s) ? s : null; }
  function scheduleApply() {
    if (applyTimer) return;
    var wait = Math.max(0, LIVE_APPLY_MS - (Date.now() - lastApply));
    applyTimer = setTimeout(function () { applyTimer = null; lastApply = Date.now(); publishPrices(); }, wait);
  }
  function watchSymbols(list) {
    var seen = {}, next = [];
    (list || []).forEach(function (s) { var f = fhSymbol(s); if (f && !seen[f] && next.length < LIVE_MAX) { seen[f] = true; next.push(f); } });
    if (next.join(',') === wanted.join(',')) return;
    wanted = next;
    if (!finnhubKey()) return;
    syncSubscriptions();
    next.forEach(function (s) { if (!live[s] && quoteQueue.indexOf(s) < 0) quoteQueue.push(s); });
    pumpQuotes();
  }
  function connect() {
    if (ws || !finnhubKey() || !('WebSocket' in window)) return;
    try { ws = new WebSocket('wss://ws.finnhub.io?token=' + encodeURIComponent(finnhubKey())); } catch (e) { ws = null; return; }
    ws.onopen = function () { wsOpen = true; wsRetry = 0; subscribed = {}; syncSubscriptions(); status(); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== 'trade' || !m.data) return;
      m.data.forEach(function (t) {
        var cur = live[t.s] || {};
        if (!cur.at || t.t >= cur.at) live[t.s] = { p: t.p, pc: cur.pc, at: t.t };
      });
      scheduleApply();
    };
    ws.onclose = function () {
      ws = null; wsOpen = false; status();
      if (!finnhubKey()) return;
      wsRetry = Math.min(wsRetry + 1, 6);
      setTimeout(connect, 1000 * Math.pow(2, wsRetry));
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  function syncSubscriptions() {
    if (!ws || !wsOpen) { connect(); return; }
    var want = {};
    wanted.forEach(function (s) { want[s] = true; });
    Object.keys(subscribed).forEach(function (s) { if (!want[s]) { ws.send(JSON.stringify({ type: 'unsubscribe', symbol: s })); delete subscribed[s]; } });
    wanted.forEach(function (s) { if (!subscribed[s]) { ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); subscribed[s] = true; } });
  }
  // A snapshot quote per newly shown symbol (free plan: 60 requests a minute), so the price
  // is current before the first trade arrives, and also outside market hours.
  function pumpQuotes() {
    if (quoteBusy || !quoteQueue.length || !finnhubKey()) return;
    quoteBusy = true;
    var s = quoteQueue.shift();
    fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(s) + '&token=' + encodeURIComponent(finnhubKey()), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (q) {
        if (q && q.c > 0) {
          var cur = live[s] || {};
          var at = (q.t || 0) * 1000;
          live[s] = (cur.at && cur.at > at) ? { p: cur.p, pc: q.pc, at: cur.at } : { p: q.c, pc: q.pc, at: at };
          scheduleApply();
        }
      })
      .catch(function () { /* ignore one symbol */ })
      .then(function () { setTimeout(function () { quoteBusy = false; pumpQuotes(); }, 1100); });
  }
  // the first shown symbol (the picked company) gets a fresh quote every 30 s
  function requoteFirst() { if (wanted[0] && quoteQueue.indexOf(wanted[0]) < 0) { quoteQueue.unshift(wanted[0]); pumpQuotes(); } }
  function resetLive() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { /* ignore */ } }
    ws = null; wsOpen = false; subscribed = {}; live = {}; quoteQueue = []; meta.liveCount = 0;
    var w = wanted; wanted = []; publishPrices(); watchSymbols(w);
  }

  // ---------- status line + settings ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function status() {
    var src = document.querySelector('.rt-src');
    if (!src) return;
    var el = document.getElementById('rt-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rt-status';
      el.className = 'rt-status';
      var txt = document.createElement('span'); txt.className = 'rt-status-t';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'rt-refresh'; btn.textContent = '⟳';
      btn.title = 'განახლება'; btn.setAttribute('aria-label', 'განახლება');
      btn.addEventListener('click', function () { loadPrices(true); loadFund(); requoteFirst(); });
      var gear = document.createElement('button');
      gear.type = 'button'; gear.className = 'rt-refresh'; gear.textContent = '⚙';
      gear.title = 'პარამეტრები'; gear.setAttribute('aria-label', 'პარამეტრები');
      gear.addEventListener('click', function () { settings(true); });
      el.append(txt, btn, gear);
      src.append(el);
    }
    var parts = [];
    var m = meta.prices;
    if (loadingPrices && !m) parts.push('იტვირთება…');
    if (m) parts.push('Google ' + hhmm(m.at) + (m.offline ? ' · ოფლაინ' : ''));
    if (!m && lastError === 'OFFLINE') parts.push('კავშირი არ არის');
    if (finnhubKey()) parts.push(wsOpen ? 'ცოცხალი: ' + (meta.liveCount || 0) : 'Finnhub: კავშირი…');
    if (meta.fund) parts.push('SEC ' + meta.fund.slice(0, 10));
    el.querySelector('.rt-status-t').textContent = parts.join(' · ');
    if (!apiUrl()) settings(true);
  }

  function settings(open) {
    var box = document.getElementById('rt-setup');
    if (!open) { if (box) box.remove(); return; }
    if (box) return;
    var host = document.querySelector('.rt');
    if (!host) return;
    box = document.createElement('div');
    box.id = 'rt-setup'; box.className = 'rt-card rt-setup';
    box.innerHTML =
      '<h2 class="rt-h">პარამეტრები</h2>' +
      '<label class="rt-note" for="rt-set-url">Google Apps Script-ის Web app მისამართი (მთავრდება /exec-ით)</label>' +
      '<div class="rt-setup-row"><input id="rt-set-url" class="rt-search rt-setup-in" type="url" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<label class="rt-note" for="rt-set-key" style="display:block;margin-top:10px">Finnhub API key ცოცხალი ფასებისთვის (არასავალდებულო). ინახება მხოლოდ ამ ტელეფონზე.</label>' +
      '<div class="rt-setup-row"><input id="rt-set-key" class="rt-search rt-setup-in" type="text" autocomplete="off" spellcheck="false" placeholder="მაგ. d1abc…"></div>' +
      '<div class="rt-setup-row"><button type="button" class="rt-btn rt-setup-ok">შენახვა</button><button type="button" class="rt-btn rt-ghost rt-setup-x">დახურვა</button></div>' +
      '<p class="rt-note rt-setup-msg"></p>';
    host.insertBefore(box, host.children[1] || null);
    var url = box.querySelector('#rt-set-url'), key = box.querySelector('#rt-set-key');
    url.value = apiUrl(); key.value = finnhubKey();
    box.querySelector('.rt-setup-x').addEventListener('click', function () { if (apiUrl()) settings(false); });
    box.querySelector('.rt-setup-ok').addEventListener('click', function () {
      var u = url.value.trim(), k = key.value.trim();
      var msg = box.querySelector('.rt-setup-msg');
      if (u !== apiUrl() && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) { msg.textContent = 'მისამართი ასე უნდა გამოიყურებოდეს: https://script.google.com/macros/s/…/exec'; return; }
      if (k && !/^[A-Za-z0-9]{10,64}$/.test(k)) { msg.textContent = 'Finnhub-ის გასაღები მხოლოდ ასოებსა და ციფრებს შეიცავს.'; return; }
      var urlChanged = u !== apiUrl(), keyChanged = k !== finnhubKey();
      lsSet(LS_URL, u);
      if (k) lsSet(LS_KEY, k); else lsDel(LS_KEY);
      settings(false);
      if (urlChanged) { loadPrices(true); loadFund(); }
      if (keyChanged) resetLive();
      status();
    });
  }

  // ---------- public API ----------
  window.dash = {
    loader: function (id, def) { loaders[id] = def; },
    calc: function (id, def) { calcs.push({ id: id, inputs: def.inputs, fn: def.fn }); },
    data: function (id) {
      var d = D[id];
      if (!d) return { status: 'loading', data: [], meta: [] };
      return { status: d.status, data: d.data || [], meta: d.meta || [] };
    },
    params: function () { return Object.assign({}, P); },
    setParams: function (o) {
      var prevHist = P.hist_range;
      Object.keys(o).forEach(function (k) { P[k] = o[k]; });
      lsSet(LS_PARAMS, JSON.stringify(P));
      if (P.hist_range !== prevHist && /^Prices!A\d+:O\d+$/.test(P.hist_range || '')) loadHistory();
      notify();
    },
    resetParams: function () { window.dash.setParams(Object.assign({}, DEFAULTS, { hist_range: P.hist_range })); },
    setLink: function (page) { try { history.replaceState(null, '', page === 'company' ? '#company' : location.pathname + location.search); } catch (e) { /* ignore */ } },
    watchSymbols: watchSymbols,
    onData: function (f) {
      subs.push(f);
      if (subs.length === 1) start();
      notify();
    }
  };

  var started = false;
  function start() {
    if (started) return;
    started = true;
    Object.keys(FILES).forEach(loadFile);
    loadFund();
    loadPrices(false);
    if (basePrices) loadHistory();
    var visible = function () { return document.visibilityState === 'visible'; };
    setInterval(function () { if (visible()) { loadPrices(true); requoteFirst(); } }, PRICE_MS);
    setInterval(function () { if (visible()) loadFund(); }, FUND_MS);
    document.addEventListener('visibilitychange', function () {
      if (visible()) { loadPrices(false); if (finnhubKey() && !ws) connect(); }
    });
    window.addEventListener('online', function () { loadPrices(true); loadFund(); });
    if (finnhubKey()) connect();
    status();
  }
})();
