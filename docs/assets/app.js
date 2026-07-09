/* 儀表板互動邏輯 — 主題切換 + 銅鋁單位/走勢圖 + 職缺搜尋/篩選/排序/直方圖。
   資料由頁面內嵌的 window.METALS_DATA / window.JOBS_DATA 提供，無外部請求。 */
(function () {
  "use strict";
  var LB_PER_TONNE = 2204.62;

  // ---------- 主題切換（兩頁共用） ----------
  function initTheme() {
    var root = document.documentElement;
    var saved = localStorage.getItem("theme");
    var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = saved || (sysDark ? "dark" : "light");
    root.setAttribute("data-theme", theme);
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    var paint = function () { btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙"; };
    paint();
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      paint();
      if (window.__redraw) window.__redraw();  // 主題色變 → 重畫圖表
    });
  }

  // ---------- 共用小工具 ----------
  function fmt(n, dp) {
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function lastValid(series, k) {
    for (var i = series.length - 1; i >= 0; i--) if (series[i][k] != null) return series[i][k];
    return null;
  }

  // ============================================================
  // 銅鋁頁
  // ============================================================
  var UNITS = {
    twd_t:  { label: "NT$/公噸", pre: "NT$", suf: "/t",  dp: 0, conv: function (u, r) { return u * r; } },
    usd_t:  { label: "US$/公噸", pre: "US$", suf: "/t",  dp: 0, conv: function (u) { return u; } },
    usd_lb: { label: "US$/磅",   pre: "US$", suf: "/lb", dp: 3, conv: function (u) { return u / LB_PER_TONNE; } },
    twd_kg: { label: "NT$/公斤", pre: "NT$", suf: "/kg", dp: 1, conv: function (u, r) { return u * r / 1000; } }
  };

  function fmtUnit(usd, rate, unitKey) {
    var U = UNITS[unitKey];
    if (usd == null) return "—";
    var r = rate != null ? rate : 1;
    return U.pre + fmt(U.conv(usd, r), U.dp) + U.suf;
  }

  function initMetals(DATA) {
    var state = {
      unit: localStorage.getItem("metalUnit") || "twd_t",
      range: localStorage.getItem("metalRange") || "all"
    };
    if (!UNITS[state.unit]) state.unit = "twd_t";

    function markBar(sel, attr, val) {
      document.querySelectorAll(sel + " button").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute(attr) === String(val));
      });
    }

    function renderFigs() {
      Object.keys(DATA).forEach(function (key) {
        var m = DATA[key];
        var panel = document.querySelector('.mpanel[data-key="' + key + '"]');
        if (!panel) return;
        var s = m.series || [];
        var usd = lastValid(s, "usd");
        var rate = lastValid(s, "rate");
        // 漲跌：最後一筆與前一筆有效 usd
        var prev = null, seenLast = false;
        for (var i = s.length - 1; i >= 0; i--) {
          if (s[i].usd == null) continue;
          if (!seenLast) { seenLast = true; continue; }
          prev = s[i].usd; break;
        }
        var U = UNITS[state.unit], r = rate != null ? rate : 1;
        var priceEl = panel.querySelector(".price");
        var chgEl = panel.querySelector(".chg");
        var watchEl = panel.querySelector(".watch");
        if (priceEl) priceEl.textContent = fmtUnit(usd, rate, state.unit);
        if (chgEl) {
          if (usd != null && prev != null) {
            var d = U.conv(usd, r) - U.conv(prev, r);
            var up = d >= 0;
            chgEl.textContent = (up ? "+" : "−") + fmt(Math.abs(d), U.dp) + U.suf;
            chgEl.style.color = up ? cssVar("--up") : cssVar("--down");
          } else { chgEl.textContent = "—"; chgEl.style.color = ""; }
        }
        if (watchEl) {
          watchEl.textContent = fmtUnit(m.watch_low, rate, state.unit) + " ~ " +
            fmtUnit(m.watch_high, rate, state.unit);
        }
      });
    }

    function drawChart(container, series) {
      container.innerHTML = "";
      var pts = series.filter(function (p) { return p.usd != null; });
      if (state.range !== "all") {
        var n = parseInt(state.range, 10);
        pts = pts.slice(-n);
      }
      if (pts.length < 2) {
        var e = document.createElement("div");
        e.className = "empty";
        e.textContent = "資料累積中，需至少兩天才會出現走勢圖。";
        container.appendChild(e);
        return;
      }
      var U = UNITS[state.unit];
      var vals = pts.map(function (p) { return U.conv(p.usd, p.rate != null ? p.rate : 1); });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var span = (hi - lo) || 1;
      var W = 600, H = 200, padY = 16;
      var up = vals[vals.length - 1] >= vals[0];
      var color = up ? cssVar("--up") : cssVar("--down");
      var X = function (i) { return i / (pts.length - 1) * W; };
      var Y = function (v) { return padY + (1 - (v - lo) / span) * (H - 2 * padY); };
      var d = vals.map(function (v, i) { return X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(" ");

      var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<polyline fill="none" stroke="' + color + '" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" points="' + d + '"/></svg>';
      container.insertAdjacentHTML("beforeend", svg);

      var guide = document.createElement("div"); guide.className = "guide";
      var dot = document.createElement("div"); dot.className = "dot"; dot.style.background = color;
      var tip = document.createElement("div"); tip.className = "tip";
      container.appendChild(guide); container.appendChild(dot); container.appendChild(tip);

      container.onmousemove = function (ev) {
        var rect = container.getBoundingClientRect();
        var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        var idx = Math.round(ratio * (pts.length - 1));
        var xpx = (idx / (pts.length - 1)) * rect.width;
        var ypx = (Y(vals[idx]) / H) * rect.height;
        guide.style.height = rect.height + "px"; guide.style.left = xpx + "px"; guide.style.opacity = ".6";
        dot.style.left = xpx + "px"; dot.style.top = ypx + "px"; dot.style.opacity = "1";
        var dt = new Date(pts[idx].ts);
        var ds = isNaN(dt) ? "" : (dt.getMonth() + 1) + "/" + dt.getDate();
        tip.textContent = ds + "　" + U.pre + fmt(vals[idx], U.dp) + U.suf;
        tip.style.left = xpx + "px"; tip.style.top = ypx + "px"; tip.style.opacity = "1";
      };
      container.onmouseleave = function () {
        guide.style.opacity = "0"; dot.style.opacity = "0"; tip.style.opacity = "0";
      };
    }

    function redraw() {
      renderFigs();
      Object.keys(DATA).forEach(function (key) {
        var c = document.querySelector('.chart[data-chart="' + key + '"]');
        if (c) drawChart(c, DATA[key].series || []);
      });
    }
    window.__redraw = redraw;

    document.querySelectorAll(".unitbar button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.unit = b.getAttribute("data-unit"); localStorage.setItem("metalUnit", state.unit);
        markBar(".unitbar", "data-unit", state.unit); redraw();
      });
    });
    document.querySelectorAll(".rangebar button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.range = b.getAttribute("data-range"); localStorage.setItem("metalRange", state.range);
        markBar(".rangebar", "data-range", state.range); redraw();
      });
    });
    markBar(".unitbar", "data-unit", state.unit);
    markBar(".rangebar", "data-range", state.range);
    redraw();
  }

  // ============================================================
  // 職缺頁
  // ============================================================
  function initJobs(JOBS) {
    var searchEl = document.getElementById("jobSearch");
    var areaEl = document.getElementById("jobArea");
    var countEl = document.getElementById("jobCount");
    var tbody = document.getElementById("jobBody");
    var sort = { key: "salary", dir: -1 };

    // 地區下拉
    if (areaEl) {
      var areas = {};
      JOBS.forEach(function (j) { areas[j.area] = (areas[j.area] || 0) + 1; });
      Object.keys(areas).sort(function (a, b) { return areas[b] - areas[a]; }).forEach(function (a) {
        var o = document.createElement("option"); o.value = a; o.textContent = a + "（" + areas[a] + "）";
        areaEl.appendChild(o);
      });
    }

    function salaryVal(j) {
      if (j.salary_low == null) return -1;
      return j.salary_high ? (j.salary_low + j.salary_high) / 2 : j.salary_low;
    }
    function salaryText(j) {
      if (j.salary_low == null) {
        return ({ "面議": "面議", "時薪": "時薪", "yearly": "年薪制" })[j.salary_kind] || "—";
      }
      return j.salary_high ? "NT$" + fmt(j.salary_low, 0) + "~" + fmt(j.salary_high, 0)
        : "NT$" + fmt(j.salary_low, 0) + " 以上";
    }
    function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

    function render() {
      var q = (searchEl && searchEl.value.trim().toLowerCase()) || "";
      var area = (areaEl && areaEl.value) || "";
      var rows = JOBS.filter(function (j) {
        if (area && j.area !== area) return false;
        if (q) { var blob = (j.title + " " + j.company).toLowerCase(); if (blob.indexOf(q) < 0) return false; }
        return true;
      });
      rows.sort(function (a, b) {
        var va, vb;
        if (sort.key === "salary") { va = salaryVal(a); vb = salaryVal(b); }
        else { va = a[sort.key] || ""; vb = b[sort.key] || ""; }
        if (va < vb) return -sort.dir; if (va > vb) return sort.dir; return 0;
      });
      if (countEl) countEl.textContent = rows.length + " / " + JOBS.length + " 筆";
      tbody.innerHTML = rows.map(function (j) {
        return '<tr><td><a href="' + esc(j.url) + '" target="_blank" rel="noopener">' +
          esc(j.title.slice(0, 40)) + "</a></td><td>" + esc(j.company.slice(0, 22)) + "</td><td>" +
          esc(j.area) + '</td><td class="num">' + salaryText(j) + "</td></tr>";
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

    // 薪資分布直方圖
    var hist = document.getElementById("hist");
    if (hist) {
      var buckets = [
        { l: "<3萬", lo: 0, hi: 30000 }, { l: "3–4萬", lo: 30000, hi: 40000 },
        { l: "4–5萬", lo: 40000, hi: 50000 }, { l: "5–7萬", lo: 50000, hi: 70000 },
        { l: "7萬+", lo: 70000, hi: Infinity }
      ];
      JOBS.forEach(function (j) {
        var v = salaryVal(j); if (v < 0) return;
        for (var i = 0; i < buckets.length; i++) if (v >= buckets[i].lo && v < buckets[i].hi) { buckets[i].n = (buckets[i].n || 0) + 1; break; }
      });
      var max = Math.max.apply(null, buckets.map(function (b) { return b.n || 0; })) || 1;
      hist.innerHTML = buckets.map(function (b) {
        return '<div class="col"><div class="bn">' + (b.n || 0) + '</div>' +
          '<div class="bar" style="height:' + Math.round((b.n || 0) / max * 100) + '%"></div>' +
          '<div class="bl">' + b.l + "</div></div>";
      }).join("");
    }

    var arw0 = document.querySelector('th.sortable[data-key="salary"] .arrow');
    if (arw0) arw0.textContent = "▼";
    render();
  }

  // ---------- 啟動 ----------
  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    if (window.METALS_DATA) initMetals(window.METALS_DATA);
    if (window.JOBS_DATA) initJobs(window.JOBS_DATA);
  });
})();
