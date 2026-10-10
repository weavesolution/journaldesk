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
  function post(url, body) {
    return fetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
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
  function footer() {
    return '<div class="footer"><img src="weave_logo.png" alt="Weave"><div>JournalDesk · weavesolution.com</div></div>';
  }
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
      var bal = opening, tdr = 0, tcr = 0;
      h += '<div class="list"><div class="row head"><div>Opening balance</div><div class="r">' + drcr(opening) + '</div></div>';
      rows.forEach(function (x) {
        bal += x.dr - x.cr; tdr += x.dr; tcr += x.cr;
        h += '<div class="row"><div class="l"><div class="t">' + esc(others(x.v, aid) || '(self)') + '</div><div class="s">' + dmy(x.d) +
          ' · ' + esc(x.v[1]) + (x.v[3] ? ' · ' + esc(x.v[3]) : '') + '</div></div><div class="r"><div class="' + (x.cr ? 'crc' : 'dr') + '">' +
          (x.dr ? 'Dr ' + inr(x.dr) : 'Cr ' + inr(x.cr)) + '</div><div class="s">' + drcr(bal) + '</div></div></div>';
      });
      if (!rows.length) h += '<div class="empty">No entries in this year.</div>';
      h += '<div class="row total"><div>Dr ' + inr(tdr) + ' · Cr ' + inr(tcr) + '</div><div class="r">' + drcr(bal) + '</div></div></div>';
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
  function renderDaybook() {
    if (!dayState.date) dayState.date = asOnDefault();
    var d = dayState.date, list;
    if (dayState.mode === 'day') list = state.idx.vouchers.filter(function (v) { return v[2] === d; });
    else list = state.idx.vouchers.filter(function (v) { return v[2].slice(0, 7) === d.slice(0, 7); });
    var total = 0;
    list.forEach(function (v) { v[4].forEach(function (l) { total += l[1]; }); });
    var h = '<div class="seg"><button data-mode="day" class="' + (dayState.mode === 'day' ? 'on' : '') + '">Day</button>' +
      '<button data-mode="month" class="' + (dayState.mode === 'month' ? 'on' : '') + '">Month</button></div>' +
      '<div class="toolbar"><button class="btn small" id="d-prev">‹</button><input id="d-date" type="date" value="' + d + '">' +
      '<button class="btn small" id="d-next">›</button></div>' +
      '<p class="muted small">' + list.length + ' entries · total ' + inr(total) + '</p>';
    h += list.length ? list.slice().reverse().map(entryHtml).join('') : '<div class="empty">No entries for this ' + dayState.mode + '.</div>';
    view().innerHTML = h + footer();
    $('d-date').addEventListener('change', function (e) { if (e.target.value) { dayState.date = e.target.value; renderDaybook(); } });
    $('d-prev').addEventListener('click', function () { shiftDay(-1); });
    $('d-next').addEventListener('click', function () { shiftDay(1); });
    view().querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { dayState.mode = b.dataset.mode; renderDaybook(); });
    });
  }
  function shiftDay(n) {
    if (dayState.mode === 'day') dayState.date = addDays(dayState.date, n);
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

  function renderChanges() {
    var h = '<h2>Sync history</h2>';
    h += state.syncs.length ? '<div class="list">' + state.syncs.slice(0, 15).map(function (s) {
      return '<div class="row"><div class="l"><div class="t">' + esc(s[0]) + '</div><div class="s">' + s[1] + ' entries</div></div>' +
        '<div class="r small"><span class="badge Added">+' + s[2] + '</span> <span class="badge Altered">~' + s[3] + '</span> <span class="badge Deleted">−' + s[4] + '</span></div></div>';
    }).join('') + '</div>' : '<div class="list"><div class="empty">No sync history yet.</div></div>';
    h += '<h2>Entry changes recorded at sync</h2>';
    h += state.changes.length ? '<div class="list">' + state.changes.map(function (c) {
      return '<div class="row"><div class="l"><div class="t"><span class="badge ' + esc(c[1]) + '">' + esc(c[1]) + '</span> ' + esc(c[2]) +
        (c[3] ? ' · ' + dmy(c[3]) : '') + '</div><div class="s">' + esc(c[4]) + '</div><div class="s">Synced ' + esc(c[0]) + '</div></div></div>';
    }).join('') + '</div>' : '<div class="list"><div class="empty">No changes recorded yet.</div></div>';
    var au = state.snap.audit || [];
    if (au.length) {
      h += '<h2>Desktop activity log</h2><div class="list">' + au.slice(0, 100).map(function (r) {
        return '<div class="row"><div class="l"><div class="t">' + esc(r[2]) + ' ' + esc(r[3]) + (r[4] ? ' · ' + esc(r[4]) : '') + '</div>' +
          '<div class="s">' + esc(r[5]) + '</div><div class="s">' + esc(r[0].replace('T', ' ')) + ' · ' + esc(r[1]) + '</div></div></div>';
      }).join('') + '</div>';
    }
    h += '<div style="margin-top:18px"><button class="btn" id="logout" style="width:100%">Sign out of this device</button></div>';
    view().innerHTML = h + footer();
    $('logout').addEventListener('click', function () {
      if (!confirm('Sign out and remove the saved books from this device?')) return;
      localStorage.removeItem(CFG_KEY);
      DB.set('snap', null).then(function () { location.hash = ''; location.reload(); });
    });
  }

  /* ---------------- navigation ---------------- */
  var stack = [];
  function go(tab) {
    state.tab = tab;
    stack = [];
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    ({ home: renderHome, accounts: renderAccounts, daybook: renderDaybook, reports: renderReports, changes: renderChanges })[tab]();
    view().scrollTop = 0;
  }
  function openAccount(id) {
    stack.push(state.tab);
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

  /* ---------------- sync ---------------- */
  function showMain() {
    $('setup').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('h-company').textContent = state.snap.company || 'JournalDesk';
    $('h-sync').textContent = 'Data as of ' + dmy(state.snap.synced_at) + ' ' + (state.snap.synced_at || '').slice(11, 16) +
      ' · code ' + (state.cfg.code || '');
    state.idx = buildIndex(state.snap);
    go(state.tab || 'home');
  }
  function refresh(silent) {
    var btn = $('refresh');
    btn.classList.add('spin');
    return post(state.cfg.url, { action: 'fetch', code: state.cfg.code, pin: state.cfg.pin })
      .then(function (j) {
        state.snap = j.data; state.changes = j.changes || []; state.syncs = j.syncs || [];
        return DB.set('snap', { data: j.data, changes: state.changes, syncs: state.syncs }).then(function () {
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

  function showSetup(msg) {
    $('main').classList.add('hidden');
    $('setup').classList.remove('hidden');
    var c = state.cfg || {};
    var p = new URLSearchParams(location.hash.slice(1));
    $('s-url').value = p.get('s') || c.url || '';
    $('s-code').value = p.get('c') || c.code || '';
    $('s-err').textContent = msg || '';
  }
  $('s-go').addEventListener('click', function () {
    var url = $('s-url').value.trim(), code = $('s-code').value.trim().toUpperCase(), pin = $('s-pin').value.trim();
    if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url)) return ($('s-err').textContent = 'Enter the sync address shared by your accountant.');
    if (!code || !pin) return ($('s-err').textContent = 'Enter the client code and PIN.');
    $('s-err').textContent = 'Connecting…';
    sha256(code + '|' + pin).then(function (h) {
      state.cfg = { url: url, code: code, pin: h };
      return refresh(true);
    }).then(function () {
      saveCfg(state.cfg);
      history.replaceState(null, '', location.pathname);
      $('s-pin').value = '';
    }).catch(function (e) {
      state.cfg = loadCfg();
      $('s-err').textContent = e.message === 'Failed to fetch' ? 'No internet, or the address is wrong.' : e.message;
    });
  });

  function start() {
    state.cfg = loadCfg();
    var p = new URLSearchParams(location.hash.slice(1));
    if (p.get('s') && (!state.cfg || state.cfg.url !== p.get('s') || state.cfg.code !== (p.get('c') || '').toUpperCase())) {
      return showSetup();
    }
    if (!state.cfg) return showSetup();
    DB.get('snap').then(function (cached) {
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
