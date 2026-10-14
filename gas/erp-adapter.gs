// ===========================================================================
// ERP 後端（Apps Script 端）：把 ErpEngine 的資料放進試算表的 ERP_* 分頁
//
// 與原系統的關係：
//   - 只由 google-apps-script.gs 的 doPost「default」分支轉進來（先已通過登入與白名單驗證）。
//   - 只讀寫「ERP_」開頭的分頁，不碰 訂單/我的名單/收藏標記/報價紀錄 等既有分頁。
//   - 沒加入本檔時，原系統行為完全不變。
//
// 一致性：每次操作都在 LockService 鎖內「讀全部 → 引擎計算 → 只回寫有變的列」；
//         引擎檢查失敗就整筆放棄、不寫任何東西。前端每次操作帶唯一 key，重送不會重複執行。
// ===========================================================================
var ERP_LOG_SHEET = "ERP_操作紀錄";
var ERP_LOG_COLS = ["ts", "by", "action", "key", "result", "payload"];

// 版本：網頁（docs/assets/app.js 的 NEED）會用 appVersion 問後端「你是第幾版」，對不上就警告。
// 改了後端的對外行為、而網頁需要新行為時，把 GAS_API 加 1，並同步改 app.js 的 NEED.erp。
var GAS_BUILD = "2026.10.14";
var GAS_API = 2;                                // 2：內控治理（gov_ 資料表只有老闆、主管能寫；每月內控月報）

function erpBackup_() {                                // 備份狀態讀不到也不能讓版本查詢失敗
  try { return typeof backupStatus_ === "function" ? backupStatus_() : null; } catch (e) { return null; }
}

function erpAccess_(email) {                            // 網頁用：我是誰、什麼職務、權限控管有沒有啟用
  try { var a = aclRole_(email); return { configured: a.configured, role: a.role, name: a.role ? ErpRoles.name(a.role) : "", why: a.why }; } catch (e) { return null; }
}

function erpVersion_(email) {
  return { ok: true, build: GAS_BUILD, api: {
    erp: GAS_API,
    alerts: typeof SA_API !== "undefined" ? SA_API : null,       // 沒貼 sched-alerts.gs → null（網頁會提示尚未安裝）
    digest: typeof EMAIL_API !== "undefined" ? EMAIL_API : null,
    backup: typeof BK_API !== "undefined" ? BK_API : null
  }, backup: erpBackup_(), access: erpAccess_(email) };
}

function erpDispatch_(action, p, email) {
  if (action === "appVersion") return erpVersion_(email);                  // 任何通過登入的人都能看版本（不含資料）
  if (action !== "erpLoad" && action !== "erpAct" && action !== "erpImport") return null;   // 不是 ERP 的 action → 交回原本的 unknown action
  // ERP 含售價、成本、毛利：可在「專案設定 → 指令碼屬性」加 ERP_EMAILS（逗號分隔）限定誰能用；
  // 沒設 = 所有通過主檔白名單的人都能用。其他功能（訂單看板、資料庫…）不受影響。
  var only = String(PropertiesService.getScriptProperties().getProperty("ERP_EMAILS") || "").trim();
  if (only && only.split(/\s*,\s*/).map(function (x) { return x.toLowerCase(); }).indexOf(String(email).toLowerCase()) < 0) {
    return { error: "此帳號沒有 ERP 權限（請管理者把你加入 ERP_EMAILS）：" + email };
  }
  // 職能分工：沒設定任何帳號（acl 空）= 維持原狀；設定後依職務把關，看不到的欄位在這裡就拿掉
  var acc = aclRole_(email), role = acc.role;
  if (acc.configured && !role) return { error: acc.why };
  var cut = function (out) { if (acc.configured && out && out.world) out.world = ErpRoles.redact(out.world, role); return out; };
  if (action === "erpLoad") return cut({ ok: true, world: erpLoad_() });
  if (action === "erpImport") {
    if (acc.configured && !ErpRoles.canImport(role)) return { error: "你的職務（" + ErpRoles.name(role) + "）不能匯入備份" };
    var imp = erpImport_(p || {}, email);
    if (imp && !imp.error) aclRisk_("匯入備份（整份取代 ERP 資料）", email, role, "匯入 " + Object.keys((p && p.world) || {}).length + " 個資料表");
    return imp;
  }
  if (acc.configured && !ErpRoles.can(role, String((p && p.action) || ""))) return { error: "你的職務（" + ErpRoles.name(role) + "）不能執行：" + String((p && p.action) || "") };
  var out = erpAct_(p || {}, email);
  if (out && out.ok && /\.delete$/.test(String((p && p.action) || "")) && aclCount_(email, 1) >= ACL_DEL_LIMIT) aclRisk_("短時間大量刪除", email, role, "10 分鐘內已刪 " + ACL_DEL_LIMIT + " 筆以上（最近：" + p.action + "）");
  return cut(out);
}

