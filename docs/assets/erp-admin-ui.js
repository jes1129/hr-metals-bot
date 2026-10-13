/*
 * erp-admin-ui.js — 行政工作台（admin.html）畫面：總覽、組織與員工、週班表、出勤、申請簽核、設備預約、公告
 * 規則在 erp-admin.js；資料與 ERP 同一份（同一個 Apps Script、ERP_ 分頁），透過 window.__erpUI 掛進 erp.js。
 */
(function () {
  "use strict";
  var U = window.__erpUI;
  if (!U) return;
  var E = U.E, X = E.admin, ic = U.ic, esc = U.esc, chip = U.chip, btn = U.btn, mini = U.mini, table = U.table, section = U.section, kpi = U.kpi;
  var WD = ["日", "一", "二", "三", "四", "五", "六"];

  [["ahome", ic("bars") + "總覽"], ["org", ic("users") + "組織與員工"], ["shifts", ic("calendar") + "週班表"], ["attendance", ic("clock") + "出勤"],
   ["requests", ic("clipboard") + "申請簽核"], ["equip", ic("wrench") + "設備預約"], ["notices", ic("bell") + "公告"]]
    .forEach(function (t) { U.addTab("admin", t[0], t[1]); });

  function W() { return U.W(); }
  function today() { return U.today(); }
  function opts(list) { return list.map(function (x) { return [x, x]; }); }
  function staffName(id) { var s = U.byId("staff", id); return s ? s.name : "—"; }
  function unitName(id) { var u = U.byId("units", id); return u ? u.name : "—"; }
  function staffOpts(all) {
    return [["", "— 選擇員工 —"]].concat(W().staff.filter(function (s) { return all || s.active !== false; })
      .sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); })
      .map(function (s) { return [s.id, s.code + " " + s.name + "（" + unitName(s.unit_id) + "）"]; }));
  }
  function unitOpts(blank) { return [["", blank || "— 選擇單位 —"]].concat(W().units.filter(function (u) { return u.active !== false; }).map(function (u) { return [u.id, u.name + "（" + u.kind + "）"]; })); }
  function addDays(d, n) { var x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function monday(d) { var wd = X.weekday(d); return addDays(d, wd === 0 ? -6 : 1 - wd); }
  function needStaff() { if (!W().staff.length) { alert("請先建立單位與員工（組織與員工）。"); U.S.tab = "org"; U.render(); return false; } return true; }
  function reqTone(s) { return { "草稿": "muted", "已送出": "warn", "已核准": "ok", "已退回": "warn", "已撤回": "muted" }[s]; }

  // ===========================================================================
  // 總覽
  // ===========================================================================
  U.VIEW.ahome = function (w) {
    var r = E.report(w, today());
    var empty = !w.units.length;
    return (empty ? section(ic("play") + "第一次使用：三步驟", '<ol class="erp-steps"><li><b>建立單位</b>：工廠、辦公室或部門。</li><li><b>加入員工</b>：員工編號建立後固定，離職請停用。</li><li><b>排班與出勤</b>：先排週班表，出勤手動登錄，系統自動比對遲到、早退、缺勤。</li></ol>'
      + '<div class="erp-row">' + btn("tab", ic("plus") + "先建立單位", "org", "primary") + (U.S.mode === "local" ? btn("admin-demo", ic("info") + "載入行政示範資料（只在本機）") : "") + "</div>") : "")
      + '<div class="okpis erp-kpis">'
      + kpi(ic("users") + "在職員工", r.staff_active + " 人", "", w.units.length + " 個單位")
      + kpi(ic("calendar") + "今日班次", r.shifts_today.length + " 班", "", "")
      + kpi(ic("clipboard") + "待簽核申請", r.requests_pending.length + " 件", r.requests_pending.length ? "warn" : "", "")
      + kpi(ic("alert") + "今日出勤差異", r.attendance_diff.length + " 筆", r.attendance_diff.length ? "warn" : "", "遲到／早退／缺勤")
      + "</div>"
      + '<div class="erp-grid2">'
      + section(ic("bell") + "公告", r.notices_active.length ? '<ul class="erp-notices">' + r.notices_active.slice(0, 5).map(function (n) {
        return '<li data-a="notice-edit" data-id="' + esc(n.id) + '">' + (n.pinned ? chip("置頂", "warn") + " " : "") + "<b>" + esc(n.title) + '</b><span class="erp-muted"> ' + esc(n.updated) + "</span>" + (n.body ? "<div>" + esc(n.body).slice(0, 120) + "</div>" : "") + "</li>";
      }).join("") + "</ul>" : '<div class="dbempty">沒有公告</div>', btn("tab", ic("arrow") + "全部公告", "notices"))
      + section(ic("clipboard") + "待簽核申請", r.requests_pending.length ? table(reqCols(true), r.requests_pending) : '<div class="dbempty">沒有待簽核的申請</div>')
      + "</div><div class=\"erp-grid2\">"
      + section(ic("alert") + "今日出勤差異", r.attendance_diff.length ? table([{ l: "員工", v: "staff" }, { l: "班次", v: "shift" }, { l: "狀況", v: function (d) { return '<b class="erp-bad">' + esc(d.issue) + "</b>"; } }], r.attendance_diff) : '<div class="dbempty">今天沒有差異（或還沒排班）</div>', btn("tab", ic("arrow") + "出勤", "attendance"))
      + section(ic("wrench") + "今日設備預約", r.reservations_today.length ? table(resCols(), r.reservations_today) : '<div class="dbempty">今天沒有設備預約</div>')
      + "</div>";
  };

  // ===========================================================================
  // 組織與員工
  // ===========================================================================
  U.VIEW.org = function (w) {
    var cnt = {}; w.staff.forEach(function (s) { if (s.active !== false) cnt[s.unit_id] = (cnt[s.unit_id] || 0) + 1; });
    return section(ic("factory") + "組織／單位", table([
      { l: "單位", v: function (u) { return esc(u.name) + (u.active === false ? " " + chip("停用", "muted") : ""); } }, { l: "類型", v: "kind" },
      { l: "上層", v: function (u) { return u.parent_id ? esc(unitName(u.parent_id)) : ""; } }, { l: "在職人數", r: 1, v: function (u) { return cnt[u.id] || 0; } },
      { l: "", v: function (u) { return mini("unit-edit", ic("edit"), u.id, "編輯"); } }
    ], w.units, { empty: "還沒有單位。先建立工廠、辦公室或部門。" }), btn("unit-new", ic("plus") + "新增單位", null, "primary"))
      + section(ic("users") + "員工", '<div class="dbtoolbar">' + U.searchBox("搜尋編號、姓名、單位…") + btn("csv-staff", ic("download") + "匯出 CSV") + "</div>" + table([
        { l: "編號", v: "code" }, { l: "姓名", v: function (s) { return esc(s.name) + (s.active === false ? " " + chip("停用", "muted") : ""); } },
        { l: "單位", v: function (s) { return esc(unitName(s.unit_id)); } }, { l: "職稱", v: "title" }, { l: "電話", v: "phone" }, { l: "Email", v: "email" }, { l: "到職", v: "hire_date" },
        { l: "", v: function (s) { return mini("staff-edit", ic("edit"), s.id, "編輯"); } }
      ], w.staff.slice().sort(function (a, b) { return String(a.code).localeCompare(String(b.code)); }), { empty: "還沒有員工。", rowCls: function (s) { return s.active === false ? "erp-off" : ""; }, search: function (s) { return unitName(s.unit_id); } }),
        btn("staff-new", ic("plus") + "新增員工", null, "primary"));
  };
  function unitForm(u) {
    var editing = !!u; u = u || { kind: "部門" };
    U.form({ title: editing ? "編輯單位" : "新增單位", fields: [
      { k: "name", l: "單位名稱", req: 1, value: u.name }, { k: "kind", l: "類型", type: "select", opts: opts(X.UNIT_KINDS), value: u.kind },
      { k: "parent_id", l: "上層單位", type: "select", opts: unitOpts("— 無（最上層）—").filter(function (o) { return !u.id || o[0] !== u.id; }), value: u.parent_id },
      editing ? { k: "active", l: "狀態", type: "check", text: "使用中", value: u.active !== false } : null,
      { k: "note", l: "備註", type: "textarea", value: u.note }].filter(Boolean),
      extra: editing ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除單位「" + u.name + "」？")) U.act("unit.delete", { id: u.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: function (v) { if (editing) v.id = u.id; return U.act("unit.save", v); } });
  }
  function staffForm(s) {
    if (!W().units.length) { alert("請先建立單位。"); return; }
    var editing = !!s; s = s || {};
    U.form({ title: editing ? "編輯員工 " + s.code : "新增員工", fields: [
      editing ? { type: "html", html: '<div class="dbnote">員工編號 <b>' + esc(s.code) + "</b>（建立後固定）</div>" } : { k: "code", l: "員工編號", req: 1, ph: "例：E001" },
      { k: "name", l: "姓名", req: 1, value: s.name }, { k: "unit_id", l: "所屬單位", type: "select", opts: unitOpts(), value: s.unit_id, req: 1 },
      { k: "title", l: "職稱", value: s.title }, { k: "phone", l: "電話", value: s.phone }, { k: "email", l: "Email", value: s.email },
      { k: "hire_date", l: "到職日", type: "date", value: s.hire_date },
      editing ? { k: "active", l: "狀態", type: "check", text: "在職（取消勾選＝停用，保留歷史）", value: s.active !== false } : null,
      { k: "note", l: "備註", type: "textarea", value: s.note }].filter(Boolean),
      submit: function (v) { if (editing) { v.id = s.id; v.code = s.code; } return U.act("staff.save", v); } });
  }
  U.OPEN.staff = function (id) { staffForm(U.byId("staff", id)); };
  U.OPEN.units = function (id) { unitForm(U.byId("units", id)); };

  // ===========================================================================
  // 週班表
  // ===========================================================================
  U.VIEW.shifts = function (w) {
    var wk = U.S.week || monday(today()), days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(wk, i); });
    var staff = w.staff.filter(function (s) { return s.active !== false || w.shifts.some(function (x) { return x.staff_id === s.id && days.indexOf(x.date) >= 0; }); });
    var head = "<th>員工</th>" + days.map(function (d) { return '<th class="' + (d === today() ? "erp-today" : "") + '">' + d.slice(5) + "（" + WD[X.weekday(d)] + "）</th>"; }).join("") + "<th class=\"r\">時數</th>";
    var rows = staff.map(function (s) {
      var hrs = 0;
      var cells = days.map(function (d) {
        var xs = w.shifts.filter(function (x) { return x.staff_id === s.id && x.date === d && x.status !== "已取消"; });
        xs.forEach(function (x) { var sp = X.span(x.date, x.start, x.end); hrs += (sp[1] - sp[0] - (x.break_min || 0)) / 60; });
        return '<td class="erp-cell">' + xs.map(function (x) {
          return '<button class="erp-shift' + (x.status === "已完成" ? " done" : "") + '" data-a="shift-edit" data-id="' + esc(x.id) + '">' + esc(x.start) + "–" + esc(x.end) + "</button>";
        }).join("") + '<button class="erp-add" data-a="shift-new-at" data-id="' + esc(s.id + "|" + d) + '" title="排班">' + ic("plus") + "</button></td>";
      }).join("");
      return "<tr><td><b>" + esc(s.name) + '</b><div class="erp-muted">' + esc(unitName(s.unit_id)) + "</div></td>" + cells + '<td class="r">' + Math.round(hrs * 10) / 10 + "</td></tr>";
    }).join("");
    return '<div class="dbtoolbar">' + btn("week-prev", ic("undo") + "上一週") + '<b class="erp-week">' + wk + " ～ " + days[6] + "</b>" + btn("week-next", "下一週" + ic("arrow")) + btn("week-this", "本週")
      + btn("week-copy", ic("refresh") + "把上一週複製到這週") + btn("shift-new", ic("plus") + "排班", null, "primary") + "</div>"
      + (staff.length ? '<div class="dbtablewrap"><table class="dbtable erp-table erp-week-grid"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>"
        : '<div class="dbempty">還沒有員工。請先到「組織與員工」新增。</div>')
      + '<div class="dbnote">點格子裡的「＋」排班，點班次可修改、標記完成或取消。結束時間早於開始時間＝跨夜班。同一人時段重疊會被擋下。</div>';
  };
  function shiftForm(x, staffId, date) {
    if (!needStaff()) return;
    var editing = !!x; x = x || { staff_id: staffId || "", date: date || today(), start: "08:00", end: "17:00", break_min: 60 };
    U.form({ title: editing ? "班次 " + staffName(x.staff_id) + " " + x.date + "（" + x.status + "）" : "排班", fields: [
      { k: "staff_id", l: "員工", type: "select", opts: staffOpts(), value: x.staff_id, req: 1 }, { k: "date", l: "日期", type: "date", value: x.date },
      { k: "start", l: "上班", value: x.start, ph: "08:00" }, { k: "end", l: "下班", value: x.end, ph: "17:00（早於上班＝跨夜）" },
      { k: "break_min", l: "休息（分鐘）", type: "num", value: x.break_min }, { k: "note", l: "備註", value: x.note }],
      extra: editing && x.status === "排定" ? [
        { l: ic("check") + "標記完成", fn: function (close) { U.act("shift.complete", { id: x.id }).then(function (r) { if (r) close(); }); } },
        { l: ic("x") + "取消班次", cls: "erp-danger", fn: function (close) { if (confirm("取消這個班次？")) U.act("shift.cancel", { id: x.id }).then(function (r) { if (r) close(); }); } }] : [],
      submit: editing && x.status !== "排定" ? null : function (v) { if (editing) v.id = x.id; return U.act("shift.save", v); } });
  }
  U.OPEN.shifts = function (id) { shiftForm(U.byId("shifts", id)); };

  // ===========================================================================
  // 出勤
  // ===========================================================================
  U.VIEW.attendance = function (w) {
    var d = U.S.attDate || today();
    var rows = w.attendance.filter(function (a) { return a.date === d; });
    var diff = X.diff(w, d);
    return '<div class="dbtoolbar"><label class="erp-inline">日期 <input type="date" class="dbfilter" data-a-change="att-date" value="' + esc(d) + '"></label>'
      + btn("att-new", ic("plus") + "登錄出勤", null, "primary") + btn("csv-att", ic("download") + "匯出本月 CSV") + "</div>"
      + section(ic("alert") + "與班表比對（" + d + "）", diff.length ? table([{ l: "員工", v: "staff" }, { l: "班次", v: "shift" }, { l: "狀況", v: function (x) { return '<b class="erp-bad">' + esc(x.issue) + "</b>"; } }], diff) : '<div class="dbempty">沒有差異（遲到、早退超過 5 分鐘或缺勤會列在這裡）</div>')
      + section(ic("clock") + "出勤紀錄", table([
        { l: "員工", v: function (a) { return esc(staffName(a.staff_id)); } }, { l: "上班", v: "clock_in" }, { l: "下班", v: function (a) { return a.clock_out || '<span class="erp-warn">未登錄</span>'; } },
        { l: "休息", r: 1, v: function (a) { return a.break_min ? a.break_min + " 分" : ""; } }, { l: "工時", r: 1, v: function (a) { return a.status === "有效" ? X.workHours(a) + " 小時" : ""; } },
        { l: "狀態", v: function (a) { return a.status === "有效" ? chip("有效", "ok") : chip("已作廢", "muted") + ' <span class="erp-muted">' + esc(a.void_reason) + "</span>"; } },
        { l: "登錄人", v: "by" },
        { l: "", v: function (a) { return a.status === "有效" ? mini("att-edit", ic("edit"), a.id, "修改") + mini("att-void", ic("x"), a.id, "作廢") : ""; } }
      ], rows, { empty: "這天還沒有出勤紀錄", rowCls: function (a) { return a.status === "有效" ? "" : "erp-off"; } }));
  };
  function attForm(a) {
    if (!needStaff()) return;
    var editing = !!a; a = a || { date: U.S.attDate || today(), clock_in: "08:00", clock_out: "17:00", break_min: 60 };
    U.form({ title: editing ? "修改出勤" : "登錄出勤", intro: "手動登錄；改錯請修改或作廢（作廢要寫原因，紀錄會保留）。", fields: [
      { k: "staff_id", l: "員工", type: "select", opts: staffOpts(), value: a.staff_id, req: 1 }, { k: "date", l: "日期", type: "date", value: a.date },
      { k: "clock_in", l: "上班", value: a.clock_in }, { k: "clock_out", l: "下班（未下班可留空）", value: a.clock_out },
      { k: "break_min", l: "休息（分鐘）", type: "num", value: a.break_min }, { k: "note", l: "備註", value: a.note }],
      submit: function (v) { if (editing) v.id = a.id; return U.act("attendance.save", v); } });
  }

  // ===========================================================================
  // 申請簽核
  // ===========================================================================
  function reqCols(compact) {
    var cols = [
      { l: "單號", v: function (r) { return mini("req-view", esc(r.no), r.id); } }, { l: "申請人", v: function (r) { return esc(staffName(r.staff_id)); } },
      { l: "類別", v: function (r) { return esc(r.kind) + (r.leave_type ? "（" + esc(r.leave_type) + "）" : ""); } },
      { l: "期間", v: function (r) { return esc(r.start_date) + (r.start_time ? " " + esc(r.start_time) : "") + (r.end_date !== r.start_date || r.end_time ? " ～ " + esc(r.end_date !== r.start_date ? r.end_date : "") + (r.end_time ? " " + esc(r.end_time) : "") : ""); } },
      { l: "時數", r: 1, v: function (r) { return r.hours ? r.hours : ""; } }
    ];
    if (!compact) cols.push({ l: "狀態", v: function (r) { return chip(r.status, reqTone(r.status)); } });
    cols.push({ l: "", v: function (r) {
      if (r.status === "草稿" || r.status === "已退回") return mini("req-edit", ic("edit"), r.id, "修改") + mini("req-submit", ic("arrow") + "送出", r.id);
      if (r.status === "已送出") return mini("req-approve", ic("check") + "核准", r.id) + mini("req-return", ic("undo") + "退回", r.id) + mini("req-withdraw", ic("x"), r.id, "撤回");
      return "";
    } });
    return cols;
  }
  U.VIEW.requests = function (w) {
    var f = U.S.reqFilter || "待處理";
    var rows = w.requests.filter(function (r) { return f === "全部" || (f === "待處理" ? (r.status === "已送出" || r.status === "已退回" || r.status === "草稿") : r.status === f); }).slice().reverse();
    return '<div class="dbtoolbar">' + ["待處理", "已送出", "已核准", "已退回", "已撤回", "全部"].map(function (s) { return '<button class="dbtab' + (s === f ? " on" : "") + '" data-a="req-filter" data-id="' + s + '">' + s + "</button>"; }).join("")
      + btn("req-new", ic("plus") + "新增申請", null, "primary") + "</div>"
      + '<div class="dbnote erp-flow">草稿 <span class="erp-muted">→</span> 送出 <span class="erp-muted">→</span> 核准／退回（要寫原因）<span class="erp-muted">→</span> 退回可修改再送；送出後可撤回。' + (U.S.mode === "cloud" ? "不能核准自己送出的申請。" : "本機試用可自己核准；正式資料需由另一位登入者核准。") + "</div>"
      + table(reqCols(false), rows, { empty: "沒有符合的申請" });
  };
  function reqForm(r) {
    if (!needStaff()) return;
    var editing = !!r; r = r || { kind: "請假", leave_type: "特休", start_date: U.plusDays(1), end_date: U.plusDays(1), hours: 8 };
    U.form({ title: editing ? "修改申請 " + r.no : "新增申請", fields: [
      { k: "staff_id", l: "申請人", type: "select", opts: staffOpts(), value: r.staff_id, req: 1 },
      { k: "kind", l: "類別", type: "select", opts: opts(X.REQ_KINDS), value: r.kind }, { k: "leave_type", l: "假別（請假時）", type: "select", opts: opts(X.LEAVE_TYPES), value: r.leave_type },
      { k: "start_date", l: "開始日期", type: "date", value: r.start_date }, { k: "start_time", l: "開始時間（選填）", value: r.start_time, ph: "08:00" },
      { k: "end_date", l: "結束日期", type: "date", value: r.end_date }, { k: "end_time", l: "結束時間（選填）", value: r.end_time, ph: "17:00" },
      { k: "hours", l: "時數", type: "num", value: r.hours }, { k: "reason", l: "事由", type: "textarea", req: 1, value: r.reason }],
      extra: editing && r.status === "草稿" ? [{ l: ic("trash") + "刪除", cls: "erp-danger", fn: function (close) { if (confirm("刪除這張草稿？")) U.act("request.delete", { id: r.id }).then(function (x) { if (x) close(); }); } }] : [],
      ok: "存成草稿", submit: function (v) { if (editing) v.id = r.id; return U.act("request.save", v); } });
  }
  function reqView(id) {
    var r = U.byId("requests", id);
    U.S.curRec = { t: "requests", id: id };
    U.info(ic("clipboard") + "申請 " + esc(r.no) + " " + chip(r.status, reqTone(r.status)),
      "<p>申請人：<b>" + esc(staffName(r.staff_id)) + "</b>　類別：" + esc(r.kind) + (r.leave_type ? "（" + esc(r.leave_type) + "）" : "") + "　時數：" + (r.hours || "—") + "</p>"
      + "<p>期間：" + esc(r.start_date) + " " + esc(r.start_time) + " ～ " + esc(r.end_date) + " " + esc(r.end_time) + "</p><p>事由：" + esc(r.reason) + "</p>"
      + (r.reviewer ? '<div class="erp-sum"><span>審核：<b>' + esc(r.reviewer) + "</b></span>" + (r.review_note ? "<span>" + esc(r.review_note) + "</span>" : "") + "</div>" : "")
      + "<h4>流程紀錄</h4><ul class=\"erp-timeline\">" + r.history.slice().reverse().map(function (h) { return "<li><b>" + esc(h.date) + "</b> " + esc(h.action) + " " + esc(h.note) + ' <span class="erp-muted">' + esc(h.by) + "</span></li>"; }).join("") + "</ul>");
  }
  U.OPEN.requests = reqView;
  function noteAct(action, title, need) {
    return function (id) {
      U.form({ title: title, fields: [{ k: "note", l: need ? "原因（必填）" : "備註（選填）", type: "textarea", req: need }],
        submit: function (v) { return U.act(action, { id: id, note: v.note }); } });
    };
  }

  // ===========================================================================
  // 設備預約
  // ===========================================================================
  function resCols() {
    return [{ l: "設備", v: function (r) { var e = U.byId("equipment", r.equipment_id); return esc(e ? e.name : "?"); } },
      { l: "日期", v: "date" }, { l: "時段", v: function (r) { return esc(r.start + "–" + r.end); } },
      { l: "使用人", v: function (r) { return r.staff_id ? esc(staffName(r.staff_id)) : esc(r.by); } }, { l: "用途", v: "purpose" },
      { l: "狀態", v: function (r) { return chip(r.status, { "預約中": "info", "已歸還": "ok", "已取消": "muted" }[r.status]); } },
      { l: "", v: function (r) { return r.status === "預約中" ? mini("res-return", ic("check") + "歸還", r.id) + mini("res-cancel", ic("x"), r.id, "取消") : ""; } }];
  }
  U.VIEW.equip = function (w) {
    var d = U.S.resDate || today();
    var res = w.reservations.filter(function (r) { return r.date >= d; }).sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); });
    return section(ic("wrench") + "設備", table([
      { l: "編號", v: "code" }, { l: "名稱", v: function (e) { return esc(e.name) + (e.active === false ? " " + chip("停用", "muted") : ""); } }, { l: "位置", v: "location" },
      { l: "保養", v: function (e) { if (!(e.maint_days > 0)) return '<span class="erp-muted">不追蹤</span>'; var nx = X.nextMaint ? X.nextMaint(e) : ""; return esc(e.last_maint || "從未") + '<div class="erp-muted">下次 ' + esc(nx || "現在") + "</div>"; } },
      { l: "今天", v: function (e) { var n = w.reservations.filter(function (r) { return r.equipment_id === e.id && r.date === today() && r.status === "預約中"; }); return n.length ? chip(n.map(function (r) { return r.start + "–" + r.end; }).join("、"), "info") : '<span class="erp-muted">空閒</span>'; } },
      { l: "", v: function (e) { return mini("equip-edit", ic("edit"), e.id, "編輯") + (e.active !== false ? mini("res-new-for", ic("calendar") + "預約", e.id) : "") + (e.maint_days > 0 ? mini("equip-maint", ic("wrench") + "已保養", e.id, "記錄今天已完成保養") : ""); } }
    ], w.equipment, { empty: "還沒有設備（例：三次元量測儀、堆高機、會議室、公務車）" }), btn("equip-new", ic("plus") + "新增設備", null, "primary"))
      + section(ic("calendar") + "預約（" + d + " 起）", '<div class="dbtoolbar"><label class="erp-inline">從 <input type="date" class="dbfilter" data-a-change="res-date" value="' + esc(d) + '"></label></div>' + table(resCols(), res, { empty: "沒有預約" }),
        btn("res-new", ic("plus") + "新增預約", null, "primary"));
  };
  function equipForm(e) {
    var editing = !!e; e = e || {};
    U.form({ title: editing ? "編輯設備" : "新增設備", fields: [
      { k: "name", l: "名稱", req: 1, value: e.name }, { k: "code", l: "設備編號", value: e.code }, { k: "location", l: "位置", value: e.location },
      { k: "maint_days", l: "保養週期（天，0＝不追蹤）", type: "num", value: e.maint_days || 0 }, { k: "last_maint", l: "上次保養日", type: "date", value: e.last_maint || "" },
      editing ? { k: "active", l: "狀態", type: "check", text: "可預約", value: e.active !== false } : null, { k: "note", l: "備註", type: "textarea", value: e.note }].filter(Boolean),
      submit: function (v) { if (editing) v.id = e.id; return U.act("equipment.save", v); } });
  }
  function resForm(eqId) {
    var eqs = W().equipment.filter(function (e) { return e.active !== false; });
    if (!eqs.length) { alert("請先新增設備。"); return; }
    U.form({ title: "新增設備預約", fields: [
      { k: "equipment_id", l: "設備", type: "select", opts: [["", "— 選擇設備 —"]].concat(eqs.map(function (e) { return [e.id, (e.code ? e.code + " " : "") + e.name]; })), value: eqId || "", req: 1 },
      { k: "staff_id", l: "使用人", type: "select", opts: [["", "（登入者本人）"]].concat(staffOpts().slice(1)) },
      { k: "date", l: "日期", type: "date", value: U.S.resDate || today() }, { k: "start", l: "開始", value: "09:00" }, { k: "end", l: "結束", value: "10:00" },
      { k: "purpose", l: "用途", req: 1 }],
      submit: function (v) { return U.act("reservation.save", v); } });
  }
  U.OPEN.equipment = function (id) { equipForm(U.byId("equipment", id)); };

  // ===========================================================================
  // 公告
  // ===========================================================================
  U.VIEW.notices = function (w) {
    var list = w.notices.slice().sort(function (a, b) { return (a.status === b.status ? 0 : a.status === "公告中" ? -1 : 1) || (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)); });
    return '<div class="dbtoolbar">' + btn("notice-new", ic("plus") + "發布公告", null, "primary") + "</div>"
      + (list.length ? '<div class="erp-notice-list">' + list.map(function (n) {
        return '<div class="erp-notice' + (n.status === "已封存" ? " off" : "") + (n.pinned ? " pin" : "") + '"><div class="erp-sechead"><h3>' + (n.pinned ? ic("pin") : ic("bell")) + esc(n.title) + "</h3>"
          + "<span>" + mini("notice-edit", ic("edit"), n.id, "編輯") + (n.status === "公告中" ? mini("notice-archive", ic("inbox") + "封存", n.id) : mini("notice-restore", ic("undo") + "恢復", n.id)) + "</span></div>"
          + (n.body ? '<div class="erp-notice-body">' + esc(n.body).replace(/\n/g, "<br>") + "</div>" : "")
          + '<div class="erp-muted">' + esc(n.updated) + " · " + esc(n.by) + (n.status === "已封存" ? " · 已封存" : "") + "</div></div>";
      }).join("") + "</div>" : '<div class="dbempty">還沒有公告</div>');
  };
  function noticeForm(n) {
    var editing = !!n; n = n || {};
    U.form({ title: editing ? "編輯公告" : "發布公告", fields: [
      { k: "title", l: "標題", req: 1, value: n.title }, { k: "body", l: "內容", type: "textarea", value: n.body },
      { k: "pinned", l: "置頂", type: "check", text: "置頂（總覽最上面）", value: n.pinned }],
      submit: function (v) { if (editing) v.id = n.id; return U.act("notice.save", v); } });
  }
  U.OPEN.notices = function (id) { noticeForm(U.byId("notices", id)); };

  // ---------- 事件 ----------
  var H = U.H;
  H["unit-new"] = function () { unitForm(null); };
  H["unit-edit"] = function (id) { unitForm(U.byId("units", id)); };
  H["staff-new"] = function () { staffForm(null); };
  H["equip-maint"] = function (id) { return U.act("equipment.maintained", { id: id }); };
  H["staff-edit"] = function (id) { staffForm(U.byId("staff", id)); };
  H["csv-staff"] = function () { U.csv("員工", ["編號", "姓名", "單位", "職稱", "電話", "Email", "到職日", "狀態"], W().staff.map(function (s) { return [s.code, s.name, unitName(s.unit_id), s.title, s.phone, s.email, s.hire_date, s.active === false ? "停用" : "在職"]; })); };
  H["week-prev"] = function () { U.S.week = addDays(U.S.week || monday(today()), -7); U.render(); };
  H["week-next"] = function () { U.S.week = addDays(U.S.week || monday(today()), 7); U.render(); };
  H["week-this"] = function () { U.S.week = monday(today()); U.render(); };
  H["week-copy"] = function () {
    var to = U.S.week || monday(today()), from = addDays(to, -7);
    if (confirm("把 " + from + " 那週的班表複製到 " + to + " 這週？（時段衝突或已停用的員工會略過）"))
      U.act("shift.copy_week", { from: from, to: to }).then(function (r) { if (r) alert(r); });
  };
  H["shift-new"] = function () { shiftForm(null); };
  H["shift-new-at"] = function (k) { var a = k.split("|"); shiftForm(null, a[0], a[1]); };
  H["shift-edit"] = function (id) { U.openRec("shifts", id); };
  H["att-new"] = function () { attForm(null); };
  H["att-edit"] = function (id) { attForm(U.byId("attendance", id)); };
  H["att-void"] = function (id) {
    U.form({ title: "作廢出勤", fields: [{ k: "reason", l: "原因（必填）", type: "textarea", req: 1, ph: "例：登錄錯日期" }],
      submit: function (v) { return U.act("attendance.void", { id: id, reason: v.reason }); } });
  };
  H["csv-att"] = function () {
    var ym = (U.S.attDate || today()).slice(0, 7);
    U.csv("出勤_" + ym, ["日期", "編號", "姓名", "上班", "下班", "休息(分)", "工時", "狀態", "作廢原因", "登錄人"], W().attendance.filter(function (a) { return a.date.slice(0, 7) === ym; })
      .sort(function (a, b) { return (a.date + a.staff_id).localeCompare(b.date + b.staff_id); })
      .map(function (a) { var s = U.byId("staff", a.staff_id) || {}; return [a.date, s.code, s.name, a.clock_in, a.clock_out, a.break_min, a.status === "有效" ? X.workHours(a) : "", a.status, a.void_reason, a.by]; }));
  };
  H["req-filter"] = function (s) { U.S.reqFilter = s; U.render(); };
  H["req-new"] = function () { reqForm(null); };
  H["req-edit"] = function (id) { reqForm(U.byId("requests", id)); };
  H["req-view"] = function (id) { U.openRec("requests", id); };
  H["req-submit"] = function (id) { U.act("request.submit", { id: id }); };
  H["req-approve"] = noteAct("request.approve", "核准申請", false);
  H["req-return"] = noteAct("request.return", "退回申請", true);
  H["req-withdraw"] = function (id) { if (confirm("撤回這張申請？")) U.act("request.withdraw", { id: id }); };
  H["equip-new"] = function () { equipForm(null); };
  H["equip-edit"] = function (id) { equipForm(U.byId("equipment", id)); };
  H["res-new"] = function () { resForm(null); };
  H["res-new-for"] = function (id) { resForm(id); };
  H["res-return"] = function (id) { U.act("reservation.return", { id: id }); };
  H["res-cancel"] = function (id) { if (confirm("取消這筆預約？")) U.act("reservation.cancel", { id: id }); };
  H["notice-new"] = function () { noticeForm(null); };
  H["notice-edit"] = function (id) { noticeForm(U.byId("notices", id)); };
  H["notice-archive"] = function (id) { U.act("notice.archive", { id: id }); };
  H["notice-restore"] = function (id) { U.act("notice.restore", { id: id }); };
  document.addEventListener("change", function (e) {
    var k = e.target.getAttribute && e.target.getAttribute("data-a-change");
    if (k === "att-date") { U.S.attDate = e.target.value; U.render(); }
    if (k === "res-date") { U.S.resDate = e.target.value; U.render(); }
  });

  // 行政示範資料（只在本機）
  H["admin-demo"] = function () {
    var w = U.W(), ctx = { by: "示範", today: today(), allowSelfApprove: true };
    var a = function (x, p) { return E.apply(w, x, p, ctx).result; };
    var hq = a("unit.save", { name: "九上科技神岡廠", kind: "工廠" });
    var mf = a("unit.save", { name: "生產課", kind: "部門", parent_id: hq });
    var qc = a("unit.save", { name: "品管課", kind: "部門", parent_id: hq });
    var of = a("unit.save", { name: "行政管理部", kind: "部門", parent_id: hq });
    var s1 = a("staff.save", { code: "E001", name: "陳組長", unit_id: mf, title: "CNC 組長", hire_date: "2019-03-01" });
    var s2 = a("staff.save", { code: "E002", name: "阮文雄", unit_id: mf, title: "CNC 技術員", hire_date: "2023-08-15" });
    var s3 = a("staff.save", { code: "E003", name: "林品管", unit_id: qc, title: "品管員", hire_date: "2021-05-10" });
    a("staff.save", { code: "E004", name: "王行政", unit_id: of, title: "行政專員", hire_date: "2020-01-06" });
    var wk = monday(today());
    [s1, s2, s3].forEach(function (s, i) { for (var d = 0; d < 5; d++) a("shift.save", { staff_id: s, date: addDays(wk, d), start: i === 1 ? "20:00" : "08:00", end: i === 1 ? "05:00" : "17:00", break_min: 60 }); });
    var t = today();
    if (w.shifts.some(function (x) { return x.date === t && x.staff_id === s1; })) a("attendance.save", { staff_id: s1, date: t, clock_in: "08:12", clock_out: "17:00", break_min: 60 });
    var q = a("request.save", { staff_id: s2, kind: "請假", leave_type: "特休", start_date: addDays(t, 3), end_date: addDays(t, 3), hours: 8, reason: "返鄉辦理居留證" });
    a("request.submit", { id: q });
    var g = a("equipment.save", { name: "三次元量測儀", code: "CMM-01", location: "品管室" });
    a("equipment.save", { name: "堆高機", code: "FL-02", location: "倉庫" });
    a("reservation.save", { equipment_id: g, staff_id: s3, date: t, start: "13:30", end: "15:00", purpose: "支架首件量測" });
    a("notice.save", { title: "10 月消防演練", body: "本週五 15:00 全廠消防演練，請各課主管清點人數。", pinned: true });
    a("notice.save", { title: "新進同仁到職", body: "歡迎阮文雄加入生產課夜班。" });
    U.lsSet("erp_world_local", w); U.render();
  };
})();
