/* JournalDesk Mobile – tiny PDF writer (no libraries). Weave Solutions. */
(function () {
  'use strict';
  var W = [[278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584], [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]];
  function clean(s) {
    return String(s == null ? '' : s).replace(/₹/g, 'Rs.').replace(/[–—]/g, '-').replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"').replace(/…/g, '...').replace(/•/g, '-').replace(/[^\x20-\x7e]/g, '?');
  }
  function width(s, size, bold) {
    var w = 0, t = clean(s);
    for (var i = 0; i < t.length; i++) { var c = t.charCodeAt(i); w += (c >= 32 && c <= 126) ? W[bold ? 1 : 0][c - 32] : 556; }
    return w * size / 1000;
  }
  function fit(s, max, size, bold) {
    s = clean(s);
    if (width(s, size, bold) <= max) return s;
    while (s.length && width(s + '...', size, bold) > max) s = s.slice(0, -1);
    return s + '...';
  }
  function esc(s) { return clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  function Doc(opts) {
    this.landscape = !!opts.landscape;
    this.W = this.landscape ? 841.89 : 595.28; this.H = this.landscape ? 595.28 : 841.89; this.M = 34;
    this.company = opts.company || ''; this.title = opts.title || ''; this.subtitle = opts.subtitle || '';
    this.logo = opts.logo || null;  // {bytes: Uint8Array, w, h}
    this.pages = []; this.head = null; this.newPage();
  }
  Doc.prototype.put = function (s) { this.ops.push(s); };
  Doc.prototype.text = function (x, y, s, size, bold, align, gray) {
    s = clean(s); size = size || 9;
    if (align === 'right') x -= width(s, size, bold); else if (align === 'center') x -= width(s, size, bold) / 2;
    this.put('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + (gray || 0).toFixed(2) + ' g ' + x.toFixed(2) + ' ' +
      (this.H - y).toFixed(2) + ' Td (' + esc(s) + ') Tj ET');
  };
  Doc.prototype.line = function (x1, y1, x2, y2, w, gray) {
    this.put((gray || 0).toFixed(2) + ' G ' + (w || 0.5) + ' w ' + x1.toFixed(2) + ' ' + (this.H - y1).toFixed(2) + ' m ' +
      x2.toFixed(2) + ' ' + (this.H - y2).toFixed(2) + ' l S');
  };
  Doc.prototype.fill = function (x, y, w, h, gray) {
    this.put('q ' + gray.toFixed(2) + ' g ' + x.toFixed(2) + ' ' + (this.H - y - h).toFixed(2) + ' ' + w.toFixed(2) + ' ' +
      h.toFixed(2) + ' re f Q');
  };
  Doc.prototype.newPage = function () {
    this.ops = []; this.pages.push(this.ops);
    var y = this.M + 6;
    if (this.logo) this.put('q 30 0 0 30 ' + this.M + ' ' + (this.H - y - 26).toFixed(2) + ' cm /Im1 Do Q');
    this.text(this.W / 2, y + 8, this.company, 14, true, 'center');
    y += 24; this.text(this.W / 2, y, this.title, 11, true, 'center');
    y += 13;
    if (this.subtitle) { this.text(this.W / 2, y, this.subtitle, 8.5, false, 'center', 0.3); y += 11; }
    this.line(this.M, y, this.W - this.M, y, 1);
    this.y = y + 14;
    if (this.head) this.drawHead(this.head);
  };
  Doc.prototype.ensure = function (h) { if (this.y + h > this.H - this.M - 22) this.newPage(); };
  Doc.prototype.layout = function (cols) {
    var total = cols.reduce(function (a, c) { return a + c[1]; }, 0), k = (this.W - 2 * this.M) / total, x = this.M;
    return cols.map(function (c) { var o = { x: x, w: c[1] * k, a: c[2] || 'left', t: c[0] }; x += c[1] * k; return o; });
  };
  Doc.prototype.cell = function (col, s, size, bold, indent) {
    var pad = 4, t = fit(s, col.w - 2 * pad - (indent || 0), size, bold);
    if (col.a === 'right') this.text(col.x + col.w - pad, this.y, t, size, bold, 'right');
    else if (col.a === 'center') this.text(col.x + col.w / 2, this.y, t, size, bold, 'center');
    else this.text(col.x + pad + (indent || 0), this.y, t, size, bold);
  };
  Doc.prototype.drawHead = function (L) {
    this.fill(this.M, this.y - 11, this.W - 2 * this.M, 17, 0.85);
    var self = this; L.forEach(function (c) { self.cell(c, c.t, 8.5, true); });
    this.y += 17; this.line(this.M, this.y - 10, this.W - this.M, this.y - 10, 0.6);
  };
  Doc.prototype.heading = function (s) { this.ensure(40); this.text(this.M, this.y, s, 10.5, true); this.y += 16; };
  Doc.prototype.table = function (cols, rows) {
    var L = this.layout(cols), self = this;
    this.ensure(45); this.head = L; this.drawHead(L);
    rows.forEach(function (r) {
      var st = r.style || 'normal';
      self.ensure(st === 'total' ? 21 : 15);
      if (st === 'group') self.fill(self.M, self.y - 11, self.W - 2 * self.M, 15, 0.94);
      if (st === 'total') self.line(self.M, self.y - 11, self.W - self.M, self.y - 11, 0.6);
      var bold = st !== 'normal';
      r.cells.forEach(function (v, i) { if (L[i]) self.cell(L[i], v, 8.5, bold, i === 0 ? (r.indent || 0) * 10 : 0); });
      self.y += 15;
      if (st === 'total') {
        self.line(self.M, self.y - 11, self.W - self.M, self.y - 11, 0.6);
        self.line(self.M, self.y - 9.5, self.W - self.M, self.y - 9.5, 0.6); self.y += 3;
      }
    });
    this.head = null; this.y += 6;
  };
  Doc.prototype.bytes = function () {
    var self = this, n = this.pages.length, now = new Date();
    var stamp = 'Generated ' + ('0' + now.getDate()).slice(-2) + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
      now.getFullYear() + ' ' + ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) +
      '  |  JournalDesk Mobile  |  Developed by Weave Solutions (weavesolution.com)';
    this.pages.forEach(function (ops, i) {
      self.ops = ops; var yb = self.H - self.M + 8;
      self.line(self.M, yb - 11, self.W - self.M, yb - 11, 0.4, 0.5);
      self.text(self.M, yb, stamp, 7, false, 'left', 0.4);
      self.text(self.W - self.M, yb, 'Page ' + (i + 1) + ' of ' + n, 7.5, false, 'right', 0.4);
    });
    var enc = new TextEncoder(), parts = [], len = 0, offsets = [];
    function add(x) { var b = typeof x === 'string' ? latin1(x) : x; parts.push(b); len += b.length; }
    function latin1(s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
    var objs = [];  // each: array of string/bytes chunks
    objs.push(['<< /Type /Catalog /Pages 2 0 R >>']);
    objs.push(null);
    objs.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    objs.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    var img = '';
    if (this.logo) {
      objs.push(['<< /Type /XObject /Subtype /Image /Width ' + this.logo.w + ' /Height ' + this.logo.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + this.logo.bytes.length + ' >>\nstream\n',
        this.logo.bytes, '\nendstream']);
      img = ' /XObject << /Im1 ' + objs.length + ' 0 R >>';
    }
    var kids = [];
    this.pages.forEach(function (ops) {
      var content = ops.join('\n');
      objs.push(['<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream']);
      var cid = objs.length;
      objs.push(['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + self.W.toFixed(2) + ' ' + self.H.toFixed(2) + '] /Contents ' +
        cid + ' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + img + ' >> >>']);
      kids.push(objs.length);
    });
    objs[1] = ['<< /Type /Pages /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>'];
    add('%PDF-1.4\n');
    objs.forEach(function (o, i) { offsets.push(len); add((i + 1) + ' 0 obj\n'); o.forEach(add); add('\nendobj\n'); });
    var xref = len;
    add('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n');
    offsets.forEach(function (o) { add(('0000000000' + o).slice(-10) + ' 00000 n \n'); });
    add('trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    void enc;
    return out;
  };
  window.JDPdf = { Doc: Doc };
})();