// 匯入備份（整份取代 ERP_ 分頁）：先完整檢查，不通過就什麼都不寫；寫入前在操作紀錄留一筆
function erpImport_(p, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var src = p.world || {}, w = ErpEngine.empty();
    Object.keys(ErpEngine.TABLES).forEach(function (t) { if (Array.isArray(src[t])) w[t] = src[t]; });
    if (src.meta && typeof src.meta === "object") w.meta = { seq: src.meta.seq || {}, lotseq: Number(src.meta.lotseq) || 0 };
    var errs = ErpEngine.validate(w);
    if (errs.length) return { error: "備份檔檢查沒通過，未匯入：\n" + errs.slice(0, 8).join("\n") };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = erpSheet_(ss, ERP_LOG_SHEET, ERP_LOG_COLS);
    erpAppend_(log, [[new Date().toISOString(), email, "erpImport", "", "", "匯入備份：" + Object.keys(ErpEngine.TABLES).map(function (t) { return t + "=" + w[t].length; }).join(" ")]]);
    Object.keys(ErpEngine.TABLES).forEach(function (t) {
      var def = ErpEngine.TABLES[t], sh = ss.getSheetByName(def.sheet);
      if (!sh && !w[t].length) return;
      sh = sh || erpSheet_(ss, def.sheet, def.cols);
      var hdr = erpHeader_(sh, def.cols);
      if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), hdr.length)).clearContent();
      if (w[t].length) erpAppend_(sh, w[t].map(function (r) { return hdr.map(function (h) { return erpEncode_(r[h]); }); }), hdr.length);
    });
    var m = erpSheet_(ss, ErpEngine.META_SHEET, ["key", "value"]);
    m.getRange(2, 1, 1, 2).setNumberFormat("@").setValues([["meta", JSON.stringify(w.meta)]]);
    return { ok: true, world: erpLoad_() };
  } finally {
    lock.releaseLock();
  }
}

function erpAct_(p, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var key = String(p.key || "").slice(0, 80);
    var log = erpSheet_(ss, ERP_LOG_SHEET, ERP_LOG_COLS);
    if (key) {
      var prev = erpFindKey_(log, key);
      if (prev !== null) return { ok: true, result: prev, world: erpLoad_(), replay: true };
    }
    var w = erpLoad_();
    var now = new Date();
    var r;
    try {
      r = ErpEngine.apply(w, String(p.action || ""), p.payload || {}, {
        by: email, now: now.toISOString(), today: Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd")
      });
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
    erpSave_(ss, w, r.dirty);
    erpAppend_(log, [[now.toISOString(), email, String(p.action), key, String(r.result || ""), JSON.stringify(p.payload || {}).slice(0, 2000)]]);
    return { ok: true, result: r.result, world: w };
  } finally {
    lock.releaseLock();
  }
}

