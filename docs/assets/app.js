/* 儀表板互動 — 主題切換 + 銅鋁日線圖(單位切換/MA/關注線/期間統計) + 匯率/比價/職缺圖
   + 職缺搜尋/篩選/排序/直方圖。資料由頁面內嵌的 window.* 提供，無外部請求。 */
(function () {
  "use strict";
  var LB_PER_TONNE = 2204.62, MA_N = 20;
  var REDRAWS = [];

  // ---------- 主題 ----------
  function initTheme() {
    var root = document.documentElement;
    var saved = localStorage.getItem("theme");
    var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", saved || (sysDark ? "dark" : "light"));
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    var paint = function () { btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙"; };
    paint();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next); localStorage.setItem("theme", next); paint();
      REDRAWS.forEach(function (f) { try { f(); } catch (e) {} });
    });
  }

  // ---------- 小工具 ----------
  function fmt(n, dp) { return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function mmdd(ts) { var d = new Date(ts); return isNaN(d) ? "" : (d.getMonth() + 1) + "/" + d.getDate(); }
  function lastValidPoint(series, k) {
    for (var i = series.length - 1; i >= 0; i--) if (series[i][k] != null) return series[i];
    return null;
  }
  function movingAvg(arr, n) {
    var out = [], win = [];
    for (var i = 0; i < arr.length; i++) {
      win.push(arr[i]); if (win.length > n) win.shift();
      var v = win.filter(function (x) { return x != null; });
      out.push(win.length === n && v.length === n ? v.reduce(function (a, b) { return a + b; }, 0) / n : null);
    }
    return out;
  }

  // ---------- 通用時序圖：pts=[{ts,val}] ----------
  function drawSeries(container, pts, opts) {
    opts = opts || {};
    container.innerHTML = "";
    var xs = pts.map(function (p) { return p.val; });
    var valid = xs.filter(function (v) { return v != null; });
    if (valid.length < 2) {
      var e = document.createElement("div"); e.className = "empty";
      e.textContent = "資料累積中…"; container.appendChild(e); return;
    }
    var ma = opts.ma ? movingAvg(xs, opts.ma) : null;
    var domain = valid.slice();
    var hlines = (opts.hlines || []).filter(function (h) { return h.val != null; });
    hlines.forEach(function (h) { domain.push(h.val); });
    if (ma) ma.forEach(function (v) { if (v != null) domain.push(v); });
    var lo = Math.min.apply(null, domain), hi = Math.max.apply(null, domain), span = (hi - lo) || 1;
    var W = 600, H = 200, pad = 14;
    var X = function (i) { return i / (pts.length - 1) * W; };
    var Y = function (v) { return pad + (1 - (v - lo) / span) * (H - 2 * pad); };
    var color = opts.color || (valid[valid.length - 1] >= valid[0] ? cssVar("--up") : cssVar("--down"));

    var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'];
    hlines.forEach(function (h) {
      var y = Y(h.val).toFixed(1);
      s.push('<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="' + (h.color || cssVar("--muted")) +
        '" stroke-width="1" stroke-dasharray="5 4" opacity="0.85"/>');
    });
    if (ma) {
      var mp = [];
      ma.forEach(function (v, i) { if (v != null) mp.push(X(i).toFixed(1) + "," + Y(v).toFixed(1)); });
      if (mp.length > 1) s.push('<polyline fill="none" stroke="' + cssVar("--muted") +
        '" stroke-width="1.4" opacity="0.9" points="' + mp.join(" ") + '"/>');
    }
    var mainp = [];
    xs.forEach(function (v, i) { if (v != null) mainp.push(X(i).toFixed(1) + "," + Y(v).toFixed(1)); });
    s.push('<polyline fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' + mainp.join(" ") + '"/>');
    s.push("</svg>");
    container.insertAdjacentHTML("beforeend", s.join(""));

    var guide = document.createElement("div"); guide.className = "guide";
    var dot = document.createElement("div"); dot.className = "dot"; dot.style.background = color;
    var tip = document.createElement("div"); tip.className = "tip";
    container.appendChild(guide); container.appendChild(dot); container.appendChild(tip);
    var f = opts.fmt || function (v) { return fmt(v, 0); };
    container.onmousemove = function (ev) {
      var rect = container.getBoundingClientRect();
      var ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      var idx = Math.round(ratio * (pts.length - 1));
      while (idx >= 0 && xs[idx] == null) idx--;
      if (idx < 0) return;
      var xpx = (idx / (pts.length - 1)) * rect.width;
      var ypx = (Y(xs[idx]) / H) * rect.height;
      guide.style.height = rect.height + "px"; guide.style.left = xpx + "px"; guide.style.opacity = ".6";
      dot.style.left = xpx + "px"; dot.style.top = ypx + "px"; dot.style.opacity = "1";
      tip.textContent = mmdd(pts[idx].ts) + "　" + f(xs[idx]);
      tip.style.left = xpx + "px"; tip.style.top = ypx + "px"; tip.style.opacity = "1";
    };
    container.onmouseleave = function () { guide.style.opacity = "0"; dot.style.opacity = "0"; tip.style.opacity = "0"; };
  }

  // ============================================================ 銅鋁頁
  var UNITS = {
    twd_t: { pre: "NT$", suf: "/t", dp: 0, conv: function (u, r) { return u * r; } },
    usd_t: { pre: "US$", suf: "/t", dp: 0, conv: function (u) { return u; } },
    usd_lb: { pre: "US$", suf: "/lb", dp: 3, conv: function (u) { return u / LB_PER_TONNE; } },
    twd_kg: { pre: "NT$", suf: "/kg", dp: 1, conv: function (u, r) { return u * r / 1000; } }
  };
  function convVal(usd, rate, uk) { return UNITS[uk].conv(usd, rate != null ? rate : 1); }
  function unitFmt(v, uk) { var U = UNITS[uk]; return U.pre + fmt(v, U.dp) + U.suf; }

  function filterDays(series, days) {
    if (!series.length) return series;
    var last = new Date(series[series.length - 1].ts);
    var cut = new Date(last); cut.setDate(cut.getDate() - days);
    return series.filter(function (p) { return new Date(p.ts) >= cut; });
  }
  function pctChange(series, days, uk) {
    var last = lastValidPoint(series, "usd"); if (!last) return null;
    var ref = new Date(last.ts); ref.setDate(ref.getDate() - days);
    var prev = null;
    for (var i = series.length - 1; i >= 0; i--) {
      if (series[i].usd != null && new Date(series[i].ts) <= ref) { prev = series[i]; break; }
    }
    if (!prev) prev = series.find(function (p) { return p.usd != null; });
    if (!prev) return null;
    var vl = convVal(last.usd, last.rate, uk), vp = convVal(prev.usd, prev.rate, uk);
    return vp ? (vl - vp) / vp * 100 : null;
  }
  function setPct(el, pct) {
    if (!el) return;
    if (pct == null) { el.textContent = "—"; el.style.color = ""; return; }
    el.textContent = (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1) + "%";
    el.style.color = pct >= 0 ? cssVar("--up") : cssVar("--down");
  }

  function initMetals(DATA) {
    var state = {
      unit: localStorage.getItem("metalUnit") || "twd_t",
      range: parseInt(localStorage.getItem("metalRange") || "90", 10)
    };
    if (!UNITS[state.unit]) state.unit = "twd_t";
    if (!state.range) state.range = 90;

    function markBar(sel, attr, val) {
      document.querySelectorAll(sel + " button").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute(attr) === String(val));
      });
    }

    function renderOne(key) {
      var m = DATA[key], s = m.series || [];
      var panel = document.querySelector('.mpanel[data-key="' + key + '"]');
      if (!panel) return;
      var uk = state.unit, U = UNITS[uk];
      var last = lastValidPoint(s, "usd");
      var rate = last ? last.rate : null;

      // 現價/漲跌/關注區間
      var priceEl = panel.querySelector(".price"), chgEl = panel.querySelector(".chg"), watchEl = panel.querySelector(".watch");
      if (last && priceEl) priceEl.textContent = unitFmt(convVal(last.usd, rate, uk), uk);
      if (chgEl) {
        var c1 = null;
        for (var i = s.length - 1, seen = false; i >= 0; i--) {
          if (s[i].usd == null) continue;
          if (!seen) { seen = true; continue; }
          c1 = s[i]; break;
        }
        if (last && c1) {
          var d = convVal(last.usd, last.rate, uk) - convVal(c1.usd, c1.rate, uk);
          chgEl.textContent = (d >= 0 ? "+" : "−") + fmt(Math.abs(d), U.dp) + U.suf;
          chgEl.style.color = d >= 0 ? cssVar("--up") : cssVar("--down");
        } else chgEl.textContent = "—";
      }
      if (watchEl) watchEl.textContent = unitFmt(convVal(m.watch_low, rate, uk), uk) + " ~ " + unitFmt(convVal(m.watch_high, rate, uk), uk);

      // 期間統計
      setPct(panel.querySelector(".c7"), pctChange(s, 7, uk));
      setPct(panel.querySelector(".c30"), pctChange(s, 30, uk));
      setPct(panel.querySelector(".c90"), pctChange(s, 90, uk));
      var win = filterDays(s, state.range).map(function (p) { return convVal(p.usd, p.rate, uk); }).filter(function (v) { return v != null; });
      var phi = panel.querySelector(".phi"), plo = panel.querySelector(".plo");
      if (phi) phi.textContent = win.length ? unitFmt(Math.max.apply(null, win), uk) : "—";
      if (plo) plo.textContent = win.length ? unitFmt(Math.min.apply(null, win), uk) : "—";
      // 距關注線（美元基準，單位無關）
      var dhi = panel.querySelector(".dhi"), dlo = panel.querySelector(".dlo");
      if (last) {
        var u = last.usd;
        if (dhi) { var a = (m.watch_high - u) / u * 100; dhi.textContent = (a >= 0 ? "+" : "") + a.toFixed(1) + "%"; }
        if (dlo) { var b = (u - m.watch_low) / u * 100; dlo.textContent = (b >= 0 ? "+" : "") + b.toFixed(1) + "%"; }
      }

      // 走勢圖
      var cont = panel.querySelector('.chart[data-chart="' + key + '"]');
      var pts = filterDays(s, state.range).map(function (p) {
        return { ts: p.ts, val: p.usd == null ? null : convVal(p.usd, p.rate, uk) };
      });
      drawSeries(cont, pts, {
        ma: MA_N,
        hlines: [
          { val: convVal(m.watch_high, rate, uk), color: cssVar("--up") },
          { val: convVal(m.watch_low, rate, uk), color: cssVar("--down") }
        ],
        fmt: function (v) { return unitFmt(v, uk); }
      });
    }

    function redraw() { Object.keys(DATA).forEach(renderOne); drawFxRatio(); }
    REDRAWS.push(redraw);

    document.querySelectorAll(".unitbar button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.unit = b.getAttribute("data-unit"); localStorage.setItem("metalUnit", state.unit);
        markBar(".unitbar", "data-unit", state.unit); redraw();
      });
    });
    document.querySelectorAll(".rangebar button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.range = parseInt(b.getAttribute("data-range"), 10); localStorage.setItem("metalRange", state.range);
        markBar(".rangebar", "data-range", state.range); redraw();
      });
    });
    markBar(".unitbar", "data-unit", state.unit);
    markBar(".rangebar", "data-range", state.range);
    redraw();
  }

  function drawFxRatio() {
    var fx = window.FX_DATA || [];
    var fxc = document.querySelector('.chart[data-chart="fx"]');
    if (fxc && fx.length) {
      drawSeries(fxc, fx.map(function (d) { return { ts: d.ts, val: d.rate }; }),
        { ma: MA_N, color: cssVar("--accent"), fmt: function (v) { return v.toFixed(3); } });
      var now = fx[fx.length - 1]; var el = document.getElementById("fxNow");
      if (el && now) el.textContent = now.rate.toFixed(3);
    }
    var rt = window.RATIO_DATA || [];
    var rtc = document.querySelector('.chart[data-chart="ratio"]');
    if (rtc && rt.length) {
      drawSeries(rtc, rt.map(function (d) { return { ts: d.ts, val: d.v }; }),
        { ma: MA_N, color: cssVar("--accent"), fmt: function (v) { return v.toFixed(2); } });
      var rnow = rt[rt.length - 1]; var rel = document.getElementById("ratioNow");
      if (rel && rnow) rel.textContent = rnow.v.toFixed(2);
    }
  }

  // ============================================================ 人才頁
  function initJobsCharts() {
    var h = window.JOBS_HISTORY || [];
    function draw(sel, key, f) {
      var c = document.querySelector(sel); if (!c) return;
      var redraw = function () { drawSeries(c, h.map(function (x) { return { ts: x.ts, val: x[key] }; }), { color: cssVar("--accent"), fmt: f }); };
      REDRAWS.push(redraw); redraw();
    }
    draw('.chart[data-chart="jobsTotal"]', "total", function (v) { return fmt(v, 0) + " 筆"; });
    draw('.chart[data-chart="jobsMed"]', "salary_median", function (v) { return "NT$" + fmt(v, 0); });
  }

  function initJobs(JOBS) {
    var searchEl = document.getElementById("jobSearch"), areaEl = document.getElementById("jobArea");
    var countEl = document.getElementById("jobCount"), tbody = document.getElementById("jobBody");
    var sort = { key: "salary", dir: -1 };

    if (areaEl) {
      var areas = {};
      JOBS.forEach(function (j) { areas[j.area] = (areas[j.area] || 0) + 1; });
      Object.keys(areas).sort(function (a, b) { return areas[b] - areas[a]; }).forEach(function (a) {
        var o = document.createElement("option"); o.value = a; o.textContent = a + "（" + areas[a] + "）"; areaEl.appendChild(o);
      });
    }
    function salVal(j) { if (j.salary_low == null) return -1; return j.salary_high ? (j.salary_low + j.salary_high) / 2 : j.salary_low; }
    function salTxt(j) {
      if (j.salary_low == null) return ({ "面議": "面議", "時薪": "時薪", "yearly": "年薪制" })[j.salary_kind] || "—";
      return j.salary_high ? "NT$" + fmt(j.salary_low, 0) + "~" + fmt(j.salary_high, 0) : "NT$" + fmt(j.salary_low, 0) + " 以上";
    }
    function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
    function render() {
      var q = (searchEl && searchEl.value.trim().toLowerCase()) || "", area = (areaEl && areaEl.value) || "";
      var rows = JOBS.filter(function (j) {
        if (area && j.area !== area) return false;
        if (q && (j.title + " " + j.company).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      rows.sort(function (a, b) {
        var va = sort.key === "salary" ? salVal(a) : (a[sort.key] || ""), vb = sort.key === "salary" ? salVal(b) : (b[sort.key] || "");
        if (va < vb) return -sort.dir; if (va > vb) return sort.dir; return 0;
      });
      if (countEl) countEl.textContent = rows.length + " / " + JOBS.length + " 筆";
      tbody.innerHTML = rows.map(function (j) {
        return '<tr><td><a href="' + esc(j.url) + '" target="_blank" rel="noopener">' + esc(j.title.slice(0, 40)) +
          "</a></td><td>" + esc(j.company.slice(0, 22)) + "</td><td>" + esc(j.area) + '</td><td class="num">' + salTxt(j) + "</td></tr>";
      }).join("") || '<tr><td colspan="4" style="color:var(--muted)">找不到符合的職缺</td></tr>';
    }
    if (searchEl) searchEl.addEventListener("input", render);
    if (areaEl) areaEl.addEventListener("change", render);
    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-key");
        if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = (k === "salary" ? -1 : 1); }
        document.querySelectorAll("th.sortable .arrow").forEach(function (a) { a.textContent = ""; });
        var arw = th.querySelector(".arrow"); if (arw) arw.textContent = sort.dir > 0 ? "▲" : "▼";
        render();
      });
    });

    var hist = document.getElementById("hist");
    if (hist) {
      var bk = [{ l: "<3萬", lo: 0, hi: 30000 }, { l: "3–4萬", lo: 30000, hi: 40000 }, { l: "4–5萬", lo: 40000, hi: 50000 }, { l: "5–7萬", lo: 50000, hi: 70000 }, { l: "7萬+", lo: 70000, hi: Infinity }];
      JOBS.forEach(function (j) { var v = salVal(j); if (v < 0) return; for (var i = 0; i < bk.length; i++) if (v >= bk[i].lo && v < bk[i].hi) { bk[i].n = (bk[i].n || 0) + 1; break; } });
      var mx = Math.max.apply(null, bk.map(function (b) { return b.n || 0; })) || 1;
      hist.innerHTML = bk.map(function (b) {
        return '<div class="col"><div class="bn">' + (b.n || 0) + '</div><div class="bar" style="height:' + Math.round((b.n || 0) / mx * 100) + '%"></div><div class="bl">' + b.l + "</div></div>";
      }).join("");
    }
    var arw0 = document.querySelector('th.sortable[data-key="salary"] .arrow'); if (arw0) arw0.textContent = "▼";
    render();
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    if (window.METALS_DATA) initMetals(window.METALS_DATA);
    if (window.JOBS_DATA) { initJobs(window.JOBS_DATA); initJobsCharts(); }
  });
})();
