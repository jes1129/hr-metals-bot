/**
 * 九上科技儀表板 — 資料庫後端（Google Apps Script）
 *
 * 用途：讓網站把「收藏/標記/備註、報價歷史」存進這個試算表（團隊共用、多裝置同步）。
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

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