// ---------- 讀 ----------
function erpLoad_(src) {                     // src 不填 = 現在這份試算表；備份還原演練會傳入備份檔
  var ss = src || SpreadsheetApp.getActiveSpreadsheet();
  var w = ErpEngine.empty();
  Object.keys(ErpEngine.TABLES).forEach(function (t) {
    var def = ErpEngine.TABLES[t];
    var sh = ss.getSheetByName(def.sheet);
    if (!sh || sh.getLastRow() < 2) return;
    var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    var hdr = vals[0];
    for (var i = 1; i < vals.length; i++) {
      if (!vals[i][0]) continue;
      var rec = {};
      for (var c = 0; c < hdr.length; c++) if (hdr[c]) rec[hdr[c]] = vals[i][c];
      w[t].push(erpDecode_(def, rec));
    }
  });
  var meta = ss.getSheetByName(ErpEngine.META_SHEET);
  if (meta && meta.getLastRow() >= 2) {
    try { w.meta = JSON.parse(meta.getRange(2, 2).getDisplayValue()) || w.meta; } catch (e) {}
  }
  w.meta.seq = w.meta.seq || {};
  w.meta.lotseq = Number(w.meta.lotseq) || 0;
  return w;
}
function erpDecode_(def, rec) {
  (def.num || []).forEach(function (k) { var n = Number(String(rec[k] || "").replace(/,/g, "")); rec[k] = isFinite(n) ? n : 0; });
  (def.bool || []).forEach(function (k) { rec[k] = String(rec[k]).toLowerCase() === "true"; });
  (def.json || []).forEach(function (k) {
    try { rec[k] = rec[k] ? JSON.parse(rec[k]) : (k === "bom" ? {} : []); } catch (e) { rec[k] = k === "bom" ? {} : []; }
  });
  return rec;
}

// ---------- 寫（只回寫 dirty 的列；新增一次批次寫入；刪除由下往上） ----------
function erpSave_(ss, w, dirty) {
  Object.keys(dirty).forEach(function (t) {
    if (t === "meta" || !ErpEngine.TABLES[t]) return;
    var def = ErpEngine.TABLES[t];
    var sh = erpSheet_(ss, def.sheet, def.cols);
    var hdr = erpHeader_(sh, def.cols);
    var last = sh.getLastRow();
    var ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues() : [];
    var rowOf = {};
    for (var i = 0; i < ids.length; i++) if (ids[i][0]) rowOf[ids[i][0]] = i + 2;
    var byId = {};
    w[t].forEach(function (r) { byId[r.id] = r; });
    var adds = [], dels = [];
    Object.keys(dirty[t]).forEach(function (id) {
      if (dirty[t][id] === "delete") { if (rowOf[id]) dels.push(rowOf[id]); return; }
      var rec = byId[id]; if (!rec) return;
      var row = hdr.map(function (h) { return erpEncode_(rec[h]); });
      if (rowOf[id]) sh.getRange(rowOf[id], 1, 1, hdr.length).setNumberFormat("@").setValues([row]);
      else adds.push(row);
    });
    if (adds.length) erpAppend_(sh, adds, hdr.length);
    dels.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  });
  if (dirty.meta) {
    var m = erpSheet_(ss, ErpEngine.META_SHEET, ["key", "value"]);
    m.getRange(2, 1, 1, 2).setNumberFormat("@").setValues([["meta", JSON.stringify(w.meta)]]);
  }
}
function erpEncode_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------- 分頁工具（全部以純文字格式存，避免料號 001 被吃成 1、日期被轉格式） ----------
function erpSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setNumberFormat("@").setValues([cols]).setFontWeight("bold");
  sh.setFrozenRows(1);
  return sh;
}
function erpHeader_(sh, cols) {
  var lc = Math.max(sh.getLastColumn(), 1);
  var hdr = sh.getRange(1, 1, 1, lc).getDisplayValues()[0].filter(function (h) { return h; });
  var miss = cols.filter(function (c) { return hdr.indexOf(c) < 0; });
  if (miss.length) {   // 新版本多了欄位 → 補在最右邊，舊資料不動
    hdr = hdr.concat(miss);
    sh.getRange(1, 1, 1, hdr.length).setNumberFormat("@").setValues([hdr]);
  }
  return hdr;
}
function erpAppend_(sh, rows, width) {
  width = width || rows[0].length;
  var start = sh.getLastRow() + 1;
  var need = start + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  sh.getRange(start, 1, rows.length, width).setNumberFormat("@").setValues(rows);
}
function erpFindKey_(log, key) {
  var last = log.getLastRow();
  if (last < 2) return null;
  var from = Math.max(2, last - 299);   // 只需比對最近 300 筆（重送都發生在幾秒內）
  var vals = log.getRange(from, 4, last - from + 1, 2).getDisplayValues();
  for (var i = vals.length - 1; i >= 0; i--) if (vals[i][0] === key) return vals[i][1];
  return null;
}

