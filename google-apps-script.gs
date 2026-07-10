/**
 * 九上科技儀表板 — 資料庫後端（Google Apps Script）
 *
 * 用途：讓網站把「收藏/標記/備註、報價歷史」＋「站內資料庫操作中心」的各張資料表
 *       （我的名單/待辦…以及日後的訂單/庫存/料號）存進這個試算表（團隊共用、多裝置同步）。
 *       各資料表分頁會在第一次寫入時自動建立，不必手動開；欄位由網站端 schema 決定。
 * 安全：只接受「你 OAuth 用戶端」發出的登入 token，且 email 在下方白名單內。
 *
 * 設定步驟（見 repo README「Google 設定」）：
 *   1. 用公司 Google 帳號建一個「Google 試算表」當資料庫。
 *   2. 在該試算表 → 擴充功能 → Apps Script → 把本檔全部貼進去。
 *   3. 下方兩個常數填好：CLIENT_ID（你的 OAuth 用戶端 ID）、ALLOWED_EMAILS（允許登入的人）。
 *   4. 部署 → 新增部署 → 類型「網頁應用程式」→ 執行身分「我」、存取權「任何人」→ 部署 → 複製網址。
 *   5. 把網址填進網站 docs/config.js 的 APPS_SCRIPT_URL；Client ID 填 GOOGLE_CLIENT_ID。
 */

// ★★ 填這裡 ★★
var CLIENT_ID = "填你的-OAuth-用戶端-ID.apps.googleusercontent.com";
var ALLOWED_EMAILS = ["your-email@gmail.com"];  // 允許登入存取的 email（可多個；填你自己的 Google 帳號）

// ---- 入口 ----
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    var email = verify_(body.token);          // 驗證登入身分，不合法會丟錯
    var p = body.payload || {};
    var out;
    switch (body.action) {
      case "load":     out = loadAll_(); break;
      case "markSet":  markSet_(p.id, p.value, email); out = { ok: true }; break;
      case "quoteAdd": quoteAdd_(p.value, email); out = { ok: true }; break;
      case "quoteDel": quoteDel_(p.ts); out = { ok: true }; break;
      case "driveSave": out = driveSave_(p.quotes, email); break;
      // ---- 通用資料表 CRUD（ERP 各模組共用：訂單/庫存/料號…只要換 table 名，不必改後端）----
      case "tList":    out = tList_(p.table); break;
      case "tUpsert":  out = tUpsert_(p.table, p.row, p.header, email); break;
      case "tRemove":  out = tRemove_(p.table, p.id); break;
      case "tImport":  out = tImport_(p.table, p.rows, p.header, email); break;
      case "ai":       out = ai_(p.question, p.context); break;
      default:         out = { error: "unknown action" };
    }
    return json_(out);
  } catch (err) {
    return json_({ error: String(err) });
  }
}
function doGet() { return json_({ ok: true, hint: "POST only" }); }

// ---- 驗證 Google 登入 token（tokeninfo）----
function verify_(token) {
  if (!token) throw "尚未登入";
  var r = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
    { muteHttpExceptions: true });
  var d = JSON.parse(r.getContentText());
  if (d.aud !== CLIENT_ID) throw "token 不符本應用";
  if (ALLOWED_EMAILS.indexOf(d.email) < 0) throw "此帳號無權限：" + d.email;
  return d.email;
}

