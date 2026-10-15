/* JournalDesk Mobile service worker: caches the app shell so it opens offline. */
var CACHE = 'journaldesk-v9';
var SHELL = ['./', 'index.html', 'app.css', 'app.js', 'pdf.js', 'jd_logo.jpg', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon.png', 'jd_logo.png',
  'weave_logo.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});

/* v9: alert reminders. While the app is installed, Chrome (Android) wakes this worker now and then
   (periodic background sync); it shows today's / overdue alerts from the data already saved on the phone. */
function idb(mode, fn) {
  return new Promise(function (res) {
    var r = indexedDB.open('journaldesk', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onerror = function () { res(null); };
    r.onsuccess = function () {
      try { var tx = r.result.transaction('kv', mode); fn(tx.objectStore('kv'), res); } catch (e) { res(null); }
    };
  });
}
function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function checkAlerts() {
  var t = today();
  return idb('readonly', function (st, res) {
    var all = [], q = st.openCursor();
    q.onsuccess = function () {
      var c = q.result;
      if (!c) return res(all);
      if (c.value && c.value.data && c.value.data.alerts) all.push(c.value.data);
      c.continue();
    };
    q.onerror = function () { res(all); };
  }).then(function (books) {
    return idb('readonly', function (st, res) { var g = st.get('notified:' + t); g.onsuccess = function () { res(g.result || {}); }; g.onerror = function () { res({}); }; })
      .then(function (done) {
        var shown = [];
        (books || []).forEach(function (b) {
          (b.alerts || []).forEach(function (a) {
            var k = (b.company || '') + (a[5] || a[2]) + a[0];
            if (a[0] <= t && !done[k]) {
              done[k] = 1;
              shown.push(self.registration.showNotification('JournalDesk: ' + a[2], {
                body: (b.company ? b.company + ' · ' : '') + a[1] + ' · due ' + a[0].split('-').reverse().join('-'),
                icon: 'icon-192.png', badge: 'favicon.png', tag: 'jd-' + k }));
            }
          });
        });
        return Promise.all(shown).then(function () { return idb('readwrite', function (st, res) { st.put(done, 'notified:' + t); res(); }); });
      });
  });
}
self.addEventListener('periodicsync', function (e) { if (e.tag === 'jd-alerts') e.waitUntil(checkAlerts()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow('./');
  }));
});
