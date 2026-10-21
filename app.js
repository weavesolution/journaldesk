/* JournalDesk Mobile – reads the books synced from the desktop software. Weave Solutions. */
(function () {
  'use strict';
  var CFG_KEY = 'jd_cfg_v1';
  var $ = function (id) { return document.getElementById(id); };
  var state = { cfg: null, snap: null, changes: [], syncs: [], tab: 'home', idx: null, reqs: [], alerts: [], unit: null };

  /* ---------------- storage (IndexedDB with localStorage fallback) ---------------- */
  var DB = {
    open: function () {
      return new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no idb'));
        var r = indexedDB.open('journaldesk', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    },
    get: function (k) {
      return DB.open().then(function (db) {
        return new Promise(function (res) {
          var q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = function () { res(q.result); };
          q.onerror = function () { res(null); };
        });
      }).catch(function () { try { return JSON.parse(localStorage.getItem('jd_' + k)); } catch (e) { return null; } });
    },
    set: function (k, v) {
      return DB.open().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction('kv', 'readwrite');
          t.objectStore('kv').put(v, k);
          t.oncomplete = res; t.onerror = res;
        });
      }).catch(function () { try { localStorage.setItem('jd_' + k, JSON.stringify(v)); } catch (e) {} });
    }
  };
  function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch (e) { return null; } }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------------- helpers ---------------- */
  var NF = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function inr(p) { return NF.format((p || 0) / 100); }
  function drcr(p) { return p === 0 ? '0.00' : inr(Math.abs(p)) + (p > 0 ? ' Dr' : ' Cr'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function parseIso(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dmy(s) { if (!s) return ''; var p = s.slice(0, 10).split('-'); return p[2] + '-' + p[1] + '-' + p[0]; }
  function fyStart(s) { var d = parseIso(s); var y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return y + '-04-01'; }
  function fyEnd(s) { return (+fyStart(s).slice(0, 4) + 1) + '-03-31'; }
  function fyLabel(s) { var y = +fyStart(s).slice(0, 4); return y + '-' + String(y + 1).slice(-2); }
  function todayIso() { return iso(new Date()); }
  function addDays(s, n) { var d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }
  function sha256(text) {
    var buf = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', buf).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function getJson(url, params) {
    var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + q, { redirect: 'follow', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Request failed'); return j; });
  }

  /* ---------------- data index ---------------- */
  /* ---------------- several businesses (v11) ---------------- */
  function unitsOn() { return !!(state.snap && state.snap.features && state.snap.features.units && (state.snap.units || []).length); }
  function unitName(id) { var u = (state.snap.units || []).filter(function (x) { return x[0] === id; })[0]; return u ? u[1] : ''; }
  function unitKey() { return 'jd_unit:' + (state.cfg ? state.cfg.id : ''); }
  function loadUnit() {
    var v = null; try { v = JSON.parse(localStorage.getItem(unitKey())); } catch (e) { v = null; }
    state.unit = unitsOn() && unitName(v) ? v : null;
  }
  function setUnit(id) {
    state.unit = id; try { localStorage.setItem(unitKey(), JSON.stringify(id)); } catch (e) {}
    renderUbar(); rebuild();
  }
  function companyLabel() {
    var c = state.snap.company || 'JournalDesk';
    if (!unitsOn()) return c;
    return c + ' – ' + (state.unit ? unitName(state.unit) + ' (standalone)' : 'All businesses (consolidated)');
  }
  function renderUbar() {
    var bar = $('ubar');
    if (!bar) return;
    if (!unitsOn()) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    var list = [[null, 'All (consolidated)']].concat(state.snap.units);
    bar.innerHTML = list.map(function (u) {
      return '<button class="uchip' + (u[0] === state.unit ? ' on' : '') + '" data-unit="' + (u[0] === null ? '' : u[0]) + '">' + esc(u[1]) + '</button>';
    }).join('');
    bar.classList.remove('hidden');
    bar.querySelectorAll('[data-unit]').forEach(function (b) {
      b.addEventListener('click', function () { setUnit(b.dataset.unit ? +b.dataset.unit : null); });
    });
  }
  // the Inter-Business Account shows as an asset when other businesses owe this one, else as a liability
  function catOf(a, bal) { return a.iu ? (bal > 0 ? 'Asset' : 'Liability') : a.c; }

  function buildIndex(snap, unit) {
    unit = unit === undefined ? state.unit : unit;
    var acc = {}, byAcc = {}, groups = {};
    (snap.groups || []).forEach(function (g) { groups[g[0]] = { id: g[0], name: g[1], cat: g[2], parent: g[3] || null }; });
    Object.keys(groups).forEach(function (id) {
      var g = groups[id], names = [], seen = {}, cur = g;
      while (cur && !seen[cur.id]) { seen[cur.id] = 1; names.unshift(cur.name); cur = groups[cur.parent]; }
      g.path = names.join(' › ');
    });
    (snap.accounts || []).forEach(function (a) { acc[a.id] = a; byAcc[a.id] = []; });
    var src = snap.vouchers || [];
    if (unit) {  // one business: only its lines (inter-business lines keep each business balanced)
      src = src.map(function (v) {
        var ls = (v[4] || []).filter(function (l) { return l[3] === unit; });
        if (!ls.length) return null;
        var c = v.slice(); c[4] = ls; c.pending = v.pending; c.unsent = v.unsent; return c;
      }).filter(Boolean);
    }
    var vouchers = src.slice().sort(function (a, b) { return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || (+a[0] || 0) - (+b[0] || 0); });
    vouchers.forEach(function (v) {
      v[4].forEach(function (l) { if (byAcc[l[0]]) byAcc[l[0]].push({ d: v[2], dr: l[1], cr: l[2], v: v }); });
    });
    return { acc: acc, byAcc: byAcc, groups: groups, vouchers: vouchers };
  }
  function isBS(a) { return a.c === 'Asset' || a.c === 'Liability'; }
  function balance(aid, asOn) {
    var a = state.idx.acc[aid], from = isBS(a) ? '0000-00-00' : fyStart(asOn), b = 0;
    state.idx.byAcc[aid].forEach(function (x) { if (x.d >= from && x.d <= asOn) b += x.dr - x.cr; });
    return b;
  }
  function natural(a, signed) { return (a.c === 'Asset' || a.c === 'Expense') ? signed : -signed; }
  function totals(asOn) {
    var t = { Asset: 0, Liability: 0, Income: 0, Expense: 0 };
    Object.keys(state.idx.acc).forEach(function (id) {
      var a = state.idx.acc[id], b = balance(+id, asOn), c = catOf(a, b);
      t[c] += natural({ c: c }, b);
    });
    t.Profit = t.Income - t.Expense;
    return t;
  }
  function groupName(a) { var g = state.idx.groups[a.g]; return g ? (g.path || g.name) : ''; }
  function others(v, aid) {
    var n = [];
    v[4].forEach(function (l) { if (l[0] !== aid) { var a = state.idx.acc[l[0]]; var s = a ? a.n : '#' + l[0]; if (n.indexOf(s) < 0) n.push(s); } });
    return n.join(', ');
  }

  /* ---------------- screens ---------------- */
  var view = function () { return $('view'); };
  function footer() { return '<div class="end-space"></div>'; }
  function asOnDefault() { var t = todayIso(); var s = state.snap.today || t; return s < t ? s : t; }

  function renderHome() {
    var asOn = asOnDefault(), t = totals(asOn);
    var h = '<h2>Position as on ' + dmy(asOn) + ' · FY ' + fyLabel(asOn) + '</h2><div class="cards">' +
      card('Total Assets', inr(t.Asset)) + card('Total Liabilities', inr(t.Liability)) +
      card('Income (FY)', inr(t.Income)) + card('Expenses (FY)', inr(t.Expense)) +
      '<div class="card wide"><div class="k">Net Profit (FY)</div><div class="v ' + (t.Profit >= 0 ? 'pos' : 'neg') + '">' +
      (t.Profit < 0 ? '−' : '') + inr(Math.abs(t.Profit)) + '</div></div></div>';
    if (unitsOn() && !state.unit) h += businessesHtml(asOn);
    var fy = fyStart(asOn), cur = monthSeries(fy, 'income'), ex = monthSeries(fy, 'expense');
    h += '<h2>This year at a glance</h2>' +
      chartCard('Income vs Expenses', svgBars(cur.labels, [['Income', PAL[0], cur.values.slice(0, cur.live)],
        ['Expenses', PAL[1], ex.values.slice(0, cur.live)]])) +
      chartCard('Where the money went', svgDonut(breakdown(fy, asOn, 'Expense', 'group'))) +
      chartCard('Cash & bank – month-end balance', svgLine(cur.labels, [['Cash & bank', PAL[0], monthSeries(fy, 'cashbank').values, cur.live]])) +
      chartCard('Profit – cumulative', svgLine(cur.labels, [['This year', PAL[2], monthSeries(fy, 'cum_profit').values, cur.live],
        ['Last year', '#a8d5aa', monthSeries(prevFy(fy), 'cum_profit').values, 12]]));
    view().innerHTML = h + footer();
  }
  function totalsFor(unit, asOn) {
    var keep = state.idx;
    state.idx = buildIndex(mergePending(state.snap), unit);
    var t = totals(asOn);
    state.idx = keep;
    return t;
  }
  function businessesHtml(asOn) {
    var h = '<h2>Businesses – FY ' + fyLabel(asOn) + '</h2><div class="list">';
    state.snap.units.forEach(function (u) {
      var t = totalsFor(u[0], asOn);
      h += '<div class="row tap" data-gounit="' + u[0] + '"><div class="l"><div class="t">' + esc(u[1]) + '</div><div class="s">Income ' +
        inr(t.Income) + ' · Expenses ' + inr(t.Expense) + ' · Assets ' + inr(t.Asset) + '</div></div><div class="r ' +
        (t.Profit >= 0 ? 'pos' : 'neg') + '">' + (t.Profit < 0 ? '−' : '') + inr(Math.abs(t.Profit)) + '<div class="s">profit</div></div></div>';
    });
    return h + '</div><p class="muted small">Tap a business to see only its figures.</p>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-gounit]');
    if (t) setUnit(+t.dataset.gounit);
  });
  function card(k, v) { return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

  /* ---------------- alerts (bell button) ---------------- */
  var ALERT_DAYS = 2;
  function dueAlerts(days) {
    var lim = addDays(todayIso(), days);
    return (state.alerts || []).filter(function (x) { return x[0] <= lim; });
  }
  function updateBell() {
    var n = state.snap ? dueAlerts(ALERT_DAYS).filter(function (x) { return !x.done; }).length : 0, b = $('bell-n');
    if (!b) return;
    b.textContent = n; b.classList.toggle('hidden', !n);
  }
  function openAlerts(days) {
    days = days || ALERT_DAYS;
    var list = dueAlerts(days), t = todayIso();
    var h = '<h3>Alerts – ' + (days === ALERT_DAYS ? 'due now and next ' + ALERT_DAYS + ' days' : 'next ' + days + ' days') + '</h3>';
    h += list.length ? '<div class="list">' + list.map(function (x) {
      var od = x[0] < t, today = x[0] === t;
      var canDone = reqOn() && x[5] && !x.pending && !x.done;
      return '<div class="row"><div class="l"><div class="t">' + esc(x[2]) + '</div><div class="s">' + esc(x[1]) + ' · ' + dmy(x[0]) +
        (od ? ' <span class="badge overdue">Overdue</span>' : today ? ' <span class="badge today">Today</span>' : '') +
        (x.pending ? ' <span class="badge pend">Pending</span>' : '') + (x.done ? ' <span class="badge pend">Done – sent to PC</span>' : '') +
        (x[4] ? '<br>' + esc(x[4]) : '') + '</div></div><div class="r">' + (x[3] ? inr(x[3]) + '<br>' : '') +
        (canDone ? '<button class="btn small" data-done="' + esc(x[5] + '|' + x[0]) + '">Done</button>' : '') + '</div></div>';
    }).join('') + '</div>' : '<div class="list"><div class="empty">Nothing due ✔</div></div>';
    h += '<p class="muted small">' + (reqOn() ? '"Done" is sent to JournalDesk on the PC and applied at its next Sync.' :
      'Alerts are marked done in JournalDesk on the computer.') + '</p>';
    if (reqOn()) h += '<button class="btn" id="al-new" style="width:100%;margin-top:4px">＋ New alert / task</button>';
    h += days === ALERT_DAYS ? '<button class="btn" id="al-more" style="width:100%;margin-top:8px">Show next 30 days</button>' :
      '<button class="btn" id="al-less" style="width:100%;margin-top:8px">Show next ' + ALERT_DAYS + ' days only</button>';
    h += '<button class="btn" data-close="1" style="width:100%;margin-top:8px">Close</button>';
    openSheet(h);
    $('sheet-body').querySelectorAll('[data-done]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.dataset.done.split('|'), a = (state.alerts || []).filter(function (x) { return x[5] === k[0] && x[0] === k[1]; })[0];
        if (!a) return;
        var msg = a[1] === 'Custom' ? 'Mark "' + a[2] + '" as done?' : 'Ask the PC to post "' + a[2] + '" (' + a[1] + ', ' + inr(a[3]) + ')?';
        if (!confirm(msg)) return;
        sendReq('alert_done', { key: a[5], due: a[0], title: a[2] + (a[1] !== 'Custom' ? ' (' + a[1] + ')' : '') }).then(function () { openAlerts(days); });
      });
    });
    if ($('al-more')) $('al-more').addEventListener('click', function () { openAlerts(30); });
    if ($('al-less')) $('al-less').addEventListener('click', function () { openAlerts(ALERT_DAYS); });
    if ($('al-new')) $('al-new').addEventListener('click', function () { alertForm(); });
  }
  $('bell').addEventListener('click', function () { if (state.snap) openAlerts(); });

  /* ---------------- add from the phone (entries / alerts) → PC posts at Sync ---------------- */
  function feats() { return (state.snap && state.snap.features) || {}; }
  function reqOn() { return feats().requests !== false && !!state.cfg; }
  function docsOn() { return feats().docs !== false && !!(state.snap && state.snap.docs_folder); }
  function outboxKey() { return 'jd_outbox:' + (state.cfg ? state.cfg.id : ''); }
  function outbox() { try { return JSON.parse(localStorage.getItem(outboxKey())) || []; } catch (e) { return []; } }
  function saveOutbox(list) { try { localStorage.setItem(outboxKey(), JSON.stringify(list)); } catch (e) {} }
  function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function allReqs() {
    var seen = {}, out = [];
    (state.reqs || []).concat(outbox()).forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; out.push(r); } });
    return out;
  }
  function mergePending(snap) {
    // phone requests show like normal entries / alerts (marked Pending) until the PC posts them
    var s = Object.assign({}, snap), reqs = allReqs();
    s.vouchers = (snap.vouchers || []).slice();
    var alerts = (snap.alerts || []).map(function (a) { return a.slice(); });
    reqs.forEach(function (r) {
      var p = r.payload || {};
      if (r.kind === 'entry') {
        var plines = (p.lines || []).map(function (l) { return l.length > 3 || !p.unit ? l : l.concat([p.unit]); });
        var v = ['r:' + r.id, 'Pending', p.date, p.narration || '', plines];
        v.pending = true; v.unsent = !!r.unsent;
        s.vouchers.push(v);
      } else if (r.kind === 'alert') {
        var a = [p.due, 'Custom', p.title, 0, p.notes || '', null]; a.pending = true; alerts.push(a);
      } else if (r.kind === 'alert_done') {
        alerts.forEach(function (a) { if (a[5] === p.key && a[0] === p.due) a.done = true; });
      }
    });
    alerts.sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; });
    state.alerts = alerts.filter(function (a) { return !a.done; }).concat(alerts.filter(function (a) { return a.done; }));
    return s;
  }
  function flushOutbox() {
    var list = outbox();
    if (!list.length || !state.cfg) return Promise.resolve();
    var cfg = state.cfg;
    return list.reduce(function (pr, r) {
      return pr.then(function () {
        var send = Object.assign({}, r); delete send.unsent;
        return getJson(cfg.url, { action: 'add', key: cfg.key, r: JSON.stringify(send) }).then(function () {
          saveOutbox(outbox().filter(function (x) { return x.id !== r.id; }));
          state.reqs = (state.reqs || []).concat([send]);
        });
      });
    }, Promise.resolve()).catch(function () {});
  }
  function sendReq(kind, payload) {
    var r = { id: uid(), kind: kind, payload: payload, created: new Date().toISOString().slice(0, 16), device: navigator.userAgent.slice(0, 50), unsent: true };
    saveOutbox(outbox().concat([r]));
    closeSheet();
    rebuild();
    return flushOutbox().then(function () {
      var still = outbox().some(function (x) { return x.id === r.id; });
      toast(still ? 'Saved on the phone – will be sent when online' : 'Sent ✔ – it will be posted on the PC at the next Sync', 3200);
      rebuild();
    });
  }
  function rebuild() {
    if (!state.snap) return;
    state.idx = buildIndex(mergePending(state.snap));
    updateBell();
    if (state.view === 'ledger' && ledgerState.id) renderLedger(ledgerState.id);
    else if (state.view) ({ home: renderHome, accounts: renderAccounts, daybook: renderDaybook, reports: renderReports })[state.view]();
  }
  $('add').addEventListener('click', function () {
    if (!state.snap) return;
    if (!reqOn()) return toast('Adding from the phone is switched off for these books.', 3000);
    openSheet('<h3>Add on the go</h3><p class="muted small">Shows here at once as "Pending"; the PC posts it at its next Sync.</p>' +
      '<button class="menu-item" id="ad-entry"><span>🧾 New journal entry</span><span>›</span></button>' +
      '<button class="menu-item" id="ad-paid"><span>💸 Quick: money paid</span><span>›</span></button>' +
      '<button class="menu-item" id="ad-recd"><span>💰 Quick: money received</span><span>›</span></button>' +
      '<button class="menu-item" id="ad-alert"><span>⏰ New alert / task</span><span>›</span></button>' +
      '<button class="btn" data-close="1" style="width:100%;margin-top:12px">Cancel</button>');
    $('ad-entry').addEventListener('click', function () { entryForm({}); });
    $('ad-paid').addEventListener('click', function () { entryForm({ mode: 'paid' }); });
    $('ad-recd').addEventListener('click', function () { entryForm({ mode: 'recd' }); });
    $('ad-alert').addEventListener('click', function () { alertForm(); });
  });
  var draft = null;
  function accName(id) { var a = state.idx.acc[id]; return a ? a.n : ''; }
  function entryForm(init) {
    if (init) {
      draft = { date: todayIso(), dr: null, cr: null, amt: '', narr: '', mode: init.mode || '',
        unit: unitsOn() ? (state.unit || state.snap.units[0][0]) : null };
    }
    var d = draft, m = d.mode;
    var drLabel = m === 'paid' ? 'Paid for (expense / party) – Debit' : m === 'recd' ? 'Received into (cash / bank) – Debit' : 'Debit (Dr) account';
    var crLabel = m === 'paid' ? 'Paid from (cash / bank) – Credit' : m === 'recd' ? 'Received from (party / income) – Credit' : 'Credit (Cr) account';
    openSheet('<h3>' + (m === 'paid' ? 'Money paid' : m === 'recd' ? 'Money received' : 'New journal entry') + '</h3>' +
      '<label>Date<input id="ef-date" type="date" value="' + d.date + '" max="' + todayIso() + '"></label>' +
      (unitsOn() ? '<label>Business<select id="ef-unit">' + state.snap.units.map(function (u) {
        return '<option value="' + u[0] + '"' + (u[0] === d.unit ? ' selected' : '') + '>' + esc(u[1]) + '</option>'; }).join('') +
        '</select></label>' : '') +
      '<label>' + drLabel + '</label><button class="pick" id="ef-dr">' + (d.dr ? esc(accName(d.dr)) : 'Choose account…') + '</button>' +
      '<label>' + crLabel + '</label><button class="pick" id="ef-cr">' + (d.cr ? esc(accName(d.cr)) : 'Choose account…') + '</button>' +
      '<label>Amount (Rs.)<input id="ef-amt" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(d.amt) + '" placeholder="0.00"></label>' +
      '<label>Narration<input id="ef-narr" type="text" value="' + esc(d.narr) + '" placeholder="e.g. Taxi to client office"></label>' +
      '<p class="err" id="ef-err"></p>' +
      '<button class="btn primary" id="ef-save">Save &amp; send</button>' +
      '<button class="btn" data-close="1" style="width:100%;margin-top:8px">Cancel</button>');
    var keep = function () {
      d.date = $('ef-date').value; d.amt = $('ef-amt').value; d.narr = $('ef-narr').value;
      if ($('ef-unit')) d.unit = +$('ef-unit').value;
    };
    $('ef-dr').addEventListener('click', function () { keep(); pickAccount(drLabel, function (id) { d.dr = id; entryForm(); }, function () { entryForm(); }); });
    $('ef-cr').addEventListener('click', function () { keep(); pickAccount(crLabel, function (id) { d.cr = id; entryForm(); }, function () { entryForm(); }); });
    $('ef-save').addEventListener('click', function () {
      keep();
      var amt = Math.round(parseFloat(d.amt) * 100), err = '';
      if (!d.date || d.date > todayIso()) err = 'Choose a date (future dates are not allowed).';
      else if (!d.dr || !d.cr) err = 'Choose both accounts.';
      else if (d.dr === d.cr) err = 'Debit and Credit must be different accounts.';
      else if (!(amt > 0)) err = 'Enter the amount.';
      if (err) { $('ef-err').textContent = err; return; }
      var pay = { date: d.date, narration: d.narr.trim(), lines: [[d.dr, amt, 0], [d.cr, 0, amt]] };
      if (unitsOn() && d.unit) pay.unit = d.unit;
      sendReq('entry', pay);
      draft = null;
    });
  }
  function pickAccount(title, onPick, onBack) {
    openSheet('<h3>' + esc(title) + '</h3><input id="pk-q" class="search" type="search" placeholder="Search account or group…" autocomplete="off">' +
      '<div id="pk-list" class="pick-list"></div><button class="btn" id="pk-back" style="width:100%;margin-top:12px">‹ Back</button>');
    var draw = function () {
      var q = ($('pk-q').value || '').toLowerCase().split(/\s+/).filter(Boolean);
      var accs = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; }).filter(function (a) {
        var hay = (a.n + ' ' + groupName(a) + ' ' + a.c).toLowerCase();
        return q.every(function (w) { return hay.indexOf(w) >= 0; });
      }).sort(function (x, y) { return x.n.localeCompare(y.n); }).slice(0, 80);
      $('pk-list').innerHTML = accs.length ? accs.map(function (a) {
        return '<button class="menu-item" data-aid="' + a.id + '"><span>' + esc(a.n) + '<small class="muted"> · ' + esc(groupName(a)) + '</small></span></button>';
      }).join('') : '<div class="empty">No matching account.</div>';
      $('pk-list').querySelectorAll('[data-aid]').forEach(function (b) { b.addEventListener('click', function () { onPick(+b.dataset.aid); }); });
    };
    $('pk-q').addEventListener('input', draw);
    $('pk-back').addEventListener('click', onBack);
    draw();
    setTimeout(function () { try { $('pk-q').focus(); } catch (e) {} }, 50);
  }
  function alertForm() {
    openSheet('<h3>New alert / task</h3>' +
      '<label>What<input id="af-title" type="text" placeholder="e.g. Pay GST, call bank"></label>' +
      '<label>Date<input id="af-due" type="date" value="' + todayIso() + '"></label>' +
      '<label>Repeat<select id="af-rep"><option>Once</option><option>Monthly</option><option>Quarterly</option><option>Half-yearly</option><option>Yearly</option></select></label>' +
      '<label>Notes<input id="af-notes" type="text" placeholder="optional"></label><p class="err" id="af-err"></p>' +
      '<button class="btn primary" id="af-save">Save &amp; send</button><button class="btn" data-close="1" style="width:100%;margin-top:8px">Cancel</button>');
    $('af-save').addEventListener('click', function () {
      var t = $('af-title').value.trim(), due = $('af-due').value;
      if (!t || !due) { $('af-err').textContent = 'Enter what and when.'; return; }
      sendReq('alert', { title: t, due: due, repeat: $('af-rep').value, notes: $('af-notes').value.trim() });
    });
  }

  /* ---------------- documents (opened from the Google Drive copy of the books folder) ---------------- */
  function docChip(d) {
    return '<span class="chip doc' + (d[2] ? '' : ' off') + '"' + (d[2] ? ' data-doc="' + esc(d[2]) + '"' : '') + '>📎 ' + esc(d[0]) + '</span>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-doc]');
    if (!t || !state.snap) return;
    if (!docsOn()) return toast('Opening documents on the phone is not set up for these books.', 3000);
    openDoc(t.getAttribute('data-doc'));
  });
  function openDoc(rel) {
    var name = rel.split('/').pop();
    openSheet('<h3>' + esc(name) + '</h3><p class="muted">Getting the file from Google Drive…</p>');
    getJson(state.cfg.url, { action: 'doc', key: state.cfg.key, p: rel }).then(function (j) {
      if (j.big || !j.b64) {
        openSheet('<h3>' + esc(j.name) + '</h3><p class="muted">This file is large – open it in Google Drive.</p>' +
          '<a class="btn primary" href="' + esc(j.url) + '" target="_blank" rel="noopener">Open in Google Drive</a>' +
          '<button class="btn" data-close="1" style="width:100%;margin-top:8px">Close</button>');
        return;
      }
      var bin = atob(j.b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: j.mime || 'application/octet-stream' }), url = URL.createObjectURL(blob);
      var img = /^image\//.test(j.mime || '');
      openSheet('<h3>' + esc(j.name) + '</h3>' + (img ? '<img src="' + url + '" class="doc-img" alt="">' : '') +
        '<a class="btn primary" href="' + url + '" download="' + esc(j.name) + '" target="_blank">Open / download</a>' +
        (navigator.canShare ? '<button class="btn" id="dc-share" style="width:100%;margin-top:8px">Share</button>' : '') +
        (j.url ? '<a class="btn" href="' + esc(j.url) + '" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:8px">Open in Google Drive</a>' : '') +
        '<button class="btn" data-close="1" style="width:100%;margin-top:8px">Close</button>');
      if ($('dc-share')) $('dc-share').addEventListener('click', function () {
        var f = new File([blob], j.name, { type: blob.type });
        if (navigator.canShare({ files: [f] })) navigator.share({ files: [f], title: j.name }).catch(function () {});
        else toast('This phone cannot share this file type.');
      });
    }).catch(function (e) {
      openSheet('<h3>' + esc(name) + '</h3><p class="err">' + esc(e.message === 'Failed to fetch' ? 'No internet connection.' : e.message) + '</p>' +
        '<button class="btn" data-close="1" style="width:100%">Close</button>');
    });
  }

  /* ---------------- alert notifications on this phone ---------------- */
  function notifyDue() {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
    var t = todayIso(), key = 'jd_notified:' + (state.cfg ? state.cfg.id : '') + ':' + t;
    var done = {}; try { done = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
    var due = (state.alerts || []).filter(function (a) { return a[0] <= t && !a.done && !done[(a[5] || a[2]) + a[0]]; });
    if (!due.length) return;
    navigator.serviceWorker.ready.then(function (reg) {
      due.forEach(function (a) {
        done[(a[5] || a[2]) + a[0]] = 1;
        reg.showNotification('JournalDesk: ' + a[2], { body: a[1] + ' · due ' + dmy(a[0]) + (a[3] ? ' · Rs. ' + inr(a[3]) : ''),
          icon: 'icon-192.png', badge: 'favicon.png', tag: 'jd-' + (a[5] || a[2]) + a[0] });
      });
      try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) {}
    });
  }
  function enableNotifications() {
    if (!('Notification' in window)) return toast('This browser does not support notifications. Use the Google Calendar reminders instead.', 4000);
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') return toast('Notifications are blocked – allow them in the browser / phone settings.', 4000);
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.periodicSync) return reg.periodicSync.register('jd-alerts', { minInterval: 6 * 60 * 60 * 1000 }).catch(function () {});
      }).finally(function () { toast('Alert notifications are on ✔'); notifyDue(); });
    });
  }

  /* ---------------- graphs (SVG, no libraries) ---------------- */
  var PAL = ['#1f6f8b', '#d9822b', '#2e7d32', '#6a4c93', '#123c4f', '#c0392b', '#8e9aa6', '#e0b04a', '#4aa3c7'];
  function prevFy(fy) { return (+fy.slice(0, 4) - 1) + '-04-01'; }
  function shortAmt(p) {
    var a = Math.abs(p) / 100, s = p < 0 ? '-' : '';
    if (a >= 1e7) return s + (a / 1e7).toFixed(1) + ' Cr';
    if (a >= 1e5) return s + (a / 1e5).toFixed(1) + ' L';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + ' K';
    return s + a.toFixed(0);
  }
  function isCashBank(a) { return a.c === 'Asset' && /bank|cash/i.test(groupName(a)); }
  function monthSeries(fy, subject, ref) {
    // 12 monthly values (natural sign): I/E = month amount, A/L = month-end balance
    var start = parseIso(fy), labels = [], keys = [], t = todayIso();
    for (var i = 0; i < 12; i++) {
      var m = new Date(start.getFullYear(), start.getMonth() + i, 1);
      labels.push(m.toLocaleString('en-IN', { month: 'short' }));
      keys.push(iso(m).slice(0, 7));
    }
    var live = keys.filter(function (k) { return k <= t.slice(0, 7); }).length;
    var pick = function (a) {
      if (subject === 'income') return a.c === 'Income';
      if (subject === 'expense') return a.c === 'Expense';
      if (subject === 'profit' || subject === 'cum_profit') return !isBS(a);
      if (subject === 'cashbank') return isCashBank(a);
      if (subject === 'group') { var g = state.idx.groups[a.g]; while (g) { if (g.id === ref) return true; g = state.idx.groups[g.parent]; } return false; }
      return a.id === ref;
    };
    var vals = keys.map(function () { return 0; }), before = 0, bs = false;
    Object.keys(state.idx.acc).forEach(function (id) {
      var a = state.idx.acc[id];
      if (!pick(a)) return;
      var sign = (a.c === 'Asset' || a.c === 'Expense') ? 1 : -1;
      if (isBS(a)) bs = true;
      state.idx.byAcc[a.id].forEach(function (x) {
        var amt = x.dr - x.cr, k = x.d.slice(0, 7), i = keys.indexOf(k);
        if (subject === 'profit' || subject === 'cum_profit') { if (i >= 0) vals[i] += -amt; return; }
        if (isBS(a)) { if (x.d < fy) before += sign * amt; else if (i >= 0) vals[i] += sign * amt; }
        else if (i >= 0) vals[i] += sign * amt;
      });
    });
    if (bs || subject === 'cum_profit') {
      var run = bs ? before : 0;
      vals = vals.map(function (v) { run += v; return run; });
    }
    return { labels: labels, values: vals, live: live };
  }
  function breakdown(fy, asOn, cat, by) {
    var res = {};
    Object.keys(state.idx.acc).forEach(function (id) {
      var a = state.idx.acc[id];
      if (a.c !== cat || a.iu) return;
      var v = 0;
      state.idx.byAcc[a.id].forEach(function (x) {
        if (x.d > asOn || (!isBS(a) && x.d < fy)) return;
        v += x.dr - x.cr;
      });
      v = natural(a, v);
      if (v <= 0) return;
      var g = state.idx.groups[a.g], key = by === 'account' ? a.n : (g ? g.name : '?');
      res[key] = (res[key] || 0) + v;
    });
    return Object.keys(res).map(function (k) { return [k, res[k]]; }).sort(function (x, y) { return y[1] - x[1]; });
  }
  function chartCard(title, svg) {
    return '<div class="chart"><div class="ct">' + esc(title) + '</div>' + svg + '<div class="tip muted small">Tap a bar or dot for the amount</div></div>';
  }
  function scale(values) {
    var hi = Math.max.apply(null, values.concat([0])), lo = Math.min.apply(null, values.concat([0]));
    if (hi === lo) hi = lo + 100;
    return [lo, hi];
  }
  function legend(series) {
    return '<div class="lg">' + series.map(function (s) { return '<span><i style="background:' + s[1] + '"></i>' + esc(s[0]) + '</span>'; }).join('') + '</div>';
  }
  function axes(W, H, L, T, B, lo, hi) {
    var o = '';
    for (var i = 0; i <= 4; i++) {
      var v = lo + (hi - lo) * i / 4, y = H - B - (H - T - B) * i / 4;
      o += '<line x1="' + L + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="#e3e9ee"/>' +
        '<text x="' + (L - 4) + '" y="' + (y + 3) + '" text-anchor="end" class="ax">' + shortAmt(v) + '</text>';
    }
    return o;
  }
  function svgBars(labels, series) {
    var W = 340, H = 180, L = 44, T = 8, B = 20;
    var all = []; series.forEach(function (s) { all = all.concat(s[2]); });
    var sc = scale(all), lo = sc[0], hi = sc[1], gw = (W - L) / labels.length, bw = gw * 0.72 / series.length;
    var y = function (v) { return H - B - (H - T - B) * (v - lo) / (hi - lo); };
    var o = axes(W, H, L, T, B, lo, hi);
    labels.forEach(function (lab, i) {
      series.forEach(function (s, j) {
        var v = s[2][i] || 0; if (!v) return;
        var x = L + gw * i + gw * 0.14 + j * bw;
        o += '<rect x="' + x.toFixed(1) + '" y="' + y(Math.max(v, 0)).toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) +
          '" height="' + Math.max(1, Math.abs(y(v) - y(0))).toFixed(1) + '" fill="' + s[1] + '" data-tip="' + esc(s[0] + ' ' + lab + ': ' + inr(v)) + '"/>';
      });
      o += '<text x="' + (L + gw * (i + 0.5)).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="ax">' + esc(lab.slice(0, 3)) + '</text>';
    });
    return legend(series) + '<svg viewBox="0 0 ' + W + ' ' + H + '" class="svgc">' + o + '</svg>';
  }
  function svgLine(labels, series) {
    var W = 340, H = 170, L = 44, T = 8, B = 20, all = [];
    series.forEach(function (s) { all = all.concat(s[2].slice(0, s[3])); });
    var sc = scale(all.length ? all : [0]), lo = sc[0], hi = sc[1], gw = (W - L) / labels.length;
    var y = function (v) { return H - B - (H - T - B) * (v - lo) / (hi - lo); };
    var o = axes(W, H, L, T, B, lo, hi);
    series.slice().reverse().forEach(function (s) {
      var pts = s[2].slice(0, s[3]).map(function (v, i) { return [L + gw * (i + 0.5), y(v), v, i]; });
      if (pts.length > 1) o += '<polyline fill="none" stroke="' + s[1] + '" stroke-width="2" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>';
      pts.forEach(function (p) {
        o += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" fill="' + s[1] + '" stroke="#fff" data-tip="' + esc(s[0] + ' ' + labels[p[3]] + ': ' + inr(p[2])) + '"/>';
      });
    });
    labels.forEach(function (lab, i) { o += '<text x="' + (L + gw * (i + 0.5)).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="ax">' + esc(lab.slice(0, 3)) + '</text>'; });
    return (series.length > 1 ? legend(series) : '') + '<svg viewBox="0 0 ' + W + ' ' + H + '" class="svgc">' + o + '</svg>';
  }
  function svgDonut(items, max) {
    max = max || 6;
    items = items.filter(function (x) { return x[1] > 0; });
    if (!items.length) return '<div class="empty">No data yet</div>';
    if (items.length > max) items = items.slice(0, max - 1).concat([['Others', items.slice(max - 1).reduce(function (s, x) { return s + x[1]; }, 0)]]);
    var total = items.reduce(function (s, x) { return s + x[1]; }, 0), R = 60, r = 36, cx = 70, cy = 70, a0 = -Math.PI / 2, o = '';
    items.forEach(function (it, i) {
      var a1 = a0 + 2 * Math.PI * it[1] / total, big = a1 - a0 > Math.PI ? 1 : 0;
      if (items.length === 1) a1 = a0 + 2 * Math.PI - 0.0001;
      var p = function (rad, a) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
      o += '<path d="M ' + p(R, a0) + ' A ' + R + ' ' + R + ' 0 ' + big + ' 1 ' + p(R, a1) + ' L ' + p(r, a1) + ' A ' + r + ' ' + r + ' 0 ' + big + ' 0 ' + p(r, a0) + ' Z" fill="' +
        PAL[i % PAL.length] + '" data-tip="' + esc(it[0] + ': ' + inr(it[1]) + ' (' + Math.round(it[1] * 100 / total) + '%)') + '"/>';
      a0 = a1;
    });
    o += '<text x="70" y="68" text-anchor="middle" class="dt">' + shortAmt(total) + '</text><text x="70" y="82" text-anchor="middle" class="ax">total</text>';
    var lg = items.map(function (it, i) {
      return '<div class="dl"><i style="background:' + PAL[i % PAL.length] + '"></i><span>' + esc(it[0]) + '</span><b>' + Math.round(it[1] * 100 / total) + '%</b></div>';
    }).join('');
    return '<div class="donut"><svg viewBox="0 0 140 140" class="svgd">' + o + '</svg><div class="dls">' + lg + '</div></div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    var c = t.closest('.chart'), tip = c && c.querySelector('.tip');
    if (tip) { tip.textContent = t.getAttribute('data-tip'); tip.classList.remove('muted'); }
  });

  function entryHtml(v) {
    var h = '<div class="entry' + (v.pending ? ' pending' : '') + '"><div class="eh"><span>' + dmy(v[2]) + '</span><span>' +
      (v.pending ? '<span class="badge pend">Pending – from phone</span>' : esc(v[1])) + '</span></div>';
    v[4].forEach(function (l) {
      var a = state.idx.acc[l[0]];
      h += '<div class="el"><span class="a ' + (l[2] ? 'cr' : '') + '">' + (l[1] ? 'Dr ' : 'Cr ') + esc(a ? a.n : '#' + l[0]) +
        '</span><span class="' + (l[2] ? 'crc' : 'dr') + '">' + inr(l[1] || l[2]) + '</span></div>';
    });
    if (v[3]) h += '<div class="n">' + esc(v[3]) + '</div>';
    if (v[5] && v[5].length) h += '<div class="docs">' + v[5].map(docChip).join('') + '</div>';
    return h + '</div>';
  }

  var accFilter = { q: '', cat: 'All' };
  function renderAccounts() {
    var asOn = asOnDefault();
    var cats = ['All', 'Asset', 'Liability', 'Income', 'Expense'];
    var h = '<div class="toolbar"><input id="a-q" type="search" placeholder="Search account or group" value="' + esc(accFilter.q) + '"></div>' +
      '<div class="chips">' + cats.map(function (c) { return '<button class="chip ' + (accFilter.cat === c ? 'on' : '') + '" data-cat="' + c + '">' + c + '</button>'; }).join('') + '</div>';
    h += '<div id="a-list"></div>';
    view().innerHTML = h;
    var draw = function () {
      var q = accFilter.q.toLowerCase().split(/\s+/).filter(Boolean);
      var rows = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; }).filter(function (a) {
        var hay = (a.n + ' ' + groupName(a) + ' ' + a.c).toLowerCase();
        return (accFilter.cat === 'All' || a.c === accFilter.cat) && q.every(function (w) { return hay.indexOf(w) >= 0; });
      }).sort(function (x, y) { return x.n.localeCompare(y.n); });
      $('a-list').innerHTML = rows.length ? '<div class="list">' + rows.map(function (a) {
        return '<div class="row tap" data-acc="' + a.id + '"><div class="l"><div class="t">' + esc(a.n) + '</div><div class="s">' +
          esc(groupName(a)) + ' · ' + a.c + '</div></div><div class="r">' + drcr(balance(a.id, asOn)) + '</div></div>';
      }).join('') + '</div><p class="muted small">' + rows.length + ' accounts · balances as on ' + dmy(asOn) + '</p>' : '<div class="empty">No accounts match.</div>';
    };
    $('a-q').addEventListener('input', function (e) { accFilter.q = e.target.value; draw(); });
    view().querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () { accFilter.cat = b.dataset.cat; renderAccounts(); });
    });
    draw();
  }

  var ledgerState = { id: null, fy: null, sub: 'entries' };
  function renderLedger(aid) {
    var a = state.idx.acc[aid];
    if (!a) return go('accounts');
    if (ledgerState.id !== aid) ledgerState = { id: aid, fy: fyStart(asOnDefault()), sub: 'entries' };
    var from = ledgerState.fy, to = fyEnd(from);
    var opening = 0, rows = [];
    state.idx.byAcc[aid].forEach(function (x) {
      if (x.d < from) { if (isBS(a)) opening += x.dr - x.cr; }
      else if (x.d <= to) rows.push(x);
    });
    var fys = [], start = +fyStart(state.snap.books_start || from).slice(0, 4), end = +fyStart(asOnDefault()).slice(0, 4);
    for (var y = end; y >= start; y--) fys.push(y + '-04-01');
    var h = '<button class="back" data-back="1">‹ Back</button><h2 style="margin-top:0">' + esc(a.n) + '</h2>' +
      '<div class="muted small" style="margin:-4px 2px 10px">' + esc(groupName(a)) + ' · ' + a.c + '</div>' +
      '<div class="cards"><div class="card wide"><div class="k">Balance as on ' + dmy(asOnDefault()) + '</div><div class="v">' +
      drcr(balance(aid, asOnDefault())) + '</div></div></div>' +
      '<div class="seg" style="margin-top:12px"><button data-sub="entries" class="' + (ledgerState.sub === 'entries' ? 'on' : '') +
      '">Entries</button><button data-sub="details" class="' + (ledgerState.sub === 'details' ? 'on' : '') + '">Details & documents</button></div>';
    if (ledgerState.sub === 'entries') {
      h += '<div class="toolbar"><select id="l-fy">' + fys.map(function (f) {
        return '<option value="' + f + '"' + (f === from ? ' selected' : '') + '>FY ' + fyLabel(f) + '</option>';
      }).join('') + '</select></div>';
      var bal = opening, tdr = 0, tcr = 0, items = [];
      rows.forEach(function (x) {
        bal += x.dr - x.cr; tdr += x.dr; tcr += x.cr;
        items.push('<div class="row"><div class="l"><div class="t">' + esc(others(x.v, aid) || '(self)') + '</div><div class="s">' + dmy(x.d) +
          ' · ' + esc(x.v[1]) + (x.v[3] ? ' · ' + esc(x.v[3]) : '') + '</div></div><div class="r"><div class="' + (x.cr ? 'crc' : 'dr') + '">' +
          (x.dr ? 'Dr ' + inr(x.dr) : 'Cr ' + inr(x.cr)) + '</div><div class="s">' + drcr(bal) + '</div></div></div>');
      });
      // newest entries on top: closing balance first, opening balance at the bottom
      h += '<div class="list"><div class="row total"><div>Closing balance<div class="s">Dr ' + inr(tdr) + ' · Cr ' + inr(tcr) +
        '</div></div><div class="r">' + drcr(bal) + '</div></div>';
      h += items.reverse().join('');
      if (!rows.length) h += '<div class="empty">No entries in this year.</div>';
      h += '<div class="row head"><div>Opening balance</div><div class="r">' + drcr(opening) + '</div></div></div>';
    } else {
      h += '<div class="card"><div class="kv">';
      if (a.p) h += '<div class="k">Periodic entry</div><div>' + esc(a.p) + '</div>';
      (a.f || []).forEach(function (f) { h += '<div class="k">' + esc(f[0]) + '</div><div>' + esc(f[1]) + '</div>'; });
      if (!a.p && !(a.f || []).length) h += '<div class="k">Details</div><div class="muted">None recorded</div>';
      h += '</div></div><h2>Documents (' + (a.d || []).length + ')</h2>';
      h += (a.d || []).length ? '<div class="list">' + a.d.map(function (d) {
        return '<div class="row' + (d[2] ? ' tap' : '') + '"' + (d[2] ? ' data-doc="' + esc(d[2]) + '"' : '') + '><div class="l"><div class="t">📄 ' + esc(d[0]) + '</div>' +
          (d[1] ? '<div class="s">' + esc(d[1]) + '</div>' : '') + '</div>' + (d[2] && docsOn() ? '<div class="r small">Open ›</div>' : '') + '</div>';
      }).join('') + '</div><p class="muted small">' + (docsOn() ? 'Tap a document to open it (from the Google Drive copy of the books).' :
        'Opening documents on the phone is not set up – names are listed here.') + '</p>' : '<div class="list"><div class="empty">No documents attached.</div></div>';
    }
    view().innerHTML = h + footer();
    var sel = $('l-fy');
    if (sel) sel.addEventListener('change', function () { ledgerState.fy = sel.value; renderLedger(aid); });
    view().querySelectorAll('[data-sub]').forEach(function (b) {
      b.addEventListener('click', function () { ledgerState.sub = b.dataset.sub; renderLedger(aid); });
    });
  }

  var dayState = { date: null, mode: 'day' };
  function monday(s) { var d = parseIso(s); var k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); }
  function dayRange() {
    var d = dayState.date || asOnDefault();
    if (dayState.mode === 'week') { var m = monday(d); return [m, addDays(m, 6)]; }
    if (dayState.mode === 'month') { var f = d.slice(0, 8) + '01', e = parseIso(f); e.setMonth(e.getMonth() + 1); e.setDate(0); return [f, iso(e)]; }
    return [d, d];
  }
  function dayLabel() {
    var r = dayRange(), t = todayIso();
    if (dayState.mode === 'day') return r[0] === t ? 'Today, ' + dmy(t) : dmy(r[0]);
    if (dayState.mode === 'week') return (r[0] <= t && t <= r[1] ? 'This week, ' : 'Week ') + dmy(r[0]) + ' to ' + dmy(r[1]);
    var lbl = parseIso(r[0]).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    return (r[0] <= t && t <= r[1] ? 'This month, ' : '') + lbl;
  }
  function dayList() {
    var r = dayRange();
    // newest first
    return state.idx.vouchers.filter(function (v) { return v[2] >= r[0] && v[2] <= r[1]; }).slice().reverse();
  }
  function renderDaybook() {
    if (!dayState.date) dayState.date = todayIso();
    var list = dayList(), total = 0, t = todayIso(), m = dayState.mode, d = dayState.date;
    list.forEach(function (v) { v[4].forEach(function (l) { total += l[1]; }); });
    var onToday = m === 'day' && d === t, onWeek = m === 'week' && monday(d) === monday(t),
      onMonth = m === 'month' && d.slice(0, 7) === t.slice(0, 7);
    var h = '<div class="seg"><button data-q="day" class="' + (onToday ? 'on' : '') + '">Today</button>' +
      '<button data-q="week" class="' + (onWeek ? 'on' : '') + '">This week</button>' +
      '<button data-q="month" class="' + (onMonth ? 'on' : '') + '">This month</button></div>' +
      '<div class="toolbar"><button class="btn small" id="d-prev" aria-label="Previous">‹</button>' +
      '<input id="d-date" type="date" value="' + d + '" title="Pick any date">' +
      '<button class="btn small" id="d-next" aria-label="Next">›</button></div>' +
      '<p class="muted small"><b>' + esc(dayLabel()) + '</b> · ' + list.length + (list.length === 1 ? ' entry' : ' entries') + ' · total ' + inr(total) + ' · newest first</p>';
    h += list.length ? list.map(entryHtml).join('') : '<div class="empty">No entries for this period.</div>';
    view().innerHTML = h + footer();
    $('d-date').addEventListener('change', function (e) { if (e.target.value) { dayState.date = e.target.value; dayState.mode = 'day'; renderDaybook(); } });
    $('d-prev').addEventListener('click', function () { shiftDay(-1); });
    $('d-next').addEventListener('click', function () { shiftDay(1); });
    view().querySelectorAll('[data-q]').forEach(function (b) {
      b.addEventListener('click', function () { dayState.mode = b.dataset.q; dayState.date = todayIso(); renderDaybook(); });
    });
  }
  function shiftDay(n) {
    if (dayState.mode === 'day') dayState.date = addDays(dayState.date, n);
    else if (dayState.mode === 'week') dayState.date = addDays(dayState.date, 7 * n);
    else { var d = parseIso(dayState.date); d.setDate(1); d.setMonth(d.getMonth() + n); dayState.date = iso(d); }
    renderDaybook();
  }

  var repState = { sub: 'tb', asOn: null, q: '' };
  function renderReports() {
    if (!repState.asOn) repState.asOn = asOnDefault();
    var asOn = repState.asOn;
    var h = '<div class="seg"><button data-r="tb" class="' + (repState.sub === 'tb' ? 'on' : '') + '">Trial Balance</button>' +
      '<button data-r="pl" class="' + (repState.sub === 'pl' ? 'on' : '') + '">Profit & Loss</button>' +
      '<button data-r="bs" class="' + (repState.sub === 'bs' ? 'on' : '') + '">Balance Sheet</button>' +
      '<button data-r="gr" class="' + (repState.sub === 'gr' ? 'on' : '') + '">Graphs</button></div>' +
      '<div class="toolbar"><label style="margin:0;flex:none">As on</label><input id="r-date" type="date" value="' + asOn + '"></div>';
    var accs = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; });
    var bal = {};
    accs.forEach(function (a) { bal[a.id] = balance(a.id, asOn); });
    if (repState.sub === 'tb') {
      h += '<div class="toolbar"><input id="r-q" type="search" placeholder="Filter accounts" value="' + esc(repState.q) + '"></div><div id="r-body"></div>';
    } else if (repState.sub === 'gr') {
      h += graphsHtml(asOn);
    } else if (repState.sub === 'pl') {
      h += '<p class="muted small">From ' + dmy(fyStart(asOn)) + ' to ' + dmy(asOn) + '</p>';
      var inc = grouped(accs, 'Income', bal), exp = grouped(accs, 'Expense', bal);
      h += section('Income', inc) + section('Expenses', exp);
      var net = inc.total - exp.total;
      h += '<div class="list" style="margin-top:10px"><div class="row total"><div>' + (net >= 0 ? 'Net Profit' : 'Net Loss') + '</div><div class="r">' + inr(Math.abs(net)) + '</div></div></div>';
    } else {
      var li = grouped(accs, 'Liability', bal), as = grouped(accs, 'Asset', bal);
      var plAll = 0;
      state.idx.vouchers.forEach(function (v) {
        if (v[2] > asOn) return;
        v[4].forEach(function (l) { var a = state.idx.acc[l[0]]; if (a && !isBS(a)) plAll += l[2] - l[1]; });
      });
      h += section('Liabilities', li, [['Profit & Loss A/c (accumulated)', plAll]]) + section('Assets', as);
    }
    view().innerHTML = h + footer();
    $('r-date').addEventListener('change', function (e) { if (e.target.value) { repState.asOn = e.target.value; renderReports(); } });
    view().querySelectorAll('[data-r]').forEach(function (b) {
      b.addEventListener('click', function () { repState.sub = b.dataset.r; renderReports(); });
    });
    view().querySelectorAll('[data-g]').forEach(function (el) {
      el.addEventListener('change', function () {
        graphState[el.dataset.g] = el.type === 'checkbox' ? el.checked : el.value; renderReports();
      });
    });
    if (repState.sub === 'tb') {
      var drawTb = function () {
        var q = repState.q.toLowerCase().split(/\s+/).filter(Boolean);
        var tdr = 0, tcr = 0;
        var rows = accs.filter(function (a) {
          var hay = (a.n + ' ' + groupName(a) + ' ' + a.c).toLowerCase();
          return bal[a.id] && q.every(function (w) { return hay.indexOf(w) >= 0; });
        }).sort(function (x, y) { return x.n.localeCompare(y.n); });
        var body = rows.map(function (a) {
          var b = bal[a.id]; if (b > 0) tdr += b; else tcr -= b;
          return '<div class="row tap" data-acc="' + a.id + '"><div class="l"><div class="t">' + esc(a.n) + '</div><div class="s">' + esc(groupName(a)) +
            ' · ' + catOf(a, b) + '</div></div><div class="r">' + drcr(b) + '</div></div>';
        }).join('');
        if (!q.length) {
          var bf = 0, fs = fyStart(asOn);
          state.idx.vouchers.forEach(function (v) {
            if (v[2] >= fs) return;
            v[4].forEach(function (l) { var a = state.idx.acc[l[0]]; if (a && !isBS(a)) bf += l[1] - l[2]; });
          });
          if (bf) { if (bf > 0) tdr += bf; else tcr -= bf; body += '<div class="row"><div class="t">P&L A/c (brought forward)</div><div class="r">' + drcr(bf) + '</div></div>'; }
        }
        $('r-body').innerHTML = '<div class="list">' + (body || '<div class="empty">No balances.</div>') +
          '<div class="row total"><div>Dr ' + inr(tdr) + '</div><div class="r">Cr ' + inr(tcr) + '</div></div></div>' +
          (!q.length ? '<p class="muted small">' + (tdr === tcr ? '✔ Tallied' : '✘ Difference ' + inr(tdr - tcr)) + '</p>' : '');
      };
      $('r-q').addEventListener('input', function (e) { repState.q = e.target.value; drawTb(); });
      drawTb();
    }
  }
  var graphState = { trend: 'ie', cmp: false, bcat: 'Expense', bby: 'group' };
  function graphsHtml(asOn) {
    var fy = fyStart(asOn), g = graphState, cur, prev, lbl, title, P = PAL;
    var sel = function (key, opts) {
      return '<select data-g="' + key + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (g[key] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    };
    var h = '<div class="toolbar">' + sel('trend', [['ie', 'Income vs Expenses'], ['profit', 'Net profit each month'], ['cum_profit', 'Profit – cumulative'], ['cashbank', 'Cash & bank balance']]) + '</div>' +
      '<label class="chk"><input type="checkbox" data-g="cmp"' + (g.cmp ? ' checked' : '') + '> Compare with previous year</label>';
    if (g.trend === 'ie') {
      var inc = monthSeries(fy, 'income'), ex = monthSeries(fy, 'expense'), ser = [['Income', P[0], inc.values.slice(0, inc.live)], ['Expenses', P[1], ex.values.slice(0, inc.live)]];
      if (g.cmp) ser.push(['Income LY', '#9fc9d8', monthSeries(prevFy(fy), 'income').values], ['Expenses LY', '#f0c79c', monthSeries(prevFy(fy), 'expense').values]);
      h += chartCard('Income vs Expenses – FY ' + fyLabel(asOn), svgBars(inc.labels, ser));
    } else {
      cur = monthSeries(fy, g.trend);
      title = { profit: 'Net profit / loss each month', cum_profit: 'Profit – cumulative', cashbank: 'Cash & bank – month-end balance' }[g.trend];
      var col = g.trend === 'cashbank' ? P[0] : P[2], ser2 = [['This year', col, cur.values, cur.live]];
      if (g.cmp) ser2.push(['Last year', g.trend === 'cashbank' ? '#9fc9d8' : '#a8d5aa', monthSeries(prevFy(fy), g.trend).values, 12]);
      h += chartCard(title + ' – FY ' + fyLabel(asOn), g.trend === 'profit' ? svgBars(cur.labels, ser2.map(function (s) { return [s[0], s[1], s[2].slice(0, s[3])]; })) : svgLine(cur.labels, ser2));
    }
    h += '<div class="toolbar">' + sel('bcat', [['Expense', 'Expenses'], ['Income', 'Income'], ['Asset', 'Assets'], ['Liability', 'Liabilities']]) +
      sel('bby', [['group', 'by group'], ['account', 'by account']]) + '</div>';
    var catName = { Expense: 'Expenses', Income: 'Income', Asset: 'Assets', Liability: 'Liabilities' }[g.bcat];
    h += chartCard(catName + ' ' + (g.bby === 'group' ? 'by group' : 'by account') + (isBS({ c: g.bcat }) ? ' – as on ' + dmy(asOn) : ' – FY to ' + dmy(asOn)),
      svgDonut(breakdown(fy, asOn, g.bcat, g.bby), 7));
    return h;
  }
  function grouped(accs, cat, bal) {
    var g = {}, total = 0;
    accs.forEach(function (a) {
      if (catOf(a, bal[a.id]) !== cat) return;
      var v = natural({ c: cat }, bal[a.id]);
      if (!v) return;
      var k = groupName(a);
      (g[k] = g[k] || { items: [], total: 0 }).items.push([a, v]);
      g[k].total += v; total += v;
    });
    return { groups: g, total: total };
  }
  function section(title, data, extra) {
    var total = data.total;
    var h = '<h2>' + title + '</h2><div class="list">';
    Object.keys(data.groups).sort().forEach(function (k) {
      var gr = data.groups[k];
      h += '<div class="row head"><div>' + esc(k) + '</div><div class="r">' + inr(gr.total) + '</div></div>';
      gr.items.sort(function (x, y) { return y[1] - x[1]; }).forEach(function (it) {
        h += '<div class="row tap" data-acc="' + it[0].id + '"><div class="t" style="font-weight:400">' + esc(it[0].n) + '</div><div class="r">' + inr(it[1]) + '</div></div>';
      });
    });
    (extra || []).forEach(function (e) {
      if (!e[1]) return;
      total += e[1];
      h += '<div class="row head"><div>' + esc(e[0]) + '</div><div class="r">' + (e[1] < 0 ? '(' + inr(-e[1]) + ')' : inr(e[1])) + '</div></div>';
    });
    return h + '<div class="row total"><div>Total</div><div class="r">' + inr(total) + '</div></div></div>';
  }

  /* ---------------- share (PDF / text) ---------------- */
  var logoBytes = null;
  function loadLogo() {
    if (logoBytes) return Promise.resolve(logoBytes);
    return fetch('jd_logo.jpg').then(function (r) { return r.arrayBuffer(); })
      .then(function (b) { logoBytes = { bytes: new Uint8Array(b), w: 96, h: 96 }; return logoBytes; })
      .catch(function () { return null; });
  }
  function fileDate() { var d = new Date(); return ('0' + d.getDate()).slice(-2) + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + d.getFullYear(); }
  function safeName(s) { return String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Report'; }
  function makePdf(spec) {
    return loadLogo().then(function (logo) {
      var doc = new window.JDPdf.Doc({ company: companyLabel(), title: spec.title, subtitle: spec.subtitle,
        landscape: spec.landscape, logo: logo });
      spec.sections.forEach(function (sec) { if (sec.heading) doc.heading(sec.heading); doc.table(sec.cols, sec.rows); });
      return new Blob([doc.bytes()], { type: 'application/pdf' });
    });
  }
  function shareFile(blob, name, text) {
    var file = null;
    try { file = new File([blob], name, { type: 'application/pdf' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name, text: text || '' }).catch(function (e) {
        if (e && e.name !== 'AbortError') download(blob, name);
      });
    }
    download(blob, name);
    return Promise.resolve();
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Saved ' + name);
  }
  function shareText(text) {
    if (navigator.share) {
      return navigator.share({ text: text }).catch(function (e) { if (e && e.name !== 'AbortError') openWa(text); });
    }
    openWa(text);
  }
  function openWa(text) { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); }
  function money(p) { return 'Rs. ' + inr(p); }

  function ledgerSpec(aid, fy) {
    var a = state.idx.acc[aid], from = fy || (ledgerState.id === aid && ledgerState.fy) || fyStart(asOnDefault()), to = fyEnd(from);
    var opening = 0, rows = [], bal, tdr = 0, tcr = 0;
    state.idx.byAcc[aid].forEach(function (x) {
      if (x.d < from) { if (isBS(a)) opening += x.dr - x.cr; } else if (x.d <= to) rows.push(x);
    });
    bal = opening;
    var body = [{ cells: [dmy(from), 'Opening Balance', '', '', '', drcr(opening)], style: 'group' }];
    rows.forEach(function (x) {
      bal += x.dr - x.cr; tdr += x.dr; tcr += x.cr;
      body.push({ cells: [dmy(x.d), others(x.v, aid) || '(self)', x.v[1], x.dr ? inr(x.dr) : '', x.cr ? inr(x.cr) : '', drcr(bal)] });
    });
    body.push({ cells: ['', 'Total for period', '', inr(tdr), inr(tcr), ''], style: 'bold' });
    body.push({ cells: [dmy(to < asOnDefault() ? to : asOnDefault()), 'Closing Balance', '', '', '', drcr(bal)], style: 'total' });
    var info = [{ cells: ['Account', a.n] }, { cells: ['Group', groupName(a) + ' (' + a.c + ')'] }];
    (a.f || []).forEach(function (f) { info.push({ cells: [f[0], f[1]] }); });
    return {
      title: 'Ledger - ' + a.n, subtitle: 'FY ' + fyLabel(from) + '  (' + dmy(from) + ' to ' + dmy(to) + ')  -  data as of ' +
        dmy(state.snap.synced_at), name: 'Ledger_' + safeName(a.n) + '_' + fileDate() + '.pdf',
      sections: [{ heading: 'Account details', cols: [['Particulars', 160], ['Details', 420]], rows: info },
        { heading: 'Entries', cols: [['Date', 62], ['Particulars', 180], ['Voucher', 92], ['Debit', 80, 'right'],
          ['Credit', 80, 'right'], ['Balance', 92, 'right']], rows: body }],
      text: state.snap.company + '\nStatement of account: ' + a.n + '\nBalance as on ' + dmy(asOnDefault()) + ': ' +
        drcr(balance(aid, asOnDefault())) + '\n\nRecent entries:\n' + rows.slice(-5).reverse().map(function (x) {
          return dmy(x.d) + '  ' + (x.dr ? 'Dr ' + inr(x.dr) : 'Cr ' + inr(x.cr)) + '  ' + (x.v[3] || others(x.v, aid));
        }).join('\n') + '\n\n- sent from JournalDesk'
    };
  }
  function daybookSpec() {
    if (!dayState.date) dayState.date = todayIso();
    var list = dayList();
    var rows = [], tdr = 0, tcr = 0;
    list.forEach(function (v) {
      v[4].forEach(function (l, i) {
        var a = state.idx.acc[l[0]]; tdr += l[1]; tcr += l[2];
        rows.push({ cells: [i ? '' : dmy(v[2]), i ? '' : v[1], a ? a.n : '#' + l[0], l[1] ? inr(l[1]) : '', l[2] ? inr(l[2]) : '',
          i ? '' : v[3]] });
      });
    });
    rows.push({ cells: ['', '', 'Total', inr(tdr), inr(tcr), ''], style: 'total' });
    var label = dayLabel();
    return { title: 'Day Book - ' + label, subtitle: list.length + ' entries', landscape: true,
      name: 'Day_Book_' + safeName(label) + '_' + fileDate() + '.pdf',
      sections: [{ cols: [['Date', 62], ['Voucher No.', 90], ['Account', 200], ['Debit', 85, 'right'], ['Credit', 85, 'right'],
        ['Narration', 240]], rows: rows }],
      text: state.snap.company + '\nDay Book ' + label + ': ' + list.length + ' entries, total ' + money(tdr) };
  }
  function reportSpec(sub) {
    sub = sub || repState.sub;
    var asOn = repState.asOn || asOnDefault();
    var accs = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; }), bal = {};
    accs.forEach(function (a) { bal[a.id] = balance(a.id, asOn); });
    function secRows(data, extra) {
      var rows = [];
      Object.keys(data.groups).sort().forEach(function (k) {
        var g = data.groups[k];
        rows.push({ cells: [k, '', inr(g.total)], style: 'group' });
        g.items.sort(function (x, y) { return y[1] - x[1]; }).forEach(function (it) { rows.push({ cells: [it[0].n, inr(it[1]), ''], indent: 1 }); });
      });
      var total = data.total;
      (extra || []).forEach(function (e) { if (e[1]) { total += e[1]; rows.push({ cells: [e[0], '', inr(e[1])], style: 'group' }); } });
      rows.push({ cells: ['Total', '', inr(total)], style: 'total' });
      return rows;
    }
    var cols3 = [['Particulars', 300], ['Amount', 110, 'right'], ['Total', 110, 'right']];
    if (sub === 'pl') {
      var inc = grouped(accs, 'Income', bal), exp = grouped(accs, 'Expense', bal), net = inc.total - exp.total;
      return { title: 'Profit & Loss Account', subtitle: dmy(fyStart(asOn)) + ' to ' + dmy(asOn),
        name: 'Profit_and_Loss_' + fileDate() + '.pdf',
        sections: [{ heading: 'Income', cols: cols3, rows: secRows(inc) }, { heading: 'Expenses', cols: cols3, rows: secRows(exp) },
          { cols: [['Result', 410], ['Amount', 110, 'right']], rows: [{ cells: [net >= 0 ? 'Net Profit' : 'Net Loss', inr(Math.abs(net))], style: 'total' }] }],
        text: companyLabel() + '\nProfit & Loss ' + dmy(fyStart(asOn)) + ' to ' + dmy(asOn) + '\nIncome ' + money(inc.total) +
          '\nExpenses ' + money(exp.total) + '\n' + (net >= 0 ? 'Net Profit ' : 'Net Loss ') + money(Math.abs(net)) };
    }
    if (sub === 'bs') {
      var li = grouped(accs, 'Liability', bal), as = grouped(accs, 'Asset', bal), plAll = 0;
      state.idx.vouchers.forEach(function (v) {
        if (v[2] > asOn) return;
        v[4].forEach(function (l) { var a = state.idx.acc[l[0]]; if (a && !isBS(a)) plAll += l[2] - l[1]; });
      });
      return { title: 'Balance Sheet', subtitle: 'As on ' + dmy(asOn), name: 'Balance_Sheet_' + fileDate() + '.pdf',
        sections: [{ heading: 'Liabilities', cols: cols3, rows: secRows(li, [['Profit & Loss A/c', plAll]]) },
          { heading: 'Assets', cols: cols3, rows: secRows(as) }],
        text: companyLabel() + '\nBalance Sheet as on ' + dmy(asOn) + '\nTotal Assets ' + money(as.total) +
          '\nTotal Liabilities ' + money(li.total) + '\nProfit & Loss A/c ' + money(plAll) };
    }
    var rows = [], tdr = 0, tcr = 0;
    accs.filter(function (a) { return bal[a.id]; }).sort(function (x, y) { return x.n.localeCompare(y.n); }).forEach(function (a) {
      var b = bal[a.id]; if (b > 0) tdr += b; else tcr -= b;
      rows.push({ cells: [a.n, a.c, groupName(a), b > 0 ? inr(b) : '', b < 0 ? inr(-b) : ''] });
    });
    var bf = 0, fs = fyStart(asOn);
    state.idx.vouchers.forEach(function (v) {
      if (v[2] >= fs) return;
      v[4].forEach(function (l) { var a = state.idx.acc[l[0]]; if (a && !isBS(a)) bf += l[1] - l[2]; });
    });
    if (bf) { if (bf > 0) tdr += bf; else tcr -= bf; rows.push({ cells: ['P&L A/c (brought forward)', '', '', bf > 0 ? inr(bf) : '', bf < 0 ? inr(-bf) : ''], style: 'bold' }); }
    rows.push({ cells: ['Grand Total', '', '', inr(tdr), inr(tcr)], style: 'total' });
    return { title: 'Trial Balance', subtitle: 'As on ' + dmy(asOn), name: 'Trial_Balance_' + fileDate() + '.pdf',
      sections: [{ cols: [['Account Name', 220], ['Category', 70], ['Group', 150], ['Debit', 95, 'right'], ['Credit', 95, 'right']], rows: rows }],
      text: companyLabel() + '\nTrial Balance as on ' + dmy(asOn) + '\nDr ' + money(tdr) + '  Cr ' + money(tcr) };
  }
  function homeText() {
    var asOn = asOnDefault(), t = totals(asOn);
    return companyLabel() + '\nPosition as on ' + dmy(asOn) + ' (FY ' + fyLabel(asOn) + ')\n' +
      'Total Assets: ' + money(t.Asset) + '\nTotal Liabilities: ' + money(t.Liability) + '\nIncome: ' + money(t.Income) +
      '\nExpenses: ' + money(t.Expense) + '\n' + (t.Profit >= 0 ? 'Net Profit: ' : 'Net Loss: ') + money(Math.abs(t.Profit)) +
      '\n\n- sent from JournalDesk';
  }
  function openShare() {
    var spec = null, text = null, what = '';
    if (state.view === 'ledger' && ledgerState.id) { spec = ledgerSpec(ledgerState.id); what = 'this ledger'; }
    else if (state.view === 'daybook') { spec = daybookSpec(); what = 'this day book'; }
    else if (state.view === 'reports') { spec = reportSpec(); what = 'this report'; }
    else if (state.view === 'accounts') { spec = reportSpec('tb'); what = 'the trial balance'; }
    else { text = homeText(); spec = reportSpec('bs'); what = 'the balance sheet'; }
    text = text || spec.text;
    openSheet('<h3>Share</h3><p class="muted small">Send ' + what + ' on WhatsApp, email or any app.</p>' +
      '<button class="menu-item" id="sh-pdf"><span>📄 PDF – ' + esc(spec.title) + '</span><span>›</span></button>' +
      '<button class="menu-item" id="sh-txt"><span>💬 Short text summary</span><span>›</span></button>' +
      '<button class="menu-item" id="sh-any"><span>📒 Ledger of any account…</span><span>›</span></button>' +
      '<button class="btn" data-close="1" style="width:100%;margin-top:12px">Cancel</button>');
    $('sh-any').addEventListener('click', pickLedgerToShare);
    $('sh-pdf').addEventListener('click', function () {
      closeSheet(); toast('Preparing PDF…');
      makePdf(spec).then(function (blob) { return shareFile(blob, spec.name, spec.title); })
        .catch(function (e) { toast('Could not make the PDF: ' + e.message, 3500); });
    });
    $('sh-txt').addEventListener('click', function () { closeSheet(); shareText(text); });
  }
  function pickLedgerToShare() {
    openSheet('<h3>Share a ledger</h3><input id="sh-q" class="search" type="search" placeholder="Search account or group…" autocomplete="off">' +
      '<div id="sh-list" class="pick-list"></div><button class="btn" data-close="1" style="width:100%;margin-top:12px">Cancel</button>');
    var draw = function () {
      var q = ($('sh-q').value || '').toLowerCase().split(/\s+/).filter(Boolean);
      var accs = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; }).filter(function (a) {
        var hay = (a.n + ' ' + groupName(a) + ' ' + a.c).toLowerCase();
        return q.every(function (w) { return hay.indexOf(w) >= 0; });
      }).sort(function (x, y) { return x.n.localeCompare(y.n); }).slice(0, 80);
      $('sh-list').innerHTML = accs.length ? accs.map(function (a) {
        return '<button class="menu-item" data-aid="' + a.id + '"><span>' + esc(a.n) + '<small class="muted"> · ' + esc(groupName(a)) +
          '</small></span><span class="small">' + drcr(balance(a.id, asOnDefault())) + '</span></button>';
      }).join('') : '<div class="empty">No matching account.</div>';
      $('sh-list').querySelectorAll('[data-aid]').forEach(function (b) {
        b.addEventListener('click', function () { shareLedgerOf(+b.dataset.aid); });
      });
    };
    $('sh-q').addEventListener('input', draw);
    draw();
    setTimeout(function () { try { $('sh-q').focus(); } catch (e) {} }, 50);
  }
  function shareLedgerOf(aid) {
    var a = state.idx.acc[aid], cur = fyStart(asOnDefault());
    var fys = [], start = +fyStart(state.snap.books_start || cur).slice(0, 4), end = +cur.slice(0, 4);
    for (var y = end; y >= start; y--) fys.push(y + '-04-01');
    openSheet('<h3>' + esc(a.n) + '</h3><p class="muted small">' + esc(groupName(a)) + ' · balance ' + drcr(balance(aid, asOnDefault())) + '</p>' +
      '<label class="small muted">Year <select id="sh-fy">' + fys.map(function (f) { return '<option value="' + f + '">FY ' + fyLabel(f) + '</option>'; }).join('') +
      '</select></label>' +
      '<button class="menu-item" id="sh-lpdf"><span>📄 PDF statement</span><span>›</span></button>' +
      '<button class="menu-item" id="sh-ltxt"><span>💬 Short text summary</span><span>›</span></button>' +
      '<button class="btn" id="sh-back" style="width:100%;margin-top:12px">‹ Choose another account</button>');
    $('sh-back').addEventListener('click', pickLedgerToShare);
    $('sh-lpdf').addEventListener('click', function () {
      var spec = ledgerSpec(aid, $('sh-fy').value);
      closeSheet(); toast('Preparing PDF…');
      makePdf(spec).then(function (blob) { return shareFile(blob, spec.name, spec.title); })
        .catch(function (e) { toast('Could not make the PDF: ' + e.message, 3500); });
    });
    $('sh-ltxt').addEventListener('click', function () { var spec = ledgerSpec(aid, $('sh-fy').value); closeSheet(); shareText(spec.text); });
  }
  $('share').addEventListener('click', function () { if (state.snap) openShare(); });
  window.__jdSpecs = { ledgerSpec: ledgerSpec, daybookSpec: daybookSpec, reportSpec: reportSpec, makePdf: makePdf };

  /* ---------------- navigation ---------------- */
  var stack = [];
  function go(tab) {
    state.tab = tab;
    state.view = tab;
    stack = [];
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    ({ home: renderHome, accounts: renderAccounts, daybook: renderDaybook, reports: renderReports })[tab]();
    view().scrollTop = 0;
  }
  function openAccount(id) {
    stack.push(state.tab);
    state.view = 'ledger';
    renderLedger(+id);
    view().scrollTop = 0;
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-acc]');
    if (t) return openAccount(t.dataset.acc);
    var b = e.target.closest('[data-back]');
    if (b) { var prev = stack.pop() || state.tab; ledgerState.id = null; go(prev); }
  });
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.tab); }); });

  /* ---------------- profiles (several books on one device) ---------------- */
  var PROF_KEY = 'jd_profiles_v2', CUR_KEY = 'jd_current_v2';
  function profiles() {
    var list = null;
    try { list = JSON.parse(localStorage.getItem(PROF_KEY)); } catch (e) { list = null; }
    if (!Array.isArray(list)) {
      list = [];
      var old = loadCfg();  // v5.0 single-login format
      if (old && old.url) {
        list.push({ id: old.url, url: old.url, key: '', company: '', cache: 'snap' });
        try { localStorage.setItem(CUR_KEY, list[0].id); localStorage.removeItem(CFG_KEY); } catch (e) {}
      }
      saveProfiles(list);
    }
    return list;
  }
  function saveProfiles(list) { try { localStorage.setItem(PROF_KEY, JSON.stringify(list)); } catch (e) {} }
  function currentProfile() {
    var list = profiles(), id = localStorage.getItem(CUR_KEY);
    return list.filter(function (x) { return x.id === id; })[0] || list[0] || null;
  }
  function cacheKey(pr) { return pr.cache || ('snap:' + pr.id); }
  function shortUrl(u) { var m = /\/s\/([^/]+)\//.exec(u || ''); return m ? 'Script …' + m[1].slice(-8) : (u || ''); }
  function upsertProfile(pr) {
    var list = profiles().filter(function (x) { return x.id !== pr.id; });
    list.unshift(pr);
    saveProfiles(list);
    try { localStorage.setItem(CUR_KEY, pr.id); } catch (e) {}
  }

  /* ---------------- install (PWA) ---------------- */
  var deferredInstall = null;
  var isStandalone = function () {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  };
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    updateInstallBtn();
  });
  window.addEventListener('appinstalled', function () {
    deferredInstall = null; updateInstallBtn(); closeSheet(); toast('JournalDesk installed ✔');
  });
  function canInstall() { return !isStandalone() && (deferredInstall || isIOS); }
  function updateInstallBtn() { $('install').classList.toggle('hidden', !canInstall()); }
  function doInstall() {
    if (deferredInstall) {
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; updateInstallBtn(); closeSheet(); });
    } else if (isIOS) {
      openSheet('<h3>Install on iPhone / iPad</h3><ol class="steps"><li>Open this page in <b>Safari</b>.</li>' +
        '<li>Tap the <b>Share</b> button <span class="ios-share">⬆</span> at the bottom.</li>' +
        '<li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>' +
        '<button class="btn primary" data-close="1">Got it</button>');
    } else {
      openSheet('<h3>Install JournalDesk</h3><p class="muted">Open the browser menu (⋮) and choose <b>Install app</b> or ' +
        '<b>Add to Home screen</b>.</p><button class="btn primary" data-close="1">OK</button>');
    }
  }
  function offerInstall() {
    if (!canInstall() || !$('sheet').classList.contains('hidden')) return;
    openSheet('<div class="center"><img src="jd_logo.png" class="sheet-logo" alt="JD"><h3>Install JournalDesk</h3>' +
      '<p class="muted">Add JournalDesk to this phone for one-tap access. It opens like an app, remembers your books ' +
      'and works offline with the last synced data.</p></div>' +
      '<button class="btn primary" id="do-install">Install app</button>' +
      '<button class="btn" data-close="1" style="width:100%;margin-top:8px">Not now</button>');
    $('do-install').addEventListener('click', doInstall);
  }
  $('install').addEventListener('click', doInstall);

  /* ---------------- bottom sheet / menu ---------------- */
  function openSheet(html) {
    $('sheet-body').innerHTML = html;
    $('sheet').classList.remove('hidden');
  }
  function closeSheet() { $('sheet').classList.add('hidden'); }
  $('sheet').addEventListener('click', function (e) {
    if (e.target === $('sheet') || e.target.closest('[data-close]')) closeSheet();
  });
  function openMenu() {
    var cur = currentProfile(), list = profiles();
    var h = '';
    if (canInstall()) h += '<button class="menu-item" id="m-install">📲 Install JournalDesk app</button>';
    h += '<div class="menu-head">Books on this device</div>';
    list.forEach(function (pr) {
      var on = cur && pr.id === cur.id;
      h += '<button class="menu-item' + (on ? ' on' : '') + '" data-switch="' + esc(pr.id) + '">' +
        '<span><b>' + esc(pr.company || 'Books') + '</b><br><small>' + esc(shortUrl(pr.url)) + '</small></span>' +
        (on ? '<span class="tick">✓</span>' : '') + '</button>';
    });
    h += '<button class="menu-item" id="m-notif">🔔 Alert notifications on this phone</button>';
    h += '<button class="menu-item" id="m-add">＋ Open another books</button>';
    if (cur) h += '<button class="menu-item danger" id="m-out">Sign out of ' + esc(cur.company || 'these books') + '</button>';
    h += '<div class="about"><img src="jd_logo.png" alt="JD"><div><b>JournalDesk Mobile</b> · v11.0<br>' +
      '<small>Developed by <a href="https://weavesolution.com" target="_blank" rel="noopener">Weave Solutions</a></small></div>' +
      '<img src="weave_logo.png" class="weave" alt="Weave Solutions"></div>';
    openSheet(h);
    if ($('m-install')) $('m-install').addEventListener('click', doInstall);
    $('m-add').addEventListener('click', function () { closeSheet(); showSetup('', true); });
    $('m-notif').addEventListener('click', function () { closeSheet(); enableNotifications(); });
    if ($('m-out')) $('m-out').addEventListener('click', signOut);
    $('sheet-body').querySelectorAll('[data-switch]').forEach(function (b) {
      b.addEventListener('click', function () { closeSheet(); switchTo(b.dataset['switch']); });
    });
  }
  $('menu').addEventListener('click', openMenu);
  document.addEventListener('click', function (e) { if (e.target.closest('[data-menu]')) openMenu(); });

  function signOut() {
    var cur = currentProfile();
    if (!cur || !confirm('Sign out of ' + (cur.company || 'these books') + ' and remove its saved data from this device?')) return;
    closeSheet();
    var rest = profiles().filter(function (x) { return x.id !== cur.id; });
    saveProfiles(rest);
    DB.set(cacheKey(cur), null).then(function () {
      if (rest.length) { switchTo(rest[0].id); }
      else { try { localStorage.removeItem(CUR_KEY); } catch (e) {} state.cfg = null; state.snap = null; showSetup('Signed out.'); }
    });
  }
  function switchTo(id) {
    try { localStorage.setItem(CUR_KEY, id); } catch (e) {}
    state.tab = 'home'; state.snap = null; state.reqs = []; ledgerState.id = null; dayState.date = null; repState.asOn = null;
    start();
  }

  /* ---------------- sync ---------------- */
  function showMain() {
    $('setup').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('h-company').textContent = state.snap.company || 'JournalDesk';
    updateBell();
    $('h-sync').textContent = 'Data as of ' + dmy(state.snap.synced_at) + ' ' + (state.snap.synced_at || '').slice(11, 16);
    loadUnit();
    renderUbar();
    state.idx = buildIndex(mergePending(state.snap));
    updateBell();
    $('add').classList.toggle('hidden', !reqOn());
    $('share').classList.toggle('hidden', feats().share === false);
    updateInstallBtn();
    setTimeout(notifyDue, 800);
    go(state.tab || 'home');
  }
  function refresh(silent) {
    var btn = $('refresh');
    btn.classList.add('spin');
    var cfg = state.cfg;
    if (!cfg.key) return Promise.reject(new Error('Enter the secret key again.'));
    return flushOutbox().then(function () { return getJson(cfg.url, { action: 'data', key: cfg.key }); })
      .then(function (j) {
        if (state.cfg !== cfg) return;  // switched books meanwhile
        state.snap = j.data; state.changes = j.changes || []; state.syncs = j.syncs || [];
        state.reqs = j.requests || [];
        var known = {}; state.reqs.forEach(function (r) { known[r.id] = 1; });
        saveOutbox(outbox().filter(function (r) { return !known[r.id]; }));
        if (cfg.id) {
          var list = profiles();
          list.forEach(function (x) { if (x.id === cfg.id) x.company = j.data.company || x.company; });
          saveProfiles(list);
        }
        return DB.set(cacheKey(cfg), { data: j.data, changes: state.changes, syncs: state.syncs, reqs: state.reqs }).then(function () {
          showMain(); if (!silent) toast('Updated – data as of ' + dmy(j.data.synced_at));
        });
      })
      .catch(function (e) {
        if (!state.snap) throw e;
        toast(navigator.onLine ? 'Could not refresh: ' + e.message : 'Offline – showing last saved data', 3500);
      })
      .finally(function () { btn.classList.remove('spin'); });
  }
  $('refresh').addEventListener('click', function () { refresh(false); });

  function showSetup(msg, adding) {
    $('main').classList.add('hidden');
    $('setup').classList.remove('hidden');
    var p = new URLSearchParams(location.hash.slice(1));
    var c = adding ? {} : (state.cfg || {});
    $('s-url').value = p.get('s') || c.url || (adding && currentProfile() ? currentProfile().url : '') || '';
    $('s-key').value = '';
    $('s-err').textContent = msg || '';
    $('s-cancel').classList.toggle('hidden', !(currentProfile() && state.snap));
  }
  $('s-cancel').addEventListener('click', function () { history.replaceState(null, '', location.pathname); showMain(); });
  $('s-go').addEventListener('click', function () {
    var url = $('s-url').value.trim().split('#')[0].replace(/\/macros\/u\/\d+\//, '/macros/'), key = $('s-key').value.trim();
    if (url.indexOf('?') >= 0) url = url.split('?')[0];
    if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url)) return ($('s-err').textContent = 'Enter the Sync URL (ends with /exec).');
    if (!key) return ($('s-err').textContent = 'Enter the secret key.');
    $('s-err').textContent = 'Connecting…';
    $('s-go').disabled = true;
    var prev = { cfg: state.cfg, snap: state.snap, changes: state.changes, syncs: state.syncs };
    var existing = profiles().filter(function (x) { return x.id === url; })[0];
    state.cfg = { id: url, url: url, key: key, company: existing ? existing.company : '', cache: existing ? existing.cache : undefined };
    state.snap = null;
    refresh(true).then(function () {
      state.cfg.company = (state.snap && state.snap.company) || state.cfg.company;
      upsertProfile(state.cfg);
      history.replaceState(null, '', location.pathname);
      $('s-key').value = '';
      setTimeout(offerInstall, 600);
    }).catch(function (e) {
      state.cfg = prev.cfg; state.snap = prev.snap; state.changes = prev.changes; state.syncs = prev.syncs;
      $('s-err').textContent = e.message === 'Failed to fetch' ? 'No internet, or the Sync URL is wrong.' : e.message;
    }).finally(function () { $('s-go').disabled = false; });
  });

  function start() {
    var pr = currentProfile();
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.get('s')) {
      var id = p.get('s');
      var known = profiles().filter(function (x) { return x.id === id; })[0];
      if (!known) { state.cfg = pr; return showSetup('', true); }
      pr = known;
      try { localStorage.setItem(CUR_KEY, id); } catch (e) {}
      history.replaceState(null, '', location.pathname);
    }
    state.cfg = pr;
    if (!pr) return showSetup();
    DB.get(cacheKey(pr)).then(function (cached) {
      if (state.cfg !== pr) return;
      if (cached && cached.data) {
        state.snap = cached.data; state.changes = cached.changes || []; state.syncs = cached.syncs || [];
        state.reqs = cached.reqs || [];
        showMain();
        refresh(true);
      } else {
        refresh(true).catch(function (e) { showSetup(e.message); });
      }
    });
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  start();
})();
