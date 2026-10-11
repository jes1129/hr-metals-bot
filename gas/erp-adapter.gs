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

function erpDispatch_(action, p, email) {
  if (action !== "erpLoad" && action !== "erpAct") return null;   // 不是 ERP 的 action → 交回原本的 unknown action
  // ERP 含售價、成本、毛利：可在「專案設定 → 指令碼屬性」加 ERP_EMAILS（逗號分隔）限定誰能用；
  // 沒設 = 所有通過主檔白名單的人都能用。其他功能（訂單看板、資料庫…）不受影響。
  var only = String(PropertiesService.getScriptProperties().getProperty("ERP_EMAILS") || "").trim();
  if (only && only.split(/\s*,\s*/).map(function (x) { return x.toLowerCase(); }).indexOf(String(email).toLowerCase()) < 0) {
    return { error: "此帳號沒有 ERP 權限（請管理者把你加入 ERP_EMAILS）：" + email };
  }
  if (action === "erpLoad") return { ok: true, world: erpLoad_() };
  return erpAct_(p || {}, email);
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
function erpLoad_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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
