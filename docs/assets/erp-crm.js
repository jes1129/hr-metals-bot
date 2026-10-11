/*
 * erp-crm.js — ERP 頁的擴充畫面：角色總覽、上手任務、釘選、客戶 360（多位聯絡人）、客服案件、服務交付、專案
 * 規則都在 erp-engine.js；這裡只負責畫面與表單，透過 window.__erpUI 掛進 erp.js。
 */
(function () {
  "use strict";
  var U = window.__erpUI;
  if (!U) return;
  var E = U.E, ic = U.ic, esc = U.esc, nt = U.nt, chip = U.chip, btn = U.btn, mini = U.mini, table = U.table, section = U.section, kpi = U.kpi;
  var ROLE_KEY = "erp_role", ONB_KEY = "erp_onboard_hide";

  U.addTab("erp", "cases", ic("chat") + "客服案件", "crm");
  U.addTab("erp", "service", ic("check") + "服務交付", "cases");
  U.addTab("erp", "project", ic("list") + "專案", "service");

  function W() { return U.W(); }
  function today() { return U.today(); }
  function opts(list) { return list.map(function (x) { return [x, x]; }); }
  function contactsOf(cid) { return W().contacts.filter(function (x) { return x.customer_id === cid; }); }
  function primaryContact(cid) { var cs = contactsOf(cid); return cs.filter(function (x) { return x.primary; })[0] || cs[0] || null; }
  function caseTone(s) { return { "開啟": "warn", "處理中": "info", "待客戶回覆": "info", "已解決": "ok", "已關閉": "muted" }[s]; }
  function svcTone(s) { return { "草稿": "muted", "已確認": "info", "已交付": "warn", "要求修改": "warn", "已驗收": "ok", "部分收款": "info", "已收款": "ok" }[s]; }
  function prTone(p) { return { "高": "warn", "中": "info", "低": "muted" }[p]; }
  function dueCell(d, done) { return d && !done && d < today() ? '<b class="erp-bad">' + esc(d) + " 逾期</b>" : esc(d); }

  // ===========================================================================
  // 總覽：角色視角 + 上手任務 + 釘選
  // ===========================================================================
  var ROLES = [["boss", "老闆"], ["sales", "業務"], ["stock", "倉管／生產"], ["office", "行政"], ["all", "全部"]];
  function role() { return U.lsGet(ROLE_KEY, "boss") || "boss"; }

  function onboarding(w) {
    var done = function (t, fn) { return (w[t] || []).some(fn || function () { return true; }); };
    var steps = [
      ["建立第一個料號（原料、成品）", done("items"), "item-new"],
      ["登錄一張進貨單（照實際進價）", done("receipts"), "receive-new"],
      ["建立客戶與聯絡人", done("contacts"), "cust-new"],
      ["發出一張報價單", done("quotes", function (q) { return q.status !== "草稿"; }), "quote-new"],
      ["建立銷售訂單", done("orders"), "order-new"],
      ["完成一次出貨", done("moves", function (m) { return m.type === "銷貨出庫"; }), "tab:orders"],
      ["記錄一筆收款", done("orders", function (o) { return o.paid > 0; }), "tab:orders"],
      ["建立 BOM 並完成一張工單", done("workorders", function (o) { return o.status === "完工"; }), "bom-new"],
      ["開一張客服案件", done("cases"), "case-new"],
      ["行政：建立單位與員工", done("staff"), "goto:admin.html#tab=org"]
    ];
    var n = steps.filter(function (s) { return s[1]; }).length;
    if (n === steps.length || U.lsGet(ONB_KEY, false)) return "";
    var pct = Math.round(n / steps.length * 100);
    return section(ic("play") + "上手任務（" + n + "／" + steps.length + "）",
      '<div class="erp-prog"><div style="width:' + pct + '%"></div></div>'
      + '<ol class="erp-onb">' + steps.map(function (s) {
        var a = s[2].indexOf("tab:") === 0 ? ' data-tab="' + s[2].slice(4) + '"' : s[2].indexOf("goto:") === 0 ? ' data-a="goto" data-id="' + s[2].slice(5) + '"' : ' data-a="' + s[2] + '"';
        return '<li class="' + (s[1] ? "done" : "") + '">' + (s[1] ? ic("check") : '<span class="erp-dot"></span>')
          + (s[1] ? "<span>" + s[0] + "</span>" : '<button class="erp-link"' + a + ">" + s[0] + "</button>") + "</li>";
      }).join("") + "</ol>"
      + (U.S.mode === "local" && !w.items.length ? '<div class="erp-row">' + btn("demo", ic("info") + "載入示範資料（只在本機）") + "</div>" : ""),
      btn("onb-hide", ic("x") + "不再顯示"));
  }

  function pinsBlock() {
    var ps = U.pinsGet();
    if (!ps.length) return "";
    return section(ic("pin") + "釘選", '<div class="erp-pins">' + ps.map(function (p) {
      return '<span class="erp-pin">' + mini("rec", esc(p.label || p.id), p.t + ":" + p.id) + mini("pin-remove", ic("x"), p.t + ":" + p.id, "取消釘選") + "</span>";
    }).join("") + "</div>");
  }

  var oldHome = U.VIEW.home;
  U.VIEW.home = function (w) {
    var r = E.report(w, today()), rl = role();
    var roleBar = '<div class="erp-roles"><span>我是：</span>' + ROLES.map(function (x) {
      return '<button class="dbtab' + (x[0] === rl ? " on" : "") + '" data-a="role" data-id="' + x[0] + '">' + x[1] + "</button>";
    }).join("") + '<span class="erp-muted">只改變總覽顯示的重點，不是權限</span></div>';
    var head = roleBar + onboarding(w) + pinsBlock();
    if (rl === "all") return head + oldHome(w) + crmSections(r);
    if (rl === "boss") return head + '<div class="okpis erp-kpis">'
      + kpi(ic("cash") + "本月銷售", nt(r.sales_month), "", "依出貨認列")
      + kpi(ic("chart") + "本月毛利", nt(r.gp_month), r.gp_month < 0 ? "warn" : "", r.gm_month == null ? "—" : "毛利率 " + r.gm_month + "%")
      + kpi(ic("file") + "應收帳款", nt(r.receivable + (r.services_unpaid || 0)), "", "含服務未收 " + nt(r.services_unpaid || 0))
      + kpi(ic("box") + "庫存價值", nt(r.inventory_value), "", "FIFO 成本")
      + kpi(ic("truck") + "未出貨訂單", r.open_orders + " 張", r.overdue_orders.length ? "warn" : "", r.overdue_orders.length ? "逾期 " + r.overdue_orders.length + " 張" : "無逾期")
      + kpi(ic("chat") + "未結案件", r.cases_open.length + " 件", r.cases_open.some(function (c) { return c.late; }) ? "warn" : "", "")
      + kpi(ic("clipboard") + "待簽核申請", (r.requests_pending || []).length + " 件", (r.requests_pending || []).length ? "warn" : "", "行政工作台")
      + kpi(ic("alert") + "缺料品項", r.shortage.length + " 項", r.shortage.length ? "warn" : "", "")
      + "</div>" + attention(r) + approvals(r);
    if (rl === "sales") return head + '<div class="okpis erp-kpis">'
      + kpi(ic("file") + "有效報價", r.quotes_open + " 張", r.quotes_expiring.length ? "warn" : "", r.quotes_expiring.length ? "7 天內到期 " + r.quotes_expiring.length + " 張" : "")
      + kpi(ic("target") + "進行中商機", w.deals.filter(function (d) { return d.stage !== "成交" && d.stage !== "失單"; }).length + " 件", "", "")
      + kpi(ic("chat") + "未結案件", r.cases_open.length + " 件", r.cases_open.some(function (c) { return c.late; }) ? "warn" : "", "")
      + kpi(ic("check") + "待客戶驗收", r.services_waiting.length + " 件", "", "服務交付")
      + "</div>" + attention(r) + crmSections(r) + followups(w);
    if (rl === "stock") return head + '<div class="okpis erp-kpis">'
      + kpi(ic("alert") + "缺料品項", r.shortage.length + " 項", r.shortage.length ? "warn" : "", "訂單/工單需要 > 現有")
      + kpi(ic("bars") + "低於安全庫存", r.low_stock.length + " 項", r.low_stock.length ? "warn" : "", "")
      + kpi(ic("factory") + "進行中工單", r.wo_active + " 張", "", "")
      + kpi(ic("truck") + "未出貨訂單", r.open_orders + " 張", r.overdue_orders.length ? "warn" : "", r.overdue_orders.length ? "逾期 " + r.overdue_orders.length + " 張" : "無逾期")
      + "</div>" + oldHome(w).split('<div class="erp-grid2">').slice(1, 2).map(function (x) { return '<div class="erp-grid2">' + x; }).join("") + toShip(w);
    // 行政
    return head + '<div class="okpis erp-kpis">'
      + kpi(ic("users") + "在職員工", (r.staff_active || 0) + " 人", "", "")
      + kpi(ic("calendar") + "今日班次", (r.shifts_today || []).length + " 班", "", "")
      + kpi(ic("clipboard") + "待簽核申請", (r.requests_pending || []).length + " 件", (r.requests_pending || []).length ? "warn" : "", "")
      + kpi(ic("wrench") + "今日設備預約", (r.reservations_today || []).length + " 筆", "", "")
      + "</div>" + section(ic("alert") + "今日出勤差異", (r.attendance_diff || []).length ? table([{ l: "員工", v: "staff" }, { l: "班次", v: "shift" }, { l: "狀況", v: function (d) { return '<b class="erp-bad">' + esc(d.issue) + "</b>"; } }], r.attendance_diff) : '<div class="dbempty">今天沒有出勤差異</div>',
        '<a class="dbbtn primary" href="admin.html">' + ic("arrow") + "到行政工作台</a>") + approvals(r);
  };
  function attention(r) {
    var items = r.overdue_orders.map(function (o) { return "<li>" + mini("order-view", ic("cart") + esc(o.no), o.id) + ' 交期 <b class="erp-bad">' + esc(o.due) + "</b></li>"; })
      .concat(r.quotes_expiring.map(function (q) { return "<li>" + mini("quote-view", ic("file") + esc(q.no), q.id) + " 報價 " + esc(q.valid_until) + " 到期</li>"; }))
      .concat(r.cases_open.filter(function (c) { return c.late || c.priority === "高"; }).map(function (c) { return "<li>" + mini("case-view", ic("chat") + esc(c.no), c.id) + " " + esc(c.title) + (c.late ? ' <b class="erp-bad">逾期</b>' : " " + chip("高", "warn")) + "</li>"; }))
      .concat(r.tasks_due.filter(function (t) { return t.late; }).map(function (t) { return "<li>" + mini("task-edit", ic("list") + esc(t.title), t.id) + ' <b class="erp-bad">' + esc(t.due) + " 逾期</b></li>"; }));
    return section(ic("clock") + "要注意的事", items.length ? '<ul class="erp-list">' + items.join("") + "</ul>" : '<div class="dbempty">沒有逾期或緊急的事</div>');
  }
  function approvals(r) {
    var q = r.requests_pending || [];
    if (!q.length) return "";
    return section(ic("clipboard") + "待簽核申請", '<ul class="erp-list">' + q.map(function (x) {
      var st = U.byId("staff", x.staff_id) || {};
      return "<li>" + mini("rec", ic("file") + esc(x.no), "requests:" + x.id) + " " + esc(st.name || "") + " " + esc(x.kind) + (x.leave_type ? "（" + esc(x.leave_type) + "）" : "") + " " + esc(x.start_date) + "</li>";
    }).join("") + "</ul>");
  }
  function crmSections(r) {
    return '<div class="erp-grid2">'
      + section(ic("chat") + "未結客服案件", r.cases_open.length ? table([
        { l: "案件", v: function (c) { return mini("case-view", esc(c.no), c.id); } }, { l: "主旨", v: "title" },
        { l: "優先", v: function (c) { return chip(c.priority, prTone(c.priority)); } }, { l: "期限", v: function (c) { return dueCell(c.due); } }], r.cases_open) : '<div class="dbempty">沒有未結案件</div>')
      + section(ic("list") + "即將到期的任務與里程碑", (r.tasks_due.length + r.milestones_soon.length) ? '<ul class="erp-list">'
        + r.tasks_due.map(function (t) { return "<li>" + mini("task-edit", ic("list") + esc(t.title), t.id) + " " + dueCell(t.due) + "</li>"; }).join("")
        + r.milestones_soon.map(function (m) { return "<li>" + mini("ms-edit", ic("target") + esc(m.title), m.id) + " " + dueCell(m.due) + "</li>"; }).join("") + "</ul>" : '<div class="dbempty">兩週內沒有到期項目</div>')
      + "</div>";
  }
  function followups(w) {
    var due = w.deals.filter(function (d) { return d.next_date && d.next_date <= U.plusDays(3) && d.stage !== "成交" && d.stage !== "失單"; });
    return section(ic("calendar") + "近期要跟進的商機", due.length ? table([
      { l: "商機", v: function (d) { return mini("deal-view", esc(d.name), d.id); } }, { l: "客戶", v: function (d) { return esc(U.custName(d.customer_id)); } },
      { l: "階段", v: "stage" }, { l: "跟進日", v: function (d) { return dueCell(d.next_date); } }], due) : '<div class="dbempty">三天內沒有要跟進的商機</div>');
  }
  function toShip(w) {
    var rows = w.orders.filter(function (o) { var s = E.orderState(o); return s === "未出貨" || s === "部分出貨"; });
    return section(ic("truck") + "待出貨訂單", rows.length ? table([
      { l: "單號", v: function (o) { return mini("order-view", esc(o.no), o.id); } }, { l: "客戶", v: function (o) { return esc(U.custName(o.customer_id)); } },
      { l: "交期", v: function (o) { return dueCell(o.due); } }, { l: "", v: function (o) { return mini("order-ship", ic("truck") + "出貨", o.id); } }], rows) : '<div class="dbempty">沒有待出貨訂單</div>');
  }

  // ===========================================================================
  // 客戶 360：基本資料、聯絡人（多位）、商機、案件、訂單、服務
  // ===========================================================================
  function custView(id) {
    var c = U.byId("customers", id); if (!c) return;
    var w = W(), cs = contactsOf(id);
    var orders = w.orders.filter(function (o) { return o.customer_id === id; });
    var cases = w.cases.filter(function (x) { return x.customer_id === id; });
    var svcs = w.services.filter(function (x) { return x.customer_id === id; });
    var deals = w.deals.filter(function (x) { return x.customer_id === id; });
    var sales = orders.reduce(function (s, o) { return o.cancelled ? s : s + E.orderNet(o); }, 0);
    U.S.curRec = { t: "customers", id: id };
    U.info(ic("users") + esc(c.name),
      '<div class="erp-sum"><span>統編 <b>' + esc(c.tax_id || "—") + "</b></span><span>累計出貨 <b>" + nt(sales) + "</b></span><span>訂單 <b>" + orders.length + "</b></span><span>案件 <b>" + cases.length + "</b></span><span>來源 <b>" + esc(c.source || "—") + "</b></span></div>"
      + (c.address ? "<p>" + ic("pin") + esc(c.address) + "</p>" : "")
      + "<h4>聯絡人</h4>" + table([
        { l: "姓名", v: function (x) { return esc(x.name) + (x.primary ? " " + chip("主要", "ok") : ""); } }, { l: "職稱", v: "title" }, { l: "電話", v: "phone" }, { l: "Email", v: "email" },
        { l: "", v: function (x) { return mini("contact-edit", ic("edit"), x.id, "編輯") + (x.email ? '<a class="dbmini" href="mailto:' + esc(x.email) + '" title="寄信">' + ic("mail") + "</a>" : ""); } }
      ], cs, { empty: "還沒有聯絡人" })
      + (deals.length ? "<h4>商機</h4><ul class=\"erp-list\">" + deals.map(function (d) { return "<li>" + mini("deal-view", esc(d.name), d.id) + " " + chip(d.stage) + " " + nt(d.amount) + "</li>"; }).join("") + "</ul>" : "")
      + (cases.length ? "<h4>客服案件</h4><ul class=\"erp-list\">" + cases.map(function (x) { return "<li>" + mini("case-view", esc(x.no), x.id) + " " + esc(x.title) + " " + chip(x.status, caseTone(x.status)) + "</li>"; }).join("") + "</ul>" : "")
      + (orders.length ? "<h4>銷售訂單</h4><ul class=\"erp-list\">" + orders.slice(-8).reverse().map(function (o) { return "<li>" + mini("order-view", esc(o.no), o.id) + " " + esc(o.date) + " " + nt(o.total) + " " + chip(E.orderState(o)) + "</li>"; }).join("") + "</ul>" : "")
      + (svcs.length ? "<h4>服務委託</h4><ul class=\"erp-list\">" + svcs.map(function (s) { return "<li>" + mini("svc-view", esc(s.no), s.id) + " " + esc(s.title) + " " + chip(s.status, svcTone(s.status)) + "</li>"; }).join("") + "</ul>" : ""),
      [{ l: ic("plus") + "新增聯絡人", fn: function (close) { close(); contactForm(null, id); } },
       { l: ic("chat") + "開客服案件", fn: function (close) { close(); caseForm(null, id); } },
       { l: ic("edit") + "編輯客戶", fn: function (close) { close(); U.H["cust-edit"](id); } }]);
  }
  U.OPEN.customers = custView;
  U.OPEN.contacts = function (id) { var x = U.byId("contacts", id); if (x) custView(x.customer_id); };

  function contactForm(x, cid) {
    var editing = !!x; x = x || { customer_id: cid };
    U.form({
      title: (editing ? "編輯聯絡人 · " : "新增聯絡人 · ") + U.custName(x.customer_id),
      fields: [
        { k: "name", l: "姓名", req: 1, value: x.name }, { k: "title", l: "職稱", value: x.title },
        { k: "phone", l: "電話", value: x.phone }, { k: "email", l: "Email", value: x.email },
        { k: "primary", l: "主要聯絡人", type: "check", text: "設為這家客戶的主要聯絡人", value: x.primary },
        { k: "note", l: "備註", type: "textarea", value: x.note }
      ],
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除聯絡人 " + x.name + "？")) U.act("contact.delete", { id: x.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { v.customer_id = x.customer_id; if (editing) v.id = x.id; return U.act("contact.save", v); }
    });
  }

  // ===========================================================================
  // 客服案件
  // ===========================================================================
  U.VIEW.cases = function (w) {
    var rows = w.cases.slice().reverse();
    return '<div class="dbtoolbar">' + U.searchBox("搜尋案件、客戶、主旨…") + btn("case-new", ic("plus") + "新增案件", null, "primary") + "</div>"
      + table([
        { l: "案件", v: function (c) { return mini("case-view", esc(c.no), c.id); } }, { l: "客戶", v: function (c) { return esc(U.custName(c.customer_id)); } },
        { l: "主旨", v: "title" }, { l: "類別", v: "kind" }, { l: "優先", v: function (c) { return chip(c.priority, prTone(c.priority)); } },
        { l: "負責人", v: "owner" }, { l: "期限", v: function (c) { return dueCell(c.due, c.status === "已解決" || c.status === "已關閉"); } },
        { l: "狀態", v: function (c) { return chip(c.status, caseTone(c.status)); } },
        { l: "", v: function (c) { return mini("case-status", ic("refresh") + "狀態", c.id) + mini("case-log", ic("edit") + "紀錄", c.id); } }
      ], rows, { empty: "還沒有客服案件。客戶詢價、客訴、技術支援都可以開案件追蹤。", search: function (c) { return c.no + " " + U.custName(c.customer_id) + " " + c.title; } });
  };
  function caseForm(c, cid) {
    if (!U.needCustomers()) return;
    var editing = !!c; c = c || { customer_id: cid || "", kind: "詢價", priority: "中" };
    var contactOpts = [["", "—"]].concat(W().contacts.map(function (x) { return [x.id, U.custName(x.customer_id) + "／" + x.name]; }));
    U.form({
      title: editing ? "編輯案件 " + c.no : "新增客服案件",
      fields: [
        { k: "customer_id", l: "客戶", type: "select", opts: U.custOpts(), value: c.customer_id, req: 1 },
        { k: "contact_id", l: "聯絡人", type: "select", opts: contactOpts, value: c.contact_id },
        { k: "title", l: "主旨", req: 1, value: c.title, ph: "例：支架毛邊、要求打樣、交期詢問" },
        { k: "kind", l: "類別", type: "select", opts: opts(E.CASE_KINDS), value: c.kind },
        { k: "priority", l: "優先度", type: "select", opts: opts(E.PRIORITIES), value: c.priority },
        { k: "owner", l: "負責人", value: c.owner }, { k: "due", l: "處理期限", type: "date", value: c.due },
        { k: "note", l: "說明", type: "textarea", value: c.note }
      ],
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除這張案件？")) U.act("case.delete", { id: c.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = c.id; return U.act("case.save", v); }
    });
  }
  function caseView(id) {
    var c = U.byId("cases", id), ct = c.contact_id ? U.byId("contacts", c.contact_id) : null;
    U.S.curRec = { t: "cases", id: id };
    U.info(ic("chat") + "客服案件 " + esc(c.no) + " " + chip(c.status, caseTone(c.status)),
      "<p><b>" + esc(c.title) + "</b></p><p>客戶：" + esc(U.custName(c.customer_id)) + (ct ? "（" + esc(ct.name) + " " + esc(ct.phone || "") + "）" : "")
      + "　類別：" + esc(c.kind) + "　優先：" + chip(c.priority, prTone(c.priority)) + "　負責：" + esc(c.owner || "—") + "　期限：" + dueCell(c.due, c.status === "已解決" || c.status === "已關閉") + "</p>"
      + (c.note ? "<p>" + esc(c.note) + "</p>" : "") + (c.resolution ? '<div class="erp-sum"><span>處理結果：<b>' + esc(c.resolution) + "</b></span></div>" : "")
      + "<h4>處理紀錄</h4><ul class=\"erp-timeline\">" + c.log.slice().reverse().map(function (l) { return "<li><b>" + esc(l.date) + "</b> " + chip(l.status, caseTone(l.status)) + " " + esc(l.note) + ' <span class="erp-muted">' + esc(l.by) + "</span></li>"; }).join("") + "</ul>",
      [{ l: ic("refresh") + "更新狀態", fn: function (close) { close(); statusForm(c); } },
       { l: ic("edit") + "加處理紀錄", fn: function (close) { close(); logForm(c); } },
       { l: ic("check") + "開服務委託", fn: function (close) { close(); serviceForm(null, c.customer_id, c.id); } },
       { l: ic("edit") + "編輯", fn: function (close) { close(); caseForm(c); } }]);
  }
  function statusForm(c) {
    U.form({ title: "更新狀態 " + c.no, intro: "目前「" + esc(c.status) + "」。改成「已解決／已關閉」要寫處理結果。",
      fields: [{ k: "status", l: "新狀態", type: "select", opts: opts(E.CASE_STATUS), value: c.status }, { k: "note", l: "說明／處理結果", type: "textarea" }],
      submit: function (v) { return U.act("case.status", { id: c.id, status: v.status, note: v.note }); } });
  }
  function logForm(c) {
    U.form({ title: "加處理紀錄 " + c.no, fields: [{ k: "note", l: "紀錄", type: "textarea", req: 1, ph: "例：已電話回覆，下週二送樣" }],
      submit: function (v) { return U.act("case.log", { id: c.id, note: v.note }); } });
  }
  U.OPEN.cases = caseView;

  // ===========================================================================
  // 服務交付（代工打樣、外包加工、技術服務）
  // ===========================================================================
  U.VIEW.service = function (w) {
    var rows = w.services.slice().reverse();
    return '<div class="dbtoolbar">' + U.searchBox("搜尋單號、客戶、項目…") + btn("svc-new", ic("plus") + "新增服務委託", null, "primary") + "</div>"
      + '<div class="dbnote erp-flow">' + ["草稿", "確認", "交付（每次一版）", "客戶驗收／要求修改", "收款"].join(' <span class="erp-muted">→</span> ') + "</div>"
      + table([
        { l: "單號", v: function (s) { return mini("svc-view", esc(s.no), s.id); } }, { l: "客戶", v: function (s) { return esc(U.custName(s.customer_id)); } },
        { l: "項目", v: "title" }, { l: "金額", r: 1, v: function (s) { return nt(s.amount); } }, { l: "已收", r: 1, v: function (s) { return s.paid ? nt(s.paid) : ""; } },
        { l: "版次", r: 1, v: function (s) { return s.deliveries.length ? "v" + s.deliveries.length : ""; } },
        { l: "狀態", v: function (s) { return chip(s.status, svcTone(s.status)); } },
        { l: "", v: function (s) { return nextSvc(s); } }
      ], rows, { empty: "還沒有服務委託。客戶委託打樣、外包加工，用這裡追交付與驗收。", search: function (s) { return s.no + " " + U.custName(s.customer_id) + " " + s.title; } });
  };
  function nextSvc(s) {
    if (s.status === "草稿") return mini("svc-confirm", ic("check") + "確認", s.id) + mini("svc-edit", ic("edit"), s.id, "編輯");
    if (s.status === "已確認" || s.status === "要求修改") return mini("svc-deliver", ic("truck") + "交付", s.id);
    if (s.status === "已交付") return mini("svc-review", ic("check") + "驗收結果", s.id);
    if (s.status === "已驗收" || s.status === "部分收款") return mini("svc-pay", ic("cash") + "收款", s.id);
    return mini("svc-view", ic("search"), s.id, "詳情");
  }
  function serviceForm(s, cid, caseId) {
    if (!U.needCustomers()) return;
    var editing = !!s; s = s || { customer_id: cid || "", case_id: caseId || "" };
    var caseOpts = [["", "—"]].concat(W().cases.map(function (c) { return [c.id, c.no + " " + c.title]; }));
    U.form({
      title: editing ? "編輯服務委託 " + s.no : "新增服務委託",
      fields: [
        { k: "customer_id", l: "客戶", type: "select", opts: U.custOpts(), value: s.customer_id, req: 1 },
        { k: "case_id", l: "來自案件", type: "select", opts: caseOpts, value: s.case_id },
        { k: "title", l: "服務項目", req: 1, value: s.title, ph: "例：鋁支架打樣 3 件、表面處理外包" },
        { k: "amount", l: "金額", type: "num", req: 1, value: s.amount }, { k: "note", l: "規格／說明", type: "textarea", value: s.note }
      ],
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除這張草稿？")) U.act("service.delete", { id: s.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = s.id; return U.act("service.save", v); }
    });
  }
  function svcView(id) {
    var s = U.byId("services", id);
    U.S.curRec = { t: "services", id: id };
    U.info(ic("check") + "服務委託 " + esc(s.no) + " " + chip(s.status, svcTone(s.status)),
      "<p><b>" + esc(s.title) + "</b>　客戶：" + esc(U.custName(s.customer_id)) + "　金額：" + nt(s.amount) + "　已收：" + nt(s.paid) + "</p>" + (s.note ? "<p>" + esc(s.note) + "</p>" : "")
      + "<h4>交付紀錄</h4>" + table([{ l: "版次", v: function (d) { return "v" + d.rev; } }, { l: "日期", v: "date" }, { l: "交付內容", v: "ref" }, { l: "說明", v: "note" },
        { l: "結果", v: function (d) { return d.result ? chip(d.result, /通過/.test(d.result) ? "ok" : "warn") : (d.rev === s.deliveries.length && s.status === "已交付" ? chip("待驗收", "info") : ""); } }], s.deliveries, { empty: "尚未交付" })
      + (s.payments.length ? "<h4>收款</h4><ul class=\"erp-list\">" + s.payments.map(function (p) { return "<li>" + esc(p.date) + " " + nt(p.amount) + " " + esc(p.note) + "</li>"; }).join("") + "</ul>" : ""));
  }
  U.OPEN.services = svcView;

  // ===========================================================================
  // 專案：任務看板、里程碑、「我的名單／待辦」
  // ===========================================================================
  U.VIEW.project = function (w) {
    var projects = {};
    w.tasks.concat(w.milestones).forEach(function (x) { if (x.project) projects[x.project] = 1; });
    var f = U.S.projectFilter || "";
    var inP = function (x) { return !f || x.project === f; };
    var filter = '<select class="dbfilter" data-a-change="project-filter"><option value="">全部專案</option>' + Object.keys(projects).sort().map(function (p) {
      return '<option' + (p === f ? " selected" : "") + ">" + esc(p) + "</option>";
    }).join("") + "</select>";
    var board = '<div class="okanban erp-kanban">' + E.TASK_STATUS.map(function (st, i) {
      var cards = w.tasks.filter(function (t) { return t.status === st && inP(t); });
      return '<div class="okcol oks' + [0, 2, 4][i] + '"><div class="okhead">' + st + " <span>" + cards.length + "</span></div>" + (cards.map(function (t) {
        var late = t.due && t.status !== "完成" && t.due < today();
        return '<div class="ocardk' + (late ? " od" : "") + '" data-a="task-edit" data-id="' + esc(t.id) + '"><div class="ock-cust">' + esc(t.title) + '</div><div class="ock-prod">'
          + esc(t.project || "") + (t.customer_id ? "・" + esc(U.custName(t.customer_id)) : "") + '</div><div class="ock-meta"><span>' + esc(t.owner || "") + "</span>"
          + (t.due ? '<span class="' + (late ? "od" : "") + '">' + ic("calendar") + esc(t.due) + "</span>" : "") + "</div>"
          + '<div class="erp-mv">' + E.TASK_STATUS.filter(function (x) { return x !== st; }).map(function (x) { return mini("task-move", x, t.id + "|" + x); }).join("") + "</div></div>";
      }).join("") || '<div class="ock-empty">尚無</div>') + "</div>";
    }).join("") + "</div>";
    var ms = w.milestones.filter(inP).slice().sort(function (a, b) { return String(a.due || "9").localeCompare(String(b.due || "9")); });
    var mylist = U.lsGet("db_console_mylist", []) || [];
    return '<div class="dbtoolbar">' + filter + btn("task-new", ic("plus") + "新增任務", null, "primary") + btn("ms-new", ic("plus") + "新增里程碑") + "</div>"
      + section(ic("list") + "任務看板", board)
      + section(ic("target") + "里程碑", table([
        { l: "里程碑", v: function (m) { return mini("ms-edit", esc(m.title), m.id); } }, { l: "專案", v: "project" },
        { l: "客戶", v: function (m) { return m.customer_id ? esc(U.custName(m.customer_id)) : ""; } },
        { l: "目標日", v: function (m) { return dueCell(m.due, m.status === "已達成"); } },
        { l: "狀態", v: function (m) { return chip(m.status, { "規劃中": "info", "已達成": "ok", "延後": "warn" }[m.status]); } },
        { l: "", v: function (m) { return m.status !== "已達成" ? mini("ms-done", ic("check") + "達成", m.id) : ""; } }
      ], ms, { empty: "還沒有里程碑（例：首件確認、量產、交貨）" }))
      + section(ic("clipboard") + "我的名單／待辦（資料庫）", mylist.length ? table([{ l: "名稱", v: "name" }, { l: "分類", v: "category" }, { l: "狀態", v: "status" }, { l: "到期", v: "due" }], mylist.slice(0, 10))
        : '<div class="dbempty">資料庫的「我的名單／待辦」目前沒有資料（或尚未載入）。</div>', '<a class="dbbtn" href="db.html">' + ic("db") + "到資料庫管理</a>");
  };
  function projectList() { var p = {}; W().tasks.concat(W().milestones).forEach(function (x) { if (x.project) p[x.project] = 1; }); return Object.keys(p).sort(); }
  function taskForm(t, isMs) {
    var tbl = isMs ? "milestones" : "tasks", editing = !!t;
    t = t || { project: U.S.projectFilter || "", status: isMs ? "規劃中" : "待辦" };
    U.form({
      title: (editing ? "編輯" : "新增") + (isMs ? "里程碑" : "任務"),
      datalist: '<datalist id="erpProj">' + projectList().map(function (p) { return '<option value="' + esc(p) + '">'; }).join("") + "</datalist>",
      fields: [
        { k: "title", l: isMs ? "里程碑" : "任務", req: 1, value: t.title }, { k: "project", l: "專案名稱", value: t.project, list: "erpProj", ph: "例：新支架開發" },
        { k: "customer_id", l: "客戶（選填）", type: "select", opts: [["", "—"]].concat(U.custOpts().slice(1)), value: t.customer_id },
        isMs ? null : { k: "owner", l: "負責人", value: t.owner },
        { k: "due", l: isMs ? "目標日" : "到期日", type: "date", value: t.due },
        { k: "status", l: "狀態", type: "select", opts: opts(isMs ? E.MS_STATUS : E.TASK_STATUS), value: t.status },
        { k: "note", l: "備註", type: "textarea", value: t.note }
      ].filter(Boolean),
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除「" + t.title + "」？")) U.act(isMs ? "milestone.delete" : "task.delete", { id: t.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = t.id; return U.act(isMs ? "milestone.save" : "task.save", v); }
    });
  }
  U.OPEN.tasks = function (id) { taskForm(U.byId("tasks", id)); };
  U.OPEN.milestones = function (id) { taskForm(U.byId("milestones", id), true); };

  // ===========================================================================
  // 客戶頁：表格加「聯絡人數」與 360 檢視入口
  // ===========================================================================
  var oldCrm = U.VIEW.crm;
  U.VIEW.crm = function (w) {
    return oldCrm(w).replace(/data-a="cust-edit" data-id="([^"]+)" title="編輯">/g, function (m, id) {
      return 'data-a="cust-view" data-id="' + id + '" title="客戶 360（聯絡人、案件、訂單）">' + ic("search") + '</button><button class="dbmini" ' + m.slice(0);
    }).replace('<th>聯絡人</th>', "<th>主要聯絡人</th>");
  };

  // ---------- 事件 ----------
  var H = U.H;
  H["role"] = function (id) { U.lsSet(ROLE_KEY, id); U.render(); };
  H["onb-hide"] = function () { U.lsSet(ONB_KEY, true); U.render(); };
  H["goto"] = function (href) { location.href = href; };
  H["cust-view"] = function (id) { custView(id); };
  H["contact-edit"] = function (id) { contactForm(U.byId("contacts", id)); };
  H["case-new"] = function () { caseForm(null); };
  H["case-view"] = function (id) { U.openRec("cases", id); };
  H["case-status"] = function (id) { statusForm(U.byId("cases", id)); };
  H["case-log"] = function (id) { logForm(U.byId("cases", id)); };
  H["svc-new"] = function () { serviceForm(null); };
  H["svc-edit"] = function (id) { serviceForm(U.byId("services", id)); };
  H["svc-view"] = function (id) { U.openRec("services", id); };
  H["svc-confirm"] = function (id) { if (confirm("確認這張服務委託？確認後內容與金額鎖定。")) U.act("service.confirm", { id: id }); };
  H["svc-deliver"] = function (id) {
    var s = U.byId("services", id);
    U.form({ title: "交付 " + s.no + "（第 " + (s.deliveries.length + 1) + " 版）", fields: [
      { k: "ref", l: "交付內容", req: 1, ph: "例：樣品 3 件（出貨單 SO-…）、圖檔連結" }, { k: "note", l: "說明", type: "textarea" }],
      submit: function (v) { return U.act("service.deliver", { id: id, ref: v.ref, note: v.note }); } });
  };
  H["svc-review"] = function (id) {
    var s = U.byId("services", id), rev = s.deliveries.length;
    U.form({ title: "客戶驗收結果 " + s.no + "（v" + rev + "）", intro: "交付內容：" + esc(s.deliveries[rev - 1].ref),
      fields: [{ k: "note", l: "要求修改的地方（驗收通過可留空）", type: "textarea" }],
      extra: [{ l: ic("check") + "驗收通過", cls: "primary", fn: function (close) { U.act("service.accept", { id: id, rev: rev }).then(function (r) { if (r) close(); }); } }],
      ok: "要求修改", submit: function (v) { return U.act("service.request_changes", { id: id, rev: rev, note: v.note }); } });
  };
  H["svc-pay"] = function (id) {
    var s = U.byId("services", id);
    U.form({ title: "收款 " + s.no, intro: "服務金額 " + nt(s.amount) + "，已收 " + nt(s.paid),
      fields: [{ k: "amount", l: "收款金額", type: "num", req: 1, value: Math.round((s.amount - s.paid) * 100) / 100 }, { k: "date", l: "收款日", type: "date", value: today() }, { k: "note", l: "備註" }],
      submit: function (v) { return U.act("service.pay", { id: id, amount: v.amount, date: v.date, note: v.note }); } });
  };
  H["task-new"] = function () { taskForm(null); };
  H["task-edit"] = function (id) { U.openRec("tasks", id); };
  H["task-move"] = function (k) { var a = k.split("|"); U.act("task.status", { id: a[0], status: a[1] }); };
  H["ms-new"] = function () { taskForm(null, true); };
  H["ms-edit"] = function (id) { U.openRec("milestones", id); };
  H["ms-done"] = function (id) { U.act("milestone.status", { id: id, status: "已達成" }); };
  document.addEventListener("change", function (e) {
    if (e.target.getAttribute && e.target.getAttribute("data-a-change") === "project-filter") { U.S.projectFilter = e.target.value; U.render(); }
  });

  // 示範資料也帶入聯絡人、案件、服務、任務
  var oldDemo = H.demo;
  H.demo = function () {
    oldDemo();
    var w = W(), c1 = w.customers[0], c2 = w.customers[1];
    if (!c1 || !c2) return;
    var ctx = { by: "示範", today: today() };
    var a = function (x, p) { return E.apply(w, x, p, ctx).result; };
    a("contact.save", { customer_id: c1.id, name: "王經理", title: "採購經理", phone: "04-2560-0000" });
    a("contact.save", { customer_id: c1.id, name: "陳工程師", title: "品管", email: "qc@example.com" });
    var p2 = a("contact.save", { customer_id: c2.id, name: "林小姐", title: "業務助理" });
    var k = a("case.save", { customer_id: c2.id, contact_id: p2, title: "銅接頭打樣需求", kind: "詢價", priority: "高", due: U.plusDays(5) });
    var s = a("service.save", { customer_id: c2.id, case_id: k, title: "銅接頭打樣 10 件", amount: 6000 });
    a("service.confirm", { id: s }); a("service.deliver", { id: s, ref: "樣品 10 件（v1）" });
    a("task.save", { title: "出 2D 圖給客戶確認", project: "銅接頭開發", customer_id: c2.id, owner: "業務", due: U.plusDays(2) });
    a("task.save", { title: "確認鍍鎳廠交期", project: "銅接頭開發", owner: "採購", due: U.plusDays(4), status: "進行中" });
    a("milestone.save", { title: "首件確認", project: "銅接頭開發", customer_id: c2.id, due: U.plusDays(10) });
    U.lsSet("erp_world_local", w); U.render();
  };
})();