// ===========================================================================
// 權限與職能分工（規則在 erp-roles.js；這裡負責讀「acl」分頁、把關、通知老闆）
//
//  - 「acl」分頁一列一個人：id（Email 小寫）、role（boss/manager/sales/ops/finance/admin/viewer）、active（1/0）、name。
//  - acl 完全沒有任何啟用的帳號 = 還沒啟用權限控管，維持原狀（所有登入者權限相同），避免把自己鎖在門外。
//    啟用方式：在 Apps Script 執行一次 accessSetup（把你自己設成老闆），之後在行政工作台「帳號權限」分頁加人。
//  - 停用帳號（active=0）、或「ERP_員工」裡同 Email 的員工被標為離職，立刻無法使用，不必等人去改白名單。
//  - 高風險操作（匯入備份、大量匯入、短時間大量刪除、帳號權限變更）會寫進「高風險操作」分頁並寄信給老闆。
// ===========================================================================
var ACL_SHEET = "acl";
var ACL_HDR = ["id", "role", "active", "name", "ts", "by"];
var RISK_SHEET = "高風險操作";
var RISK_HDR = ["ts", "who", "role", "kind", "detail"];
var ACL_BULK_ROWS = 20;                       // 一次匯入超過幾列算高風險
var ACL_DEL_LIMIT = 5;                        // 10 分鐘內刪幾筆算「大量刪除」

function aclTrue_(v) { return v === true || v === 1 || /^(1|true|yes|是|y)$/i.test(String(v).trim()); }
function aclRows_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getValues(), hdr = v[0], out = [];
  for (var i = 1; i < v.length; i++) {
    var o = {}; for (var c = 0; c < hdr.length; c++) o[hdr[c]] = v[i][c];
    if (!o.id) continue;
    o.id = String(o.id).trim().toLowerCase(); o.active = aclTrue_(o.active); out.push(o);
  }
  return out;
}
function aclStaffInactive_(email) {           // 員工資料裡同 Email 的人被標為離職 → 視同停用
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ERP_員工");
    if (!sh || sh.getLastRow() < 2) return false;
    var v = sh.getDataRange().getValues(), hdr = v[0], ei = hdr.indexOf("email"), ai = hdr.indexOf("active"), hit = false, anyActive = false;
    if (ei < 0 || ai < 0) return false;
    for (var i = 1; i < v.length; i++) if (String(v[i][ei]).trim().toLowerCase() === email) { hit = true; if (aclTrue_(v[i][ai])) anyActive = true; }
    return hit && !anyActive;
  } catch (e) { return false; }
}
/** → {configured, role, why}；role 為 null = 不准使用 */
function aclRole_(email) {
  var rows = aclRows_(), em = String(email || "").trim().toLowerCase();
  if (!rows.some(function (r) { return r.active; })) return { configured: false, role: "boss", why: "" };
  var me = rows.filter(function (r) { return r.id === em; })[0];
  if (!me) return { configured: true, role: null, why: "此帳號還沒有被指派職務：" + email + "（請老闆在「帳號權限」加入）" };
  if (!me.active) return { configured: true, role: null, why: "此帳號已停用：" + email };
  if (aclStaffInactive_(em)) return { configured: true, role: null, why: "此帳號對應的員工已離職：" + email };
  if (!ErpRoles.role(String(me.role))) return { configured: true, role: null, why: "職務設定不正確（" + me.role + "）：" + email };
  return { configured: true, role: String(me.role), why: "" };
}
function aclBosses_() {
  var l = aclRows_().filter(function (r) { return r.active && r.role === "boss"; }).map(function (r) { return r.id; });
  if (l.length) return l;
  var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  return [(v && v.trim()) ? v.trim() : Session.getActiveUser().getEmail()];
}
/** 高風險操作：寫紀錄＋寄信給老闆（同一人同一類 10 分鐘內只寄一次，避免洗版） */
function aclRisk_(kind, email, role, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    erpAppend_(erpSheet_(ss, RISK_SHEET, RISK_HDR), [[new Date().toISOString(), email, role || "", kind, String(detail || "").slice(0, 500)]]);
    var cache = CacheService.getScriptCache(), ck = "risk:" + kind + ":" + email;
    if (cache.get(ck)) return;
    cache.put(ck, "1", 600);
    GmailApp.sendEmail(aclBosses_().join(","), "【高風險操作】" + kind + "（" + email + "）",
      "操作人：" + email + "（" + (role ? ErpRoles.name(role) : "未設定") + "）\n操作：" + kind + "\n內容：" + detail +
      "\n時間：" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm") + "\n\n如果這不是你預期的操作，請立刻到「帳號權限」停用該帳號，並檢查「高風險操作」分頁。");
  } catch (e) { console.log("高風險通知失敗：" + e); }
}
function aclCount_(email, n) {                // 10 分鐘內累計刪除筆數
  var cache = CacheService.getScriptCache(), k = "del:" + email, v = (Number(cache.get(k)) || 0) + n;
  cache.put(k, String(v), 600); return v;
}
function aclDeny_(role, what) { return { error: "你的職務（" + ErpRoles.name(role) + "）不能" + what }; }