// ---- 試算表存取 ----
function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); }
  return sh;
}
function loadAll_() {
  var mk = sheet_("marks", ["id", "status", "note", "fav", "by", "ts"]).getDataRange().getValues();
  var marks = {};
  for (var i = 1; i < mk.length; i++) {
    if (!mk[i][0]) continue;
    marks[mk[i][0]] = { status: mk[i][1] || "", note: mk[i][2] || "", fav: mk[i][3] === true || mk[i][3] === "TRUE" || mk[i][3] === "true" };
  }
  var qz = sheet_("quotes", ["ts", "material", "weight", "price", "proc", "margin", "quote", "by"]).getDataRange().getValues();
  var quotes = [];
  for (var j = 1; j < qz.length; j++) {
    if (!qz[j][0]) continue;
    quotes.push({ ts: Number(qz[j][0]), material: qz[j][1], weight: qz[j][2], price: qz[j][3], proc: qz[j][4], margin: qz[j][5], quote: qz[j][6] });
  }
  quotes.sort(function (a, b) { return b.ts - a.ts; });
  return { marks: marks, quotes: quotes };
}
function markSet_(id, v, by) {
  if (!id) return;
  var sh = sheet_("marks", ["id", "status", "note", "fav", "by", "ts"]);
  var ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  var row = -1;
  for (var i = 1; i < ids.length; i++) if (ids[i][0] === id) { row = i + 1; break; }
  var rec = [id, (v && v.status) || "", (v && v.note) || "", !!(v && v.fav), by, new Date()];
  if (row > 0) sh.getRange(row, 1, 1, rec.length).setValues([rec]);
  else sh.appendRow(rec);
}
function quoteAdd_(v, by) {
  if (!v) return;
  sheet_("quotes", ["ts", "material", "weight", "price", "proc", "margin", "quote", "by"])
    .appendRow([v.ts, v.material, v.weight, v.price, v.proc, v.margin, v.quote, by]);
}
function quoteDel_(ts) {
  var sh = sheet_("quotes", ["ts", "material", "weight", "price", "proc", "margin", "quote", "by"]);
  var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var i = vals.length - 1; i >= 1; i--) if (Number(vals[i][0]) === Number(ts)) sh.deleteRow(i + 1);
}
// ---- 把報價歷史另存成一份 Google 試算表到 Drive（回傳連結）----
var DRIVE_FOLDER_ID = "";  // 選填：報價單存放資料夾 ID（留空存 Drive 根目錄）
function driveSave_(quotes, by) {
  quotes = quotes || [];
  var name = "九上報價單_" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd_HHmm");
  var ss = SpreadsheetApp.create(name);
  var sh = ss.getSheets()[0];
  sh.appendRow(["時間", "材質", "重量(kg)", "料價(NT$/kg)", "加工費", "利潤%", "建議報價", "建立者"]);
  quotes.forEach(function (q) {
    sh.appendRow([new Date(q.ts), q.material, q.weight, q.price, q.proc, q.margin, q.quote, by]);
  });
  var file = DriveApp.getFileById(ss.getId());
  if (DRIVE_FOLDER_ID) {
    try { DriveApp.getFolderById(DRIVE_FOLDER_ID).addFile(file); DriveApp.getRootFolder().removeFile(file); } catch (e) {}
  }
  return { ok: true, url: ss.getUrl(), name: name };
}

