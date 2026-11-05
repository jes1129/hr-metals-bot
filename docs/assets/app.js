/* 儀表板互動 — 主題切換 + 銅鋁日線走勢圖(單位切換/期間統計) + 報價試算/供應商/客戶名單。
   資料由頁面內嵌的 window.* 或登入後的試算表提供，無第三方外部請求。 */
(function () {
  "use strict";
  var LB_PER_TONNE = 2204.62, MA_N = 20;
  var REDRAWS = [];

  // ---------- 單色線條圖示（docs/assets/icons.svg） ----------
  function ic(name, cls) { return '<svg class="ic' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="assets/icons.svg#' + name + '"/></svg>'; }

  // ---------- 主題 ----------
  function initTheme() {
    var root = document.documentElement;
    var saved = localStorage.getItem("theme");
    var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", saved || (sysDark ? "dark" : "light"));
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    var paint = function () { btn.innerHTML = ic(root.getAttribute("data-theme") === "dark" ? "sun" : "moon"); };
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

  // ---------- 原料資料來源：頁面本身太久沒更新就亮警示（機器人整個停擺時，伺服器端的檢查也會一起停，所以由瀏覽器補這一關） ----------
  (function dataStale() {
    var b = document.getElementById("dhBox"); if (!b) return;
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(b.getAttribute("data-upd") || ""); if (!m) return;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]), h = (Date.now() - t) / 3600000, day = new Date().getUTCDay();
    if (h > 54 || (h > 30 && day !== 0 && day !== 1)) {         // 一天跑兩次；週日、週一早上容許較久
      var lv = h > 54 ? "red" : "yellow";
      b.hidden = false; b.insertAdjacentHTML("afterbegin", '<div class="dh-t dh-' + lv + '">原料報價已經 ' + Math.floor(h) + ' 小時沒有更新，排程可能停了，報價先別直接照用</div>');
    }
  })();

  function cloudPull() {   // 登入後從試算表拉最新，覆蓋本機並刷新畫面
    dbCall("load", {}).then(function (d) {
      if (!d || d.error) return;
      if (d.marks) { Marks = d.marks; lsSet("marks", Marks); }
      if (d.quotes) { Quotes = d.quotes; lsSet("quotes", Quotes); }
      if (window.__refreshMarks) window.__refreshMarks();
      if (window.__refreshQuotes) window.__refreshQuotes();
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
      box.innerHTML = '<span class="guser" title="' + escAttr(gUser.email) + '">' + ic("user") + escAttr(gUser.name || gUser.email) + '</span><button id="gOut" class="gbtn">登出</button>';
      var o = document.getElementById("gOut"); if (o) o.onclick = signOut;
    } else {
      box.innerHTML = '<div id="gBtn"></div>';
      // 只放「Sign in with Google」按鈕，不呼叫 One Tap prompt()（避免自動彈窗與未登入時的 console 噪音）
      try { google.accounts.id.renderButton(document.getElementById("gBtn"), { type: "standard", size: "medium", text: "signin_with", shape: "pill" }); } catch (e) {}
    }
    if (window.__refreshAlerts) window.__refreshAlerts();
    if (window.__refreshAuthHint) window.__refreshAuthHint();
    // 登入狀態一改變就刷新資料庫操作中心 / 訂單頁 / 首頁數字（顯示/隱藏「未登入」橫幅、載入雲端資料）
    
  }
  window.onGoogleLibraryLoad = initAuth;  // GIS 載入完成時回呼
  function needLogin() { return !!(CLIENT_ID && !idToken); }  // 有設定 Google 但尚未登入

  var STATUS = ["", "已聯絡", "合作中", "不合適"];
  function escAttr(s) { return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function favSpan(id) { return '<span class="mkfav' + (markGet(id).fav ? " on" : "") + '" data-id="' + escAttr(id) + '" title="收藏">' + ic("star") + "</span> "; }
  // Google 日曆 / Gmail 預填深連結（免 OAuth、免敏感權限）
  function calLink(title) { return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(title); }
  function markCell(id, name) {
    var m = markGet(id); name = name || "";
    var opts = STATUS.map(function (o) { return '<option value="' + o + '"' + (m.status === o ? " selected" : "") + ">" + (o || "—狀態—") + "</option>"; }).join("");
    var acts = '<a class="mkact" target="_blank" rel="noopener" href="' + calLink("追蹤／拜訪 " + name) + '" title="加到 Google 日曆提醒">' + ic("calendar") + '</a>';
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
      el.classList.toggle("on", m.fav);
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
        var near = s.is_near ? '<span class="star" title="神岡周邊">' + ic("star") + '</span> ' : "";
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
        var color = s.is_near ? "#c0392b" : "#2f6fb0";
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
  // 沒登入時提醒：報價只存在這個瀏覽器
  function authHint(el) {
    if (!el) return;
    var msg = "";
    if (!API || !CLIENT_ID) msg = "尚未設定 Google 登入：報價只存在這個瀏覽器，換電腦或清除瀏覽器資料就會不見，同事也看不到。";
    else if (!idToken) msg = "尚未登入 Google：報價目前只存在這個瀏覽器，同事看不到。請按右上角「使用 Google 帳戶登入」，之後的報價才會同步到公司試算表。";
    el.hidden = !msg; el.textContent = msg ? "⚠ " + msg : "";
  }
  function ntdFmt(n) { return "NT$" + Math.round(n).toLocaleString("en-US"); }
  // 這筆報價「和現在比」：用今天的料價重算成本
  function quoteNow(q, MATS) {
    var now = MATS.filter(function (m) { return m.name === q.material; })[0];
    if (!now || now.nt == null || !(q.price > 0)) return null;
    var dp = (now.nt / q.price - 1) * 100, dc = (now.nt - q.price) * q.weight;
    return { dp: dp, dc: dc, cls: dp > 0.05 ? "up" : dp < -0.05 ? "down" : "", nt: now.nt };
  }

  function initQuote(MATS) {
    var matEl = document.getElementById("qMat"), wEl = document.getElementById("qWeight");
    var pEl = document.getElementById("qPrice"), noteEl = document.getElementById("qPriceNote");
    var procEl = document.getElementById("qProc"), mgEl = document.getElementById("qMargin");
    var lEl = document.getElementById("qL"), wwEl = document.getElementById("qW"), hEl = document.getElementById("qH");
    var custEl = document.getElementById("qNote"), hintEl = document.getElementById("qHint");
    var ntd = ntdFmt;
    var otherEl = document.getElementById("qOther"), oName = document.getElementById("qOName"), oDen = document.getElementById("qODen"), forgetBtn = document.getElementById("qForget");
    // 「我的材料」：手動輸入過的其他材料，記在這個瀏覽器，下次直接從選單選（帶入上次的價格與密度）
    function loadCustom() { var a = lsGet("custom_mats", []); return Array.isArray(a) ? a : []; }
    var LIST = [];
    function buildList(selName) {
      LIST = MATS.concat(loadCustom().map(function (c) { return { name: c.name, nt: c.nt, density: c.density || null, live: false, custom: true, note: "這是你上次輸入的價格，請確認是否還是現在的採購價" }; }));
      matEl.innerHTML = "";
      LIST.forEach(function (m, i) { var o = document.createElement("option"); o.value = i; o.textContent = m.name + (m.custom ? "（我的材料）" : ""); matEl.appendChild(o); });
      var o2 = document.createElement("option"); o2.value = "new"; o2.textContent = "＋ 其他材料（手動輸入）"; matEl.appendChild(o2);
      if (selName) LIST.forEach(function (m, i) { if (m.name === selName) matEl.value = i; });
    }
    buildList();
    function isNew() { return matEl.value === "new"; }
    function cur() {
      if (isNew()) return { name: (oName.value || "").trim() || "其他材料", nt: null, density: parseFloat(oDen.value) || null, live: false, isNew: true, note: "請填實際採購價（每公斤）" };
      return LIST[parseInt(matEl.value, 10) || 0];
    }
    function onMat() {
      var m = cur();
      otherEl.hidden = !isNew(); forgetBtn.hidden = !m.custom;
      if (isNew()) pEl.value = ""; else if (m.nt != null) pEl.value = m.nt;
      noteEl.textContent = m.live ? "（已帶入最新行情，可修改）" : (m.note || "參考值，請填實際採購價");
      noteEl.style.color = m.live ? "var(--muted)" : "var(--up)";
      if (hintEl) { hintEl.hidden = !m.hint; hintEl.textContent = m.hint ? "今日行情提醒：" + m.hint : ""; }
      calc();
    }
    function calcWeight() {
      var m = cur(), L = parseFloat(lEl.value), W = parseFloat(wwEl.value), H = parseFloat(hEl.value);
      if (!(m.density > 0)) { alert("這個材料還沒有密度，請先填密度，或直接輸入重量。"); if (isNew()) oDen.focus(); return; }
      if (L > 0 && W > 0 && H > 0) { wEl.value = (L * W * H * m.density / 1000).toFixed(2); calc(); }
    }
    function remember(m, price) {
      if (!(m.isNew || m.custom)) return;
      var a = loadCustom().filter(function (c) { return c.name !== m.name; });
      a.unshift({ name: m.name, nt: price, density: m.density || null });
      lsSet("custom_mats", a.slice(0, 30));
      buildList(m.name); onMat();
    }
    forgetBtn.addEventListener("click", function () {
      var m = cur(); if (!m.custom) return;
      lsSet("custom_mats", loadCustom().filter(function (c) { return c.name !== m.name; }));
      buildList(); matEl.value = 0; onMat();
    });
    var simUpdate = function () {};
    function calc() {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0;
      var proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0;
      var matCost = w * p, total = matCost + proc, quote = total * (1 + mg / 100), ok = w && p;
      document.getElementById("qMatCost").textContent = ok ? ntd(matCost) : "—";
      document.getElementById("qTotal").textContent = ok ? ntd(total) : "—";
      document.getElementById("qQuote").textContent = ok ? ntd(quote) : "—";
      document.getElementById("qMarginPct").textContent = ok && quote > 0 ? ((quote - total) / quote * 100).toFixed(1) + "%" : "—";
      var sens = document.getElementById("qSens");
      if (sens) {
        if (ok && quote > 0) {
          var m3 = (quote - (matCost * 1.03 + proc)) / quote * 100;
          sens.innerHTML = "若料價再漲 3%，毛利率剩 <b>" + m3.toFixed(1) + "%</b>（約少賺 " + ntd(matCost * 0.03) + "）";
        } else sens.textContent = "填好重量就會即時算出報價";
      }
      simUpdate();
    }
    simUpdate = initSim(function () {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0, proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0, cost = w * p + proc;
      return { ok: !!(w && p), w: w, p: p, proc: proc, mg: mg, cost: cost, quote: cost * (1 + mg / 100) };
    });
    matEl.addEventListener("change", onMat);
    [wEl, pEl, procEl, mgEl].forEach(function (e) { e.addEventListener("input", calc); });
    document.getElementById("qCalc").addEventListener("click", calcWeight);

    // 最近 5 筆
    var histEl = document.getElementById("qHistory"), saveBtn = document.getElementById("qSave");
    function renderHist() {
      if (!histEl) return;
      histEl.innerHTML = Quotes.length ? Quotes.slice(0, 5).map(function (q) {
        var d = new Date(q.ts), ds = (d.getMonth() + 1) + "/" + d.getDate() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
        var nw = quoteNow(q, MATS), nowTxt = nw ? '<div class="qnow ' + nw.cls + '">現在料價 NT$' + nw.nt + "（比報價時 " + (nw.dp >= 0 ? "+" : "") + nw.dp.toFixed(1) + "%）→ 成本" +
          (Math.abs(nw.dc) < 1 ? "沒變" : (nw.dc > 0 ? "多了 " : "少了 ") + ntd(Math.abs(nw.dc))) + "</div>" : "";
        return '<div class="qh"><div>' + (q.note ? "<b>" + escAttr(q.note) + "</b>　" : "") + escAttr(q.material) + "　" + q.weight + "kg × NT$" + q.price +
          (q.proc ? "　+工 " + q.proc : "") + "　利 " + q.margin + "% → <b style='color:var(--accent)'>" + ntd(q.quote) + "</b>" + nowTxt +
          '<div class="mnote">' + ds + "</div></div></div>";
      }).join("") : '<div class="mnote" style="padding:10px 4px">還沒有報價紀錄（算好後按「存這筆報價」）</div>';
    }
    window.__refreshQuotes = renderHist;
    window.__refreshAuthHint = function () { authHint(document.getElementById("qLogin")); };

    var savedEl = document.getElementById("qSaved");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0;
      if (!(w && p)) { alert("請先填重量與料價"); return; }
      var proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0;
      var mat = cur(); if (mat.isNew && !(oName.value || "").trim()) { alert("請先填材料名稱"); oName.focus(); return; }
      quoteAdd({ ts: Date.now(), material: mat.name, weight: w, price: p, proc: proc, margin: mg, note: custEl ? custEl.value.trim() : "", quote: Math.round((w * p + proc) * (1 + mg / 100)) });
      renderHist(); remember(mat, p);
      if (savedEl) { savedEl.hidden = false; savedEl.innerHTML = "已存好 ✓　" + (idToken ? "已同步到公司試算表。" : "目前只存在這個瀏覽器。") + ' <a href="records.html">到「報價紀錄」查看 →</a>'; }
    });

    var copyBtn = document.getElementById("qCopy");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var w = parseFloat(wEl.value) || 0, p = parseFloat(pEl.value) || 0;
      if (!(w && p)) { alert("請先填重量與料價"); return; }
      var proc = parseFloat(procEl.value) || 0, mg = parseFloat(mgEl.value) || 0, q = Math.round((w * p + proc) * (1 + mg / 100));
      var d = new Date(), ds = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
      var txt = "【報價】" + ds + (custEl && custEl.value.trim() ? "\n客戶／品名：" + custEl.value.trim() : "") + "\n材質：" + cur().name + "　重量：" + w + " kg\n報價：" + ntd(q) + "（未稅）\n※ 原料價格會隨行情變動，本報價請於 3 天內確認。";
      var done = function () { copyBtn.textContent = "已複製 ✓"; setTimeout(function () { copyBtn.innerHTML = ic("clipboard") + "複製報價文字"; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { window.prompt("複製下面的文字：", txt); });
      else window.prompt("複製下面的文字：", txt);
    });
    onMat(); renderHist(); authHint(document.getElementById("qLogin"));
  }

  // ============================================================ 報價紀錄頁（搜尋／篩選／刪除／清除舊資料／匯出）
  function initRecords(MATS) {
    var body = document.getElementById("rBody"), qEl = document.getElementById("rSearch"), mEl = document.getElementById("rMat"), dEl = document.getElementById("rDays");
    var cntEl = document.getElementById("rCount"), purge = document.getElementById("rPurge"), pDays = document.getElementById("rPurgeDays"), pInfo = document.getElementById("rPurgeInfo");
    var DAY = 86400000;
    function fillMats() {
      var keep = mEl.value, names = MATS.map(function (m) { return m.name; });
      Quotes.forEach(function (q) { if (q.material && names.indexOf(q.material) < 0) names.push(q.material); });
      mEl.innerHTML = '<option value="">全部材質</option>' + names.map(function (n) { return '<option value="' + escAttr(n) + '">' + escAttr(n) + "</option>"; }).join("");
      mEl.value = keep;
    }
    function filtered() {
      var kw = qEl.value.trim().toLowerCase(), mat = mEl.value, days = parseInt(dEl.value, 10) || 0, now = Date.now();
      return Quotes.filter(function (q) {
        if (mat && q.material !== mat) return false;
        if (days && now - q.ts > days * DAY) return false;
        if (kw && (String(q.note || "") + " " + q.material).toLowerCase().indexOf(kw) < 0) return false;
        return true;
      }).sort(function (a, b) { return b.ts - a.ts; });
    }
    function fmtDate(ts) { var d = new Date(ts); return d.getFullYear() + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + ("0" + d.getDate()).slice(-2) + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
    function render() {
      fillMats();
      var rows = filtered();
      cntEl.textContent = "共 " + Quotes.length + " 筆" + (rows.length !== Quotes.length ? "，符合條件 " + rows.length + " 筆" : "");
      body.innerHTML = rows.length ? rows.map(function (q) {
        var nw = quoteNow(q, MATS), nowTxt = nw ? '<span class="qnow ' + nw.cls + '">' + (nw.dp >= 0 ? "+" : "") + nw.dp.toFixed(1) + "%　" + (Math.abs(nw.dc) < 1 ? "成本沒變" : (nw.dc > 0 ? "成本多 " : "成本少 ") + ntdFmt(Math.abs(nw.dc))) + "</span>" : "—";
        return "<tr><td>" + fmtDate(q.ts) + "</td><td>" + (escAttr(q.note) || '<span class="rdim">—</span>') + "</td><td>" + escAttr(q.material) + "</td><td>" + q.weight + " kg</td><td>" + q.price + "</td><td>" +
          (q.proc || 0) + "</td><td>" + q.margin + "%</td><td><b>" + ntdFmt(q.quote) + "</b></td><td>" + nowTxt + '</td><td><button class="qdel" data-ts="' + q.ts + '">刪除</button></td></tr>';
      }).join("") : '<tr><td colspan="10" class="rempty">' + (Quotes.length ? "沒有符合條件的紀錄" : "還沒有報價紀錄。到「報價試算」算好後按「存這筆報價」就會出現在這裡。") + "</td></tr>";
      purgeInfo();
    }
    function oldList() { var days = parseInt(pDays.value, 10) || 0, now = Date.now(); return days > 0 ? Quotes.filter(function (q) { return now - q.ts > days * DAY; }) : []; }
    function purgeInfo() { var n = oldList().length; pInfo.textContent = "→ 會刪除 " + n + " 筆"; pInfo.style.color = n ? "var(--up)" : "var(--muted)"; }
    [qEl, mEl, dEl].forEach(function (e) { e.addEventListener("input", render); e.addEventListener("change", render); });
    body.addEventListener("click", function (e) {
      if (!e.target.classList.contains("qdel")) return;
      var ts = parseInt(e.target.getAttribute("data-ts"), 10), q = Quotes.filter(function (x) { return x.ts === ts; })[0];
      if (q && !window.confirm("刪除這筆報價？\n" + (q.note ? q.note + " " : "") + q.material + " " + ntdFmt(q.quote))) return;
      quoteDel(ts); render();
    });
    document.getElementById("rPurgeBtn").addEventListener("click", function () { purge.hidden = !purge.hidden; purgeInfo(); });
    document.getElementById("rPurgeCancel").addEventListener("click", function () { purge.hidden = true; });
    pDays.addEventListener("input", purgeInfo);
    document.getElementById("rPurgeGo").addEventListener("click", function () {
      var list = oldList(); if (!list.length) return;
      list.forEach(function (q) { quoteDel(q.ts); });
      purge.hidden = true; render(); cntEl.textContent += "　（已刪除 " + list.length + " 筆舊資料）";
    });
    document.getElementById("rCsv").addEventListener("click", function () {
      var rows = filtered(), cell = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var lines = [["日期", "客戶／備註", "材質", "重量(kg)", "料價(NT$/kg)", "加工費", "利潤%", "報價"].join(",")].concat(rows.map(function (q) {
        return [fmtDate(q.ts), q.note || "", q.material, q.weight, q.price, q.proc || 0, q.margin, q.quote].map(cell).join(",");
      }));
      var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
      a.download = "報價紀錄.csv"; document.body.appendChild(a); a.click(); a.remove();
    });
    window.__refreshQuotes = render;
    window.__refreshAuthHint = function () { authHint(document.getElementById("rLogin")); };
    render(); authHint(document.getElementById("rLogin"));
  }

  // ============================================================ 首頁：報價自動盯盤
  // 拿「已存的報價」和「現在的料價」比：料價漲超過 3% → 這筆報價可能偏低，該重報；降超過 3% → 成本有下降空間。
  function initWatch(MATS) {
    var box = document.getElementById("watchBox"); if (!box) return;
    var TH = 3, WINDOW_DAYS = 30, DAY = 86400000;
    function render() {
      var now = Date.now(), up = [], down = [];
      Quotes.forEach(function (q) {
        if (now - q.ts > WINDOW_DAYS * DAY) return;
        var nw = quoteNow(q, MATS); if (!nw) return;
        if (nw.dp >= TH) up.push({ q: q, nw: nw }); else if (nw.dp <= -TH) down.push({ q: q, nw: nw });
      });
      up.sort(function (a, b) { return b.nw.dp - a.nw.dp; });
      var total = Quotes.filter(function (q) { return now - q.ts <= WINDOW_DAYS * DAY; }).length;
      if (!total) { box.hidden = false; box.className = "watchbox"; box.innerHTML = '<div class="adv-k">' + ic("clipboard") + '報價盯盤</div><div class="wb-t">還沒有近期報價可以盯</div><div class="adv-f">在「報價試算」存報價後，系統會每天比對最新料價，成本漲超過 ' + TH + '% 就提醒你重報。</div>'; return; }
      box.hidden = false; box.className = "watchbox" + (up.length ? " wb-warn" : "");
      var li = function (x) { return "<li><b>" + (x.q.note ? escAttr(x.q.note) + "　" : "") + escAttr(x.q.material) + " " + ntdFmt(x.q.quote) + "</b>　料價 " + x.q.price + " → " + x.nw.nt + "（" + (x.nw.dp >= 0 ? "+" : "") + x.nw.dp.toFixed(1) + "%）→ 成本" + (x.nw.dc > 0 ? "多了 " : "少了 ") + ntdFmt(Math.abs(x.nw.dc)) + "</li>"; };
      box.innerHTML = '<div class="adv-k">' + ic(up.length ? "alert" : "check") + '報價盯盤（近 ' + WINDOW_DAYS + ' 天共 ' + total + ' 筆報價）</div>' +
        '<div class="wb-t">' + (up.length ? up.length + " 筆報價的料價已經漲超過 " + TH + "%，可能需要重報" : "目前沒有需要重報的報價") + "</div>" +
        (up.length ? "<ul>" + up.slice(0, 5).map(li).join("") + "</ul>" : "") +
        (down.length ? '<div class="adv-f">另有 ' + down.length + " 筆報價的料價下降超過 " + TH + "%，成本有下降空間。</div>" : "") +
        '<div class="adv-f"><a href="records.html">到報價紀錄查看全部 →</a>　（比的是你存報價時的料價與現在行情；沒登入時只看得到這個瀏覽器的報價）</div>';
    }
    window.__refreshQuotes = render; render();
  }

  // ============================================================ 報價頁：情境模擬滑桿
  function initSim(getState) {
    var box = document.getElementById("qSim"); if (!box) return function () {};
    var aEl = document.getElementById("qSimA"), fEl = document.getElementById("qSimF"), out = document.getElementById("qSimOut");
    function update() {
      var s = getState(), a = parseFloat(aEl.value) || 0, f = parseFloat(fEl.value) || 0;
      document.getElementById("qSimAV").textContent = (a > 0 ? "+" : "") + a + "%";
      document.getElementById("qSimFV").textContent = (f > 0 ? "+" : "") + f + "%";
      if (!s.ok) { box.hidden = true; return; }
      box.hidden = false;
      var p2 = s.p * (1 + a / 100) * (1 + f / 100), cost2 = s.w * p2 + s.proc;
      var m0 = (s.quote - s.cost) / s.quote * 100, m1 = (s.quote - cost2) / s.quote * 100, need = cost2 * (1 + s.mg / 100);
      var dm = m1 - m0, dq = need - s.quote;
      out.innerHTML = "新料價 <b>NT$" + p2.toFixed(1) + "</b> / 公斤（原本 " + s.p + "）<br>" +
        "報價不變 → 毛利率 <b class='" + (dm < -0.05 ? "bad" : dm > 0.05 ? "good" : "") + "'>" + m1.toFixed(1) + "%</b>（" + (dm >= 0 ? "+" : "") + dm.toFixed(1) + " 個百分點）<br>" +
        "要維持原本的加成 → 報價要調到 <b>" + ntdFmt(need) + "</b>（" + (dq >= 0 ? "+" : "") + ntdFmt(dq).replace("NT$-", "-NT$") + "）";
    }
    [aEl, fEl].forEach(function (e) { e.addEventListener("input", update); });
    document.getElementById("qSimReset").addEventListener("click", function () { aEl.value = 0; fEl.value = 0; update(); });
    return update;
  }

  // ============================================================ 數字動畫（尊重「減少動態效果」設定）
  function animateNumbers() {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var els = document.querySelectorAll("[data-count]"); if (reduce || !els.length) return;
    Array.prototype.forEach.call(els, function (el) {
      var target = parseFloat(el.getAttribute("data-count")), dp = (String(el.getAttribute("data-count")).split(".")[1] || "").length, t0 = null, dur = 900;
      if (isNaN(target)) return;
      function step(ts) {
        if (t0 == null) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3), v = target * e;
        el.textContent = v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // ============================================================ 我的提醒（原料頁）
  // 規則先存本機；登入 Google 後同步到試算表的 alerts 分頁，由 price-alerts.gs 在行情更新後寄 Email。
  function initAlerts() {
    var CTX = window.ALERT_CTX || {}, NAME = { copper: "銅", aluminum: "鋁" };
    var HDR = ["id", "email", "metal", "type", "value", "active", "fired", "firedAt", "t"];
    var listEl = document.getElementById("alList"), noteEl = document.getElementById("alNote");
    var typeEl = document.getElementById("alType"), valEl = document.getElementById("alVal"), metalEl = document.getElementById("alMetal"), unitEl = document.getElementById("alUnit");
    var rules = lsGet("alerts", []);
    function me() { return gUser && gUser.email ? String(gUser.email).toLowerCase() : ""; }
    function isPrice(t) { return t === "above" || t === "below"; }
    function txt(r) {
      var n = NAME[r.metal] || r.metal, v = Number(r.value);
      if (r.type === "above") return n + "價格超過 NT$" + Math.round(v).toLocaleString("en-US") + " / 噸";
      if (r.type === "below") return n + "價格低於 NT$" + Math.round(v).toLocaleString("en-US") + " / 噸";
      if (r.type === "week_up") return n + "近 7 天漲幅超過 " + v + "%";
      return n + "近 7 天跌幅超過 " + v + "%";
    }
    function met(r) {
      var c = CTX[r.metal], v = Number(r.value); if (!c || isNaN(v)) return null;
      if (r.type === "above") return c.price_twd == null ? null : c.price_twd >= v;
      if (r.type === "below") return c.price_twd == null ? null : c.price_twd <= v;
      if (r.type === "week_up") return c.d7 == null ? null : c.d7 >= v;
      return c.d7 == null ? null : c.d7 <= -v;
    }
    function nowTxt(r) {
      var c = CTX[r.metal]; if (!c) return "";
      return isPrice(r.type) ? (c.price_twd != null ? "目前 NT$" + c.price_twd.toLocaleString("en-US") : "") : (c.d7 != null ? "目前近 7 天 " + (c.d7 > 0 ? "+" : "") + c.d7 + "%" : "");
    }
    function render() {
      var mine = rules;
      listEl.innerHTML = mine.length ? mine.map(function (r) {
        var m = met(r), st = m === true ? "目前已達標" : m === false ? "監看中" : "資料不足";
        return '<div class="alrow"><div class="al-tx">' + escAttr(txt(r)) + '<div class="al-st' + (m === true ? " hit" : "") + '">' + st + (nowTxt(r) ? "　·　" + nowTxt(r) : "") +
          (Number(r.fired) === 1 ? "　·　已寄過通知" : "") + '</div></div><button type="button" data-del="' + escAttr(r.id) + '">刪除</button></div>';
      }).join("") : '<div class="al-st" style="padding:8px 0">還沒有提醒。選金屬、條件、填數字，按「新增提醒」。</div>';
      if (!API || !CLIENT_ID) noteEl.textContent = "目前還沒設定 Google 登入，提醒只存在這台電腦，不會寄信。";
      else if (!idToken) noteEl.textContent = "提醒目前只存在這台電腦。用右上角「Google 登入」後才會同步，並寄 Email 通知你。";
      else noteEl.textContent = "已登入 " + me() + "：提醒會寄到這個信箱。";
    }
    function syncUp(r) { if (idToken && API) dbCall("tUpsert", { table: "alerts", row: r, header: HDR }); }
    function pull() {
      if (!API || !idToken) { render(); return; }
      // 登入前建立的本機規則，補上 email 並上傳
      rules.forEach(function (r) { if (!r.email) { r.email = me(); syncUp(r); } });
      dbCall("tList", { table: "alerts" }).then(function (d) {
        if (d && d.rows) {
          var mine = d.rows.filter(function (r) { return String(r.email || "").toLowerCase() === me(); });
          var ids = {}; mine.forEach(function (r) { ids[r.id] = 1; });
          rules = mine.concat(rules.filter(function (r) { return !ids[r.id] && String(r.email || "").toLowerCase() === me(); }));
          lsSet("alerts", rules);
        }
        render();
      });
    }
    function onType() {
      unitEl.textContent = isPrice(typeEl.value) ? "NT$ / 噸" : "%";
      var c = CTX[metalEl.value];
      valEl.placeholder = isPrice(typeEl.value) && c && c.price_twd ? "例如 " + Math.round(c.price_twd / 1000) * 1000 : "例如 3";
    }
    typeEl.addEventListener("change", onType); metalEl.addEventListener("change", onType);
    document.getElementById("alAdd").addEventListener("click", function () {
      var v = parseFloat(valEl.value);
      if (!(v > 0)) { valEl.focus(); return; }
      var r = { id: "a" + Date.now(), email: me(), metal: metalEl.value, type: typeEl.value, value: v, active: 1, fired: 0, t: Date.now() };
      rules.push(r); lsSet("alerts", rules); syncUp(r); valEl.value = ""; render();
    });
    listEl.addEventListener("click", function (e) {
      var id = e.target.getAttribute && e.target.getAttribute("data-del"); if (!id) return;
      rules = rules.filter(function (r) { return String(r.id) !== id; }); lsSet("alerts", rules);
      if (idToken && API) dbCall("tRemove", { table: "alerts", id: id });
      render();
    });
    window.__refreshAlerts = pull;
    onType(); render();
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    if (window.METALS_DATA) initMetals(window.METALS_DATA);
    if (window.SUPPLIERS_DATA) { initSuppliers(window.SUPPLIERS_DATA); initSupplierMap(window.SUPPLIERS_DATA); }
    if (window.QUOTE_MATERIALS) initQuote(window.QUOTE_MATERIALS);
    if (window.RECORD_MATERIALS && document.getElementById("rBody")) initRecords(window.RECORD_MATERIALS);
    if (window.CUSTOMERS_DATA) initCustomers(window.CUSTOMERS_DATA);
    if (document.getElementById("alertBox")) initAlerts();
    if (document.getElementById("watchBox") && window.RECORD_MATERIALS) initWatch(window.RECORD_MATERIALS);
    animateNumbers();
    initAuth();  // Google 登入（GIS 若已載入）；登入後 cloudPull 拉雲端資料
    // 情報下拉：點空白處收起（原生 details 負責開關）
    document.addEventListener("click", function (e) {
      Array.prototype.forEach.call(document.querySelectorAll("details.navdrop[open]"), function (d) {
        if (!d.contains(e.target)) d.removeAttribute("open");
      });
    });
  });
})();