/**
 * 主檔 doPost 驗證完 email 之後呼叫（見 README「權限」的一行設定）。回傳 null = 放行；回傳物件 = 直接當回應擋下。
 * 沒貼這個檔、或沒設定任何帳號時完全不影響原本行為。
 */
function accessGate_(action, p, email) {
  var a = aclRole_(email);
  if (!a.configured) return null;
  if (!a.role) return { error: a.why };
  var role = a.role;
  p = p || {};
  switch (action) {
    case "tList":
      return ErpRoles.canTable(role, p.table, false) ? null : aclDeny_(role, "讀取資料表「" + p.table + "」");
    case "tUpsert": case "tRemove": case "tImport":
      if (!ErpRoles.canTable(role, p.table, true)) return aclDeny_(role, "修改資料表「" + p.table + "」");
      if (p.table === ACL_SHEET) {
        var chk = aclChange_(action, p); if (chk) return chk;
        aclRisk_("帳號權限變更", email, role, action + " " + (p.row ? JSON.stringify(p.row) : (p.id || "")));
      } else if (action === "tImport" && (p.rows || []).length > ACL_BULK_ROWS) aclRisk_("大量匯入", email, role, p.table + " 匯入 " + p.rows.length + " 列");
      else if (action === "tRemove" && aclCount_(email, 1) >= ACL_DEL_LIMIT) aclRisk_("短時間大量刪除", email, role, "10 分鐘內已刪 " + ACL_DEL_LIMIT + " 筆以上（最近：" + p.table + "）");
      return null;
    case "markSet": case "quoteAdd": case "quoteDel": case "driveSave":
      return role === "viewer" ? aclDeny_(role, "修改資料") : null;
    default:
      return null;                              // erpLoad / erpAct / erpImport 由 erpDispatch_ 依職務處理
  }
}
/** 改 acl 本身的防呆：不能把最後一位老闆停用或降級（會沒人能管帳號） */
function aclChange_(action, p) {
  var rows = aclRows_(), bosses = rows.filter(function (r) { return r.active && r.role === "boss"; });
  var target = String((p.row && p.row.id) || p.id || "").trim().toLowerCase();
  var isBoss = bosses.some(function (r) { return r.id === target; });
  if (!isBoss || bosses.length > 1) return null;
  var stays = action === "tUpsert" && p.row && (p.row.role === undefined || p.row.role === "boss") && (p.row.active === undefined || aclTrue_(p.row.active));
  return stays ? null : { error: "不能停用、刪除或降級最後一位老闆，否則沒有人能管理帳號。請先指定另一位老闆。" };
}

// 一次性設定：在 Apps Script 編輯器執行，把「你自己」設為第一位老闆，啟用權限控管
function accessSetup() {
  var me = String(Session.getActiveUser().getEmail()).toLowerCase();
  if (aclRows_().some(function (r) { return r.active; })) return "已經設定過了（acl 分頁已有啟用的帳號）。";
  var sh = erpSheet_(SpreadsheetApp.getActiveSpreadsheet(), ACL_SHEET, ACL_HDR);
  erpAppend_(sh, [[me, "boss", 1, "老闆", new Date().toISOString(), "accessSetup"]]);
  return "已啟用權限控管：" + me + " 是老闆。請到行政工作台「帳號權限」加入其他人；沒加入的人將無法使用。";
}