// ===========================================================================
// 通用資料表 CRUD（schema 驅動；每個 ERP 模組 = 一張分頁，欄位不綁死）
//   - 第一欄固定為 id；稽核欄 by / ts 自動補。
//   - 寫入一律用 LockService 鎖住，避免多人同時寫入撞列。
//   - 分頁不存在時自動建立。
// ===========================================================================
function tSheet_(table) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(table || ""))) throw "非法資料表名：" + table;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(table);
  if (!sh) { sh = ss.insertSheet(table); sh.appendRow(["id"]); }
  return sh;
}
function tHeader_(sh) {
  var lc = Math.max(sh.getLastColumn(), 1);
  return sh.getRange(1, 1, 1, lc).getValues()[0];
}
function tList_(table) {
  var sh = tSheet_(table);
  var vals = sh.getDataRange().getValues();
  if (vals.length < 1) return { header: [], rows: [] };
  var header = vals[0], rows = [];
  for (var i = 1; i < vals.length; i++) {
    if (!vals[i][0] && vals[i].join("") === "") continue;
    var o = {};
    for (var c = 0; c < header.length; c++) o[header[c]] = vals[i][c];
    if (!o.id && o.id !== 0) continue;
    rows.push(o);
  }
  return { header: header, rows: rows };
}
function tUpsert_(table, row, wantHeader, by) {
  row = row || {};
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = tSheet_(table);
    var last = Math.max(sh.getLastRow(), 1);
    var hdr = tHeader_(sh);
    // 剛建立（只有 id）且前端給了欄位順序 → 一次鋪好乾淨的表頭
    if (hdr.length === 1 && hdr[0] === "id" && wantHeader && wantHeader.length) {
      hdr = ["id"].concat(wantHeader.filter(function (h) { return h !== "id" && h !== "by" && h !== "ts"; })).concat(["by", "ts"]);
      sh.getRange(1, 1, 1, hdr.length).setValues([hdr]);
    }
    // 確保 row 的欄位與 by/ts 都在表頭（缺的就補欄）
    var changed = false;
    Object.keys(row).concat(["by", "ts"]).forEach(function (k) {
      if (hdr.indexOf(k) < 0) { hdr.push(k); changed = true; }
    });
    if (changed) sh.getRange(1, 1, 1, hdr.length).setValues([hdr]);

    if (!row.id && row.id !== 0) row.id = "r" + Date.now() + Math.floor(Math.random() * 1000);
    row.by = by; row.ts = new Date();

    var ids = sh.getRange(1, 1, last, 1).getValues();
    var rownum = -1;
    for (var i = 1; i < ids.length; i++) if (String(ids[i][0]) === String(row.id)) { rownum = i + 1; break; }

    if (rownum > 0) {  // 更新：未提供的欄位保留原值
      var cur = sh.getRange(rownum, 1, 1, hdr.length).getValues()[0];
      var upd = hdr.map(function (h, idx) { return row[h] !== undefined ? row[h] : cur[idx]; });
      sh.getRange(rownum, 1, 1, hdr.length).setValues([upd]);
    } else {           // 新增
      sh.appendRow(hdr.map(function (h) { return row[h] !== undefined ? row[h] : ""; }));
    }
    return { ok: true, id: row.id };
  } finally { lock.releaseLock(); }
}
function tRemove_(table, id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var sh = tSheet_(table);
    var last = Math.max(sh.getLastRow(), 1);
    var ids = sh.getRange(1, 1, last, 1).getValues();
    for (var i = ids.length - 1; i >= 1; i--) if (String(ids[i][0]) === String(id)) sh.deleteRow(i + 1);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function tImport_(table, rows, wantHeader, by) {
  (rows || []).forEach(function (r) { tUpsert_(table, r, wantHeader, by); });
  return { ok: true, n: (rows || []).length };
}

// ===========================================================================
// AI 助手（Gemini 免費）— 金鑰放在 Apps Script「指令碼屬性」GEMINI_API_KEY，不進公開 repo
//   啟用方式：Apps Script 左側「專案設定」→「指令碼屬性」→ 新增 GEMINI_API_KEY = 你的金鑰。
//   （免費金鑰申請：https://aistudio.google.com/apikey）未設定時回 need_setup，網站會顯示提示。
// ===========================================================================
function ai_(question, context) {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) return { error: "未設定 GEMINI_API_KEY", need_setup: true };
  var sys = "你是九上科技（精密金屬零件加工廠）的 ERP 助手。請用繁體中文、精簡、條列、盡量引用下列資料中的數字回答；"
    + "若資料不足就說明還缺什麼。以下為目前系統資料摘要（JSON）：\n" + JSON.stringify(context || {});
  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + encodeURIComponent(key);
  var payload = { contents: [{ parts: [{ text: sys + "\n\n使用者問題：" + String(question || "") }] }] };
  try {
    var r = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
    var d = JSON.parse(r.getContentText());
    if (d.error) return { error: d.error.message || "Gemini 錯誤" };
    var parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    var text = parts[0] ? parts[0].text : "";
    return { ok: true, text: text || "（AI 沒有回覆內容）" };
  } catch (e) { return { error: String(e) }; }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
