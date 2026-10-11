/* JournalDesk Mobile – reads the books synced from the desktop software. Weave Solutions. */
(function () {
  'use strict';
  var CFG_KEY = 'jd_cfg_v1';
  var $ = function (id) { return document.getElementById(id); };
  var state = { cfg: null, snap: null, changes: [], syncs: [], tab: 'home', idx: null };

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
  function buildIndex(snap) {
    var acc = {}, byAcc = {}, groups = {};
    (snap.groups || []).forEach(function (g) { groups[g[0]] = { id: g[0], name: g[1], cat: g[2] }; });
    (snap.accounts || []).forEach(function (a) { acc[a.id] = a; byAcc[a.id] = []; });
    var vouchers = (snap.vouchers || []).slice().sort(function (a, b) { return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0]; });
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
    Object.keys(state.idx.acc).forEach(function (id) { var a = state.idx.acc[id]; t[a.c] += natural(a, balance(+id, asOn)); });
    t.Profit = t.Income - t.Expense;
    return t;
  }
  function groupName(a) { var g = state.idx.groups[a.g]; return g ? g.name : ''; }
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
    var al = state.snap.alerts || [];
    h += '<h2>Alerts (next 30 days)</h2>';
    if (!al.length) h += '<div class="list"><div class="empty">Nothing due ✔</div></div>';
    else {
      h += '<div class="list">' + al.map(function (x) {
        var od = x[0] < todayIso();
        return '<div class="row"><div class="l"><div class="t">' + esc(x[2]) + '</div><div class="s">' + esc(x[1]) + ' · ' +
          dmy(x[0]) + (od ? ' <span class="badge overdue">Overdue</span>' : '') + '</div></div><div class="r">' +
          (x[3] ? inr(x[3]) : '') + '</div></div>';
      }).join('') + '</div>';
    }
    var cash = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; })
      .filter(function (a) { return a.c === 'Asset' && /bank|cash|deposit/i.test(groupName(a)); })
      .map(function (a) { return { a: a, b: balance(a.id, asOn) }; }).filter(function (x) { return x.b; })
      .sort(function (x, y) { return y.b - x.b; });
    if (cash.length) {
      h += '<h2>Cash, bank & deposits</h2><div class="list">' + cash.map(function (x) {
        return '<div class="row tap" data-acc="' + x.a.id + '"><div class="l"><div class="t">' + esc(x.a.n) + '</div><div class="s">' +
          esc(groupName(x.a)) + '</div></div><div class="r">' + drcr(x.b) + '</div></div>';
      }).join('') + '</div>';
    }
    var recent = state.idx.vouchers.slice(-5).reverse();
    if (recent.length) h += '<h2>Latest entries</h2>' + recent.map(entryHtml).join('');
    view().innerHTML = h + footer();
  }
  function card(k, v) { return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

  function entryHtml(v) {
    var h = '<div class="entry"><div class="eh"><span>' + dmy(v[2]) + '</span><span>' + esc(v[1]) + '</span></div>';
    v[4].forEach(function (l) {
      var a = state.idx.acc[l[0]];
      h += '<div class="el"><span class="a ' + (l[2] ? 'cr' : '') + '">' + (l[1] ? 'Dr ' : 'Cr ') + esc(a ? a.n : '#' + l[0]) +
        '</span><span class="' + (l[2] ? 'crc' : 'dr') + '">' + inr(l[1] || l[2]) + '</span></div>';
    });
    if (v[3]) h += '<div class="n">' + esc(v[3]) + '</div>';
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
        return '<div class="row"><div class="l"><div class="t">📄 ' + esc(d[0]) + '</div>' + (d[1] ? '<div class="s">' + esc(d[1]) + '</div>' : '') + '</div></div>';
      }).join('') + '</div><p class="muted small">Document files stay on the desktop; names are listed here.</p>' : '<div class="list"><div class="empty">No documents attached.</div></div>';
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
      '<button data-r="bs" class="' + (repState.sub === 'bs' ? 'on' : '') + '">Balance Sheet</button></div>' +
      '<div class="toolbar"><label style="margin:0;flex:none">As on</label><input id="r-date" type="date" value="' + asOn + '"></div>';
    var accs = Object.keys(state.idx.acc).map(function (id) { return state.idx.acc[id]; });
    var bal = {};
    accs.forEach(function (a) { bal[a.id] = balance(a.id, asOn); });
    if (repState.sub === 'tb') {
      h += '<div class="toolbar"><input id="r-q" type="search" placeholder="Filter accounts" value="' + esc(repState.q) + '"></div><div id="r-body"></div>';
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
            ' · ' + a.c + '</div></div><div class="r">' + drcr(b) + '</div></div>';
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
  function grouped(accs, cat, bal) {
    var g = {}, total = 0;
    accs.forEach(function (a) {
      if (a.c !== cat) return;
      var v = natural(a, bal[a.id]);
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
      var doc = new window.JDPdf.Doc({ company: state.snap.company, title: spec.title, subtitle: spec.subtitle,
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
        text: state.snap.company + '\nProfit & Loss ' + dmy(fyStart(asOn)) + ' to ' + dmy(asOn) + '\nIncome ' + money(inc.total) +
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
        text: state.snap.company + '\nBalance Sheet as on ' + dmy(asOn) + '\nTotal Assets ' + money(as.total) +
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
      text: state.snap.company + '\nTrial Balance as on ' + dmy(asOn) + '\nDr ' + money(tdr) + '  Cr ' + money(tcr) };
  }
  function homeText() {
    var asOn = asOnDefault(), t = totals(asOn);
    return state.snap.company + '\nPosition as on ' + dmy(asOn) + ' (FY ' + fyLabel(asOn) + ')\n' +
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
    h += '<button class="menu-item" id="m-add">＋ Open another books</button>';
    if (cur) h += '<button class="menu-item danger" id="m-out">Sign out of ' + esc(cur.company || 'these books') + '</button>';
    h += '<div class="about"><img src="jd_logo.png" alt="JD"><div><b>JournalDesk Mobile</b> · v7.0<br>' +
      '<small>Developed by <a href="https://weavesolution.com" target="_blank" rel="noopener">Weave Solutions</a></small></div>' +
      '<img src="weave_logo.png" class="weave" alt="Weave Solutions"></div>';
    openSheet(h);
    if ($('m-install')) $('m-install').addEventListener('click', doInstall);
    $('m-add').addEventListener('click', function () { closeSheet(); showSetup('', true); });
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
    state.tab = 'home'; state.snap = null; ledgerState.id = null; dayState.date = null; repState.asOn = null;
    start();
  }

  /* ---------------- sync ---------------- */
  function showMain() {
    $('setup').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('h-company').textContent = state.snap.company || 'JournalDesk';
    $('h-sync').textContent = 'Data as of ' + dmy(state.snap.synced_at) + ' ' + (state.snap.synced_at || '').slice(11, 16);
    state.idx = buildIndex(state.snap);
    updateInstallBtn();
    go(state.tab || 'home');
  }
  function refresh(silent) {
    var btn = $('refresh');
    btn.classList.add('spin');
    var cfg = state.cfg;
    if (!cfg.key) return Promise.reject(new Error('Enter the secret key again.'));
    return getJson(cfg.url, { action: 'data', key: cfg.key })
      .then(function (j) {
        if (state.cfg !== cfg) return;  // switched books meanwhile
        state.snap = j.data; state.changes = j.changes || []; state.syncs = j.syncs || [];
        if (cfg.id) {
          var list = profiles();
          list.forEach(function (x) { if (x.id === cfg.id) x.company = j.data.company || x.company; });
          saveProfiles(list);
        }
        return DB.set(cacheKey(cfg), { data: j.data, changes: state.changes, syncs: state.syncs }).then(function () {
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
