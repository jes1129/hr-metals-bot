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

  // ---------- 資料庫層（Google 登入 + Apps Script 試算表；未設定/未登入則存本機瀏覽器） ----------
  var CFG = window.APP_CONFIG || {};
  var CLIENT_ID = CFG.GOOGLE_CLIENT_ID || "";
  var API = CFG.APPS_SCRIPT_URL || "";
  var idToken = null, gUser = null;   // 登入後的 Google ID token 與使用者
  function lsGet(k, def) { try { var v = JSON.parse(localStorage.getItem("db_" + k)); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem("db_" + k, JSON.stringify(v)); } catch (e) {} }
  var Marks = lsGet("marks", {});     // { id: {status, note, fav} }
  var Quotes = lsGet("quotes", []);   // [ {ts, material, weight, price, proc, margin, quote} ]

  // 呼叫 Apps Script 後端（帶 Google ID token；未設定/未登入則略過、只用本機快取）
  function dbCall(action, payload) {
    if (!API || !idToken) return Promise.resolve(null);
    return fetch(API, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: action, token: idToken, payload: payload || {} })
    }).then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  function cloudPull() {   // 登入後從試算表拉最新，覆蓋本機並刷新畫面
    dbCall("load", {}).then(function (d) {
      if (!d || d.error) return;
      if (d.marks) { Marks = d.marks; lsSet("marks", Marks); }
      if (d.quotes) { Quotes = d.quotes; lsSet("quotes", Quotes); }
      if (window.__refreshMarks) window.__refreshMarks();
      if (window.__refreshQuotes) window.__refreshQuotes();
      if (window.__refreshConsole) window.__refreshConsole();
    });
  }
  function markGet(id) { return Marks[id] || { status: "", note: "", fav: false }; }
  function markSet(id, m) { Marks[id] = m; lsSet("marks", Marks); dbCall("markSet", { id: id, value: m }); }
  function quoteAdd(q) { Quotes.unshift(q); lsSet("quotes", Quotes); dbCall("quoteAdd", { value: q }); }
  function quoteDel(ts) { Quotes = Quotes.filter(function (x) { return x.ts !== ts; }); lsSet("quotes", Quotes); dbCall("quoteDel", { ts: ts }); }

  // ---------- Google 登入（Identity Services；只用身分，不要敏感權限） ----------
  var authReady = false, pulledOnce = false;
  function initAuth() {
    var box = document.getElementById("gAuth"); if (!box) return;
    if (!CLIENT_ID) { box.innerHTML = '<span class="gnote" title="見 README Google 設定">未設定 Google</span>'; return; }
    // 先還原本機登入（即使 GIS 尚未載入，也能立刻顯示已登入、不會閃成登出）
    var restored = restoreAuth();
    if (restored) { paintAuth(); if (!pulledOnce) { pulledOnce = true; cloudPull(); } }
    if (typeof google === "undefined" || !google.accounts || !google.accounts.id) return; // GIS 尚未載入，稍後 onGoogleLibraryLoad 再進來
    if (authReady) return;
    authReady = true;
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCred, auto_select: true });
    paintAuth();
  }
  function onCred(resp) {
    idToken = resp.credential;
    var exp = 0;
    try { var p = JSON.parse(decodeURIComponent(escape(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))); gUser = { email: p.email, name: p.name }; exp = p.exp || 0; } catch (e) { gUser = null; }
    // 持久化登入：存 token 與到期時間，換頁重載時還原（token 效期約 1 小時）
    lsSet("gtoken", { t: idToken, e: exp, u: gUser });
    paintAuth(); cloudPull();
  }
  // 換頁重載時，若本機存有未過期的登入，先還原，避免「切換頁面就自動登出」
  function restoreAuth() {
    var g = lsGet("gtoken", null);
    if (g && g.t && g.e && g.e > (Date.now() / 1000 + 60)) {
      idToken = g.t; gUser = g.u || null; return true;
    }
    if (g) lsSet("gtoken", null);   // 已過期 → 清掉
    return false;
  }
  function signOut() { idToken = null; gUser = null; lsSet("gtoken", null); try { google.accounts.id.disableAutoSelect(); } catch (e) {} paintAuth(); }
  function paintAuth() {
    var box = document.getElementById("gAuth"); if (!box) return;
    if (gUser) {
      box.innerHTML = '<span class="guser" title="' + escAttr(gUser.email) + '">👤 ' + escAttr(gUser.name || gUser.email) + '</span><button id="gOut" class="gbtn">登出</button>';
      var o = document.getElementById("gOut"); if (o) o.onclick = signOut;
    } else {
      box.innerHTML = '<div id="gBtn"></div>';
      // 只放「Sign in with Google」按鈕，不呼叫 One Tap prompt()（避免自動彈窗與未登入時的 console 噪音）
      try { google.accounts.id.renderButton(document.getElementById("gBtn"), { type: "standard", size: "medium", text: "signin_with", shape: "pill" }); } catch (e) {}
    }
    // 登入狀態一改變就刷新資料庫操作中心 / 訂單頁（顯示/隱藏「未登入」橫幅、載入雲端資料）
    if (window.__refreshConsole) window.__refreshConsole();
    if (window.__refreshOrders) window.__refreshOrders();
    if (window.__refreshMrp) window.__refreshMrp();
    if (window.__refreshAssistant) window.__refreshAssistant();
  }
  window.onGoogleLibraryLoad = initAuth;  // GIS 載入完成時回呼
  function needLogin() { return !!(CLIENT_ID && !idToken); }  // 有設定 Google 但尚未登入

  var STATUS = ["", "已聯絡", "合作中", "不合適"];
  function escAttr(s) { return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function favSpan(id) { return '<span class="mkfav' + (markGet(id).fav ? " on" : "") + '" data-id="' + escAttr(id) + '" title="收藏">' + (markGet(id).fav ? "⭐" : "☆") + "</span> "; }
  // Google 日曆 / Gmail 預填深連結（免 OAuth、免敏感權限）
  function calLink(title) { return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(title); }
  function markCell(id, name) {
    var m = markGet(id); name = name || "";
    var opts = STATUS.map(function (o) { return '<option value="' + o + '"' + (m.status === o ? " selected" : "") + ">" + (o || "—狀態—") + "</option>"; }).join("");
    var acts = '<a class="mkact" target="_blank" rel="noopener" href="' + calLink("追蹤／拜訪 " + name) + '" title="加到 Google 日曆提醒">📅</a>';
    return '<td class="mkcell"><select class="mkstat" data-id="' + escAttr(id) + '">' + opts + "</select>" +
      '<input class="mknote" data-id="' + escAttr(id) + '" value="' + escAttr(m.note) + '" placeholder="備註…">' +
      '<div class="mkacts">' + acts + "</div></td>";
  }
  // 於名錄 tbody 綁定「收藏/狀態/備註」事件（委派），idOf(row元素)->id
  function attachMarks(tbody) {
    tbody.addEventListener("change", function (e) {
      var el = e.target, id = el.getAttribute && el.getAttribute("data-id"); if (!id) return;
      var m = markGet(id);
      if (el.classList.contains("mkstat")) m.status = el.value;
      else if (el.classList.contains("mknote")) m.note = el.value;
      else return;
      markSet(id, m);
    });
    tbody.addEventListener("click", function (e) {
      var el = e.target; if (!el.classList || !el.classList.contains("mkfav")) return;
      var id = el.getAttribute("data-id"); var m = markGet(id); m.fav = !m.fav; markSet(id, m);
      el.textContent = m.fav ? "⭐" : "☆"; el.classList.toggle("on", m.fav);
    });
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

      // 現價/漲跌
      var priceEl = panel.querySelector(".price"), chgEl = panel.querySelector(".chg");
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

      // 期間統計
      setPct(panel.querySelector(".c7"), pctChange(s, 7, uk));
      setPct(panel.querySelector(".c30"), pctChange(s, 30, uk));
      setPct(panel.querySelector(".c90"), pctChange(s, 90, uk));
      var win = filterDays(s, state.range).map(function (p) { return convVal(p.usd, p.rate, uk); }).filter(function (v) { return v != null; });
      var phi = panel.querySelector(".phi"), plo = panel.querySelector(".plo");
      if (phi) phi.textContent = win.length ? unitFmt(Math.max.apply(null, win), uk) : "—";
      if (plo) plo.textContent = win.length ? unitFmt(Math.min.apply(null, win), uk) : "—";

      // 走勢圖
      var cont = panel.querySelector('.chart[data-chart="' + key + '"]');
      var pts = filterDays(s, state.range).map(function (p) {
        return { ts: p.ts, val: p.usd == null ? null : convVal(p.usd, p.rate, uk) };
      });
      drawSeries(cont, pts, {
        ma: 0,
        hlines: [],
        fmt: function (v) { return unitFmt(v, uk); }
      });
    }

    function redraw() { Object.keys(DATA).forEach(renderOne); }
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
    var priEl = document.getElementById("jobPriority"), favEl = document.getElementById("jobFav");
    var statusEl = document.getElementById("jobStatus");
    var countEl = document.getElementById("jobCount"), tbody = document.getElementById("jobBody");
    var sort = { key: "salary", dir: -1 };

    if (areaEl) {
      var areas = {};
      JOBS.forEach(function (j) { var d = j.district || "其他"; areas[d] = (areas[d] || 0) + 1; });
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
      var priOnly = priEl && priEl.checked, favOnly = favEl && favEl.checked;
      var rows = JOBS.filter(function (j) {
        if (priOnly && !j.is_priority) return false;
        if (favOnly && !markGet(j.url || j.title).fav) return false;
        if (statusEl && statusEl.value && markGet(j.url || j.title).status !== statusEl.value) return false;
        if (area && (j.district || "其他") !== area) return false;
        if (q && (j.title + " " + j.company).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      rows.sort(function (a, b) {
        var va = sort.key === "salary" ? salVal(a) : (a[sort.key] || ""), vb = sort.key === "salary" ? salVal(b) : (b[sort.key] || "");
        if (va < vb) return -sort.dir; if (va > vb) return sort.dir; return 0;
      });
      if (countEl) countEl.textContent = rows.length + " / " + JOBS.length + " 筆";
      tbody.innerHTML = rows.map(function (j) {
        var id = j.url || j.title;
        var star = j.is_priority ? '<span class="star">⭐</span> ' : "";
        return '<tr><td>' + favSpan(id) + star + '<a href="' + esc(j.url) + '" target="_blank" rel="noopener">' + esc(j.title.slice(0, 40)) +
          "</a></td><td>" + esc(j.company.slice(0, 22)) + "</td><td>" + esc(j.district || "其他") + '</td><td class="num">' + salTxt(j) + "</td>" + markCell(id, j.company || j.title) + "</tr>";
      }).join("") || '<tr><td colspan="5" style="color:var(--muted)">找不到符合的職缺</td></tr>';
    }
    window.__refreshMarks = render;
    attachMarks(tbody);
    if (searchEl) searchEl.addEventListener("input", render);
    if (areaEl) areaEl.addEventListener("change", render);
    if (priEl) priEl.addEventListener("change", render);
    if (favEl) favEl.addEventListener("change", render);
    if (statusEl) statusEl.addEventListener("change", render);
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

  // ============================================================ 供應商頁
  function initSuppliers(SUP) {
    var searchEl = document.getElementById("supSearch"), catEl = document.getElementById("supCat");
    var nearEl = document.getElementById("supNear"), countEl = document.getElementById("supCount");
    var favEl = document.getElementById("supFav"), statusEl = document.getElementById("supStatus");
    var tbody = document.getElementById("supBody");
    var sort = { key: "name", dir: 1 };
    function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

    if (catEl) {
      var cats = {};
      SUP.forEach(function (s) { var c = s.category || "其他"; cats[c] = (cats[c] || 0) + 1; });
      Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).forEach(function (c) {
        var o = document.createElement("option"); o.value = c; o.textContent = c + "（" + cats[c] + "）"; catEl.appendChild(o);
      });
    }
    function render() {
      var q = (searchEl && searchEl.value.trim().toLowerCase()) || "";
      var cat = (catEl && catEl.value) || "", nearOnly = nearEl && nearEl.checked, favOnly = favEl && favEl.checked;
      var rows = SUP.filter(function (s) {
        if (nearOnly && !s.is_near) return false;
        if (favOnly && !markGet(s.url || s.name).fav) return false;
        if (statusEl && statusEl.value && markGet(s.url || s.name).status !== statusEl.value) return false;
        if (cat && s.category !== cat) return false;
        if (q && (s.name + " " + s.area + " " + (s.address || "")).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      rows.sort(function (a, b) {
        var va = (a[sort.key] || ""), vb = (b[sort.key] || "");
        if (va < vb) return -sort.dir; if (va > vb) return sort.dir; return 0;
      });
      if (countEl) countEl.textContent = rows.length + " / " + SUP.length + " 家";
      tbody.innerHTML = rows.map(function (s) {
        var id = s.url || s.name;
        var near = s.is_near ? '<span class="star">⭐</span> ' : "";
        var name = s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name.slice(0, 34)) + "</a>" : esc(s.name.slice(0, 34));
        return "<tr><td>" + favSpan(id) + near + name + "</td><td>" + esc(s.category) + "</td><td>" +
          esc(s.area || s.address || "—") + "</td><td>" + esc(s.size || "—") + "</td><td>" + esc(s.source) + "</td>" + markCell(id, s.name) + "</tr>";
      }).join("") || '<tr><td colspan="6" style="color:var(--muted)">找不到符合的供應商</td></tr>';
    }
    window.__refreshMarks = render;
    attachMarks(tbody);
    if (searchEl) searchEl.addEventListener("input", render);
    if (catEl) catEl.addEventListener("change", render);
    if (nearEl) nearEl.addEventListener("change", render);
    if (favEl) favEl.addEventListener("change", render);
    if (statusEl) statusEl.addEventListener("change", render);
    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-key");
        if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = 1; }
        document.querySelectorAll("th.sortable .arrow").forEach(function (a) { a.textContent = ""; });
        var arw = th.querySelector(".arrow"); if (arw) arw.textContent = sort.dir > 0 ? "▲" : "▼";
        render();
      });
    });
    render();
  }

  // ============================================================ 供應商地圖
  var TC = {  // 台中各行政區約略中心
    "神岡":[24.257,120.662],"豐原":[24.253,120.717],"大雅":[24.229,120.647],"潭子":[24.211,120.705],
    "后里":[24.309,120.711],"清水":[24.269,120.566],"沙鹿":[24.234,120.566],"梧棲":[24.255,120.531],
    "龍井":[24.192,120.545],"大甲":[24.349,120.622],"外埔":[24.333,120.654],"大安":[24.348,120.588],
    "石岡":[24.276,120.780],"新社":[24.234,120.809],"東勢":[24.259,120.827],"和平":[24.174,120.900],
    "西屯":[24.181,120.616],"南屯":[24.138,120.643],"北屯":[24.182,120.686],"西區":[24.141,120.664],
    "北區":[24.166,120.684],"東區":[24.138,120.694],"南區":[24.119,120.664],"中區":[24.144,120.679],
    "烏日":[24.104,120.622],"大肚":[24.154,120.541],"霧峰":[24.061,120.700],"太平":[24.126,120.718],"大里":[24.099,120.677]
  };
  var COUNTY = {
    "台北":[25.04,121.56],"新北":[25.01,121.46],"桃園":[24.99,121.30],"台中":[24.15,120.67],"台南":[23.00,120.21],
    "高雄":[22.62,120.31],"基隆":[25.13,121.74],"新竹":[24.81,120.97],"苗栗":[24.56,120.82],"彰化":[24.05,120.52],
    "南投":[23.91,120.69],"雲林":[23.71,120.43],"嘉義":[23.48,120.45],"屏東":[22.55,120.55],"宜蘭":[24.70,121.74],
    "花蓮":[23.99,121.60],"台東":[22.76,121.14],"澎湖":[23.57,119.58],"金門":[24.43,118.32],"連江":[26.16,119.95]
  };
  function _latlng(area) {
    var a = (area || "").replace(/臺/g, "台");
    for (var k in TC) if (a.indexOf(k) >= 0) return TC[k];
    for (var c in COUNTY) if (a.indexOf(c) >= 0) return COUNTY[c];
    return null;
  }
  function initSupplierMap(SUP) {
    var mapEl = document.getElementById("supMap"), tableEl = document.getElementById("supTable");
    if (!mapEl || typeof L === "undefined") return;
    var map = null;
    function build() {
      map = L.map(mapEl).setView([24.257, 120.662], 10);  // 神岡為中心
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
      L.marker([24.257, 120.662]).addTo(map).bindPopup("<b>九上科技</b><br>神岡（你的位置）");
      var esc = function (s) { var d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; };
      SUP.slice(0, 600).forEach(function (s) {
        var ll = _latlng(s.area || s.address); if (!ll) return;
        var lat = ll[0] + (Math.random() - 0.5) * 0.02, lng = ll[1] + (Math.random() - 0.5) * 0.02;
        var color = s.is_near ? "#c0392b" : "#2c7be5";
        L.circleMarker([lat, lng], { radius: 5, color: color, weight: 1, fillOpacity: .7 })
          .addTo(map)
          .bindPopup("<b>" + esc(s.name) + "</b><br>" + esc(s.category) + " · " + esc(s.area) +
            "<br>來源：" + esc(s.source) + (s.url ? '<br><a href="' + esc(s.url) + '" target="_blank">公司頁</a>' : ""));
      });
    }
    document.querySelectorAll(".viewbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-view");
        document.querySelectorAll(".viewbar button").forEach(function (b) { b.classList.toggle("on", b === btn); });
        if (v === "map") {
          tableEl.style.display = "none"; mapEl.style.display = "block";
          if (!map) build();
          setTimeout(function () { map.invalidateSize(); }, 60);
        } else { mapEl.style.display = "none"; tableEl.style.display = ""; }
      });
    });
  }

  // ============================================================ 客戶開發雷達
  function initCustomers(CUS) {
    var searchEl = document.getElementById("custSearch"), catEl = document.getElementById("custCat");
    var favEl = document.getElementById("custFav"), statusEl = document.getElementById("custStatus");
    var countEl = document.getElementById("custCount"), tbody = document.getElementById("custBody");
    var sort = { key: "name", dir: 1 };
    function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
    if (catEl) {
      var cats = {};
      CUS.forEach(function (s) { var c = s.category || "其他"; cats[c] = (cats[c] || 0) + 1; });
      Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).forEach(function (c) {
        var o = document.createElement("option"); o.value = c; o.textContent = c + "（" + cats[c] + "）"; catEl.appendChild(o);
      });
    }
    function render() {
      var q = (searchEl && searchEl.value.trim().toLowerCase()) || "", cat = (catEl && catEl.value) || "", favOnly = favEl && favEl.checked;
      var rows = CUS.filter(function (s) {
        if (favOnly && !markGet(s.url || s.name).fav) return false;
        if (statusEl && statusEl.value && markGet(s.url || s.name).status !== statusEl.value) return false;
        if (cat && s.category !== cat) return false;
        if (q && (s.name + " " + s.area + " " + (s.address || "")).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      rows.sort(function (a, b) {
        var va = (a[sort.key] || ""), vb = (b[sort.key] || "");
        if (va < vb) return -sort.dir; if (va > vb) return sort.dir; return 0;
      });
      if (countEl) countEl.textContent = rows.length + " / " + CUS.length + " 家";
      tbody.innerHTML = rows.map(function (s) {
        var id = s.url || s.name;
        var name = s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name.slice(0, 34)) + "</a>" : esc(s.name.slice(0, 34));
        return "<tr><td>" + favSpan(id) + name + "</td><td>" + esc(s.category) + "</td><td>" + esc(s.area || "—") + "</td><td>" + esc(s.source) + "</td>" + markCell(id, s.name) + "</tr>";
      }).join("") || '<tr><td colspan="5" style="color:var(--muted)">找不到符合的客戶</td></tr>';
    }
    window.__refreshMarks = render;
    attachMarks(tbody);
    if (searchEl) searchEl.addEventListener("input", render);
    if (catEl) catEl.addEventListener("change", render);
    if (favEl) favEl.addEventListener("change", render);
    if (statusEl) statusEl.addEventListener("change", render);
    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-key");
        if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = 1; }
        document.querySelectorAll("th.sortable .arrow").forEach(function (a) { a.textContent = ""; });
        var arw = th.querySelector(".arrow"); if (arw) arw.textContent = sort.dir > 0 ? "▲" : "▼";
        render();
      });
    });
    render();
  }

  // ============================================================ 報價試算器
  function initQuote(MATS) {
    var matEl = document.getElementById("qMat"), wEl = document.getElementById("qWeight");
    var pEl = document.getElementById("qPrice"), noteEl = document.getElementById("qPriceNote");
    var procEl = document.getElementById("qProc"), mgEl = document.getElementById("qMargin");
    var lEl = document.getElementById("qL"), wwEl = document.getElementById("qW"), hEl = document.getElementById("qH");
    var ntd = function (n) { return "NT$" + Math.round(n).toLocaleString("en-US"); };

    MATS.forEach(function (m, i) {
      var o = document.createElement("option"); o.value = i; o.textContent = m.name; matEl.appendChild(o);
    });
    function cur() { return MATS[parseInt(matEl.value, 10) || 0]; }
    function onMat() {
      var m = cur();
      if (m.nt != null && !pEl.value) pEl.value = m.nt;
      else if (m.nt != null) pEl.value = m.nt;
      noteEl.textContent = m.live ? "（已帶入最新行情，可修改）" : "⚠️ " + (m.note || "參考值，請填實際採購價");
      noteEl.style.color = m.live ? "var(--muted)" : "var(--up)";
      calc();
    }
    function calcWeight() {
      var m = cur(), L = parseFloat(lEl.value), W = parseFloat(wwEl.value), H = parseFloat(hEl.value);
      if (L > 0 && W > 0 && H > 0) { wEl.value = (L * W * H * m.density / 1000).toFixed(2); calc(); }
    }
    function calc() {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0;
      var proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0;
      var matCost = w * p, total = matCost + proc, quote = total * (1 + mg / 100);
      document.getElementById("qMatCost").textContent = w && p ? ntd(matCost) : "—";
      document.getElementById("qTotal").textContent = w && p ? ntd(total) : "—";
      document.getElementById("qQuote").textContent = w && p ? ntd(quote) : "—";
    }
    matEl.addEventListener("change", onMat);
    [wEl, pEl, procEl, mgEl].forEach(function (e) { e.addEventListener("input", calc); });
    document.getElementById("qCalc").addEventListener("click", calcWeight);

    // 報價歷史（存/列/刪）
    var histEl = document.getElementById("qHistory"), saveBtn = document.getElementById("qSave");
    function renderHist() {
      if (!histEl) return;
      histEl.innerHTML = Quotes.length ? Quotes.map(function (q) {
        var d = new Date(q.ts); var ds = (d.getMonth() + 1) + "/" + d.getDate() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
        return '<div class="qh"><div><b>' + escAttr(q.material) + "</b>　" + q.weight + "kg × NT$" + q.price +
          (q.proc ? "　+工 " + q.proc : "") + "　利 " + q.margin + "% → <b style='color:var(--accent)'>" + ntd(q.quote) + "</b>" +
          '<div class="mnote">' + ds + "</div></div><button class=\"qdel\" data-ts=\"" + q.ts + "\">刪除</button></div>";
      }).join("") : '<div class="mnote" style="padding:10px 4px">尚無報價紀錄（算好後按「💾 存這筆」）</div>';
    }
    window.__refreshQuotes = renderHist;
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0;
      if (!(w && p)) { alert("請先填重量與料價"); return; }
      var proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0;
      quoteAdd({ ts: Date.now(), material: cur().name, weight: w, price: p, proc: proc, margin: mg, quote: Math.round((w * p + proc) * (1 + mg / 100)) });
      renderHist();
    });
    if (histEl) histEl.addEventListener("click", function (e) {
      if (e.target.classList.contains("qdel")) { quoteDel(parseInt(e.target.getAttribute("data-ts"), 10)); renderHist(); }
    });
    var driveBtn = document.getElementById("qDrive");
    if (driveBtn) driveBtn.addEventListener("click", function () {
      if (needLogin()) { alert("請先用右上角「Google 登入」，才能存到公司 Drive。"); return; }
      if (!API || !idToken) { alert("尚未設定 Google（見說明），目前報價只存在本機。"); return; }
      if (!Quotes.length) { alert("尚無報價紀錄，先算好並「存這筆」。"); return; }
      driveBtn.textContent = "⏳ 存檔中…"; driveBtn.disabled = true;
      dbCall("driveSave", { quotes: Quotes }).then(function (d) {
        driveBtn.textContent = "📄 報價歷史另存到 Drive"; driveBtn.disabled = false;
        if (d && d.url) { window.open(d.url, "_blank"); }
        else alert("存檔失敗，請稍後再試。");
      });
    });
    onMat(); renderHist();
  }

  // ===========================================================================
  // 資料庫操作中心（db.html）— schema 驅動的通用資料表：查/篩/排/增/改/刪/匯出
  //   後端 = Apps Script 通用 CRUD（tList/tUpsert/tRemove）。日後加訂單/庫存只要加 schema。
  // ===========================================================================
  var SCHEMAS = {
    mylist: {
      title: "我的名單 / 待辦", icon: "📝", table: "mylist", canAdd: true, canEdit: true, canDelete: true,
      cols: [
        { k: "name", label: "名稱", wide: true },
        { k: "category", label: "分類", filter: true },
        { k: "status", label: "狀態", type: "select", opts: ["", "待處理", "進行中", "已完成", "擱置"], filter: true, stat: true },
        { k: "owner", label: "負責人" },
        { k: "due", label: "到期", type: "date" },
        { k: "note", label: "備註", wide: true }
      ],
      sample: [
        { name: "聯絡大雅精密報價", category: "報價", status: "進行中", owner: "我", due: "", note: "316 不鏽鋼件" },
        { name: "追蹤神岡工業樣品", category: "供應商", status: "待處理", owner: "我", due: "", note: "" },
        { name: "整理本月客戶開發名單", category: "客戶開發", status: "待處理", owner: "我", due: "", note: "" }
      ]
    },
    marks: {
      title: "收藏與標記", icon: "⭐", table: "marks", canAdd: false, canEdit: true, canDelete: true,
      cols: [
        { k: "id", label: "對象", wide: true, ro: true },
        { k: "status", label: "狀態", type: "select", opts: ["", "已聯絡", "合作中", "不合適"], filter: true, stat: true },
        { k: "note", label: "備註", wide: true },
        { k: "fav", label: "收藏", type: "bool" }
      ]
    },
    quotes: {
      title: "報價歷史", icon: "🧮", table: "quotes", canAdd: false, canEdit: false, canDelete: true,
      delKey: "ts", delAction: "quoteDel",
      cols: [
        { k: "ts", label: "時間", type: "time", ro: true },
        { k: "material", label: "材質", filter: true, stat: true },
        { k: "weight", label: "重量kg", type: "num" },
        { k: "price", label: "料價", type: "num" },
        { k: "quote", label: "報價NT$", type: "num" }
      ]
    },
    orders: {
      title: "訂單", icon: "📦", table: "orders", canAdd: true, canEdit: true, canDelete: true,
      cols: [
        { k: "customer", label: "客戶", filter: true },
        { k: "product", label: "品名", wide: true },
        { k: "qty", label: "數量", type: "num" },
        { k: "price", label: "單價", type: "num" },
        { k: "amount", label: "金額", type: "num" },
        { k: "status", label: "狀態", type: "select", opts: ["報價", "接單", "生產", "出貨", "結案", "取消"], filter: true, stat: true },
        { k: "order_date", label: "下單日", type: "date" },
        { k: "due", label: "交期", type: "date" },
        { k: "email", label: "客戶信箱" },
        { k: "note", label: "備註", wide: true }
      ]
    },
    items: {
      title: "料號 / 庫存", icon: "🧱", table: "items", canAdd: true, canEdit: true, canDelete: true,
      cols: [
        { k: "code", label: "料號", filter: true },
        { k: "name", label: "品名", wide: true },
        { k: "category", label: "分類", filter: true },
        { k: "unit", label: "單位" },
        { k: "stock", label: "庫存", type: "num" },
        { k: "safety", label: "安全庫存", type: "num" },
        { k: "on_order", label: "在途", type: "num" },
        { k: "cost", label: "單價", type: "num" },
        { k: "note", label: "備註", wide: true }
      ],
      sample: [
        { code: "SUS304-8", name: "不鏽鋼棒 8mm", category: "材料", unit: "支", stock: 120, safety: 200, on_order: 0, cost: 90, note: "" },
        { code: "CU-8", name: "銅棒 8mm", category: "材料", unit: "支", stock: 500, safety: 100, on_order: 0, cost: 320, note: "" },
        { code: "SCREW-M4", name: "四線牙螺絲 M4", category: "零件", unit: "顆", stock: 3000, safety: 5000, on_order: 1000, cost: 2, note: "" }
      ]
    },
    bom: {
      title: "產品用料 (BOM)", icon: "🧩", table: "bom", canAdd: true, canEdit: true, canDelete: true,
      cols: [
        { k: "product", label: "產品", filter: true },
        { k: "item_code", label: "料號", filter: true },
        { k: "per", label: "每件用量", type: "num" },
        { k: "note", label: "備註", wide: true }
      ],
      sample: [
        { product: "316螺絲", item_code: "SUS304-8", per: 1, note: "" },
        { product: "316螺絲", item_code: "SCREW-M4", per: 4, note: "" },
        { product: "銅接頭", item_code: "CU-8", per: 1, note: "" }
      ]
    }
  };
  // 訂單狀態流程（看板欄位順序；取消單獨處理）
  var ORDER_FLOW = ["報價", "接單", "生產", "出貨", "結案"];
  // MRP 需求採計的訂單狀態（已接的單才算真實需求；報價未成單不算）
  var MRP_DEMAND_STATUS = ["接單", "生產"];

  function initDbConsole() {
    var mount = document.getElementById("dbConsole");
    if (!mount) return;
    var state = { cur: "mylist", rows: [], sortK: "", sortDir: 1, q: "", filters: {} };
    var cache = {};  // table -> rows（本機快取，離線也看得到）

    function schema() { return SCHEMAS[state.cur]; }
    function cacheKey(t) { return "console_" + t; }
    function fmtCell(col, v) {
      if (v === undefined || v === null || v === "") return "";
      if (col.type === "time") { var d = new Date(Number(v) || v); return isNaN(d) ? String(v) : d.toLocaleString("zh-TW", { hour12: false }).replace(/:\d\d$/, ""); }
      if (col.type === "bool") return (v === true || v === "TRUE" || v === "true") ? "⭐" : "";
      if (col.type === "num") { var n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString(); }
      return String(v);
    }
    function isFav(v) { return v === true || v === "TRUE" || v === "true"; }

    function load(t) {
      state.rows = lsGet(cacheKey(t), []) || [];   // 先用快取畫
      render();
      if (!idToken) { render(); return; }           // 未登入：只看快取
      dbCall("tList", { table: SCHEMAS[t].table }).then(function (d) {
        if (!d || d.error || !d.rows) return;
        cache[t] = d.rows; lsSet(cacheKey(t), d.rows);
        if (state.cur === t) { state.rows = d.rows; render(); }
      });
    }
    window.__refreshConsole = function () { load(state.cur); };

    function filtered() {
      var s = schema(), q = state.q.toLowerCase();
      var rows = state.rows.filter(function (r) {
        for (var fk in state.filters) { if (state.filters[fk] && String(r[fk] || "") !== state.filters[fk]) return false; }
        if (!q) return true;
        return s.cols.some(function (c) { return String(r[c.k] || "").toLowerCase().indexOf(q) >= 0; });
      });
      if (state.sortK) {
        rows = rows.slice().sort(function (a, b) {
          var x = a[state.sortK], y = b[state.sortK];
          var nx = Number(x), ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny) && x !== "" && y !== "") return (nx - ny) * state.sortDir;
          return String(x || "").localeCompare(String(y || ""), "zh-TW") * state.sortDir;
        });
      }
      return rows;
    }

    function statBlock(rows) {
      var s = schema();
      var chips = '<span class="dbchip strong">共 ' + rows.length + ' 筆</span>';
      var statCol = s.cols.filter(function (c) { return c.stat; })[0];
      var bars = "";
      if (statCol) {
        var counts = {}, order = statCol.opts ? statCol.opts.slice() : [];
        rows.forEach(function (r) { var v = String(r[statCol.k] || "（空）"); counts[v] = (counts[v] || 0) + 1; if (order.indexOf(v) < 0) order.push(v); });
        var mx = 1; for (var k in counts) mx = Math.max(mx, counts[k]);
        order.forEach(function (v) {
          var label = v === "" ? "（未填）" : v, n = counts[v] || 0;
          if (!n) return;
          chips += '<span class="dbchip">' + escAttr(label) + ' ' + n + '</span>';
          bars += '<div class="dbrow"><div class="dblabel">' + escAttr(label) + '</div>'
            + '<div class="dbtrack"><div class="dbbar" style="width:' + Math.round(n / mx * 100) + '%"></div></div>'
            + '<div class="dbval">' + n + '</div></div>';
        });
      }
      return '<div class="dbchips">' + chips + '</div>' + (bars ? '<div class="dbbars">' + bars + '</div>' : "");
    }

    function render() {
      var s = schema(), rows = filtered();
      var tabs = Object.keys(SCHEMAS).map(function (k) {
        return '<button class="dbtab' + (k === state.cur ? " on" : "") + '" data-tab="' + k + '">' + SCHEMAS[k].icon + " " + SCHEMAS[k].title + '</button>';
      }).join("");

      var filterCtrls = s.cols.filter(function (c) { return c.filter; }).map(function (c) {
        var vals = {}; state.rows.forEach(function (r) { if (r[c.k]) vals[r[c.k]] = 1; });
        var opts = ['<option value="">' + escAttr(c.label) + '：全部</option>'].concat(Object.keys(vals).sort().map(function (v) {
          return '<option value="' + escAttr(v) + '"' + (state.filters[c.k] === v ? " selected" : "") + '>' + escAttr(v) + '</option>';
        }));
        return '<select class="dbfilter" data-k="' + c.k + '">' + opts.join("") + '</select>';
      }).join("");

      var toolbar = '<div class="dbtoolbar">'
        + '<input id="dbSearch" class="dbsearch" placeholder="🔍 搜尋…" value="' + escAttr(state.q) + '">'
        + filterCtrls
        + (s.canAdd ? '<button class="dbbtn primary" id="dbAdd">＋ 新增</button>' : "")
        + '<button class="dbbtn" id="dbExport">⬇ 匯出 CSV</button>'
        + '<button class="dbbtn" id="dbReload">↻ 重新整理</button>'
        + '</div>';

      // 表頭
      var ths = s.cols.map(function (c) {
        var ar = state.sortK === c.k ? (state.sortDir > 0 ? " ▲" : " ▼") : "";
        return '<th class="dbsort" data-k="' + c.k + '">' + escAttr(c.label) + '<span class="dbarrow">' + ar + "</span></th>";
      }).join("") + (s.canEdit || s.canDelete ? "<th></th>" : "");

      var body = rows.map(function (r) {
        var tds = s.cols.map(function (c) {
          var val = c.type === "bool" ? (isFav(r[c.k]) ? "⭐" : "") : fmtCell(c, r[c.k]);
          return '<td data-label="' + escAttr(c.label) + '"' + (c.wide ? ' class="wide"' : "") + '>' + escAttr(val) + "</td>";
        }).join("");
        var act = "";
        if (s.canEdit || s.canDelete) {
          act = '<td class="dbact">'
            + (s.canEdit ? '<button class="dbmini" data-edit="' + escAttr(r.id !== undefined ? r.id : r[s.delKey]) + '">✏️</button>' : "")
            + (s.canDelete ? '<button class="dbmini" data-del="' + escAttr(r.id !== undefined && r.id !== "" ? r.id : r[s.delKey]) + '">🗑️</button>' : "")
            + "</td>";
        }
        return "<tr>" + tds + act + "</tr>";
      }).join("");

      var emptyHint = "";
      if (!rows.length) {
        emptyHint = '<div class="dbempty">目前沒有資料。'
          + (state.cur === "mylist" ? '<button class="dbbtn primary" id="dbSample">載入範例資料</button>' : "")
          + (!idToken ? '<div class="dbnote">（請先用右上角「使用 Google 帳戶登入」，登入後才會同步公司試算表的資料）</div>' : "")
          + '</div>';
      }

      mount.innerHTML =
        '<div class="dbtabs">' + tabs + '</div>'
        + (!idToken ? '<div class="dbbanner">🔒 尚未登入：目前顯示的是本機快取。登入後可新增/編輯並同步到公司試算表。</div>' : "")
        + statBlock(rows)
        + toolbar
        + '<div class="dbtablewrap"><table class="dbtable"><thead><tr>' + ths + "</tr></thead><tbody>" + body + "</tbody></table></div>"
        + emptyHint
        + '<div class="dbfoot">資料存在公司 Google 試算表；也可 <a id="dbSheet" href="#" target="_blank" rel="noopener">開啟原始試算表</a>。</div>';

      wire();
    }

    function wire() {
      var s = schema();
      Array.prototype.forEach.call(mount.querySelectorAll(".dbtab"), function (b) {
        b.onclick = function () { state.cur = b.getAttribute("data-tab"); state.q = ""; state.filters = {}; state.sortK = ""; load(state.cur); };
      });
      var se = document.getElementById("dbSearch");
      if (se) se.oninput = function () { state.q = se.value; renderKeepFocus(); };
      Array.prototype.forEach.call(mount.querySelectorAll(".dbfilter"), function (f) {
        f.onchange = function () { state.filters[f.getAttribute("data-k")] = f.value; render(); };
      });
      Array.prototype.forEach.call(mount.querySelectorAll(".dbsort"), function (h) {
        h.onclick = function () { var k = h.getAttribute("data-k"); if (state.sortK === k) state.sortDir *= -1; else { state.sortK = k; state.sortDir = 1; } render(); };
      });
      var add = document.getElementById("dbAdd"); if (add) add.onclick = function () { if (requireAuth()) openForm(null); };
      var exp = document.getElementById("dbExport"); if (exp) exp.onclick = exportCsv;
      var rl = document.getElementById("dbReload"); if (rl) rl.onclick = function () { load(state.cur); };
      var sp = document.getElementById("dbSample"); if (sp) sp.onclick = loadSample;
      var sheet = document.getElementById("dbSheet");
      if (sheet) { var u = (window.APP_CONFIG || {}).SHEET_URL || ""; if (u) sheet.href = u; else sheet.style.display = "none"; }
      Array.prototype.forEach.call(mount.querySelectorAll("[data-edit]"), function (b) {
        b.onclick = function () { if (!requireAuth()) return; var id = b.getAttribute("data-edit"); openForm(findRow(id)); };
      });
      Array.prototype.forEach.call(mount.querySelectorAll("[data-del]"), function (b) {
        b.onclick = function () { if (!requireAuth()) return; delRow(b.getAttribute("data-del")); };
      });
    }
    function renderKeepFocus() {
      render();
      var se = document.getElementById("dbSearch");
      if (se) { se.focus(); se.setSelectionRange(se.value.length, se.value.length); }
    }
    function findRow(id) {
      var s = schema();
      return state.rows.filter(function (r) { return String(r.id !== undefined && r.id !== "" ? r.id : r[s.delKey]) === String(id); })[0] || null;
    }
    function requireAuth() {
      if (!idToken) { alert(CLIENT_ID ? "請先用右上角「使用 Google 帳戶登入」再操作。" : "尚未設定 Google（見說明頁）。"); return false; }
      return true;
    }

    // 新增 / 編輯 彈出表單
    function openForm(row) {
      var s = schema(), editing = !!row; row = row || {};
      var fields = s.cols.filter(function (c) { return !(c.ro && !editing); }).map(function (c) {
        var v = row[c.k] !== undefined ? row[c.k] : "";
        var input;
        if (c.ro) input = '<input disabled value="' + escAttr(fmtCell(c, v)) + '">';
        else if (c.type === "select") input = '<select data-f="' + c.k + '">' + c.opts.map(function (o) { return '<option' + (String(v) === o ? " selected" : "") + '>' + escAttr(o) + "</option>"; }).join("") + "</select>";
        else if (c.type === "bool") input = '<label class="dbcheck"><input type="checkbox" data-f="' + c.k + '"' + (isFav(v) ? " checked" : "") + '> 收藏</label>';
        else if (c.type === "date") input = '<input type="date" data-f="' + c.k + '" value="' + escAttr(v) + '">';
        else if (c.type === "num") input = '<input type="number" step="any" data-f="' + c.k + '" value="' + escAttr(v) + '">';
        else input = '<input data-f="' + c.k + '" value="' + escAttr(v) + '">';
        return '<label class="dbfield"><span>' + escAttr(c.label) + "</span>" + input + "</label>";
      }).join("");
      var ov = document.createElement("div");
      ov.className = "dbmodal";
      ov.innerHTML = '<div class="dbdialog"><h3>' + (editing ? "編輯" : "新增") + " · " + s.icon + escAttr(s.title) + "</h3>"
        + '<div class="dbform">' + fields + "</div>"
        + '<div class="dbdlgbtns"><button class="dbbtn" data-x>取消</button><button class="dbbtn primary" data-ok>儲存</button></div></div>';
      document.body.appendChild(ov);
      function close() { document.body.removeChild(ov); }
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      ov.querySelector("[data-x]").onclick = close;
      ov.querySelector("[data-ok]").onclick = function () {
        var out = {};
        if (editing && row.id !== undefined) out.id = row.id;
        Array.prototype.forEach.call(ov.querySelectorAll("[data-f]"), function (el) {
          out[el.getAttribute("data-f")] = el.type === "checkbox" ? el.checked : el.value;
        });
        save(out); close();
      };
    }
    function save(row) {
      var s = schema(), header = s.cols.map(function (c) { return c.k; });
      // 樂觀更新畫面
      if (row.id) { var f = findRow(row.id); if (f) for (var k in row) f[k] = row[k]; }
      else { row.id = "tmp" + Date.now(); state.rows.unshift(row); }
      lsSet(cacheKey(state.cur), state.rows); render();
      dbCall("tUpsert", { table: s.table, row: row, header: header }).then(function (d) { if (d && d.ok) load(state.cur); });
    }
    function delRow(id) {
      var s = schema(), r = findRow(id);
      if (!confirm("確定刪除這筆？")) return;
      state.rows = state.rows.filter(function (x) { return String(x.id !== undefined && x.id !== "" ? x.id : x[s.delKey]) !== String(id); });
      lsSet(cacheKey(state.cur), state.rows); render();
      if (s.delAction) dbCall(s.delAction, { ts: r ? r[s.delKey] : id });
      else dbCall("tRemove", { table: s.table, id: id });
    }
    function loadSample() {
      if (!requireAuth()) return;
      var s = SCHEMAS.mylist, header = s.cols.map(function (c) { return c.k; });
      dbCall("tImport", { table: s.table, rows: s.sample, header: header }).then(function () { load("mylist"); });
    }
    function exportCsv() {
      var s = schema(), rows = filtered();
      var head = s.cols.map(function (c) { return c.label; });
      var lines = [head.map(csvCell).join(",")];
      rows.forEach(function (r) { lines.push(s.cols.map(function (c) { return csvCell(fmtCell(c, r[c.k])); }).join(",")); });
      var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = s.table + "_" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    function csvCell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

    load(state.cur);
  }

  // ===========================================================================
  // 訂單 + 老闆 KPI 儀表板（orders.html）— 讀 orders 資料表，做 KPI/看板/營收圖
  //   後端沿用通用 CRUD（table="orders"），不需改 Apps Script。
  // ===========================================================================
  function initOrders() {
    var mount = document.getElementById("ordersView");
    if (!mount) return;
    var ORD = SCHEMAS.orders;
    var rows = [];
    function ck() { return "console_orders"; }
    function amt(o) { var a = Number(o.amount); if (!isNaN(a) && o.amount !== "" && o.amount != null) return a; var q = Number(o.qty) || 0, p = Number(o.price) || 0; return q * p; }
    function todayStr() { var d = new Date(); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
    function z(n) { return (n < 10 ? "0" : "") + n; }
    function ym(s) { s = String(s || ""); return s.length >= 7 ? s.slice(0, 7) : ""; }
    function ntfmt(n) { return "NT$ " + Math.round(n).toLocaleString(); }
    function overdue(o) { return o.due && String(o.due) < todayStr() && ORDER_FLOW.indexOf(o.status) >= 0 && o.status !== "出貨" && o.status !== "結案"; }

    function load() {
      rows = lsGet(ck(), []) || [];
      render();
      if (!idToken) return;
      dbCall("tList", { table: "orders" }).then(function (d) {
        if (!d || d.error || !d.rows) return;
        rows = d.rows; lsSet(ck(), rows); render();
      });
    }
    window.__refreshOrders = load;

    function kpis() {
      var tm = todayStr().slice(0, 7), rev = 0, cnt = 0, ship = 0, late = 0;
      rows.forEach(function (o) {
        if (o.status === "取消") return;
        if (ym(o.order_date) === tm) { rev += amt(o); cnt++; }
        if (o.status === "接單" || o.status === "生產") ship++;
        if (overdue(o)) late++;
      });
      return { rev: rev, cnt: cnt, ship: ship, late: late };
    }
    function barsHTML(pairs, money) {
      var mx = 1; pairs.forEach(function (p) { mx = Math.max(mx, p[1]); });
      return '<div class="obars">' + pairs.map(function (p) {
        return '<div class="obar-row"><div class="obar-label">' + escAttr(p[0]) + '</div>'
          + '<div class="obar-track"><div class="obar-fill" style="width:' + Math.round(p[1] / mx * 100) + '%"></div></div>'
          + '<div class="obar-val">' + (money ? ntfmt(p[1]) : p[1]) + '</div></div>';
      }).join("") + '</div>';
    }
    function revenueByMonth() {
      var out = [], d = new Date();
      for (var i = 5; i >= 0; i--) { var m = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push([m.getFullYear() + "-" + z(m.getMonth() + 1), 0]); }
      var idx = {}; out.forEach(function (p, i) { idx[p[0]] = i; });
      rows.forEach(function (o) { if (o.status === "取消") return; var k = ym(o.order_date); if (idx[k] != null) out[idx[k]][1] += amt(o); });
      return out.map(function (p) { return [p[0].slice(2), p[1]]; });  // 顯示 YY-MM
    }
    function statusCounts() {
      return ORDER_FLOW.map(function (s) { return [s, rows.filter(function (o) { return o.status === s; }).length]; });
    }

    function render() {
      var k = kpis();
      var kpiHTML = '<div class="okpis">'
        + kcard("💰 本月營收", ntfmt(k.rev), "accent")
        + kcard("🧾 本月訂單", k.cnt + " 筆", "")
        + kcard("🚚 待出貨", k.ship + " 筆", "")
        + kcard("⏰ 逾期未出", k.late + " 筆", k.late ? "warn" : "")
        + '</div>';
      var charts = '<div class="ocharts">'
        + '<div class="ocard"><div class="octitle">近 6 個月營收</div>' + barsHTML(revenueByMonth(), true) + '</div>'
        + '<div class="ocard"><div class="octitle">訂單狀態分佈</div>' + barsHTML(statusCounts(), false) + '</div>'
        + '</div>';
      var tools = '<div class="otools">'
        + '<button class="dbbtn primary" id="oAdd">＋ 新增訂單</button>'
        + '<button class="dbbtn" id="oConv">🧮 從報價轉單</button>'
        + '<a class="dbbtn" href="db.html">🗂️ 在資料庫管理全部訂單</a>'
        + '</div>';
      // 看板
      var board = '<div class="okanban">' + ORDER_FLOW.map(function (st) {
        var cards = rows.filter(function (o) { return o.status === st; });
        var sum = cards.reduce(function (a, o) { return a + amt(o); }, 0);
        var body = cards.map(function (o) {
          return '<div class="ocardk' + (overdue(o) ? " od" : "") + '" data-edit="' + escAttr(o.id) + '">'
            + '<div class="ock-cust">' + escAttr(o.customer || "（未填客戶）") + '</div>'
            + '<div class="ock-prod">' + escAttr(o.product || "") + '</div>'
            + '<div class="ock-meta"><span>' + ntfmt(amt(o)) + '</span>'
            + (o.due ? '<span class="' + (overdue(o) ? "od" : "") + '">📅 ' + escAttr(o.due) + '</span>' : '') + '</div>'
            + '<select class="ock-move" data-id="' + escAttr(o.id) + '">'
            + ORDER_FLOW.concat(["取消"]).map(function (s) { return '<option' + (s === st ? " selected" : "") + '>' + s + '</option>'; }).join("")
            + '</select></div>';
        }).join("") || '<div class="ock-empty">—</div>';
        return '<div class="okcol"><div class="okhead">' + st + ' <span>' + cards.length + '</span></div>'
          + '<div class="oksum">' + ntfmt(sum) + '</div>' + body + '</div>';
      }).join("") + '</div>';

      mount.innerHTML = (!idToken ? '<div class="dbbanner">🔒 尚未登入：目前顯示本機快取。登入後可新增/更新訂單並同步到公司試算表。</div>' : "")
        + kpiHTML + charts + tools + board
        + '<div class="dbfoot">訂單資料存在公司 Google 試算表（與資料庫操作中心同一份）。</div>';
      wire();
    }
    function kcard(label, val, cls) {
      return '<div class="okpi ' + cls + '"><div class="okpi-l">' + label + '</div><div class="okpi-v">' + escAttr(val) + '</div></div>';
    }
    function wire() {
      var add = document.getElementById("oAdd"); if (add) add.onclick = function () { if (auth()) openOrderForm(null); };
      var conv = document.getElementById("oConv"); if (conv) conv.onclick = fromQuote;
      Array.prototype.forEach.call(mount.querySelectorAll(".ocardk"), function (c) {
        c.onclick = function (e) { if (e.target.classList.contains("ock-move")) return; if (auth()) openOrderForm(findRow(c.getAttribute("data-edit"))); };
      });
      Array.prototype.forEach.call(mount.querySelectorAll(".ock-move"), function (sel) {
        sel.onclick = function (e) { e.stopPropagation(); };
        sel.onchange = function () { if (!auth()) { load(); return; } moveStatus(sel.getAttribute("data-id"), sel.value); };
      });
    }
    function auth() { if (!idToken) { alert(CLIENT_ID ? "請先用右上角「使用 Google 帳戶登入」再操作。" : "尚未設定 Google（見說明頁）。"); return false; } return true; }
    function findRow(id) { return rows.filter(function (o) { return String(o.id) === String(id); })[0] || null; }
    function moveStatus(id, st) {
      var o = findRow(id); if (o) o.status = st; lsSet(ck(), rows); render();
      dbCall("tUpsert", { table: "orders", row: { id: id, status: st }, header: ORD.cols.map(function (c) { return c.k; }) }).then(function (d) { if (d && d.ok) load(); });
    }
    function save(row) {
      if ((row.amount === "" || row.amount == null) && (row.qty || row.price)) row.amount = (Number(row.qty) || 0) * (Number(row.price) || 0);
      if (row.id) { var f = findRow(row.id); if (f) for (var kk in row) f[kk] = row[kk]; }
      else { row.id = "tmp" + Date.now(); rows.unshift(row); }
      lsSet(ck(), rows); render();
      dbCall("tUpsert", { table: "orders", row: row, header: ORD.cols.map(function (c) { return c.k; }) }).then(function (d) { if (d && d.ok) load(); });
    }
    function fromQuote() {
      if (!auth()) return;
      if (!Quotes || !Quotes.length) { alert("尚無報價紀錄。請先到「報價」頁算一筆並「存這筆」。"); return; }
      var q = Quotes[0];
      openOrderForm({ product: q.material || "", qty: 1, price: q.quote || 0, amount: q.quote || 0, status: "報價", order_date: todayStr() }, "已帶入最新一筆報價（" + (q.material || "") + " " + ntfmt(q.quote || 0) + "），可修改");
    }
    function openOrderForm(row, hint) {
      var editing = !!(row && row.id); row = row || { status: "報價", order_date: todayStr() };
      var fields = ORD.cols.map(function (c) {
        var v = row[c.k] !== undefined ? row[c.k] : "";
        var input;
        if (c.type === "select") input = '<select data-f="' + c.k + '">' + c.opts.map(function (o) { return '<option' + (String(v) === o ? " selected" : "") + '>' + escAttr(o) + "</option>"; }).join("") + "</select>";
        else if (c.type === "date") input = '<input type="date" data-f="' + c.k + '" value="' + escAttr(v) + '">';
        else if (c.type === "num") input = '<input type="number" step="any" data-f="' + c.k + '" value="' + escAttr(v) + '"' + (c.k === "amount" ? ' placeholder="留空=數量×單價"' : '') + '>';
        else input = '<input data-f="' + c.k + '" value="' + escAttr(v) + '">';
        return '<label class="dbfield"><span>' + escAttr(c.label) + "</span>" + input + "</label>";
      }).join("");
      var ov = document.createElement("div");
      ov.className = "dbmodal";
      ov.innerHTML = '<div class="dbdialog"><h3>' + (editing ? "編輯訂單" : "新增訂單") + "</h3>"
        + (hint ? '<div class="dbnote" style="margin-bottom:10px">💡 ' + escAttr(hint) + '</div>' : "")
        + '<div class="dbform">' + fields + "</div>"
        + '<div class="dbdlgbtns">'
        + (editing ? '<button class="dbbtn" data-del style="margin-right:auto;color:var(--up)">🗑️ 刪除</button>' : "")
        + '<button class="dbbtn" data-x>取消</button><button class="dbbtn primary" data-ok>儲存</button></div></div>';
      document.body.appendChild(ov);
      function close() { document.body.removeChild(ov); }
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      ov.querySelector("[data-x]").onclick = close;
      var del = ov.querySelector("[data-del]");
      if (del) del.onclick = function () { if (confirm("確定刪除這筆訂單？")) { rows = rows.filter(function (o) { return String(o.id) !== String(row.id); }); lsSet(ck(), rows); render(); dbCall("tRemove", { table: "orders", id: row.id }); close(); } };
      ov.querySelector("[data-ok]").onclick = function () {
        var out = {}; if (editing) out.id = row.id;
        Array.prototype.forEach.call(ov.querySelectorAll("[data-f]"), function (el) { out[el.getAttribute("data-f")] = el.value; });
        save(out); close();
      };
    }
    load();
  }

  // ===========================================================================
  // AI 助手（assistant.html）— 快速問答本地即時算（免設定）；自由提問走 Gemini（Apps Script 代理）
  // ===========================================================================
  function initAssistant() {
    var mount = document.getElementById("aiView");
    if (!mount) return;
    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function nt(n) { return "NT$ " + Math.round(n).toLocaleString(); }
    function today() { var d = new Date(); return d.getFullYear() + "-" + zz(d.getMonth() + 1) + "-" + zz(d.getDate()); }
    function zz(n) { return (n < 10 ? "0" : "") + n; }
    function D(t) { return lsGet("console_" + t, []) || []; }

    function pullAll() {
      if (!idToken) return;
      var bn = mount.querySelector(".dbbanner"); if (bn) bn.parentNode.removeChild(bn);  // 登入後移除「未登入」提示
      ["orders"].forEach(function (t) { dbCall("tList", { table: t }).then(function (d) { if (d && d.rows) lsSet("console_" + t, d.rows); }); });
    }
    window.__refreshAssistant = pullAll;

    function overdueList() {
      var t = today();
      return D("orders").filter(function (o) { return o.due && String(o.due) < t && ["報價", "接單", "生產"].indexOf(o.status) >= 0; });
    }
    function kpi() {
      var tm = today().slice(0, 7), rev = 0, cnt = 0, ship = 0;
      D("orders").forEach(function (o) {
        if (o.status === "取消") return;
        if (String(o.order_date || "").slice(0, 7) === tm) { rev += (num(o.amount) || num(o.qty) * num(o.price)); cnt++; }
        if (o.status === "接單" || o.status === "生產") ship++;
      });
      return { rev: rev, cnt: cnt, ship: ship };
    }
    function ans(type) {
      if (type === "overdue") {
        var o = overdueList();
        if (!o.length) return "目前沒有逾期未出貨的訂單 ✅。";
        return "逾期訂單（交期已過、尚未出貨）：\n" + o.map(function (x) { return "・" + (x.customer || "?") + "／" + (x.product || "") + "：交期 " + x.due + "（狀態：" + x.status + "）"; }).join("\n");
      }
      if (type === "kpi") {
        var k = kpi();
        return "本月概況：\n・營收：" + nt(k.rev) + "\n・訂單數：" + k.cnt + " 筆\n・待出貨：" + k.ship + " 筆\n・逾期：" + overdueList().length + " 筆";
      }
      if (type === "ship") {
        var sh = D("orders").filter(function (x) { return x.status === "接單" || x.status === "生產"; });
        if (!sh.length) return "目前沒有待出貨的訂單。";
        return "待出貨清單（接單/生產中）：\n" + sh.map(function (x) { return "・" + (x.customer || "?") + "／" + (x.product || "") + " ×" + num(x.qty) + "（交期 " + (x.due || "未定") + "）"; }).join("\n");
      }
      if (type === "howto") return OVERVIEW;
      return "";
    }

    // 教學小腦袋（本地，免 Gemini 也能答網站怎麼用）
    var OVERVIEW = "這個網站是一套免費小型 ERP，最簡單的用法：\n"
      + "1) 右上角用 Google 登入。\n"
      + "2) 平常開「🏠 首頁」看重點；情報類（原料/招募/供應商/客戶）在「📈 情報」下拉裡。\n"
      + "3) 客人詢價 →「🧮 報價」算一算 → 存起來。\n"
      + "4) 接到單 →「📦 訂單」按＋新增或「從報價轉單」，用看板追進度。\n"
      + "5) 任何細節直接打字問我，例如：報價怎麼用、怎麼建訂單、匯出。\n"
      + "6) 要跟越南員工溝通？我這頁上面可切「🗣️ 中越對話」。\n"
      + "想更詳細請看「📖 說明」的「🚀 新手上路」。";
    var HELP_KB = [
      { k: ["登入", "login", "登陸", "登錄"], a: "登入：點右上角「使用 Google 帳戶登入」→ 選公司帳號。登入後資料才會存進公司試算表、換裝置也看得到；約一小時後要再登一次是正常的。" },
      { k: ["報價", "估價", "算價"], a: "報價：上面「🧮 報價」→ 選材質(自動帶入最新原料價)→ 填重量(或填長寬高按「計算」)→ 看建議報價 → 按「存這筆」記錄。" },
      { k: ["轉單", "轉訂單", "報價轉"], a: "報價轉訂單：到「📦 訂單」按「🧮 從報價轉單」，會把最新一筆報價帶成新訂單，可再修改。" },
      { k: ["訂單", "建單", "接單", "下單", "開單"], a: "訂單：「📦 訂單」按「＋新增訂單」填客戶/品名/數量/單價/交期(金額留空會自動＝數量×單價)。看板每張卡下拉可改狀態(報價→接單→生產→出貨→結案)，點卡片可編輯或刪除。" },
      { k: ["看板", "狀態", "進度"], a: "狀態看板在「📦 訂單」：欄位是 報價→接單→生產→出貨→結案。改某張訂單卡的下拉，就會移到對應欄位；逾期會標紅。" },
      { k: ["料號", "庫存", "入庫", "存貨", "料件", "bom", "用料", "配方", "物料清單"], a: "料號/庫存/BOM：在「🗂️ 資料庫」的「料號/庫存」「產品用料(BOM)」分頁建立、編輯（每種材料的庫存/安全庫存/單價、每個產品用哪些料）。" },
      { k: ["中越", "越南", "翻譯", "vietnam", "移工", "員工溝通", "語音"], a: "中越對話：到「🤖 助手」頁上方切「🗣️ 中越對話」。點常用句立刻顯示中文＋越南文；或打字/用🎤語音講，按「翻譯」自動中↔越（打字翻譯需登入）。" },
      { k: ["資料庫", "試算表", "增刪改", "編輯資料", "新增資料"], a: "資料庫操作中心「🗂️ 資料庫」：不用開 Google 試算表，站內就能新增/編輯/刪除/搜尋/篩選/匯出 CSV。分頁有：我的名單、收藏標記、報價歷史、訂單、料號、BOM。" },
      { k: ["收藏", "標記", "備註", "星星"], a: "在供應商/客戶/職缺名單，點星星⭐收藏、選狀態、打備註；勾「只看收藏」只顯示收藏的。會存進試算表。" },
      { k: ["匯出", "csv", "excel", "下載", "報表"], a: "匯出：資料庫或訂單頁的「⬇ 匯出 CSV」，下載成 Excel 可開的檔案。" },
      { k: ["深色", "淺色", "主題", "暗", "亮"], a: "右上角 🌙/☀️ 切深色/淺色，設定會記住。" },
      { k: ["更新", "看不到", "重新整理", "舊的", "沒變", "刷新"], a: "看不到新資料：按 Ctrl+F5 強制重新整理(Mac 是 Cmd+Shift+R)。原料價一天更新兩次，其他名單每天更新。" },
      { k: ["供應商"], a: "「🏭 供應商」(在 📈情報 下拉裡)：找金屬加工供應商，可依類別篩、勾只看神岡周邊、切地圖看位置。" },
      { k: ["客戶", "開發"], a: "「🎯 客戶」(在 📈情報 下拉裡)：找可能買精密金屬零件的潛在客戶，可依產業篩、搜尋公司名。" },
      { k: ["招募", "職缺", "徵才", "薪水", "薪資"], a: "「🔧 招募」(在 📈情報 下拉裡)：追蹤台中金屬加工/品管職缺行情，可搜尋、排序、看薪資分布。" },
      { k: ["原料", "行情", "價格", "銅價", "鋁價"], a: "「🔩 原料」(在 📈情報 下拉裡)：看銅/鋁/鎳/鋼國際價(換算台幣)走勢，可切單位與期間。漲＝進料成本高要注意。" },
      { k: ["免費", "要錢", "收費", "費用"], a: "整套免費——跑在 GitHub + Google 的免費額度上，關機也會自己在雲端更新。" },
      { k: ["手機", "平板"], a: "手機可用：表格會自動變成一張張卡片，好點好讀。" },
      { k: ["情報", "下拉", "分頁", "選單", "找不到", "在哪"], a: "上面導覽列：🏠首頁、📈情報(點開有 原料/招募/供應商/客戶)、🧮報價、📦訂單、🤖助手、🗂️資料庫、📖說明。" }
    ];
    function matchData(q) {
      q = String(q || "").toLowerCase();
      if (/逾期|過期|延誤|遲交|來不及/.test(q)) return "overdue";
      if (/營收|業績|收入|營業額|賺多少|這個?月.*(如何|怎樣|多少|概況)/.test(q)) return "kpi";
      if (/待出貨|要出貨|出貨清單|還沒出/.test(q)) return "ship";
      return "";
    }
    function matchHelp(q) {
      var s = String(q || "").toLowerCase();
      for (var i = 0; i < HELP_KB.length; i++) {
        if (HELP_KB[i].k.some(function (w) { return s.indexOf(w.toLowerCase()) >= 0; })) return HELP_KB[i].a;
      }
      if (/怎麼用|怎用|教我|教學|不會用|不懂|使用方式|操作|入門|上手|new|help|介紹|功能/.test(s)) return OVERVIEW;
      return "";
    }

    function buildContext() {
      var k = kpi();
      return { 月份: today().slice(0, 7), 本月營收: k.rev, 本月訂單數: k.cnt, 待出貨: k.ship,
        逾期訂單: overdueList().map(function (o) { return { 客戶: o.customer, 品名: o.product, 交期: o.due, 狀態: o.status }; }),
        網站功能說明: "這是九上科技的免費小型 ERP。分頁：首頁(每日總覽)、情報(原料行情/招募/供應商/客戶)、報價(選材質+重量算報價並存檔)、訂單(建單/報價轉單/狀態看板 報價→接單→生產→出貨→結案/老闆KPI)、資料庫(站內增刪改查所有資料表，含料號/庫存/BOM、匯出CSV)、助手(你，含🗣️中越對話)。右上角 Google 登入才會存資料。看不到新資料按 Ctrl+F5。全部免費。回答使用問題時請用這份說明、給具體步驟。" };
    }

    function msg(role, text) {
      var log = document.getElementById("aiLog");
      var b = document.createElement("div"); b.className = "aimsg " + role; b.textContent = text;
      log.appendChild(b); log.scrollTop = log.scrollHeight; return b;
    }
    function askText(q) {
      msg("user", q);
      var dt = matchData(q);
      if (dt) { msg("ai", ans(dt)); return; }          // 資料問題 → 本地精準計算（最快最準）
      var wait = msg("ai", "🤖 思考中…");
      dbCall("ai", { question: q, context: buildContext() }).then(function (d) {
        if (d && d.ok && d.text) { wait.textContent = d.text; return; }   // Gemini 已啟用 → 什麼都能答
        var local = matchHelp(q);                        // 沒 Gemini → 本地教學小腦袋
        if (local) {
          wait.textContent = local + "\n\n💡 想讓我像 ChatGPT 一樣什麼都能聊？在「📖 說明→🤖 AI 助手」照步驟啟用免費 AI（一次就好）。";
          return;
        }
        if (d && d.need_setup) {
          wait.textContent = "這題要啟用免費 AI 我才能自由回答～設定很簡單(一次就好)，「📖 說明→🤖 AI 助手」有圖解。\n或先問我：報價怎麼用 / 怎麼建訂單 / 缺料 / 這個網站怎麼用。";
          return;
        }
        if (d && d.error) { wait.textContent = "⚠️ AI 失敗：" + d.error + "\n先試試：報價怎麼用 / 缺料 / 逾期。"; return; }
        wait.textContent = "這題我暫時答不了(可能未登入或未設定 AI)。試試問：報價怎麼用 / 怎麼建訂單 / 缺料 / 這個網站怎麼用。";
      });
    }

    // 🗣️ 中越對話（獨立系統）：常用句免登入即時顯示；打字翻譯走現成 Groq
    var PHRASES = [
      ["上班打卡", "Chấm công đi làm"], ["下班了", "Tan làm rồi"], ["休息時間", "Giờ nghỉ"],
      ["來我這裡", "Đến chỗ tôi"], ["去領料", "Đi lấy vật liệu"], ["搬到那邊", "Chuyển sang bên kia"],
      ["停機", "Dừng máy"], ["換刀", "Thay dao"], ["做完了", "Làm xong rồi"],
      ["小心危險", "Cẩn thận nguy hiểm"], ["注意安全", "Chú ý an toàn"], ["戴手套/護目鏡", "Đeo găng tay / kính bảo hộ"],
      ["我不懂", "Tôi không hiểu"], ["等一下", "Đợi một chút"], ["慢一點", "Chậm lại một chút"],
      ["這樣對嗎？", "Như vậy đúng không?"], ["不對，重做", "Sai rồi, làm lại"], ["好 / OK", "Được / OK"],
      ["謝謝", "Cảm ơn"], ["辛苦了", "Vất vả rồi"]
    ];
    var phrHtml = PHRASES.map(function (p, i) { return '<button class="dbbtn" data-i="' + i + '">' + p[0] + '</button>'; }).join("");

    mount.innerHTML =
      (!idToken ? '<div class="dbbanner">🔒 尚未登入：登入後 ERP 助手才能讀公司資料、中越對話才能即時翻譯（常用句免登入）。</div>' : "")
      + '<div class="aimode">'
      + '<button class="aimodebtn on" data-mode="erp">🤖 ERP 助手</button>'
      + '<button class="aimodebtn" data-mode="bi">🗣️ 中越對話</button>'
      + '</div>'
      // ── 🤖 ERP 助手（查公司資料／教學）──
      + '<div id="erpMode">'
      + '<div class="aichips">'
      + '<button class="dbbtn" data-q="howto">📖 教我用這個網站</button>'
      + '<button class="dbbtn" data-q="overdue">⏰ 哪些訂單逾期？</button>'
      + '<button class="dbbtn" data-q="kpi">💰 本月營收概況</button>'
      + '<button class="dbbtn" data-q="ship">🚚 待出貨清單</button>'
      + '</div>'
      + '<div class="ailog" id="aiLog"></div>'
      + '<div class="airow"><input id="aiInput" class="dbsearch" placeholder="什麼都能問：報價怎麼用？怎麼建訂單？哪些訂單逾期？"><button class="dbbtn primary" id="aiSend">送出</button></div>'
      + '<div class="dbfoot">打字問我「網站怎麼用、報價/訂單怎麼操作、逾期/營收/待出貨」都行。啟用免費 AI 後(見說明)可像 ChatGPT 一樣自由聊。</div>'
      + '</div>'
      // ── 🗣️ 中越對話（老闆 ⇄ 越南員工，獨立於上面）──
      + '<div id="biMode" style="display:none">'
      + '<div class="bihint">點常用句 → 立刻顯示中文＋越南文；或用 🎤語音／打字，按「翻譯」自動判斷中↔越。<br>Bấm câu thường dùng, hoặc dùng 🎤giọng nói / gõ chữ rồi bấm Dịch.</div>'
      + '<div class="biphr">' + phrHtml + '</div>'
      + '<div class="ailog bilog" id="biLog"></div>'
      + '<div class="bimic"><button class="dbbtn bimicbtn" data-mic="zh">🎤 說中文</button><button class="dbbtn bimicbtn" data-mic="vi">🎤 Nói tiếng Việt</button></div>'
      + '<div class="airow"><input id="biInput" class="dbsearch" placeholder="打中文或越南文… / Gõ tiếng Trung hoặc tiếng Việt…"><button class="dbbtn primary bitr" id="biTr">🔄 翻譯 · Dịch</button></div>'
      + '<div class="dbfoot">現場口語溝通用；常用句免登入。🎤語音需 Android／桌機 Chrome＋麥克風權限。即時翻譯為機器翻譯，重要文件仍請人工複核。</div>'
      + '</div>';

    // 模式切換（兩系統各自獨立顯示）
    Array.prototype.forEach.call(mount.querySelectorAll(".aimode [data-mode]"), function (b) {
      b.onclick = function () {
        var m = b.getAttribute("data-mode");
        Array.prototype.forEach.call(mount.querySelectorAll(".aimode [data-mode]"), function (x) { x.classList.toggle("on", x === b); });
        document.getElementById("erpMode").style.display = (m === "erp") ? "" : "none";
        document.getElementById("biMode").style.display = (m === "bi") ? "" : "none";
      };
    });

    // ── 🤖 ERP 助手 ──
    msg("ai", "嗨！我是九上 ERP 助手 🤖\n・想學怎麼用？點「📖 教我用這個網站」，或直接問「報價怎麼用」「怎麼建訂單」。\n・想查資料？點按鈕或問「哪些訂單逾期 / 營收多少 / 待出貨」。\n・要跟越南員工溝通？上面切到「🗣️ 中越對話」。");
    Array.prototype.forEach.call(mount.querySelectorAll(".aichips [data-q]"), function (b) {
      b.onclick = function () { var t = b.getAttribute("data-q"); msg("user", b.textContent.replace(/^\S+\s/, "")); msg("ai", ans(t)); };
    });
    var input = document.getElementById("aiInput"), send = document.getElementById("aiSend");
    function go() { var v = (input.value || "").trim(); if (!v) return; input.value = ""; if (!idToken) { msg("user", v); var lh = matchHelp(v); msg("ai", lh || "先用右上角 Google 登入，我才能查你的資料；不過網站用法我現在就能教，例如問「報價怎麼用」。"); return; } askText(v); }
    send.onclick = go;
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });

    // ── 🗣️ 中越對話（獨立邏輯／獨立對話容器 #biLog）──
    function biMsg(role, text) {
      var log = document.getElementById("biLog");
      var b = document.createElement("div"); b.className = "aimsg " + role; b.textContent = text;
      log.appendChild(b); log.scrollTop = log.scrollHeight; return b;
    }
    function biPair(cn, vi) {
      var log = document.getElementById("biLog");
      var b = document.createElement("div"); b.className = "aimsg pair";
      var c = document.createElement("div"); c.className = "bicn"; c.textContent = cn;
      var v = document.createElement("div"); v.className = "bivi"; v.textContent = vi;
      b.appendChild(c); b.appendChild(v);
      log.appendChild(b); log.scrollTop = log.scrollHeight;
    }
    function biTranslate(dir) {
      var inp = document.getElementById("biInput");
      var v = (inp && inp.value || "").trim(); if (!v) return; inp.value = "";
      biMsg("user", v);
      if (!idToken) { biMsg("ai", "即時翻譯需先用右上角 Google 登入；上面常用句免登入即可用。\nDịch tức thời cần đăng nhập Google trước."); return; }
      var wait = biMsg("ai", "翻譯中… Đang dịch…");
      var prompt = (dir === "cn2vi")
        ? "把以下內容翻成越南文，用詞簡單口語、適合工廠越南籍移工，只回越南文，不要加任何解釋：\n" + v
        : "把以下越南文翻成繁體中文，口語、簡單，只回中文，不要加任何解釋：\n" + v;
      dbCall("ai", { question: prompt, context: {} }).then(function (d) {
        if (d && d.ok && d.text) { wait.textContent = d.text; return; }
        if (d && d.need_setup) { wait.textContent = "需先啟用免費 AI（見「📖 說明→🤖 AI 助手」，一次就好）。上面常用句可先用。"; return; }
        if (d && d.error) { wait.textContent = "⚠️ 翻譯失敗：" + d.error; return; }
        wait.textContent = "暫時無法翻譯（可能未登入或未設定 AI）。";
      });
    }
    // 自動判方向：含中日韓漢字 → 中翻越，否則（越南文拉丁字母）→ 越翻中
    function autoDir(t) { return /[一-鿿]/.test(t || "") ? "cn2vi" : "vi2cn"; }
    // 🎤 免費語音輸入（瀏覽器內建 Web Speech API，免金鑰）
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    function biVoice(which) {
      var el = document.getElementById("biInput");
      if (!SR) { biMsg("ai", "這支手機/瀏覽器不支援語音輸入，請改打字或用上面常用句。語音建議用 Android 版 Chrome。\nThiết bị không hỗ trợ giọng nói — hãy gõ chữ."); return; }
      var rec = new SR();
      rec.lang = (which === "zh") ? "zh-TW" : "vi-VN";
      rec.interimResults = false; rec.maxAlternatives = 1;
      var btn = mount.querySelector('.bimicbtn[data-mic="' + which + '"]'), old = btn ? btn.innerHTML : "";
      if (btn) { btn.innerHTML = "🔴 聆聽中… Đang nghe…"; btn.disabled = true; }
      rec.onresult = function (e) {
        var t = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
        if (t) { el.value = t; biTranslate(which === "zh" ? "cn2vi" : "vi2cn"); }
      };
      rec.onerror = function (e) { biMsg("ai", "語音辨識失敗（" + ((e && e.error) || "") + "）。請確認已允許麥克風、有網路。"); };
      rec.onend = function () { if (btn) { btn.innerHTML = old; btn.disabled = false; } };
      try { rec.start(); } catch (err) { if (btn) { btn.innerHTML = old; btn.disabled = false; } }
    }

    biMsg("ai", "這裡讓老闆和越南員工雙向對話 🗣️\n・點上面常用句 → 立刻同時顯示中文＋越南文，把手機拿給對方看。\n・要講別的話 → 用 🎤語音 或打字，按「翻譯」自動判斷中↔越。手機沒越南文鍵盤？按「🎤 Nói tiếng Việt」直接講。");
    Array.prototype.forEach.call(mount.querySelectorAll(".biphr [data-i]"), function (b) {
      b.onclick = function () { var p = PHRASES[+b.getAttribute("data-i")]; biPair(p[0], p[1]); };
    });
    Array.prototype.forEach.call(mount.querySelectorAll(".bimic [data-mic]"), function (b) {
      b.onclick = function () { biVoice(b.getAttribute("data-mic")); };
    });
    var biInput = document.getElementById("biInput");
    document.getElementById("biTr").onclick = function () { var v = (biInput.value || "").trim(); if (v) biTranslate(autoDir(v)); };
    biInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { var v = (biInput.value || "").trim(); if (v) biTranslate(autoDir(v)); } });
    pullAll();
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    if (window.METALS_DATA) initMetals(window.METALS_DATA);
    if (window.JOBS_DATA) { initJobs(window.JOBS_DATA); initJobsCharts(); }
    if (window.SUPPLIERS_DATA) { initSuppliers(window.SUPPLIERS_DATA); initSupplierMap(window.SUPPLIERS_DATA); }
    if (window.QUOTE_MATERIALS) initQuote(window.QUOTE_MATERIALS);
    if (window.CUSTOMERS_DATA) initCustomers(window.CUSTOMERS_DATA);
    if (document.getElementById("dbConsole")) initDbConsole();  // 資料庫操作中心
    if (document.getElementById("ordersView")) initOrders();     // 訂單 + 老闆儀表板
    if (document.getElementById("aiView")) initAssistant();       // AI 助手
    initAuth();  // Google 登入（GIS 若已載入）；登入後 cloudPull 拉雲端資料
    // 情報下拉：點空白處收起（原生 details 負責開關）
    document.addEventListener("click", function (e) {
      Array.prototype.forEach.call(document.querySelectorAll("details.navdrop[open]"), function (d) {
        if (!d.contains(e.target)) d.removeAttribute("open");
      });
    });
  });
})();
