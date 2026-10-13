/**
 * 九上科技儀表板 — 每日自動備份與還原演練（Apps Script 檔案，貼進同一個專案）
 *
 * 做什麼：
 *   backupNow()      每天把「整份公司試算表」複製一份到雲端硬碟資料夾「九上儀表板備份」，留最近 30 份，
 *                    並檢查有沒有哪張表的資料列數突然大減（誤刪的早期訊號）。結果寫在「backup_log」分頁。
 *   restoreDrill()   還原演練：打開最新一份備份，確認真的打得開、分頁沒少、列數對得上，
 *                    ERP 資料還通過引擎的完整檢查——證明「備份是能用的」，而不是只有檔案存在。
 *   restoreSheet()   真的要救資料時：把某一張分頁從備份救回來（會先把現在那張改名留底，不覆蓋）。
 *
 * 安裝（只要做一次）：
 *   1. 把本檔全部貼進 Apps Script 新增的檔案（名稱例：backup）。
 *   2. 上方函式選單選 installBackupTrigger → 按「執行」→ 第一次會要求「雲端硬碟」授權，按允許。
 *   3. 想立刻試一次：選 backupNow 執行；再選 restoreDrill 執行。到「backup_log」分頁看結果。
 *
 * 備份失敗、列數異常、還原演練沒過，都會寄信給老闆（門檻設定裡填的 Email；沒填就寄給你自己）。
 * 本檔不含任何帳號、金鑰或白名單。
 */
var BK_API = 1;
var BK_FOLDER = "九上儀表板備份";
var BK_KEEP = 30;                                         // 保留最近幾份
var BK_LOG = "backup_log";
var BK_HDR = ["ts", "kind", "ok", "fileId", "name", "counts", "msg"];
var BK_DROP = 0.3;                                        // 某張表列數比上次少超過 30% → 警告
var BK_SKIP = { "backup_log": 1 };                        // 不列入列數比較的分頁

function bk_boss_() {
  if (typeof sa_cfg_ === "function") { try { return sa_cfg_().boss; } catch (e) {} }
  var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  return (v && v.trim()) ? v.trim() : Session.getActiveUser().getEmail();
}
function bk_mail_(subject, body) {
  try { GmailApp.sendEmail(bk_boss_(), subject, body); } catch (e) { console.log("備份通知寄信失敗：" + e); }
}
function bk_sheet_(ss) {
  var sh = ss.getSheetByName(BK_LOG);
  if (!sh) { sh = ss.insertSheet(BK_LOG); sh.getRange(1, 1, 1, BK_HDR.length).setValues([BK_HDR]); sh.setFrozenRows(1); }
  return sh;
}
function bk_rows_(ss) {                                   // 讀 backup_log → [{ts,kind,ok,...}]
  var sh = ss.getSheetByName(BK_LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(1, 1, sh.getLastRow(), BK_HDR.length).getValues(), out = [];
  for (var i = 1; i < v.length; i++) { var o = {}; for (var c = 0; c < BK_HDR.length; c++) o[BK_HDR[c]] = v[i][c]; out.push(o); }
  return out;
}
function bk_log_(ss, kind, ok, fileId, name, counts, msg) {
  bk_sheet_(ss).appendRow([new Date().toISOString(), kind, ok ? 1 : 0, fileId || "", name || "", counts ? JSON.stringify(counts) : "", msg || ""]);
}
function bk_counts_(ss) {                                 // {分頁名: 資料列數}
  var o = {};
  ss.getSheets().forEach(function (sh) { var n = sh.getName(); if (!BK_SKIP[n]) o[n] = Math.max(0, sh.getLastRow() - 1); });
  return o;
}
function bk_folder_() {
  var it = DriveApp.getFoldersByName(BK_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BK_FOLDER);
}
function bk_lastOk_(rows, kind) {
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i].kind === kind && Number(rows[i].ok) === 1) return rows[i];
  return null;
}

// 兩份列數比較：回傳「少很多」的分頁清單
function bk_drops_(prev, cur) {
  var out = [];
  Object.keys(prev || {}).forEach(function (k) {
    var a = Number(prev[k]) || 0, b = cur[k] === undefined ? 0 : Number(cur[k]);
    if (a >= 10 && b < a * (1 - BK_DROP)) out.push(k + "：" + a + " → " + b);
  });
  return out;
}

function backupNow() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    var rows = bk_rows_(ss), prev = bk_lastOk_(rows, "backup"), prevCounts = {};
    try { prevCounts = prev && prev.counts ? JSON.parse(prev.counts) : {}; } catch (e) {}
    var counts = bk_counts_(ss), drops = bk_drops_(prevCounts, counts);
    var stamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd_HHmm");
    var name = "備份_" + ss.getName() + "_" + stamp;
    var copy = DriveApp.getFileById(ss.getId()).makeCopy(name, bk_folder_());
    var msg = drops.length ? "⚠ 資料列數大減：" + drops.join("；") : "";
    bk_log_(ss, "backup", true, copy.getId(), name, counts, msg);
    bk_prune_(ss);
    if (drops.length) bk_mail_("【備份警示】有資料表的列數突然大減", "剛完成的備份發現以下分頁列數比上一次少超過 " + Math.round(BK_DROP * 100) + "%：\n\n" + drops.join("\n") +
      "\n\n如果這不是你刻意刪的，請不要動資料，先到雲端硬碟「" + BK_FOLDER + "」找前一份備份，再用 restoreSheet 救回來。\n（這份備份已保留，前一份也還在。）");
    return "備份完成：" + name + (msg ? "（" + msg + "）" : "");
  } catch (e) {
    bk_log_(ss, "backup", false, "", "", null, String(e));
    bk_mail_("【備份失敗】今天的自動備份沒有完成", "原因：" + e + "\n\n請打開 Apps Script → 執行項目 看詳細訊息，或手動執行 backupNow 再試一次。\n備份失敗期間，資料沒有保護，請盡快處理。");
    throw e;
  } finally { lock.releaseLock(); }
}

