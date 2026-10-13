/*
 * erp-roles.js — 職能分工規則（純計算，沒有畫面也沒有儲存）
 *
 * 同一份程式在三個地方執行：瀏覽器（隱藏看不到的欄位）、Apps Script（真正擋下不該做的操作、
 * 把看不到的欄位在伺服器端就拿掉）、Node（tests/roles.test.mjs 驗算）。
 * 真正的把關在伺服器端；瀏覽器只是不顯示。
 *
 * 職務：老闆／主管／業務／生管倉管／會計／行政／唯讀。
 * 原則：業務看不到成本與毛利；人事資料只有老闆、主管、行政、會計看得到；會計只管收付款；
 *       匯入備份、帳號設定只有老闆與主管能做；還沒設定任何帳號時維持原狀（所有登入者權限相同），避免把自己鎖在門外。
 */
(function (root) {
  "use strict";

  var ROLES = {
    boss:    { name: "老闆",     all: true,  seeCost: true,  seePersonnel: true,  manage: true,  rank: 7 },
    manager: { name: "主管",     all: true,  seeCost: true,  seePersonnel: true,  manage: false, rank: 6 },
    sales:   { name: "業務",     seeCost: false, seePersonnel: false, rank: 3,
      can: ["customer.", "deal.", "quote.", "contact.", "case.", "task.", "milestone.", "reservation.", "request.save", "request.submit", "request.withdraw", "request.delete",
            "order.create", "order.update", "order.ship", "order.cancel",
            "service.save", "service.confirm", "service.deliver", "service.accept", "service.request_changes"] },
    ops:     { name: "生管／倉管", seeCost: false, seePersonnel: false, rank: 3,
      can: ["item.", "stock.", "bom.", "wo.", "task.", "milestone.", "reservation.", "equipment.save", "request.save", "request.submit", "request.withdraw", "request.delete",
            "order.ship", "order.return"] },
    finance: { name: "會計",     seeCost: true,  seePersonnel: true,  rank: 4,
      can: ["order.pay", "order.refund", "service.pay", "reservation.", "request.save", "request.submit", "request.withdraw", "request.delete"] },
    admin:   { name: "行政",     seeCost: false, seePersonnel: true,  rank: 4,
      can: ["unit.", "staff.", "shift.", "attendance.", "request.", "equipment.", "reservation.", "notice.", "task.", "milestone."] },
    viewer:  { name: "唯讀",     seeCost: false, seePersonnel: false, rank: 1, can: [] }
  };
  var ORDER = ["boss", "manager", "sales", "ops", "finance", "admin", "viewer"];

  // 看得到成本才算得出來的欄位／整張表
  var COST_FIELDS = { items: ["std_cost"], lots: ["unit_cost"], moves: ["value"], workorders: ["extra_cost", "actual_cost"] };
  var COST_TABLES = ["receipts"];                                   // 進貨單全是進價
  var PERSONNEL_TABLES = ["staff", "shifts", "attendance", "requests"];

  function role(r) { return ROLES[r] || null; }
  function name(r) { return ROLES[r] ? ROLES[r].name : String(r || ""); }

  /** 這個職務能不能執行這個 ERP 動作（action 例：order.pay） */
  function can(r, action) {
    var d = ROLES[r]; if (!d) return false;
    if (d.all) return true;
    var list = d.can || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.charAt(p.length - 1) === "." ? String(action).indexOf(p) === 0 : action === p) return true;
    }
    return false;
  }

  /** 只有老闆、主管能匯入備份（整份取代）；只有老闆能管帳號 */
  function canImport(r) { return !!(ROLES[r] && ROLES[r].all); }
  function canManage(r) { return !!(ROLES[r] && ROLES[r].manage); }

  /** 一般資料表（非 ERP_ 分頁）的存取：write=是否為寫入 */
  function canTable(r, table, write) {
    var d = ROLES[r]; if (!d) return false;
    var t = String(table || "");
    if (t === "acl") return d.manage === true;                                 // 帳號表只有老闆能讀寫
    if (t === "高風險操作") return !write && d.all === true;                     // 高風險紀錄由伺服器寫入，老闆、主管可讀
    if (/^ERP_/.test(t) || t === "backup_log") return d.all === true;          // ERP 分頁只透過 ERP 動作存取；直接讀寫限老闆／主管
    if (!write) return true;
    if (r === "viewer") return false;
    if (/^sched_(notice|alert)$/.test(t)) return true;                        // 通知中心「已知悉」
    if (/^sched/.test(t)) return d.all === true || r === "ops";                // 排程設定與資料：老闆、主管、生管
    return true;
  }

  /** 伺服器端把這個職務看不到的欄位拿掉（回傳新物件，不改原本的）。world.meta.access 讓畫面知道要顯示「—」 */
  function redact(world, r) {
    var d = ROLES[r] || ROLES.viewer, w = JSON.parse(JSON.stringify(world));
    w.meta = w.meta || {};
    w.meta.access = { role: r, name: d.name, seeCost: !!d.seeCost, seePersonnel: !!d.seePersonnel };
    if (!d.seeCost) {
      Object.keys(COST_FIELDS).forEach(function (t) {
        (w[t] || []).forEach(function (row) { COST_FIELDS[t].forEach(function (f) { if (f in row) row[f] = null; }); });
      });
      COST_TABLES.forEach(function (t) { if (w[t]) w[t] = []; });
      (w.items || []).forEach(function (it) { it.cost_hidden = true; });
      (w.workorders || []).forEach(function (row) { (row.consumed || []).forEach(function (c) { delete c.value; }); });
      (w.orders || []).forEach(function (o) { (o.lines || []).forEach(function (l) { delete l.cost_layers; delete l.cost; delete l.unit_cost; }); });
    }
    if (!d.seePersonnel) PERSONNEL_TABLES.forEach(function (t) { if (w[t]) w[t] = []; });
    return w;
  }

  var api = { ROLES: ROLES, ORDER: ORDER, role: role, name: name, can: can, canImport: canImport, canManage: canManage, canTable: canTable, redact: redact,
    COST_FIELDS: COST_FIELDS, PERSONNEL_TABLES: PERSONNEL_TABLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ErpRoles = api;
})(typeof window !== "undefined" ? window : this);
