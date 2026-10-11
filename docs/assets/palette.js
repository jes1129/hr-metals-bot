/*
 * palette.js — 全站搜尋（Ctrl+K）與釘選
 *   - 任何頁按 Ctrl+K（Mac：⌘K）或頂欄「搜尋」：找頁面、料號、客戶、聯絡人、單據、案件、員工、設備…
 *   - 搜尋框空白時列出釘選；首頁 #pinBox 顯示釘選
 *   - 資料：ERP／行政頁用目前載入的資料；其他頁登入時向公司後端讀一次（只放在記憶體），未登入讀本機試用資料
 */
(function () {
  "use strict";
  var PIN_KEY = "erp_pins";
  var PAGES = [
    ["index.html", "今日總覽", "home"], ["metals.html", "原料行情", "ingot"], ["quote.html", "報價試算", "calc"],
    ["orders.html", "訂單看板", "clipboard"], ["erp.html", "ERP 作業", "factory"], ["erp.html#tab=items", "ERP · 料號庫存", "box"],
    ["erp.html#tab=receive", "ERP · 進貨", "truck"], ["erp.html#tab=quotes", "ERP · 報價單", "file"], ["erp.html#tab=orders", "ERP · 銷售訂單", "cart"],
    ["erp.html#tab=mfg", "ERP · BOM／工單", "factory"], ["erp.html#tab=crm", "ERP · 客戶／商機", "users"], ["erp.html#tab=cases", "ERP · 客服案件", "chat"],
    ["erp.html#tab=service", "ERP · 服務交付", "check"], ["erp.html#tab=project", "ERP · 專案", "list"], ["erp.html#tab=moves", "ERP · 異動紀錄", "list"],
    ["admin.html", "行政工作台", "users"], ["admin.html#tab=org", "行政 · 組織與員工", "users"], ["admin.html#tab=shifts", "行政 · 週班表", "calendar"],
    ["admin.html#tab=attendance", "行政 · 出勤", "clock"], ["admin.html#tab=requests", "行政 · 申請簽核", "clipboard"],
    ["admin.html#tab=equip", "行政 · 設備預約", "wrench"], ["admin.html#tab=notices", "行政 · 公告", "bell"],
    ["assistant.html", "AI 助手", "bot"], ["db.html", "資料庫", "db"], ["help.html", "使用說明", "book"], ["help.html#map", "功能地圖", "book"]
  ];
  // 資料表 → [類別名稱, 圖示, 標題, 補充說明, 所在頁]
  var REC = {
    items: ["料號", "box", function (r) { return r.sku + " " + r.name; }, function (r) { return r.kind + " · 現有 " + r.on_hand + " " + r.unit; }],
    customers: ["客戶", "users", function (r) { return r.name; }, function (r) { return [r.tax_id, r.contact, r.phone].filter(Boolean).join(" · "); }],
    contacts: ["聯絡人", "user", function (r) { return r.name; }, function (r, w) { return [cust(w, r.customer_id), r.title, r.phone, r.email].filter(Boolean).join(" · "); }],
    orders: ["銷售訂單", "cart", function (r, w) { return r.no + " " + cust(w, r.customer_id); }, function (r) { return r.date + " · NT$ " + Number(r.total).toLocaleString(); }],
    quotes: ["報價單", "file", function (r, w) { return r.no + " " + cust(w, r.customer_id); }, function (r) { return r.status + " · NT$ " + Number(r.total).toLocaleString(); }],
    receipts: ["進貨單", "truck", function (r) { return r.no + " " + r.supplier; }, function (r) { return r.date; }],
    workorders: ["工單", "factory", function (r) { return r.no + " " + (r.bom && r.bom.name || ""); }, function (r) { return r.status; }],
    deals: ["商機", "target", function (r) { return r.name; }, function (r, w) { return cust(w, r.customer_id) + " · " + r.stage; }],
    cases: ["客服案件", "chat", function (r) { return r.no + " " + r.title; }, function (r, w) { return cust(w, r.customer_id) + " · " + r.status; }],
    services: ["服務委託", "check", function (r) { return r.no + " " + r.title; }, function (r, w) { return cust(w, r.customer_id) + " · " + r.status; }],
    tasks: ["任務", "list", function (r) { return r.title; }, function (r) { return [r.project, r.status, r.due].filter(Boolean).join(" · "); }],
    milestones: ["里程碑", "target", function (r) { return r.title; }, function (r) { return [r.project, r.status, r.due].filter(Boolean).join(" · "); }],
    staff: ["員工", "user", function (r) { return r.code + " " + r.name; }, function (r) { return [r.title, r.phone].filter(Boolean).join(" · "); }],
    requests: ["申請", "clipboard", function (r, w) { return r.no + " " + staffName(w, r.staff_id) + " " + r.kind; }, function (r) { return r.status + " · " + r.start_date; }],
    equipment: ["設備", "wrench", function (r) { return (r.code ? r.code + " " : "") + r.name; }, function (r) { return r.location || ""; }],
    notices: ["公告", "bell", function (r) { return r.title; }, function (r) { return r.status; }]
  };
  var ADMIN = { staff: 1, requests: 1, equipment: 1, notices: 1, units: 1, shifts: 1, attendance: 1, reservations: 1 };
  var world = null, loading = false, ov, input, list, results = [], sel = 0;

  function ic(n) { return '<svg class="ic" aria-hidden="true"><use href="assets/icons.svg#' + n + '"/></svg>'; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function cust(w, id) { var c = (w.customers || []).filter(function (x) { return x.id === id; })[0]; return c ? c.name : ""; }
  function staffName(w, id) { var s = (w.staff || []).filter(function (x) { return x.id === id; })[0]; return s ? s.name : ""; }
  function recHref(t, id) { return (ADMIN[t] ? "admin.html" : "erp.html") + "#rec=" + t + ":" + encodeURIComponent(id); }

  function getWorld() {
    if (window.__erpWorld) return Promise.resolve(window.__erpWorld);
    if (world) return Promise.resolve(world);
    var b = window.__erpBridge;
    if (b && b.authed() && !loading) {
      loading = true;
      return b.call("erpLoad", {}).then(function (d) { loading = false; world = d && d.ok ? d.world : lsGet("erp_world_local", null); return world; });
    }
    return Promise.resolve(lsGet("erp_world_local", null));
  }

  function build(q) {
    q = q.trim().toLowerCase();
    var out = [];
    if (!q) {
      lsGet(PIN_KEY, []).forEach(function (p) { out.push({ grp: "釘選", icon: "pin", title: p.label || p.id, href: recHref(p.t, p.id) }); });
      PAGES.slice(0, 6).forEach(function (p) { out.push({ grp: "常用頁面", icon: p[2], title: p[1], href: p[0] }); });
      return out;
    }
    var words = q.split(/\s+/);
    var hit = function (s) { s = String(s || "").toLowerCase(); return words.every(function (w) { return s.indexOf(w) >= 0; }); };
    PAGES.forEach(function (p) { if (hit(p[1])) out.push({ grp: "頁面", icon: p[2], title: p[1], href: p[0] }); });
    var w = world || window.__erpWorld;
    if (w) Object.keys(REC).forEach(function (t) {
      var R = REC[t], n = 0;
      (w[t] || []).forEach(function (r) {
        if (n >= 6) return;
        var title = R[2](r, w), sub = R[3](r, w);
        if (hit(title + " " + sub + " " + (r.note || "") + " " + (r.email || ""))) { n++; out.push({ grp: R[0], icon: R[1], title: title, sub: sub, href: recHref(t, r.id) }); }
      });
    });
    return out.slice(0, 40);
  }

  function paint() {
    results = build(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    var g = "";
    list.innerHTML = results.length ? results.map(function (r, i) {
      var head = r.grp !== g ? '<div class="pal-grp">' + esc(r.grp) + "</div>" : "";
      g = r.grp;
      return head + '<a class="pal-item' + (i === sel ? " on" : "") + '" href="' + esc(r.href) + '" data-i="' + i + '">' + ic(r.icon) + '<span class="pal-t">' + esc(r.title) + "</span>" + (r.sub ? '<span class="pal-s">' + esc(r.sub) + "</span>" : "") + "</a>";
    }).join("") : '<div class="pal-empty">找不到「' + esc(input.value) + "」" + (world || window.__erpWorld ? "" : "（登入後也會搜尋 ERP 與行政資料）") + "</div>";
  }
  function go(i) {
    var r = results[i]; if (!r) return;
    close();
    var here = location.pathname.split("/").pop() || "index.html", target = r.href.split("#")[0];
    if (target === here && r.href.indexOf("#") >= 0) { location.hash = r.href.split("#")[1]; }
    else location.href = r.href;
  }
  function open() {
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "pal-ov";
      ov.innerHTML = '<div class="pal" role="dialog" aria-label="搜尋"><div class="pal-in">' + ic("search")
        + '<input type="search" placeholder="搜尋頁面、料號、客戶、單號、員工…" autocomplete="off"><kbd>Esc</kbd></div><div class="pal-list"></div>'
        + '<div class="pal-foot">↑↓ 選擇 · Enter 開啟 · 資料只在你的瀏覽器裡搜尋</div></div>';
      document.body.appendChild(ov);
      input = ov.querySelector("input"); list = ov.querySelector(".pal-list");
      ov.addEventListener("click", function (e) {
        if (e.target === ov) return close();
        var a = e.target.closest(".pal-item"); if (a) { e.preventDefault(); go(+a.getAttribute("data-i")); }
      });
      input.addEventListener("input", function () { sel = 0; paint(); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); paint(); scroll(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); scroll(); }
        else if (e.key === "Enter") { e.preventDefault(); go(sel); }
        else if (e.key === "Escape") close();
      });
    }
    ov.style.display = "flex"; input.value = ""; sel = 0; paint(); input.focus();
    getWorld().then(function (w) { world = w || world; if (ov.style.display !== "none") paint(); });
  }
  function scroll() { var on = list.querySelector(".on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" }); }
  function close() { if (ov) ov.style.display = "none"; }

  // 首頁的釘選區
  function pinBox() {
    var box = document.getElementById("pinBox"); if (!box) return;
    var ps = lsGet(PIN_KEY, []);
    if (!ps.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="hqlabel">釘選</div><div class="pin-row">' + ps.map(function (p) {
      return '<a class="pin-chip" href="' + esc(recHref(p.t, p.id)) + '">' + ic("pin") + esc(p.label || p.id) + "</a>";
    }).join("") + "</div>";
  }

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); open(); }
  });
  document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("#paletteBtn")) { e.preventDefault(); open(); } });
  document.addEventListener("DOMContentLoaded", pinBox);
  window.__openPalette = open;
})();