function bk_prune_(ss) {                                  // 只清「備份資料夾」裡超過保留份數的舊檔，移到垃圾桶（30 天內仍可救）
  var files = [], it = bk_folder_().getFiles();
  while (it.hasNext()) { var f = it.next(); if (String(f.getName()).indexOf("備份_") === 0) files.push(f); }
  files.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  files.slice(BK_KEEP).forEach(function (f) { f.setTrashed(true); });
}

function restoreDrill() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), rows = bk_rows_(ss), last = bk_lastOk_(rows, "backup"), problems = [], info = [];
  if (!last) { problems.push("找不到任何成功的備份紀錄（backup_log 沒有成功的備份）"); }
  else {
    var bk = null;
    try { bk = SpreadsheetApp.openById(last.fileId); } catch (e) { problems.push("最新備份打不開：" + e); }
    if (bk) {
      var want = {}; try { want = JSON.parse(last.counts || "{}"); } catch (e) {}
      var have = bk_counts_(bk);
      Object.keys(want).forEach(function (k) {
        if (have[k] === undefined) problems.push("備份裡少了分頁「" + k + "」");
        else if (have[k] !== want[k]) problems.push("分頁「" + k + "」列數對不上（備份當時 " + want[k] + "、備份檔 " + have[k] + "）");
      });
      info.push("備份檔：" + last.name + "，共 " + Object.keys(have).length + " 張分頁");
      if (typeof ErpEngine !== "undefined" && typeof erpLoad_ === "function") {         // ERP 資料要通過引擎的完整檢查，才算「還原後能用」
        try {
          var errs = ErpEngine.validate(erpLoad_(bk));
          if (errs.length) problems.push("備份裡的 ERP 資料檢查沒通過（" + errs.length + " 項）：" + errs.slice(0, 3).join("；"));
          else info.push("ERP 資料通過完整檢查");
        } catch (e) { problems.push("無法檢查備份裡的 ERP 資料：" + e); }
      }
    }
  }
  var ok = problems.length === 0;
  bk_log_(ss, "drill", ok, last ? last.fileId : "", last ? last.name : "", null, ok ? info.join("；") : problems.join("；"));
  bk_mail_(ok ? "【還原演練通過】備份是能用的" : "【還原演練失敗】備份可能無法還原", (ok ? "這次演練確認：\n- " + info.join("\n- ") : "發現問題：\n- " + problems.join("\n- ") + "\n\n請先手動執行 backupNow 重做一份備份，再執行 restoreDrill 確認。"));
  return ok ? "演練通過：" + info.join("；") : "演練失敗：" + problems.join("；");
}

// 真的要救資料：把某一張分頁從備份救回來。不會覆蓋現在的分頁——現在那張先改名成「_留底_時間_原名」。
// 用法：在編輯器新增一個小函式 function 救回訂單() { restoreSheet("訂單"); }，執行它。（fileId 不填 = 用最新備份）
function restoreSheet(sheetName, fileId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!fileId) { var last = bk_lastOk_(bk_rows_(ss), "backup"); if (!last) throw new Error("找不到可用的備份紀錄"); fileId = last.fileId; }
  var src = SpreadsheetApp.openById(fileId).getSheetByName(sheetName);
  if (!src) throw new Error("備份裡沒有分頁「" + sheetName + "」");
  var cur = ss.getSheetByName(sheetName);
  if (cur) cur.setName("_留底_" + Utilities.formatDate(new Date(), "Asia/Taipei", "MMdd_HHmm") + "_" + sheetName);
  var copy = src.copyTo(ss);
  copy.setName(sheetName);
  bk_log_(ss, "restore", true, fileId, sheetName, null, "分頁「" + sheetName + "」已從備份救回；原本那張已改名留底");
  bk_mail_("【資料還原】分頁「" + sheetName + "」已從備份救回", "操作人：" + Session.getActiveUser().getEmail() + "\n備份檔：" + fileId + "\n原本那張分頁已改名成「_留底_…」保留，確認沒問題後再自行刪除。");
  return "已救回「" + sheetName + "」";
}

// 給網頁與早報用的狀態：最近一次備份／演練是幾天前
function backupStatus_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), rows = bk_rows_(ss), now = Date.now();
  var b = bk_lastOk_(rows, "backup"), d = bk_lastOk_(rows, "drill");
  var lastRow = rows.length ? rows[rows.length - 1] : null;
  var days = function (r) { return r ? Math.floor((now - new Date(r.ts).getTime()) / 86400000) : null; };
  var fails = 0; for (var i = rows.length - 1; i >= 0 && rows[i].kind === "backup" && Number(rows[i].ok) !== 1; i--) fails++;
  return { installed: !!ss.getSheetByName(BK_LOG), backupDays: days(b), drillDays: days(d), failStreak: fails, lastMsg: lastRow ? String(lastRow.msg || "") : "" };
}

function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { var h = t.getHandlerFunction(); if (h === "backupNow" || h === "restoreDrill") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("backupNow").timeBased().everyDays(1).atHour(3).inTimezone("Asia/Taipei").create();          // 每天 03:00
  ScriptApp.newTrigger("restoreDrill").timeBased().onMonthDay(1).atHour(4).inTimezone("Asia/Taipei").create();      // 每月 1 號 04:00 演練
  return "已安裝：每天 03:00 備份、每月 1 號 04:00 還原演練。請現在再手動執行一次 backupNow。";
}
