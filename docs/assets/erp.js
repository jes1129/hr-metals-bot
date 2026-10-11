/*
 * erp.js — ERP 作業頁（erp.html）的畫面與操作
 *
 * 規則全部在 erp-engine.js；這裡只負責畫面、表單與「送去哪裡算」：
 *   - 已登入且後端已加入 ERP 檔 → 送 Apps Script（erpAct），資料存公司試算表 ERP_* 分頁（正式）
 *   - 未登入／後端未啟用       → 在本瀏覽器算、存 localStorage（本機試用，不影響公司資料）
 * 登入沿用 app.js（window.__erpBridge），本檔不另做登入，也不改動其他頁面的資料。
 */
(function () {
  "use strict";
  var E = window.ErpEngine;
  var LOCAL_KEY = "erp_world_local";
  var TABS = [
    ["home", ic("bars") + "總覽"], ["items", ic("box") + "料號庫存"], ["receive", ic("truck") + "進貨"], ["quotes", ic("file") + "報價單"],
    ["orders", ic("cart") + "銷售訂單"], ["mfg", ic("factory") + "BOM／工單"], ["crm", ic("users") + "客戶／商機"], ["moves", ic("list") + "異動紀錄"]
  ];
  var S = { tab: "home", world: null, mode: "local", backend: null, backendErr: "", loading: false, busy: false, metal: {} };
  var mount;

  // ---------- 小工具 ----------
  function ic(name) { return '<svg class="ic" aria-hidden="true"><use href="assets/icons.svg#' + name + '"/></svg>'; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function nt(n) { return "NT$ " + (Number(n) || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 }); }
  function num(n) { return (Number(n) || 0).toLocaleString("zh-TW", { maximumFractionDigits: 3 }); }
  function z(n) { return (n < 10 ? "0" : "") + n; }
  function dstr(d) { return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
  function today() { return dstr(new Date()); }
  function plusDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return dstr(d); }
  function lsGet(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function bridge() { return window.__erpBridge || null; }
  function W() { return S.world || E.empty(); }
  function byId(t, id) { var a = W()[t]; for (var i = 0; i < a.length; i++) if (String(a[i].id) === String(id)) return a[i]; return null; }
  function custName(id) { var c = byId("customers", id); return c ? c.name : "（已刪除）"; }
  function itemOf(id) { return byId("items", id); }
  function avgCost(it) { return it.on_hand > 0 ? E.stockValue(W(), it.id) / it.on_hand : it.std_cost; }
  function chip(text, tone) { return '<span class="erp-st ' + (tone || "") + '">' + esc(text) + "</span>"; }
  function btn(a, label, id, cls) { return '<button class="dbbtn ' + (cls || "") + '" data-a="' + a + '"' + (id != null ? ' data-id="' + esc(id) + '"' : "") + ">" + label + "</button>"; }
  function mini(a, label, id, title) { return '<button class="dbmini" data-a="' + a + '" data-id="' + esc(id) + '" title="' + esc(title || "") + '">' + label + "</button>"; }
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "application/json;charset=utf-8" }));
    a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ---------- 載入與模式 ----------
  function loadLocal() { S.mode = "local"; S.world = lsGet(LOCAL_KEY, null) || E.empty(); }
  function saveLocal() { lsSet(LOCAL_KEY, S.world); }
  function load() {
    var b = bridge();
    if (b && b.authed()) {
      if (S.loading) return;   // 登入流程會連續觸發幾次，只載一次
      S.loading = true; render();
      b.call("erpLoad", {}).then(function (d) {
        S.loading = false;
        if (d && d.ok && d.world) { S.backend = true; S.backendErr = ""; S.mode = "cloud"; S.world = d.world; }
        else {
          S.backend = false;
          S.backendErr = !d ? "連不到公司後端" : /unknown action/.test(d.error || "") ? "公司後端尚未加入 ERP 檔" : String(d.error || "");
          loadLocal();
        }
        render();
      });
    } else { S.backend = null; loadLocal(); render(); }
  }
  window.__refreshErp = load;

  // 每次操作：雲端送 Apps Script（帶唯一 key，斷線自動重送一次不會重複執行）；本機則複製一份再算，失敗就丟掉
  function act(action, payload) {
    if (S.busy) return Promise.resolve(null);
    S.busy = true; paintBusy();
    var p;
    if (S.mode === "cloud") {
      var key = "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      p = sendCloud(action, payload, key, 0);
    } else {
      p = new Promise(function (res) {
        var w = JSON.parse(JSON.stringify(W()));
        try {
          var r = E.apply(w, action, payload, { by: "本機試用", today: today(), now: new Date().toISOString() });
          S.world = w; saveLocal(); res({ ok: true, result: r.result });
        } catch (e) { res({ error: e.message }); }
      });
    }
    return p.then(function (r) {
      S.busy = false; paintBusy();
      if (!r || r.error) { alert((r ? r.error : "連線失敗，請稍後再試（這筆沒有寫入）")); return null; }
      render();
      return r.result || true;
    });
  }
  function sendCloud(action, payload, key, tries) {
    return bridge().call("erpAct", { action: action, payload: payload, key: key }).then(function (d) {
      if (d === null && tries < 1) return sendCloud(action, payload, key, tries + 1);
      if (d && d.ok && d.world) S.world = d.world;
      return d;
    });
  }
  function paintBusy() { var b = document.getElementById("erpBusy"); if (b) b.style.display = S.busy ? "" : "none"; }

  // ---------- 外框 ----------
  function render() {
    if (!mount) return;
    var w = W();
    var tabs = TABS.map(function (t) { return '<button class="dbtab' + (t[0] === S.tab ? " on" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("");
    var mode = S.mode === "cloud"
      ? '<div class="erp-mode cloud">' + ic("db") + '公司正式資料（Google 試算表 ERP_ 分頁，多人共用）</div>'
      : '<div class="erp-mode local">' + ic("info") + '本機試用模式：資料只存在這個瀏覽器，不會進公司試算表。'
        + (S.backendErr ? "（" + esc(S.backendErr) + "，見「說明 → ERP 設定」）" : bridge() && bridge().configured() ? "登入 Google 後改用公司正式資料。" : "")
        + "</div>";
    var tools = '<div class="erp-tools">'
      + '<span id="erpBusy" class="erp-busy" style="display:none">' + ic("clock") + '處理中…</span>'
      + btn("reload", ic("refresh") + "重新整理") + btn("backup", ic("download") + "備份 JSON") + btn("health", ic("shield") + "資料健檢")
      + (S.mode === "local" ? btn("reset-local", ic("eraser") + "清空試用資料") : "")
      + "</div>";
    var body = S.loading ? '<div class="dbloading">載入公司 ERP 資料中…</div>' : (VIEW[S.tab] || VIEW.home)(w);
    mount.innerHTML = mode + tools + '<div class="dbtabs erp-tabs">' + tabs + "</div>" + body;
    paintBusy();
  }

  // ---------- 通用表格（含即時搜尋，不重畫保留游標） ----------
  function table(cols, rows, opts) {
    opts = opts || {};
    var head = cols.map(function (c) { return "<th" + (c.r ? ' class="r"' : "") + ">" + esc(c.l) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      var s = cols.map(function (c) { return typeof c.v === "function" ? "" : String(r[c.v] || ""); }).join(" ") + " " + (opts.search ? opts.search(r) : "");
      return '<tr data-s="' + esc(s.toLowerCase()) + '"' + (opts.rowCls ? ' class="' + opts.rowCls(r) + '"' : "") + ">" + cols.map(function (c) {
        var v = typeof c.v === "function" ? c.v(r) : esc(r[c.v]);
        return '<td data-label="' + esc(c.l) + '"' + (c.r ? ' class="r"' : "") + ">" + v + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>"
      + (rows.length ? "" : '<div class="dbempty">' + (opts.empty || "目前沒有資料") + "</div>");
  }
  function searchBox(ph) { return '<input class="dbsearch erp-search" placeholder="' + esc(ph || "搜尋…") + '">'; }
  function kpi(label, val, cls, sub) {
    return '<div class="okpi ' + (cls || "") + '"><div class="okpi-l">' + label + '</div><div class="okpi-v">' + esc(val) + "</div>"
      + (sub ? '<div class="erp-kpisub">' + sub + "</div>" : "") + "</div>";
  }
  function section(title, inner, right) {
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + title + "</h3>" + (right || "") + "</div>" + inner + "</div>";
  }

  // ===========================================================================
  // 各分頁
  // ===========================================================================
  var VIEW = {};

  VIEW.home = function (w) {
    var r = E.report(w, today());
    var emptyWorld = !w.items.length && !w.customers.length;
    var guide = emptyWorld ? section(ic("play") + "第一次使用：四步驟開始",
      '<ol class="erp-steps"><li><b>建料號</b>：原料（kg）、成品（件）都要建，進貨與出貨才算得出成本。</li>'
      + "<li><b>進貨</b>：照實際進價登錄，系統用先進先出（FIFO）自動算庫存成本。</li>"
      + "<li><b>建客戶 → 報價 → 接受轉訂單</b>：也可以直接開訂單。</li>"
      + "<li><b>出貨、收款</b>；要自己生產的，先建 BOM 再開工單。</li></ol>"
      + '<div class="erp-row">' + btn("tab", "＋ 先建第一個料號", "items", "primary")
      + (S.mode === "local" ? btn("demo", ic("info") + "載入示範資料（只在本機）") : "") + "</div>") : "";
    var kp = '<div class="okpis erp-kpis">'
      + kpi(ic("cash") + "本月銷售", nt(r.sales_month), "", "依出貨認列")
      + kpi(ic("chart") + "本月毛利", nt(r.gp_month), r.gp_month < 0 ? "warn" : "", r.gm_month == null ? "—" : "毛利率 " + r.gm_month + "%")
      + kpi(ic("box") + "庫存價值", nt(r.inventory_value), "", "FIFO 成本")
      + kpi(ic("file") + "應收帳款", nt(r.receivable), "", "已出貨未收")
      + kpi(ic("truck") + "未出貨訂單", r.open_orders + " 張", r.overdue_orders.length ? "warn" : "", r.overdue_orders.length ? "逾期 " + r.overdue_orders.length + " 張" : "無逾期")
      + kpi(ic("factory") + "進行中工單", r.wo_active + " 張", "", "")
      + kpi(ic("file") + "有效報價", r.quotes_open + " 張", r.quotes_expiring.length ? "warn" : "", r.quotes_expiring.length ? "7 天內到期 " + r.quotes_expiring.length + " 張" : "")
      + kpi(ic("alert") + "缺料品項", r.shortage.length + " 項", r.shortage.length ? "warn" : "", "訂單/工單需要 > 現有")
      + "</div>";
    var short = r.shortage.length ? table([
      { l: "料號", v: "sku" }, { l: "品名", v: "name" }, { l: "類別", v: "kind" },
      { l: "缺多少", r: 1, v: function (x) { return '<b class="erp-bad">' + num(x.short) + "</b>"; } },
      { l: "建議", v: function (x) { return x.has_bom ? mini("wo-new-for", ic("factory") + "開工單", x.id) : mini("receive-for", ic("truck") + "進貨", x.id); } }
    ], r.shortage) : '<div class="dbempty">沒有缺料</div>';
    var low = r.low_stock.length ? table([
      { l: "料號", v: "sku" }, { l: "品名", v: "name" }, { l: "現有", r: 1, v: function (x) { return num(x.on_hand); } }, { l: "安全庫存", r: 1, v: function (x) { return num(x.safety); } }
    ], r.low_stock) : '<div class="dbempty">都在安全庫存以上</div>';
    var due = r.overdue_orders.concat([]).map(function (o) { return '<li>' + mini("order-view", ic("cart") + esc(o.no), o.id) + ' 交期 <b class="erp-bad">' + esc(o.due) + "</b></li>"; })
      .concat(r.quotes_expiring.map(function (q) { return "<li>" + mini("quote-view", ic("file") + esc(q.no), q.id) + " 報價 " + esc(q.valid_until) + " 到期</li>"; }));
    var funnel = E.STAGES.map(function (s) {
      var x = r.pipeline[s], mx = 1; E.STAGES.forEach(function (k) { mx = Math.max(mx, r.pipeline[k].n); });
      return '<div class="dbrow"><div class="dblabel">' + s + '</div><div class="dbtrack"><div class="dbbar" style="width:' + Math.round(x.n / mx * 100) + '%"></div></div><div class="dbval">' + x.n + " · " + nt(x.amount) + "</div></div>";
    }).join("");
    var metal = (S.metal.copper || S.metal.aluminum) ? '<div class="erp-metal">' + ic("ingot") + '原料參考價（LME 換算）：'
      + (S.metal.copper ? "銅 NT$ " + num(S.metal.copper) + "/kg　" : "") + (S.metal.aluminum ? "鋁 NT$ " + num(S.metal.aluminum) + "/kg" : "")
      + (S.metal.updated ? '　<span class="erp-muted">更新 ' + esc(S.metal.updated) + "</span>" : "") + "</div>" : "";
    return guide + kp + metal
      + '<div class="erp-grid2">' + section(ic("alert") + "缺料（需要補料或生產）", short) + section(ic("bars") + "低於安全庫存", low) + "</div>"
      + '<div class="erp-grid2">' + section(ic("clock") + "要注意的單據", due.length ? '<ul class="erp-list">' + due.join("") + "</ul>" : '<div class="dbempty">沒有逾期或快到期的單據</div>')
      + section(ic("target") + "銷售漏斗（商機）", '<div class="dbbars erp-funnel">' + funnel + "</div>") + "</div>";
  };

  VIEW.items = function (w) {
    var rows = w.items.slice().sort(function (a, b) { return String(a.sku).localeCompare(String(b.sku)); });
    return '<div class="dbtoolbar">' + searchBox("搜尋料號、品名…") + btn("item-new", ic("plus") + "新增料號", null, "primary") + btn("csv-items", ic("download") + "匯出 CSV") + "</div>"
      + table([
        { l: "料號", v: "sku" }, { l: "品名", v: function (x) { return esc(x.name) + (x.active === false ? " " + chip("停用", "muted") : "") + (x.metal ? " " + chip(x.metal === "copper" ? "銅" : "鋁", "info") : ""); } },
        { l: "類別", v: "kind" }, { l: "單位", v: "unit" },
        { l: "現有", r: 1, v: function (x) { return num(x.on_hand); } },
        { l: "預留", r: 1, v: function (x) { return x.reserved ? num(x.reserved) : ""; } },
        { l: "可用", r: 1, v: function (x) { var a = x.on_hand - x.reserved; return '<b class="' + (a < 0 ? "erp-bad" : x.safety && x.on_hand < x.safety ? "erp-warn" : "") + '">' + num(a) + "</b>"; } },
        { l: "平均成本", r: 1, v: function (x) { return nt(avgCost(x)); } },
        { l: "庫存價值", r: 1, v: function (x) { return nt(E.stockValue(w, x.id)); } },
        { l: "售價", r: 1, v: function (x) { return x.price ? nt(x.price) : ""; } },
        { l: "", v: function (x) { return mini("item-edit", ic("edit"), x.id, "編輯") + mini("item-adjust", ic("scale"), x.id, "盤點調整") + mini("item-lots", ic("search"), x.id, "成本批次"); } }
      ], rows, { empty: "還沒有料號。先建原料與成品，進貨、報價、訂單都會用到。", search: function (x) { return x.sku + " " + x.name + " " + x.note; }, rowCls: function (x) { return x.active === false ? "erp-off" : ""; } });
  };

  VIEW.receive = function (w) {
    var rows = w.receipts.slice().reverse();
    return '<div class="dbtoolbar">' + searchBox("搜尋單號、供應商…") + btn("receive-new", ic("plus") + "新增進貨單", null, "primary") + "</div>"
      + table([
        { l: "單號", v: function (x) { return mini("receive-view", esc(x.no), x.id); } }, { l: "日期", v: "date" }, { l: "供應商", v: "supplier" },
        { l: "品項", v: function (x) { return esc(x.lines.map(function (l) { return l.name + "×" + num(l.qty); }).join("、")); } },
        { l: "金額", r: 1, v: function (x) { return nt(x.total); } }
      ], rows, { empty: "還沒有進貨紀錄。", search: function (x) { return x.no + " " + x.supplier; } });
  };

  var QTONE = { "草稿": "muted", "已發出": "info", "已成交": "ok", "已取代": "muted" };
  VIEW.quotes = function (w) {
    var rows = w.quotes.slice().reverse();
    return '<div class="dbtoolbar">' + searchBox("搜尋單號、客戶…") + btn("quote-new", ic("plus") + "新增報價單", null, "primary") + "</div>"
      + table([
        { l: "單號", v: function (x) { return mini("quote-view", esc(x.no), x.id); } }, { l: "日期", v: "date" },
        { l: "客戶", v: function (x) { return esc(custName(x.customer_id)); } },
        { l: "金額", r: 1, v: function (x) { return nt(x.total); } },
        { l: "有效至", v: function (x) { return x.valid_until && x.status === "已發出" && x.valid_until < today() ? '<span class="erp-bad">' + esc(x.valid_until) + " 已過期</span>" : esc(x.valid_until); } },
        { l: "狀態", v: function (x) { return chip(x.status, QTONE[x.status]); } },
        { l: "", v: function (x) {
          if (x.status === "草稿") return mini("quote-edit", ic("edit"), x.id, "編輯") + mini("quote-issue", ic("arrow") + "發出", x.id) + mini("quote-del", ic("trash"), x.id, "刪除");
          if (x.status === "已發出") return mini("quote-accept", ic("check") + "客戶接受", x.id) + mini("quote-print", ic("printer"), x.id, "列印");
          if (x.status === "已成交") return mini("order-view", ic("cart") + "看訂單", x.so_id) + mini("quote-print", ic("printer"), x.id, "列印");
          return mini("quote-print", ic("printer"), x.id, "列印");
        } }
      ], rows, { empty: "還沒有報價單。", search: function (x) { return x.no + " " + custName(x.customer_id); } });
  };

  function stTone(s) { return { "未出貨": "warn", "部分出貨": "info", "已出貨": "ok", "部分退貨": "warn", "已退貨": "muted", "已取消": "muted" }[s]; }
  function payTone(s) { return { "未收款": "warn", "部分收款": "info", "已收清": "ok" }[s]; }
  VIEW.orders = function (w) {
    var rows = w.orders.slice().reverse();
    return '<div class="dbtoolbar">' + searchBox("搜尋單號、客戶、品名…") + btn("order-new", ic("plus") + "新增銷售訂單", null, "primary") + btn("csv-orders", ic("download") + "匯出 CSV") + "</div>"
      + table([
        { l: "單號", v: function (x) { return mini("order-view", esc(x.no), x.id); } }, { l: "日期", v: "date" },
        { l: "客戶", v: function (x) { return esc(custName(x.customer_id)); } },
        { l: "金額", r: 1, v: function (x) { return nt(x.total); } },
        { l: "交期", v: function (x) { var s = E.orderState(x); return x.due && x.due < today() && (s === "未出貨" || s === "部分出貨") ? '<b class="erp-bad">' + esc(x.due) + " 逾期</b>" : esc(x.due); } },
        { l: "出貨", v: function (x) { var s = E.orderState(x); return chip(s, stTone(s)); } },
        { l: "收款", v: function (x) { if (x.cancelled) return ""; var s = E.payState(x); return chip(s, payTone(s)); } },
        { l: "", v: function (x) {
          if (x.cancelled) return mini("order-view", ic("search"), x.id, "詳情");
          var s = E.orderState(x);
          return (s === "未出貨" || s === "部分出貨" ? mini("order-ship", ic("truck") + "出貨", x.id) : "")
            + (E.payState(x) !== "已收清" ? mini("order-pay", ic("cash") + "收款", x.id) : "")
            + mini("order-view", ic("search"), x.id, "詳情");
        } }
      ], rows, { empty: "還沒有銷售訂單。", search: function (x) { return x.no + " " + custName(x.customer_id) + " " + x.lines.map(function (l) { return l.name + " " + l.sku; }).join(" "); } });
  };

  var WTONE = { "計畫": "muted", "已備料": "info", "生產中": "warn", "完工": "ok", "已取消": "muted" };
  VIEW.mfg = function (w) {
    var boms = w.boms.filter(function (b) { return b.active; });
    var wos = w.workorders.slice().reverse();
    return section(ic("layers") + "BOM（產品用料表，每次修改自動升版）", table([
      { l: "成品", v: function (b) { var it = itemOf(b.item_id); return esc(it ? it.sku + " " + it.name : "?"); } },
      { l: "版本", v: function (b) { return "v" + b.revision; } },
      { l: "用料（每 1 單位）", v: function (b) { return esc(b.components.map(function (c) { var ci = itemOf(c.item_id); return (ci ? ci.name : c.name) + " " + num(c.qty) + (ci ? ci.unit : ""); }).join("、")); } },
      { l: "估算材料成本", r: 1, v: function (b) { return nt(b.components.reduce(function (s, c) { var ci = itemOf(c.item_id); return s + (ci ? avgCost(ci) : 0) * c.qty; }, 0)); } },
      { l: "", v: function (b) { return mini("bom-edit", ic("edit") + "改版", b.item_id) + mini("wo-new-for", ic("factory") + "開工單", b.item_id); } }
    ], boms, { empty: "還沒有 BOM。自己生產的成品，先定義每 1 件要用哪些料。" }), btn("bom-new", ic("plus") + "新增 BOM", null, "primary"))
      + section(ic("factory") + "工單（計畫 → 預留用料 → 開工 → 完工入庫）", table([
        { l: "單號", v: "no" }, { l: "成品", v: function (o) { return esc(o.bom.sku + " " + o.bom.name) + ' <span class="erp-muted">v' + o.bom.revision + "</span>"; } },
        { l: "數量", r: 1, v: function (o) { return num(o.qty); } }, { l: "交期", v: "due" },
        { l: "狀態", v: function (o) { return chip(o.status, WTONE[o.status]); } },
        { l: "實際成本", r: 1, v: function (o) { return o.status === "完工" ? nt(o.actual_cost) + '<div class="erp-muted">單位 ' + nt(o.actual_cost / o.qty) + "</div>" : ""; } },
        { l: "", v: function (o) {
          var b = { "計畫": mini("wo-reserve", ic("inbox") + "預留用料", o.id), "已備料": mini("wo-start", ic("play") + "開工", o.id), "生產中": mini("wo-complete", ic("check") + "完工", o.id) }[o.status] || "";
          return b + (["計畫", "已備料", "生產中"].indexOf(o.status) >= 0 ? mini("wo-cancel", ic("x"), o.id, "取消工單") : "") + mini("wo-view", ic("search"), o.id, "用料明細");
        } }
      ], wos, { empty: "還沒有工單。" }), btn("wo-new", ic("plus") + "新增工單", null, "primary"));
  };

  VIEW.crm = function (w) {
    var stats = {};
    w.orders.forEach(function (o) { if (o.cancelled) return; var s = stats[o.customer_id] = stats[o.customer_id] || { n: 0, amt: 0 }; s.n++; s.amt += E.orderNet(o); });
    var board = '<div class="okanban erp-kanban">' + E.STAGES.map(function (st, i) {
      var cards = w.deals.filter(function (d) { return d.stage === st; });
      return '<div class="okcol oks' + Math.min(i, 4) + '"><div class="okhead">' + st + " <span>" + cards.length + "</span></div>"
        + (cards.map(function (d) {
          var late = d.next_date && d.next_date < today() && st !== "成交" && st !== "失單";
          return '<div class="ocardk' + (late ? " od" : "") + '" data-a="deal-view" data-id="' + esc(d.id) + '"><div class="ock-cust">' + esc(d.name) + '</div><div class="ock-prod">' + esc(custName(d.customer_id)) + "</div>"
            + '<div class="ock-meta">' + (d.amount ? nt(d.amount) : "") + (d.next_date ? ' <span class="' + (late ? "od" : "") + '">' + ic("calendar") + esc(d.next_date) + "</span>" : "") + "</div></div>";
        }).join("") || '<div class="ock-empty">尚無</div>') + "</div>";
    }).join("") + "</div>";
    return section(ic("target") + "商機看板（點卡片看跟進紀錄）", board, btn("deal-new", ic("plus") + "新增商機", null, "primary"))
      + section(ic("users") + "客戶", '<div class="dbtoolbar">' + searchBox("搜尋客戶、統編、電話…") + btn("csv-customers", ic("download") + "匯出 CSV") + "</div>" + table([
        { l: "名稱", v: "name" }, { l: "統編", v: "tax_id" }, { l: "聯絡人", v: "contact" }, { l: "電話", v: "phone" }, { l: "Email", v: "email" },
        { l: "來源", v: "source" },
        { l: "訂單", r: 1, v: function (c) { return stats[c.id] ? stats[c.id].n : ""; } },
        { l: "累計出貨", r: 1, v: function (c) { return stats[c.id] ? nt(stats[c.id].amt) : ""; } },
        { l: "", v: function (c) { return mini("cust-edit", ic("edit"), c.id, "編輯") + mini("deal-new-for", ic("target"), c.id, "新增商機") + mini("quote-new-for", ic("file"), c.id, "開報價"); } }
      ], w.customers, { empty: "還沒有客戶。" }), btn("cust-new", ic("plus") + "新增客戶", null, "primary"));
  };

  VIEW.moves = function (w) {
    var rows = w.moves.slice().reverse();
    return '<div class="dbtoolbar">' + searchBox("搜尋料號、單號、類別…") + btn("csv-moves", ic("download") + "匯出 CSV") + "</div>"
      + table([
        { l: "日期", v: "date" },
        { l: "料號", v: function (m) { var it = itemOf(m.item_id); return esc(it ? it.sku : "?"); } },
        { l: "品名", v: function (m) { var it = itemOf(m.item_id); return esc(it ? it.name : "?"); } },
        { l: "類別", v: "type" },
        { l: "數量", r: 1, v: function (m) { return '<span class="' + (m.qty < 0 ? "erp-bad" : "erp-good") + '">' + (m.qty > 0 ? "+" : "") + num(m.qty) + "</span>"; } },
        { l: "成本金額", r: 1, v: function (m) { return nt(m.value); } },
        { l: "單據", v: "ref" }, { l: "備註", v: "note" }, { l: "經手人", v: "by" }
      ], rows, { empty: "還沒有庫存異動。進貨、出貨、工單、盤點都會自動記在這裡（不可修改，可追溯）。",
        search: function (m) { var it = itemOf(m.item_id); return it ? it.sku + " " + it.name : ""; } });
  };

  // ===========================================================================
  // 表單（彈窗）：欄位型別 text/num/date/select/textarea/check/lines/html
  // ===========================================================================
  function itemOpts(filter) {
    return [["", "— 選擇料號 —"]].concat(W().items.filter(function (i) { return i.active !== false && (!filter || filter(i)); })
      .sort(function (a, b) { return String(a.sku).localeCompare(String(b.sku)); })
      .map(function (i) { return [i.id, i.sku + " · " + i.name + "（可用 " + num(i.on_hand - i.reserved) + " " + i.unit + "）"]; }));
  }
  function custOpts() { return [["", "— 選擇客戶 —"]].concat(W().customers.map(function (c) { return [c.id, c.name]; })); }
  function selectHtml(attr, opts, v) {
    return "<select " + attr + ">" + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select>";
  }
  function inputHtml(f, v, attr) {
    if (f.type === "select") return selectHtml(attr, f.opts, v);
    if (f.type === "textarea") return "<textarea " + attr + ' rows="2">' + esc(v) + "</textarea>";
    if (f.type === "check") return '<label class="dbcheck"><input type="checkbox" ' + attr + (v ? " checked" : "") + "> " + esc(f.text || "") + "</label>";
    var t = f.type === "num" ? 'type="number" step="any"' : f.type === "date" ? 'type="date"' : 'type="text"';
    return "<input " + t + " " + attr + ' value="' + esc(v) + '"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") + (f.list ? ' list="' + f.list + '"' : "") + ">";
  }
  function lineRow(f, r) {
    return '<div class="erp-line">' + f.cols.map(function (c) {
      return '<label class="erp-lcol' + (c.wide ? " wide" : "") + '"><span>' + esc(c.l) + "</span>" + inputHtml(c, r[c.k] != null ? r[c.k] : "", 'data-c="' + c.k + '"' + (c.fill ? ' data-fill="' + c.fill + '"' : "")) + "</label>";
    }).join("") + '<button type="button" class="dbmini erp-ldel" title="移除這列">' + ic("x") + '</button></div>';
  }
  function fieldHtml(f) {
    if (f.type === "html") return '<div class="erp-fhtml">' + f.html + "</div>";
    var v = f.value != null ? f.value : "";
    if (f.type === "lines") {
      var rows = (v && v.length ? v : [{}]).map(function (r) { return lineRow(f, r); }).join("");
      return '<div class="dbfield erp-lines" data-lines="' + f.k + '"><span>' + esc(f.l) + "</span>" + rows
        + '<button type="button" class="dbbtn erp-ladd">＋ 加一列</button></div>';
    }
    return '<label class="dbfield"><span>' + esc(f.l) + (f.req ? ' <b class="erp-bad">*</b>' : "") + "</span>" + inputHtml(f, v, 'data-f="' + f.k + '"')
      + (f.hint ? '<small class="erp-muted" data-hint="' + f.k + '">' + f.hint + "</small>" : "") + "</label>";
  }
  function form(o) {
    var ov = document.createElement("div");
    ov.className = "dbmodal";
    ov.innerHTML = '<div class="dbdialog erp-dialog' + (o.wide ? " wide" : "") + '"><h3>' + (o.titleHtml || esc(o.title)) + "</h3>"
      + (o.intro ? '<div class="dbnote erp-intro">' + o.intro + "</div>" : "")
      + '<div class="dbform">' + o.fields.map(fieldHtml).join("") + "</div>"
      + '<div class="dbdlgbtns">' + (o.extra || []).map(function (x, i) { return '<button class="dbbtn ' + (x.cls || "") + '" data-extra="' + i + '">' + x.l + "</button>"; }).join("")
      + '<button class="dbbtn" data-x>' + (o.submit ? "取消" : "關閉") + "</button>" + (o.submit ? '<button class="dbbtn primary" data-ok>' + esc(o.ok || "儲存") + "</button>" : "") + "</div></div>"
      + (o.datalist || "");
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) {
      if (e.target === ov || e.target.hasAttribute("data-x")) return close();
      var t = e.target;
      if (t.classList.contains("erp-ladd")) {
        var box = t.parentNode, f = o.fields.filter(function (x) { return x.k === box.getAttribute("data-lines"); })[0];
        var tmp = document.createElement("div"); tmp.innerHTML = lineRow(f, {}); box.insertBefore(tmp.firstChild, t);
      } else if (t.classList.contains("erp-ldel")) {
        var ln = t.parentNode; if (ln.parentNode.querySelectorAll(".erp-line").length > 1) ln.parentNode.removeChild(ln);
      } else if (t.hasAttribute("data-extra")) {
        o.extra[Number(t.getAttribute("data-extra"))].fn(close, collect);
      } else if (t.hasAttribute("data-ok")) {
        Promise.resolve(o.submit(collect())).then(function (res) { if (res) close(); });
      }
    });
    // 選了料號就帶入預設價（只在該格還空著或仍是上次自動帶入的值時）
    ov.addEventListener("change", function (e) {
      var t = e.target;
      if (t.getAttribute("data-c") === "item_id") {
        var it = itemOf(t.value), row = t.closest(".erp-line");
        Array.prototype.forEach.call(row.querySelectorAll("[data-fill]"), function (inp) {
          if (it && (!inp.value || inp.getAttribute("data-auto") === inp.value)) { inp.value = it[inp.getAttribute("data-fill")] || ""; inp.setAttribute("data-auto", inp.value); }
        });
      }
      if (o.onChange) o.onChange(t, ov);
    });
    function collect() {
      var out = {};
      Array.prototype.forEach.call(ov.querySelectorAll("[data-f]"), function (el) { out[el.getAttribute("data-f")] = el.type === "checkbox" ? el.checked : el.value; });
      Array.prototype.forEach.call(ov.querySelectorAll("[data-lines]"), function (box) {
        out[box.getAttribute("data-lines")] = Array.prototype.map.call(box.querySelectorAll(".erp-line"), function (ln) {
          var r = {}; Array.prototype.forEach.call(ln.querySelectorAll("[data-c]"), function (el) { r[el.getAttribute("data-c")] = el.value; }); return r;
        }).filter(function (r) { return Object.keys(r).some(function (k) { return r[k] !== ""; }); });
      });
      return out;
    }
    var first = ov.querySelector("input:not([disabled]),select"); if (first) first.focus();
    return ov;
  }
  // titleHtml：可含狀態標籤；呼叫端要自行 esc 使用者輸入的文字
  function info(titleHtml, html, extra) { return form({ titleHtml: titleHtml, fields: [{ type: "html", html: html }], extra: extra, wide: true }); }
  function needCustomers() { if (!W().customers.length) { alert("請先建立客戶（客戶／商機 → ＋ 新增客戶）。"); S.tab = "crm"; render(); return false; } return true; }
  function needItems() { if (!W().items.length) { alert("請先建立料號（料號庫存 → ＋ 新增料號）。"); S.tab = "items"; render(); return false; } return true; }

  // ---------- 料號 ----------
  function itemForm(it) {
    var editing = !!it; it = it || { kind: "成品", unit: "件" };
    var metalHint = function (m) { return S.metal[m] ? "LME 參考價：NT$ " + num(S.metal[m]) + "/kg（可作原料標準成本參考）" : ""; };
    form({
      title: editing ? "編輯料號 " + it.sku : "新增料號",
      fields: [
        { k: "sku", l: "料號", req: 1, value: it.sku, ph: "例：RM-CU-C3604、FG-BRK-001" },
        { k: "name", l: "品名", req: 1, value: it.name },
        { k: "kind", l: "類別", type: "select", opts: E.KINDS.map(function (k) { return [k, k]; }), value: it.kind },
        { k: "unit", l: "單位", value: it.unit, ph: "件 / kg / 支 / 片" },
        { k: "metal", l: "金屬原料（連動原料行情）", type: "select", opts: [["", "—"], ["copper", "銅"], ["aluminum", "鋁"]], value: it.metal || "", hint: metalHint(it.metal) },
        { k: "std_cost", l: "標準成本（未填進價時使用）", type: "num", value: it.std_cost },
        { k: "price", l: "建議售價", type: "num", value: it.price },
        { k: "safety", l: "安全庫存（低於會提醒）", type: "num", value: it.safety },
        editing ? { k: "active", l: "狀態", type: "check", text: "使用中（取消勾選＝停用，保留歷史）", value: it.active !== false } : null,
        { k: "note", l: "備註／規格", type: "textarea", value: it.note }
      ].filter(Boolean),
      onChange: function (t, ov) {
        if (t.getAttribute("data-f") !== "metal") return;
        var h = ov.querySelector('[data-hint="metal"]'); if (h) h.textContent = metalHint(t.value);
        var c = ov.querySelector('[data-f="std_cost"]'); if (c && !c.value && S.metal[t.value]) c.value = Math.round(S.metal[t.value] * 100) / 100;
      },
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("確定刪除料號 " + it.sku + "？（已有異動的料號不能刪，請改停用）")) act("item.delete", { id: it.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = it.id; return act("item.save", v); }
    });
  }
  function adjustForm(it) {
    form({
      title: "盤點調整 " + it.sku + " " + it.name,
      intro: "帳面現有 <b>" + num(it.on_hand) + " " + esc(it.unit) + "</b>。輸入實盤數量，系統自動算差異；盤虧依先進先出扣成本，盤盈以標準成本（或你填的成本）入帳。",
      fields: [
        { k: "actual", l: "實盤數量", type: "num", req: 1, value: it.on_hand },
        { k: "unit_cost", l: "盤盈單位成本（留空＝標準成本 " + it.std_cost + "）", type: "num" },
        { k: "note", l: "原因", req: 1, value: "月底盤點" }
      ],
      submit: function (v) {
        var d = Math.round((Number(v.actual) - it.on_hand) * 1000) / 1000;
        if (!d) { alert("實盤與帳面相同，不需調整。"); return true; }
        return act("stock.adjust", { item_id: it.id, qty: d, unit_cost: v.unit_cost, note: v.note });
      }
    });
  }
  function lotsView(it) {
    var lots = E.itemLots(W(), it.id);
    info("成本批次（先進先出順序）· " + esc(it.sku + " " + it.name), lots.length ? table([
      { l: "順序", v: function (l, i) { return lots.indexOf(l) + 1; } }, { l: "日期", v: "date" }, { l: "來源", v: "src" }, { l: "單據", v: "ref" },
      { l: "剩餘", r: 1, v: function (l) { return num(l.qty); } }, { l: "單位成本", r: 1, v: function (l) { return nt(l.unit_cost); } },
      { l: "價值", r: 1, v: function (l) { return nt(l.qty * l.unit_cost); } }
    ], lots) + '<div class="erp-muted" style="margin-top:8px">出貨或領料會先扣最上面（最早）的批次。</div>' : '<div class="dbempty">目前沒有庫存。</div>');
  }

  // ---------- 進貨 ----------
  function receiveForm(preItem) {
    if (!needItems()) return;
    var sup = {}; W().receipts.forEach(function (r) { sup[r.supplier] = 1; });
    form({
      title: "新增進貨單", wide: true,
      datalist: '<datalist id="erpSup">' + Object.keys(sup).map(function (s) { return '<option value="' + esc(s) + '">'; }).join("") + "</datalist>",
      fields: [
        { k: "supplier", l: "供應商", req: 1, list: "erpSup" },
        { k: "date", l: "進貨日", type: "date", value: today() },
        { k: "lines", l: "品項", type: "lines", value: preItem ? [{ item_id: preItem.id, unit_cost: preItem.std_cost }] : [], cols: [
          { k: "item_id", l: "料號", type: "select", opts: itemOpts(), wide: 1 },
          { k: "qty", l: "數量", type: "num" },
          { k: "unit_cost", l: "實際單價", type: "num", fill: "std_cost" }
        ] },
        { k: "note", l: "備註", type: "textarea" }
      ],
      ok: "入庫",
      submit: function (v) { return act("stock.receive", v); }
    });
  }

  // ---------- 客戶／商機 ----------
  function custForm(c) {
    var editing = !!c; c = c || {};
    form({
      title: editing ? "編輯客戶" : "新增客戶",
      fields: [
        { k: "name", l: "客戶名稱", req: 1, value: c.name }, { k: "tax_id", l: "統一編號", value: c.tax_id },
        { k: "contact", l: "聯絡人", value: c.contact }, { k: "phone", l: "電話", value: c.phone }, { k: "email", l: "Email", value: c.email },
        { k: "address", l: "地址", value: c.address }, { k: "source", l: "來源", value: c.source, ph: "例：客戶開發雷達、展覽、介紹" },
        { k: "note", l: "備註", type: "textarea", value: c.note }
      ],
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("確定刪除客戶 " + c.name + "？")) act("customer.delete", { id: c.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = c.id; return act("customer.save", v); }
    });
  }
  function dealForm(d, custId) {
    if (!needCustomers()) return;
    var editing = !!d; d = d || { customer_id: custId || "", stage: "新開發" };
    form({
      title: editing ? "編輯商機" : "新增商機",
      fields: [
        { k: "customer_id", l: "客戶", type: "select", opts: custOpts(), value: d.customer_id, req: 1 },
        { k: "name", l: "商機名稱", req: 1, value: d.name, ph: "例：精密支架年度採購" },
        { k: "amount", l: "預估金額", type: "num", value: d.amount },
        { k: "stage", l: "階段", type: "select", opts: E.STAGES.map(function (s) { return [s, s]; }), value: d.stage },
        { k: "lost_reason", l: "失單原因（階段選失單時必填）", value: d.lost_reason },
        { k: "next_date", l: "下次跟進日", type: "date", value: d.next_date },
        { k: "note", l: "備註", type: "textarea", value: d.note }
      ],
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("確定刪除商機？")) act("deal.delete", { id: d.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) { v.id = d.id; } return act("deal.save", v); }
    });
  }
  function dealView(d) {
    var fu = (d.followups || []).slice().reverse().map(function (f) { return "<li><b>" + esc(f.date) + "</b> " + esc(f.note) + ' <span class="erp-muted">' + esc(f.by) + "</span></li>"; }).join("");
    var qs = W().quotes.filter(function (q) { return q.deal_id === d.id; }).map(function (q) { return mini("quote-view", ic("file") + esc(q.no) + " " + esc(q.status), q.id); }).join(" ");
    form({
      title: d.name, wide: true,
      intro: "客戶：<b>" + esc(custName(d.customer_id)) + "</b>　階段：" + chip(d.stage) + "　預估：" + nt(d.amount)
        + (d.next_date ? "　下次跟進：" + esc(d.next_date) : "") + (d.lost_reason ? "<br>失單原因：" + esc(d.lost_reason) : "")
        + (qs ? '<div style="margin-top:6px">報價：' + qs + "</div>" : ""),
      fields: [
        { type: "html", html: fu ? '<ul class="erp-list">' + fu + "</ul>" : '<div class="erp-muted">還沒有跟進紀錄</div>' },
        { k: "note", l: "新增跟進紀錄", type: "textarea", ph: "例：電話聯繫，客戶要 316 不鏽鋼樣品" },
        { k: "next_date", l: "下次跟進日", type: "date", value: d.next_date }
      ],
      extra: [
        { l: ic("edit") + "編輯", fn: function (close) { close(); dealForm(d); } },
        { l: ic("file") + "開報價", fn: function (close) { close(); quoteForm(null, d.customer_id, d.id); } }
      ],
      ok: "記錄跟進",
      submit: function (v) { return act("deal.followup", { id: d.id, note: v.note, next_date: v.next_date }); }
    });
  }

  // ---------- 報價 ----------
  function quoteForm(q, custId, dealId) {
    if (!needCustomers() || !needItems()) return;
    var editing = !!q; q = q || { customer_id: custId || "", deal_id: dealId || "", date: today(), valid_until: plusDays(14) };
    var deals = [["", "— 不連結商機 —"]].concat(W().deals.filter(function (d) { return d.stage !== "失單"; }).map(function (d) { return [d.id, d.name + "（" + custName(d.customer_id) + "）"]; }));
    var calc = lsGet("db_quotes", [])[0];
    form({
      title: editing ? "編輯報價單 " + q.no : "新增報價單", wide: true,
      intro: calc ? ic("info") + "最近一筆報價試算：" + esc(calc.material) + " " + esc(calc.weight) + "kg → 建議報價 <b>" + nt(calc.quote) + "</b>（可填入單價）" : "",
      fields: [
        { k: "customer_id", l: "客戶", type: "select", opts: custOpts(), value: q.customer_id, req: 1 },
        { k: "deal_id", l: "商機", type: "select", opts: deals, value: q.deal_id },
        { k: "date", l: "報價日", type: "date", value: q.date },
        { k: "valid_until", l: "有效至", type: "date", value: q.valid_until },
        { k: "lines", l: "品項", type: "lines", value: q.lines, cols: [
          { k: "item_id", l: "料號", type: "select", opts: itemOpts(), wide: 1 },
          { k: "qty", l: "數量", type: "num" }, { k: "price", l: "單價", type: "num", fill: "price" }
        ] },
        { k: "note", l: "備註（交期、付款條件…）", type: "textarea", value: q.note }
      ],
      ok: "儲存草稿",
      submit: function (v) { if (editing) v.id = q.id; return act("quote.save", v); }
    });
  }
  function docLines(lines, withCost) {
    return table([
      { l: "#", v: "line" }, { l: "料號", v: "sku" }, { l: "品名", v: "name" },
      { l: "數量", r: 1, v: function (l) { return num(l.qty); } }, { l: "單價", r: 1, v: function (l) { return nt(l.price); } },
      { l: "小計", r: 1, v: function (l) { return nt(l.qty * l.price); } }
    ].concat(withCost || []), lines);
  }
  function quoteView(q) {
    var extra = [{ l: ic("printer") + "列印／存 PDF", fn: function () { printQuote(q); } }];
    if (q.status === "草稿") extra.push({ l: ic("arrow") + "發出", fn: function (close) { close(); doIssue(q); } });
    if (q.status === "已發出") extra.push({ l: ic("check") + "客戶接受", fn: function (close) { close(); acceptForm(q); } });
    info(ic("file") + "報價單 " + esc(q.no) + " " + chip(q.status, QTONE[q.status]),
      "<p>客戶：<b>" + esc(custName(q.customer_id)) + "</b>　報價日：" + esc(q.date) + "　有效至：" + esc(q.valid_until || "—") + "</p>"
      + docLines(q.lines) + '<p class="erp-total">合計 ' + nt(q.total) + "</p>" + (q.note ? "<p>" + esc(q.note) + "</p>" : ""), extra);
  }
  function doIssue(q) {
    if (confirm("發出後報價內容會鎖定（要改請開新版，舊版自動作廢）。確定發出 " + q.no + "？")) act("quote.issue", { id: q.id });
  }
  function acceptForm(q) {
    form({
      title: "客戶接受報價 " + q.no, intro: "會自動建立銷售訂單（" + nt(q.total) + "），並預留庫存；庫存不足的會在總覽列為缺料。",
      fields: [{ k: "due", l: "交期", type: "date", value: plusDays(14) }],
      ok: "轉成訂單",
      submit: function (v) { return act("quote.accept", { id: q.id, due: v.due }).then(function (soId) { if (soId) { S.tab = "orders"; render(); } return soId; }); }
    });
  }

  // ---------- 銷售訂單 ----------
  function orderForm(custId) {
    if (!needCustomers() || !needItems()) return;
    form({
      title: "新增銷售訂單", wide: true,
      intro: "建單後會預留庫存。庫存不夠也可以先接單，系統會在總覽列出缺料，提醒你進貨或開工單。",
      fields: [
        { k: "customer_id", l: "客戶", type: "select", opts: custOpts(), value: custId || "", req: 1 },
        { k: "date", l: "下單日", type: "date", value: today() },
        { k: "due", l: "交期", type: "date", value: plusDays(14) },
        { k: "lines", l: "品項", type: "lines", cols: [
          { k: "item_id", l: "料號", type: "select", opts: itemOpts(), wide: 1 },
          { k: "qty", l: "數量", type: "num" }, { k: "price", l: "單價", type: "num", fill: "price" }
        ] },
        { k: "note", l: "備註", type: "textarea" }
      ],
      ok: "建立訂單",
      submit: function (v) { return act("order.create", v); }
    });
  }
  function shipForm(o) {
    var rest = o.lines.filter(function (l) { return l.shipped < l.qty; });
    form({
      title: "出貨 " + o.no + "（" + custName(o.customer_id) + "）",
      intro: "預設帶入「未出數量」與「現有庫存」較小者；可分批出貨。出貨會依先進先出扣庫存並算出成本。",
      fields: rest.map(function (l) {
        var it = itemOf(l.item_id), left = Math.round((l.qty - l.shipped) * 1000) / 1000;
        return { k: "L" + l.line, l: l.sku + " " + l.name + "　未出 " + num(left) + "／現有 " + num(it ? it.on_hand : 0), type: "num", value: Math.max(0, Math.min(left, it ? it.on_hand : 0)) };
      }).concat([{ k: "date", l: "出貨日", type: "date", value: today() }]),
      extra: [{ l: ic("printer") + "出貨單", fn: function (close, collect) { printDelivery(o, collect()); } }],
      ok: "確認出貨",
      submit: function (v) {
        var lines = rest.map(function (l) { return { line: l.line, qty: Number(v["L" + l.line]) || 0 }; }).filter(function (x) { return x.qty > 0; });
        if (!lines.length) { alert("請至少填一個出貨數量。"); return false; }
        return act("order.ship", { id: o.id, lines: lines, date: v.date });
      }
    });
  }
  function payForm(o) {
    var due = Math.round((o.total - o.paid + o.refunded) * 100) / 100;
    form({
      title: "收款 " + o.no, intro: "訂單 " + nt(o.total) + "，已收 " + nt(o.paid - o.refunded) + "，尚可收 <b>" + nt(due) + "</b>",
      fields: [{ k: "amount", l: "收款金額", type: "num", value: due, req: 1 }, { k: "date", l: "收款日", type: "date", value: today() }, { k: "note", l: "備註", ph: "例：匯款末五碼、支票號碼" }],
      ok: "記錄收款",
      submit: function (v) { return act("order.pay", { id: o.id, amount: v.amount, date: v.date, note: v.note }); }
    });
  }
  function returnForm(o) {
    var can = o.lines.filter(function (l) { return l.shipped > l.returned; });
    if (!can.length) { alert("這張訂單沒有可退貨的品項。"); return; }
    form({
      title: "退貨 " + o.no, intro: "退回的庫存會用「當初出貨的成本」還原。要退錢請另外按「退款」。",
      fields: can.map(function (l) { return { k: "L" + l.line, l: l.sku + " " + l.name + "　可退 " + num(l.shipped - l.returned), type: "num", value: 0 }; })
        .concat([{ k: "note", l: "退貨原因", req: 1 }]),
      ok: "確認退貨",
      submit: function (v) {
        var lines = can.map(function (l) { return { line: l.line, qty: Number(v["L" + l.line]) || 0 }; }).filter(function (x) { return x.qty > 0; });
        if (!lines.length) { alert("請填退貨數量。"); return false; }
        return act("order.return", { id: o.id, lines: lines, note: v.note });
      }
    });
  }
  function orderView(o) {
    if (!o) return;
    var st = E.orderState(o), cost = 0, rev = 0;
    o.lines.forEach(function (l) {
      rev += (l.shipped - l.returned) * l.price;
      (l.cost_layers || []).forEach(function (ly) { cost += (ly.qty - ly.returned) * ly.unit_cost; });
    });
    var pays = (o.payments || []).map(function (p) { return "<li>" + esc(p.date) + "　" + nt(p.amount) + "　" + esc(p.note) + ' <span class="erp-muted">' + esc(p.by) + "</span></li>"; }).join("");
    var extra = [{ l: ic("printer") + "出貨單", fn: function () { printDelivery(o); } }];
    if (!o.cancelled) {
      if (st === "未出貨" || st === "部分出貨") extra.push({ l: ic("truck") + "出貨", fn: function (close) { close(); shipForm(o); } });
      if (o.lines.some(function (l) { return l.shipped > l.returned; })) extra.push({ l: ic("undo") + "退貨", fn: function (close) { close(); returnForm(o); } });
      if (o.paid - o.refunded > 0) extra.push({ l: ic("cash") + "退款", fn: function (close) {
        var a = prompt("退款金額（已收 " + (o.paid - o.refunded) + "）", ""); if (a) act("order.refund", { id: o.id, amount: a }).then(function (r) { if (r) close(); });
      } });
      extra.push({ l: ic("calendar") + "改交期", fn: function (close) { var d = prompt("新交期（YYYY-MM-DD）", o.due || today()); if (d) act("order.update", { id: o.id, due: d }).then(function (r) { if (r) close(); }); } });
      if (st === "未出貨") extra.push({ l: ic("x") + "取消訂單", cls: "erp-danger", fn: function (close) { if (confirm("確定取消 " + o.no + "？會釋放預留庫存。")) act("order.cancel", { id: o.id }).then(function (r) { if (r) close(); }); } });
    }
    info(ic("cart") + "銷售訂單 " + esc(o.no) + " " + chip(st, stTone(st)) + (o.cancelled ? "" : " " + chip(E.payState(o), payTone(E.payState(o)))),
      "<p>客戶：<b>" + esc(custName(o.customer_id)) + "</b>　下單：" + esc(o.date) + "　交期：" + esc(o.due || "—") + (o.quote_id ? "　來自報價" : "") + "</p>"
      + docLines(o.lines, [
        { l: "已出", r: 1, v: function (l) { return num(l.shipped); } },
        { l: "已退", r: 1, v: function (l) { return l.returned ? num(l.returned) : ""; } }
      ])
      + '<div class="erp-sum"><span>訂單 <b>' + nt(o.total) + "</b></span><span>已出貨營收 <b>" + nt(rev) + "</b></span><span>出貨成本 <b>" + nt(cost) + "</b></span>"
      + "<span>毛利 <b>" + nt(rev - cost) + "</b>" + (rev ? "（" + Math.round((rev - cost) / rev * 1000) / 10 + "%）" : "") + "</span><span>已收 <b>" + nt(o.paid - o.refunded) + "</b></span></div>"
      + (pays ? "<h4>收款紀錄</h4><ul class=\"erp-list\">" + pays + "</ul>" : "") + (o.note ? "<p>" + esc(o.note) + "</p>" : ""), extra);
  }

  // ---------- BOM／工單 ----------
  function bomForm(itemId) {
    if (!needItems()) return;
    var cur = itemId ? E.activeBom(W(), itemId) : null;
    form({
      title: cur ? "BOM 改版（目前 v" + cur.revision + "）" : "新增 BOM", wide: true,
      intro: "定義做 <b>1 單位</b>成品要用多少料（kg 可填小數）。儲存後產生新版本；已開的工單仍用開單當時的版本。",
      fields: [
        { k: "item_id", l: "成品／半成品", type: "select", opts: itemOpts(function (i) { return i.kind === "成品" || i.kind === "半成品"; }), value: itemId || "", req: 1 },
        { k: "components", l: "用料", type: "lines", value: cur ? cur.components : [], cols: [
          { k: "item_id", l: "用料料號", type: "select", opts: itemOpts(), wide: 1 }, { k: "qty", l: "每單位用量", type: "num" }
        ] },
        { k: "note", l: "備註（製程、損耗率…）", type: "textarea", value: cur ? cur.note : "" }
      ],
      submit: function (v) { return act("bom.save", v); }
    });
  }
  function woForm(itemId, qty) {
    var withBom = W().items.filter(function (i) { return E.activeBom(W(), i.id); });
    if (!withBom.length) { alert("請先建立 BOM（BOM／工單 → ＋ 新增 BOM）。"); S.tab = "mfg"; render(); return; }
    form({
      title: "新增工單",
      fields: [
        { k: "item_id", l: "生產品項", type: "select", opts: [["", "— 選擇 —"]].concat(withBom.map(function (i) { return [i.id, i.sku + " · " + i.name]; })), value: itemId || "", req: 1 },
        { k: "qty", l: "生產數量", type: "num", value: qty || "", req: 1 },
        { k: "due", l: "預計完工", type: "date", value: plusDays(7) },
        { k: "note", l: "備註", type: "textarea" }
      ],
      ok: "建立工單",
      submit: function (v) { return act("wo.create", v); }
    });
  }
  function woView(o) {
    var rows = o.bom.components.map(function (c) {
      var ci = itemOf(c.item_id), need = c.qty * o.qty;
      return { name: (ci ? ci.sku + " " : "") + c.name, per: c.qty, need: need, have: ci ? ci.on_hand : 0, unit: ci ? ci.unit : "" };
    });
    info(ic("factory") + "工單 " + esc(o.no) + " " + chip(o.status, WTONE[o.status]),
      "<p>" + esc(o.bom.sku + " " + o.bom.name) + "（BOM v" + o.bom.revision + "）× <b>" + num(o.qty) + "</b>　交期 " + esc(o.due || "—") + "</p>"
      + table([{ l: "用料", v: "name" }, { l: "每單位", r: 1, v: function (r) { return num(r.per); } },
        { l: "共需", r: 1, v: function (r) { return num(r.need) + " " + esc(r.unit); } },
        { l: "現有", r: 1, v: function (r) { return '<span class="' + (r.have < r.need && o.status !== "完工" ? "erp-bad" : "") + '">' + num(r.have) + "</span>"; } }], rows)
      + (o.status === "完工" ? '<div class="erp-sum"><span>用料成本 <b>' + nt(o.actual_cost - o.extra_cost) + "</b></span><span>加工費 <b>" + nt(o.extra_cost) + "</b></span><span>總成本 <b>" + nt(o.actual_cost) + "</b></span><span>單位成本 <b>" + nt(o.actual_cost / o.qty) + "</b></span></div>" : ""));
  }
  function completeForm(o) {
    form({
      title: "完工入庫 " + o.no, intro: "用料依先進先出扣庫存，成本（＋加工／人工費）轉入成品 " + esc(o.bom.name) + " × " + num(o.qty) + "。",
      fields: [{ k: "extra_cost", l: "加工／人工／外包費用（整張工單合計，可 0）", type: "num", value: 0 }],
      ok: "完工入庫",
      submit: function (v) { return act("wo.complete", { id: o.id, extra_cost: v.extra_cost }); }
    });
  }

  // ---------- 列印（報價單／出貨單；瀏覽器列印可另存 PDF） ----------
  function printDoc(title, inner) {
    var win = window.open("", "_blank");
    if (!win) { alert("瀏覽器擋住了彈出視窗，請允許後再試。"); return; }
    win.document.write('<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>"
      + "body{font-family:'Noto Sans TC','Microsoft JhengHei',sans-serif;color:#111;margin:32px}h1{font-size:22px;margin:0}h2{font-size:16px;color:#444;margin:4px 0 18px}"
      + "table{width:100%;border-collapse:collapse;margin:14px 0}th,td{border:1px solid #999;padding:6px 8px;font-size:13px;text-align:left}td.r,th.r{text-align:right}"
      + ".meta{display:flex;justify-content:space-between;font-size:14px}.tot{text-align:right;font-size:16px;font-weight:700}.sign{display:flex;justify-content:space-between;margin-top:48px}"
      + "@media print{button{display:none}}</style></head><body>" + inner
      + '<p><button onclick="window.print()">列印 / 另存 PDF</button></p></body></html>');
    win.document.close();
  }
  function plainLines(rows) {
    return "<table><tr><th>#</th><th>料號</th><th>品名</th><th class=r>數量</th><th class=r>單價</th><th class=r>小計</th></tr>"
      + rows.map(function (l, i) { return "<tr><td>" + (i + 1) + "</td><td>" + esc(l.sku) + "</td><td>" + esc(l.name) + "</td><td class=r>" + num(l.qty) + "</td><td class=r>" + nt(l.price) + "</td><td class=r>" + nt(l.qty * l.price) + "</td></tr>"; }).join("") + "</table>";
  }
  function custBlock(id) {
    var c = byId("customers", id) || {};
    return "<div><b>客戶：</b>" + esc(c.name) + (c.tax_id ? "（統編 " + esc(c.tax_id) + "）" : "") + "<br>" + esc(c.contact || "") + " " + esc(c.phone || "") + "<br>" + esc(c.address || "") + "</div>";
  }
  function printQuote(q) {
    printDoc(q.no, "<h1>九上科技　報價單</h1><h2>" + esc(q.no) + "</h2><div class=meta>" + custBlock(q.customer_id)
      + "<div>報價日：" + esc(q.date) + "<br>有效至：" + esc(q.valid_until || "—") + "</div></div>" + plainLines(q.lines)
      + '<p class="tot">合計（未稅）' + nt(q.total) + "</p>" + (q.note ? "<p>備註：" + esc(q.note) + "</p>" : "") + '<div class="sign"><span>報價人：</span><span>客戶確認：</span></div>');
  }
  function printDelivery(o, v) {
    var rows = o.lines.map(function (l) { var n = v && v["L" + l.line] !== undefined ? Number(v["L" + l.line]) || 0 : l.shipped; return { sku: l.sku, name: l.name, qty: n, price: l.price }; }).filter(function (r) { return r.qty > 0; });
    printDoc(o.no + " 出貨單", "<h1>九上科技　出貨單</h1><h2>" + esc(o.no) + "</h2><div class=meta>" + custBlock(o.customer_id)
      + "<div>出貨日：" + esc((v && v.date) || today()) + "<br>交期：" + esc(o.due || "—") + "</div></div>" + plainLines(rows)
      + '<div class="sign"><span>出貨人：</span><span>收貨簽收：</span></div>');
  }

  // ---------- CSV ----------
  function csv(name, head, rows) {
    var cell = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    download(name + "_" + today() + ".csv", "﻿" + [head.map(cell).join(",")].concat(rows.map(function (r) { return r.map(cell).join(","); })).join("\r\n"), "text/csv;charset=utf-8");
  }

  // ---------- 示範資料（只在本機試用） ----------
  function demo() {
    var w = E.empty(), c = { by: "示範", today: today(), now: new Date().toISOString() };
    function a(x, p) { return E.apply(w, x, p, c).result; }
    var cu = a("item.save", { sku: "RM-CU-C3604", name: "黃銅棒 C3604 Ø12", kind: "原料", unit: "kg", metal: "copper", std_cost: S.metal.copper ? Math.round(S.metal.copper) : 420 });
    var al = a("item.save", { sku: "RM-AL-6061", name: "鋁板 6061 T6 10mm", kind: "原料", unit: "kg", metal: "aluminum", std_cost: S.metal.aluminum ? Math.round(S.metal.aluminum) : 120, safety: 50 });
    var sc = a("item.save", { sku: "PT-SCR-M4", name: "不鏽鋼螺絲 M4×10", kind: "耗材", unit: "支", std_cost: 1.2 });
    var fg1 = a("item.save", { sku: "FG-JNT-001", name: "銅接頭（客製）", kind: "成品", unit: "件", price: 180 });
    var fg2 = a("item.save", { sku: "FG-BRK-002", name: "鋁合金支架", kind: "成品", unit: "件", price: 650, safety: 20 });
    a("stock.receive", { supplier: "中部金屬材料行", lines: [{ item_id: cu, qty: 80, unit_cost: "" }, { item_id: al, qty: 60, unit_cost: "" }, { item_id: sc, qty: 2000, unit_cost: 1.2 }] });
    a("bom.save", { item_id: fg1, components: [{ item_id: cu, qty: 0.18 }] });
    a("bom.save", { item_id: fg2, components: [{ item_id: al, qty: 1.6 }, { item_id: sc, qty: 4 }] });
    var wo = a("wo.create", { item_id: fg2, qty: 30 }); a("wo.reserve", { id: wo }); a("wo.start", { id: wo }); a("wo.complete", { id: wo, extra_cost: 4500 });
    var c1 = a("customer.save", { name: "大雅精密股份有限公司", tax_id: "12345678", contact: "王經理", phone: "04-2560-0000", source: "客戶開發雷達" });
    var c2 = a("customer.save", { name: "神岡自動化設備", contact: "林小姐", source: "展覽" });
    var d1 = a("deal.save", { customer_id: c2, name: "銅接頭年度採購", amount: 360000, next_date: plusDays(3) });
    var q = a("quote.save", { customer_id: c2, deal_id: d1, valid_until: plusDays(14), lines: [{ item_id: fg1, qty: 2000, price: 175 }] }); a("quote.issue", { id: q });
    var so = a("order.create", { customer_id: c1, due: plusDays(10), lines: [{ item_id: fg2, qty: 25, price: 650 }] });
    a("order.ship", { id: so, lines: [{ line: 1, qty: 20 }] }); a("order.pay", { id: so, amount: 8000, note: "訂金" });
    a("deal.save", { customer_id: c1, name: "支架追加訂單", amount: 120000, stage: "已聯繫" });
    S.world = w; saveLocal(); render();
  }

  // ===========================================================================
  // 事件（事件委派：整頁只綁一次）
  // ===========================================================================
  var H = {
    "tab": function (id) { S.tab = id; render(); },
    "reload": function () { load(); },
    "backup": function () { download("九上ERP備份_" + (S.mode === "cloud" ? "公司" : "本機") + "_" + today() + ".json", JSON.stringify(W(), null, 1)); },
    "health": function () {
      var errs = E.check(W());
      alert(errs.length ? "發現 " + errs.length + " 個不一致（多半是有人直接改了試算表）：\n\n" + errs.join("\n") : "資料一致：每個料號的帳面數量都等於成本批次加總。");
    },
    "reset-local": function () { if (confirm("清空這個瀏覽器裡的 ERP 試用資料？（不影響公司試算表）")) { S.world = E.empty(); saveLocal(); render(); } },
    "demo": demo,
    "item-new": function () { itemForm(null); },
    "item-edit": function (id) { itemForm(itemOf(id)); },
    "item-adjust": function (id) { adjustForm(itemOf(id)); },
    "item-lots": function (id) { lotsView(itemOf(id)); },
    "receive-new": function () { receiveForm(null); },
    "receive-for": function (id) { receiveForm(itemOf(id)); },
    "receive-view": function (id) {
      var r = byId("receipts", id);
      info(ic("truck") + "進貨單 " + esc(r.no), "<p>供應商：<b>" + esc(r.supplier) + "</b>　日期：" + esc(r.date) + "</p>" + table([
        { l: "料號", v: "sku" }, { l: "品名", v: "name" }, { l: "數量", r: 1, v: function (l) { return num(l.qty); } },
        { l: "單價", r: 1, v: function (l) { return nt(l.unit_cost); } }, { l: "小計", r: 1, v: function (l) { return nt(l.qty * l.unit_cost); } }
      ], r.lines) + '<p class="erp-total">合計 ' + nt(r.total) + "</p>" + (r.note ? "<p>" + esc(r.note) + "</p>" : ""));
    },
    "cust-new": function () { custForm(null); },
    "cust-edit": function (id) { custForm(byId("customers", id)); },
    "deal-new": function () { dealForm(null); },
    "deal-new-for": function (id) { dealForm(null, id); },
    "deal-view": function (id) { dealView(byId("deals", id)); },
    "quote-new": function () { quoteForm(null); },
    "quote-new-for": function (id) { quoteForm(null, id); },
    "quote-edit": function (id) { quoteForm(byId("quotes", id)); },
    "quote-view": function (id) { quoteView(byId("quotes", id)); },
    "quote-issue": function (id) { doIssue(byId("quotes", id)); },
    "quote-accept": function (id) { acceptForm(byId("quotes", id)); },
    "quote-del": function (id) { if (confirm("刪除這張報價草稿？")) act("quote.delete", { id: id }); },
    "quote-print": function (id) { printQuote(byId("quotes", id)); },
    "order-new": function () { orderForm(null); },
    "order-view": function (id) { orderView(byId("orders", id)); },
    "order-ship": function (id) { shipForm(byId("orders", id)); },
    "order-pay": function (id) { payForm(byId("orders", id)); },
    "bom-new": function () { bomForm(null); },
    "bom-edit": function (id) { bomForm(id); },
    "wo-new": function () { woForm(null); },
    "wo-new-for": function (id) {
      var short = E.report(W(), today()).shortage.filter(function (s) { return s.id === id; })[0];
      woForm(id, short ? Math.ceil(short.short) : "");
    },
    "wo-view": function (id) { woView(byId("workorders", id)); },
    "wo-reserve": function (id) { act("wo.reserve", { id: id }); },
    "wo-start": function (id) { act("wo.start", { id: id }); },
    "wo-complete": function (id) { completeForm(byId("workorders", id)); },
    "wo-cancel": function (id) { if (confirm("取消這張工單？已預留的用料會釋放。")) act("wo.cancel", { id: id }); },
    "csv-items": function () {
      csv("料號庫存", ["料號", "品名", "類別", "單位", "現有", "預留", "可用", "平均成本", "庫存價值", "售價", "安全庫存"], W().items.map(function (i) {
        return [i.sku, i.name, i.kind, i.unit, i.on_hand, i.reserved, i.on_hand - i.reserved, Math.round(avgCost(i) * 100) / 100, E.stockValue(W(), i.id), i.price, i.safety];
      }));
    },
    "csv-orders": function () {
      csv("銷售訂單", ["單號", "日期", "客戶", "交期", "金額", "已收", "出貨狀態", "收款狀態", "品項"], W().orders.map(function (o) {
        return [o.no, o.date, custName(o.customer_id), o.due, o.total, o.paid - o.refunded, E.orderState(o), o.cancelled ? "" : E.payState(o), o.lines.map(function (l) { return l.name + "×" + l.qty; }).join("、")];
      }));
    },
    "csv-customers": function () { csv("客戶", ["名稱", "統編", "聯絡人", "電話", "Email", "地址", "來源", "備註"], W().customers.map(function (c) { return [c.name, c.tax_id, c.contact, c.phone, c.email, c.address, c.source, c.note]; })); },
    "csv-moves": function () {
      csv("庫存異動", ["日期", "料號", "品名", "類別", "數量", "成本金額", "單據", "備註", "經手人"], W().moves.map(function (m) {
        var it = itemOf(m.item_id) || {}; return [m.date, it.sku, it.name, m.type, m.qty, m.value, m.ref, m.note, m.by];
      }));
    }
  };

  function init() {
    mount = document.getElementById("erpView");
    if (!mount || !E) return;
    mount.addEventListener("click", function (e) {
      var t = e.target.closest("[data-a],[data-tab]");
      if (!t || !mount.contains(t)) return;
      if (t.hasAttribute("data-tab")) return H.tab(t.getAttribute("data-tab"));
      var fn = H[t.getAttribute("data-a")];
      if (fn) fn(t.getAttribute("data-id"));
    });
    mount.addEventListener("input", function (e) {
      if (!e.target.classList.contains("erp-search")) return;
      var q = e.target.value.trim().toLowerCase(), wrap = e.target.closest(".erp-sec") || mount;
      Array.prototype.forEach.call(wrap.querySelectorAll("tbody tr[data-s]"), function (tr) { tr.style.display = !q || tr.getAttribute("data-s").indexOf(q) >= 0 ? "" : "none"; });
    });
    // 原料行情（每天兩次由 GitHub Actions 更新）：銅/鋁 NT$/噸 → /kg
    fetch("signals.json?v=" + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      (d.metals || []).forEach(function (m) { if (m.price_twd) S.metal[m.key] = Math.round(m.price_twd / 10) / 100; });
      S.metal.updated = d.updated || "";
      if (S.tab === "home") render();
    }).catch(function () {});
    load();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