// 每季帳號盤點：列出所有帳號與最後使用時間、久未使用的、白名單與職務對不上的
// 手動執行 = 立刻寄；由每月 1 號的觸發器呼叫時，只在 1、4、7、10 月寄
function accessReview(e) {
  if (e && [0, 3, 6, 9].indexOf(new Date().getMonth()) < 0) return "非季初，略過";
  var ss = SpreadsheetApp.getActiveSpreadsheet(), rows = aclRows_(), last = {}, lines = [], flags = [];
  var log = ss.getSheetByName(ERP_LOG_SHEET);
  if (log && log.getLastRow() >= 2) {
    log.getRange(2, 1, log.getLastRow() - 1, 2).getValues().forEach(function (r) { var em = String(r[1]).toLowerCase(), t = new Date(r[0]).getTime(); if (t && (!last[em] || t > last[em])) last[em] = t; });
  }
  var now = Date.now(), allow = typeof ALLOWED_EMAILS !== "undefined" ? ALLOWED_EMAILS.map(function (x) { return String(x).toLowerCase(); }) : null;
  rows.forEach(function (r) {
    var idle = last[r.id] ? Math.floor((now - last[r.id]) / 86400000) : null;
    lines.push((r.active ? "● " : "○ ") + r.id + "　" + ErpRoles.name(r.role) + (r.active ? "" : "（已停用）") + "　最後操作：" + (idle === null ? "沒有紀錄" : idle + " 天前"));
    if (r.active && (idle === null || idle > 90)) flags.push("🟡 " + r.id + " 已 " + (idle === null ? "從未" : idle + " 天沒") + "使用，確認還需要這個帳號嗎？");
    if (r.active && allow && allow.indexOf(r.id) < 0) flags.push("🔴 " + r.id + " 在 acl 是啟用的，但不在 ALLOWED_EMAILS 白名單，實際上無法登入。");
    if (r.active && aclStaffInactive_(r.id)) flags.push("🔴 " + r.id + " 對應的員工已離職，但帳號還是啟用的（已被系統擋下，請在「帳號權限」停用）。");
  });
  if (allow) allow.forEach(function (em) { if (!rows.some(function (r) { return r.id === em; })) flags.push("🟡 " + em + " 在 ALLOWED_EMAILS 白名單，但 acl 沒有這個人（啟用權限控管後他無法使用）。若這個人已離職，請從白名單移除。"); });
  var body = "【每季帳號盤點】\n\n" + (lines.join("\n") || "（acl 還沒有帳號，權限控管尚未啟用）") + "\n\n" + (flags.length ? "需要處理：\n" + flags.join("\n") : "沒有發現需要處理的項目。") +
    "\n\n請老闆逐一確認：每個人的職務是否仍適合？離職或調動的人是否已停用？";
  GmailApp.sendEmail(aclBosses_().join(","), "【每季帳號盤點】" + (flags.length ? flags.length + " 項待處理" : "無異常"), body);
  erpAppend_(erpSheet_(ss, RISK_SHEET, RISK_HDR), [[new Date().toISOString(), "system", "", "每季帳號盤點", flags.length + " 項待處理"]]);
  return body;
}
function installAccessTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "accessReview") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("accessReview").timeBased().onMonthDay(1).atHour(9).inTimezone("Asia/Taipei").create();   // 每月 1 號觸發；實際只在 1、4、7、10 月寄出盤點信
  return "已安裝：每季（1、4、7、10 月 1 號 09:00）寄帳號盤點信。";
}


// ===========================================================================
// 全公司營運風險（規則在 biz-kri.js）：給 sched-alerts.gs 的 checkSchedAlerts 每 30 分鐘呼叫。
// 門檻與負責人存在 sched_cfg 的 biz_tol 列（網頁「風險儀表板 → 門檻設定」改）；歷史存在 biz_hist（趨勢與小曲線用）。
// ===========================================================================
var BIZ_HIST = "biz_hist";
var BIZ_HIST_HDR = ["id", "t", "v"];
var BIZ_HIST_KEEP = 400;                       // 約 18 個上班日（每 30 分鐘一筆）

