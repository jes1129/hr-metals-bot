/*
 * erp-admin.js — 行政工作台規則（掛在 ErpEngine 上的擴充模組；同樣在瀏覽器、Apps Script、Node 測試三處執行）
 *
 * 組織／部門、員工、週班表（可整週複製）、手動出勤（作廢要寫原因）、
 * 申請（請假／加班／出差／採購…：草稿 → 送出 → 核准或退回 → 退回可修改再送；送出後可撤回）、
 * 設備與預約（同設備時段不可重疊）、公告（置頂、封存）。
 * 移植自 mars-tw/freedom-erp-crm（MIT）行政工作台的流程規則，改為真實帳號簽核（不能核准自己送出的申請）。
 */
(function (root) {
  "use strict";
  var E = root.ErpEngine || (typeof require === "function" ? require("./erp-engine.js") : null);
  var H = E.h, need = H.need, str = H.str, find = H.find, touch = H.touch, isDate = H.isDate, today = H.today;

  var UNIT_KINDS = ["公司", "工廠", "辦公室", "門市", "部門"];
  var REQ_KINDS = ["請假", "加班", "出差", "採購", "其他"];
  var LEAVE_TYPES = ["特休", "事假", "病假", "公假", "婚假", "喪假", "產假", "其他"];
  var REQ_STATUS = ["草稿", "已送出", "已核准", "已退回", "已撤回"];

  var TABLES = {
    units: { sheet: "ERP_組織", cols: ["id", "name", "kind", "parent_id", "active", "note", "created"], bool: ["active"] },
    staff: { sheet: "ERP_員工", cols: ["id", "code", "name", "unit_id", "title", "phone", "email", "hire_date", "active", "note", "created"], bool: ["active"] },
    shifts: { sheet: "ERP_班表", cols: ["id", "staff_id", "date", "start", "end", "break_min", "status", "note", "created"], num: ["break_min"] },
    attendance: { sheet: "ERP_出勤", cols: ["id", "staff_id", "date", "clock_in", "clock_out", "break_min", "status", "void_reason", "note", "by", "created"], num: ["break_min"] },
    requests: { sheet: "ERP_申請", cols: ["id", "no", "staff_id", "kind", "leave_type", "start_date", "start_time", "end_date", "end_time", "hours", "reason", "status", "created_by", "reviewer", "review_note", "history", "created"], num: ["hours"], json: ["history"] },
    equipment: { sheet: "ERP_設備", cols: ["id", "code", "name", "location", "active", "note", "created"], bool: ["active"] },
    reservations: { sheet: "ERP_設備預約", cols: ["id", "equipment_id", "staff_id", "date", "start", "end", "purpose", "status", "by", "created"] },
    notices: { sheet: "ERP_公告", cols: ["id", "title", "body", "pinned", "status", "by", "created", "updated"], bool: ["pinned"] }
  };

  // ---------- 時間工具（HH:MM；結束早於開始＝跨夜） ----------
  function hm(v, label) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
    need(m && +m[1] < 24 && +m[2] < 60, (label || "時間") + "請用 HH:MM（例 08:30）");
    return (m[1].length === 1 ? "0" : "") + m[1] + ":" + m[2];
  }
  function mins(t) { var a = t.split(":"); return +a[0] * 60 + +a[1]; }
  function dayIndex(d) { return Math.round(Date.parse(d + "T00:00:00Z") / 86400000); }
  function span(date, start, end) {      // 以「天數×1440＋分鐘」表示絕對區間，跨夜自動 +1 天
    var a = dayIndex(date) * 1440 + mins(start), b = dayIndex(date) * 1440 + mins(end);
    if (b <= a) b += 1440;
    return [a, b];
  }
  function overlap(x, y) { return x[0] < y[1] && y[0] < x[1]; }
  function weekday(d) { return new Date(d + "T00:00:00Z").getUTCDay(); }   // 0=日 1=一
  function needDate(v, label) { need(isDate(v), (label || "日期") + "格式不符"); return v; }
  function oneOf(v, list, def, label) { v = str(v) || def; need(list.indexOf(v) >= 0, (label || "選項") + "不符"); return v; }
  function activeStaff(w, id) { var s = find(w, "staff", id, "員工"); need(s.active !== false, "「" + s.name + "」已停用"); return s; }

  var A = {};

  // ---- 組織／部門（可有上層，不能形成循環） ----
  A["unit.save"] = function (w, p, ctx) {
    var name = str(p.name, 60); need(name, "請填單位名稱");
    w.units.forEach(function (u) { need(u.name !== name || u.id === p.id, "單位「" + name + "」已存在"); });
    var u = p.id ? find(w, "units", p.id, "單位") : { id: ctx.newId("U"), active: true, created: today(ctx) };
    var parent = p.parent_id ? find(w, "units", p.parent_id, "上層單位") : null;
    for (var cur = parent; cur; cur = cur.parent_id ? H.findOpt(w, "units", cur.parent_id) : null) need(cur.id !== u.id, "上層單位不能是自己或下層");
    u.name = name; u.kind = oneOf(p.kind, UNIT_KINDS, "部門", "單位類型"); u.parent_id = parent ? parent.id : ""; u.note = str(p.note, 300);
    if (p.active !== undefined) u.active = !!p.active;
    if (!p.id) w.units.push(u);
    touch(ctx, "units", u);
    return u.id;
  };
  A["unit.delete"] = function (w, p, ctx) {
    var u = find(w, "units", p.id, "單位");
    need(!w.staff.some(function (s) { return s.unit_id === u.id; }) && !w.units.some(function (x) { return x.parent_id === u.id; }), "此單位還有員工或下層單位，不能刪除；請改為停用");
    H.del(w, ctx, "units", u);
    return u.id;
  };

  // ---- 員工（員工編號建立後固定；離職請停用，保留歷史） ----
  A["staff.save"] = function (w, p, ctx) {
    var code = str(p.code, 20), name = str(p.name, 40);
    need(code, "請填員工編號"); need(name, "請填姓名");
    var s = p.id ? find(w, "staff", p.id, "員工") : null;
    if (s) need(s.code === code, "員工編號建立後不能修改");
    else w.staff.forEach(function (x) { need(x.code !== code, "員工編號「" + code + "」已存在"); });
    var unit = find(w, "units", p.unit_id, "所屬單位");
    var rec = s || { id: ctx.newId("E"), code: code, active: true, created: today(ctx) };
    rec.name = name; rec.unit_id = unit.id;
    ["title", "phone", "email", "note"].forEach(function (k) { rec[k] = str(p[k], k === "note" ? 300 : 80); });
    rec.hire_date = isDate(p.hire_date) ? p.hire_date : "";
    if (p.active !== undefined) rec.active = !!p.active;
    if (!s) w.staff.push(rec);
    touch(ctx, "staff", rec);
    return rec.id;
  };

  // ---- 班表（同一人時段不能重疊；可整週複製） ----
  function shiftClash(w, staffId, sp, exceptId) {
    return w.shifts.filter(function (x) {
      return x.staff_id === staffId && x.status !== "已取消" && x.id !== exceptId && overlap(sp, span(x.date, x.start, x.end));
    })[0];
  }
  A["shift.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id), date = needDate(p.date, "日期");
    var start = hm(p.start, "上班時間"), end = hm(p.end, "下班時間");
    var brk = Math.round(Number(p.break_min) || 0); need(brk >= 0 && brk < 600, "休息分鐘不符");
    var sp = span(date, start, end); need(sp[1] - sp[0] > brk, "休息時間不能比班長");
    var x = p.id ? find(w, "shifts", p.id, "班次") : null;
    if (x) need(x.status === "排定", "只有「排定」的班次可以修改");
    var c = shiftClash(w, st.id, sp, x && x.id);
    need(!c, "「" + st.name + "」在 " + (c && c.date) + " " + (c && c.start) + "–" + (c && c.end) + " 已有班次，時段重疊");
    var r = x || { id: ctx.newId("H"), status: "排定", created: today(ctx) };
    r.staff_id = st.id; r.date = date; r.start = start; r.end = end; r.break_min = brk; r.note = str(p.note, 200);
    if (!x) w.shifts.push(r);
    touch(ctx, "shifts", r);
    return r.id;
  };
  A["shift.cancel"] = function (w, p, ctx) {
    var x = find(w, "shifts", p.id, "班次"); need(x.status === "排定", "只有「排定」的班次可以取消");
    x.status = "已取消"; touch(ctx, "shifts", x); return x.id;
  };
  A["shift.complete"] = function (w, p, ctx) {
    var x = find(w, "shifts", p.id, "班次"); need(x.status === "排定", "只有「排定」的班次可以標記完成");
    x.status = "已完成"; touch(ctx, "shifts", x); return x.id;
  };
  A["shift.copy_week"] = function (w, p, ctx) {
    var from = needDate(p.from, "來源週"), to = needDate(p.to, "目標週");
    need(weekday(from) === 1 && weekday(to) === 1, "請選兩個星期一（整週複製）");
    need(from !== to, "來源週與目標週相同");
    var diff = dayIndex(to) - dayIndex(from), copied = 0, skipped = 0;
    w.shifts.filter(function (x) { var d = dayIndex(x.date) - dayIndex(from); return d >= 0 && d < 7 && x.status !== "已取消"; })
      .forEach(function (x) {
        var nd = new Date((dayIndex(x.date) + diff) * 86400000).toISOString().slice(0, 10);
        var st = H.findOpt(w, "staff", x.staff_id);
        if (!st || st.active === false || shiftClash(w, x.staff_id, span(nd, x.start, x.end))) { skipped++; return; }
        var r = { id: ctx.newId("H"), staff_id: x.staff_id, date: nd, start: x.start, end: x.end, break_min: x.break_min, status: "排定", note: x.note, created: today(ctx) };
        w.shifts.push(r); touch(ctx, "shifts", r); copied++;
      });
    need(copied + skipped > 0, "來源週沒有班次可以複製");
    return "複製 " + copied + " 班" + (skipped ? "，略過 " + skipped + " 班（時段衝突或員工已停用）" : "");
  };

  // ---- 出勤（手動輸入；作廢要寫原因並保留紀錄） ----
  A["attendance.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id), date = needDate(p.date, "日期");
    var cin = hm(p.clock_in, "上班打卡"), cout = p.clock_out ? hm(p.clock_out, "下班打卡") : "";
    var brk = Math.round(Number(p.break_min) || 0); need(brk >= 0 && brk < 600, "休息分鐘不符");
    var x = p.id ? find(w, "attendance", p.id, "出勤") : null;
    if (x) need(x.status === "有效", "已作廢的出勤不能修改");
    var dup = w.attendance.filter(function (a) { return a.staff_id === st.id && a.date === date && a.status === "有效" && (!x || a.id !== x.id); })[0];
    need(!dup, "「" + st.name + "」" + date + " 已有出勤紀錄，請直接修改那筆");
    var r = x || { id: ctx.newId("A"), status: "有效", void_reason: "", created: today(ctx) };
    r.staff_id = st.id; r.date = date; r.clock_in = cin; r.clock_out = cout; r.break_min = brk; r.note = str(p.note, 200); r.by = ctx.by;
    if (!x) w.attendance.push(r);
    touch(ctx, "attendance", r);
    return r.id;
  };
  A["attendance.void"] = function (w, p, ctx) {
    var x = find(w, "attendance", p.id, "出勤"); need(x.status === "有效", "這筆已作廢");
    var reason = str(p.reason, 200); need(reason, "作廢請寫原因");
    x.status = "已作廢"; x.void_reason = reason; x.by = ctx.by; touch(ctx, "attendance", x); return x.id;
  };

  // ---- 申請與簽核 ----
  function hist(r, ctx, action, note) { r.history.push({ date: today(ctx), by: ctx.by, action: action, note: note || "" }); }
  A["request.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id);
    var x = p.id ? find(w, "requests", p.id, "申請") : null;
    if (x) need(x.status === "草稿" || x.status === "已退回", "送出後不能修改；請先撤回");
    var kind = oneOf(p.kind, REQ_KINDS, "請假", "申請類別");
    var sd = needDate(p.start_date, "開始日期"), ed = needDate(p.end_date || p.start_date, "結束日期");
    need(ed >= sd, "結束日期不能早於開始日期");
    var stt = p.start_time ? hm(p.start_time, "開始時間") : "", ett = p.end_time ? hm(p.end_time, "結束時間") : "";
    if (sd === ed && stt && ett) need(mins(ett) > mins(stt), "結束時間要晚於開始時間");
    var hours = Math.round((Number(p.hours) || 0) * 10) / 10; need(hours >= 0 && hours <= 2000, "時數不符");
    var reason = str(p.reason, 500); need(reason, "請寫申請事由");
    var r = x || { id: ctx.newId("Q"), no: H.nextNo(w, ctx, "AP"), status: "草稿", created_by: ctx.by, reviewer: "", review_note: "", history: [], created: today(ctx) };
    r.staff_id = st.id; r.kind = kind; r.leave_type = kind === "請假" ? oneOf(p.leave_type, LEAVE_TYPES, "特休", "假別") : "";
    r.start_date = sd; r.end_date = ed; r.start_time = stt; r.end_time = ett; r.hours = hours; r.reason = reason;
    if (!x) { hist(r, ctx, "建立草稿"); w.requests.push(r); } else hist(r, ctx, "修改");
    touch(ctx, "requests", r);
    return r.id;
  };
  function reqStep(from, to, label, needNote) {
    return function (w, p, ctx) {
      var r = find(w, "requests", p.id, "申請");
      need(from.indexOf(r.status) >= 0, "目前狀態「" + r.status + "」不能" + label);
      var note = str(p.note, 300);
      if (needNote) need(note, label + "請寫原因");
      if (to === "已核准") need(ctx.allowSelfApprove || !r.created_by || r.created_by !== ctx.by, "不能核准自己送出的申請，請由另一位主管核准");
      if (to === "已核准" || to === "已退回") { r.reviewer = ctx.by; r.review_note = note; }
      r.status = to; hist(r, ctx, label, note);
      touch(ctx, "requests", r);
      return r.id;
    };
  }
  A["request.submit"] = reqStep(["草稿", "已退回"], "已送出", "送出");
  A["request.approve"] = reqStep(["已送出"], "已核准", "核准");
  A["request.return"] = reqStep(["已送出"], "已退回", "退回", true);
  A["request.withdraw"] = reqStep(["已送出"], "已撤回", "撤回");
  A["request.delete"] = function (w, p, ctx) {
    var r = find(w, "requests", p.id, "申請"); need(r.status === "草稿", "只有草稿可以刪除"); H.del(w, ctx, "requests", r); return r.id;
  };

  // ---- 設備與預約 ----
  A["equipment.save"] = function (w, p, ctx) {
    var name = str(p.name, 60); need(name, "請填設備名稱");
    var code = str(p.code, 30);
    if (code) w.equipment.forEach(function (x) { need(x.code !== code || x.id === p.id, "設備編號「" + code + "」已存在"); });
    var e = p.id ? find(w, "equipment", p.id, "設備") : { id: ctx.newId("G"), active: true, created: today(ctx) };
    e.name = name; e.code = code; e.location = str(p.location, 60); e.note = str(p.note, 300);
    if (p.active !== undefined) e.active = !!p.active;
    if (!p.id) w.equipment.push(e);
    touch(ctx, "equipment", e);
    return e.id;
  };
  A["reservation.save"] = function (w, p, ctx) {
    var e = find(w, "equipment", p.equipment_id, "設備"); need(e.active !== false, "「" + e.name + "」已停用");
    if (p.staff_id) activeStaff(w, p.staff_id);
    var date = needDate(p.date, "日期"), start = hm(p.start, "開始時間"), end = hm(p.end, "結束時間");
    var sp = span(date, start, end);
    var x = p.id ? find(w, "reservations", p.id, "預約") : null;
    if (x) need(x.status === "預約中", "只有「預約中」可以修改");
    var c = w.reservations.filter(function (r) { return r.equipment_id === e.id && r.status === "預約中" && (!x || r.id !== x.id) && overlap(sp, span(r.date, r.start, r.end)); })[0];
    need(!c, "「" + e.name + "」" + (c && c.date) + " " + (c && c.start) + "–" + (c && c.end) + " 已被預約");
    var r = x || { id: ctx.newId("B"), status: "預約中", created: today(ctx) };
    r.equipment_id = e.id; r.staff_id = p.staff_id || ""; r.date = date; r.start = start; r.end = end;
    r.purpose = str(p.purpose, 200); need(r.purpose, "請寫用途"); r.by = ctx.by;
    if (!x) w.reservations.push(r);
    touch(ctx, "reservations", r);
    return r.id;
  };
  A["reservation.cancel"] = function (w, p, ctx) {
    var r = find(w, "reservations", p.id, "預約"); need(r.status === "預約中", "這筆預約已結束"); r.status = "已取消"; touch(ctx, "reservations", r); return r.id;
  };
  A["reservation.return"] = function (w, p, ctx) {
    var r = find(w, "reservations", p.id, "預約"); need(r.status === "預約中", "這筆預約已結束"); r.status = "已歸還"; touch(ctx, "reservations", r); return r.id;
  };

  // ---- 公告 ----
  A["notice.save"] = function (w, p, ctx) {
    var title = str(p.title, 100); need(title, "請填公告標題");
    var n = p.id ? find(w, "notices", p.id, "公告") : { id: ctx.newId("O"), status: "公告中", created: today(ctx) };
    n.title = title; n.body = str(p.body, 2000); n.pinned = !!p.pinned; n.by = ctx.by; n.updated = today(ctx);
    if (!p.id) w.notices.push(n);
    touch(ctx, "notices", n);
    return n.id;
  };
  A["notice.archive"] = function (w, p, ctx) { var n = find(w, "notices", p.id, "公告"); need(n.status === "公告中", "已封存"); n.status = "已封存"; n.pinned = false; touch(ctx, "notices", n); return n.id; };
  A["notice.restore"] = function (w, p, ctx) { var n = find(w, "notices", p.id, "公告"); need(n.status === "已封存", "公告中"); n.status = "公告中"; touch(ctx, "notices", n); return n.id; };

  // ---------- 報表：今天的班、出勤差異、待簽核、今日預約、公告 ----------
  function report(w, t, r) {
    w.staff = w.staff || []; w.shifts = w.shifts || []; w.attendance = w.attendance || [];
    w.requests = w.requests || []; w.reservations = w.reservations || []; w.notices = w.notices || [];
    r.staff_active = w.staff.filter(function (s) { return s.active !== false; }).length;
    r.shifts_today = w.shifts.filter(function (x) { return x.date === t && x.status !== "已取消"; });
    r.requests_pending = w.requests.filter(function (x) { return x.status === "已送出"; });
    r.reservations_today = w.reservations.filter(function (x) { return x.date === t && x.status === "預約中"; });
    r.notices_active = w.notices.filter(function (x) { return x.status === "公告中"; })
      .sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)); });
    r.attendance_diff = diff(w, t);
  }
  // 班表 vs 出勤：遲到（>5 分）、早退（>5 分）、有班沒出勤
  function diff(w, date) {
    var out = [];
    w.shifts.filter(function (x) { return x.date === date && x.status !== "已取消"; }).forEach(function (x) {
      var a = w.attendance.filter(function (y) { return y.staff_id === x.staff_id && y.date === date && y.status === "有效"; })[0];
      var st = H.findOpt(w, "staff", x.staff_id) || { name: "?" };
      if (!a) { out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "沒有出勤紀錄" }); return; }
      var late = mins(a.clock_in) - mins(x.start);
      if (late > 5) out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "遲到 " + late + " 分" });
      if (a.clock_out) {
        var early = mins(x.end) - mins(a.clock_out);
        if (mins(x.end) > mins(x.start) && early > 5) out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "早退 " + early + " 分" });
      }
    });
    return out;
  }
  function workHours(a) {      // 出勤時數（扣休息）
    if (!a.clock_out) return 0;
    var sp = span(a.date, a.clock_in, a.clock_out);
    return Math.max(0, Math.round((sp[1] - sp[0] - (a.break_min || 0)) / 6) / 10);
  }

  E.extend({
    tables: TABLES, actions: A, report: report,
    refs: { staff: { unit_id: "units" }, shifts: { staff_id: "staff" }, attendance: { staff_id: "staff" },
      requests: { staff_id: "staff" }, reservations: { equipment_id: "equipment" } }
  });
  E.admin = { UNIT_KINDS: UNIT_KINDS, REQ_KINDS: REQ_KINDS, LEAVE_TYPES: LEAVE_TYPES, REQ_STATUS: REQ_STATUS,
    diff: diff, workHours: workHours, weekday: weekday, span: span };
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof window !== "undefined" ? window : this);