function bizTol_() {
  try {
    var r = tList_("sched_cfg").rows.filter(function (x) { return x.id === "biz_tol"; })[0];
    return r ? JSON.parse(String(r.data).replace(/^~/, "")) : {};
  } catch (e) { return {}; }
}
function bizItems_(now) {
  var d = new Date(now), today = Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd");
  var tol = bizTol_(), o = tol._opts || {};                        // _opts：帳款天數、集中度最低銷售額（網頁「門檻設定」）
  return BizKri.evaluate(erpLoad_(), today, tol, { seeCost: true, terms: o.terms, minSales: o.minSales });
}
function bizCurrent_(now) {
  var items = bizItems_(now), out = {};
  try { bizHist_(items, now); } catch (e) {}
  items.forEach(function (x) {
    if (x.level !== "yellow" && x.level !== "red") return;
    out[x.id] = { key: x.id, level: x.level, name: x.name, display: x.display, msg: x.msg || "", owner: x.owner || "老闆", action: x.actionLabel || "", cat: "營運" };
  });
  return out;
}
function bizHist_(items, now) {                 // 距離上一筆至少 25 分鐘才記一筆
  var rows = tList_(BIZ_HIST).rows, last = 0;
  rows.forEach(function (r) { var t = Number(r.t); if (t > last) last = t; });
  if (now - last < 25 * 60000) return;
  var v = {}; items.forEach(function (x) { if (x.value != null) v[x.id] = Math.round(x.value * 100) / 100; });
  tUpsert_(BIZ_HIST, { id: "h" + now, t: now, v: JSON.stringify(v) }, BIZ_HIST_HDR, "營運風險");
  rows.sort(function (a, b) { return Number(b.t) - Number(a.t); }).slice(BIZ_HIST_KEEP - 1).forEach(function (r) { tRemove_(BIZ_HIST, r.id); });
}


// ===========================================================================
// 內控月報（規則在 governance.js）：每月 1 號 08:00 寄給老闆。
// 內容：目前紅黃燈（排程＋營運）、備份與還原演練、近 30 天高風險操作、定期治理紀錄（gov_log）有沒有逾期、待辦清單。
// 安裝：Apps Script 函式選單選 installGovTrigger → 執行（只做一次）；想先看看內容，執行 govMonthlyReport。
// ===========================================================================
var GOV_LOG = "gov_log";

function govActiveKri_() {                          // 目前還亮著的燈：sched_alert 分頁（排程與營運風險共用，checkSchedAlerts 每 30 分鐘維護）
  var rows = [];
  try { rows = tList_("sched_alert").rows || []; } catch (e) {}
  var out = { red: 0, yellow: 0, red_names: [], yellow_names: [] };
  rows.forEach(function (r) {
    if (!aclTrue_(r.active)) return;
    if (r.level === "red") { out.red++; out.red_names.push(String(r.name || r.id) + (r.display ? "（" + r.display + "）" : "")); }
    else if (r.level === "yellow") { out.yellow++; out.yellow_names.push(String(r.name || r.id) + (r.display ? "（" + r.display + "）" : "")); }
  });
  return out;
}
function govRiskOps_(now) {                         // 近 30 天高風險操作筆數（每季帳號盤點那一行不算）
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RISK_SHEET);
    if (!sh || sh.getLastRow() < 2) return 0;
    var since = now - 30 * 86400000;
    return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().filter(function (r) { var t = new Date(r[0]).getTime(); return t && t >= since && r[3] !== "每季帳號盤點"; }).length;
  } catch (e) { return 0; }
}
function govReport_(now) {
  var records = [];
  try { records = tList_(GOV_LOG).rows || []; } catch (e) {}
  return ErpGov.monthlyReport({ now: now, kri: govActiveKri_(), backup: erpBackup_(), riskOps: govRiskOps_(now), records: records });
}
function govMonthlyReport(e) {
  var r = govReport_(Date.now());
  GmailApp.sendEmail(aclBosses_().join(","), r.subject, r.body);
  return r.body;
}
function installGovTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "govMonthlyReport") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("govMonthlyReport").timeBased().onMonthDay(1).atHour(8).inTimezone("Asia/Taipei").create();
  return "已安裝：每月 1 號 08:00 寄內控月報給老闆。";
}
