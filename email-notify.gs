/**
 * 九上科技 — 每日 ERP 早報 / 警示 email（Google Apps Script）
 *
 * 用專案擁有者的 Gmail 帳號以 GmailApp 寄信；重用 notebooklm-export.gs 的
 * buildBriefText_/readTable_/n_/ymd_/comma_（同一個 Apps Script 專案，函式共用）。
 *
 * 安裝（貼進「同一個」Apps Script 專案，當第三個檔案；需先有 notebooklm-export.gs）：
 *   1. 專案設定 → 指令碼屬性 → 加 NOTIFY_EMAILS = 收信人（可多個，逗號分隔；不填＝寄給帳號本人）。
 *   2. 編輯器選函式 sendDailyDigest → 執行一次（授權後會寄一封到你信箱）。
 *   3. 執行一次 installEmailTrigger → 每天上午自動寄。
 *
 * 想在試算表選單也能「立即寄一封測試」，把這行加進 notebooklm-export.gs 的 onOpen 選單：
 *   .addItem("📧 立即寄 ERP 早報", "sendDailyDigest")
 */

var EMAIL_SIGNALS_URL = "https://jes1129.github.io/hr-metals-bot/signals.json";

function getNotifyEmails_() {
  var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  return (v && v.trim()) ? v.trim() : Session.getActiveUser().getEmail();
}

// 從訂單算「需注意」數字（只看逾期；不做缺料/庫存，MRP 已移除）
function erpAlertCounts_() {
  var orders = readTable_("orders");
  var today = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  var overdue = 0;
  orders.forEach(function (o) { var d = ymd_(o.due); if (d && d < today && ["報價", "接單", "生產"].indexOf(o.status) >= 0) overdue++; });
  return { overdue: overdue };
}

// 原料現況（讀網站 signals.json）— 現價＋今日漲跌%（不做上下線告警）
function metalsSignalText_() {
  try {
    var r = UrlFetchApp.fetch(EMAIL_SIGNALS_URL, { muteHttpExceptions: true });
    var d = JSON.parse(r.getContentText());
    var lines = ["【原料行情】更新 " + (d.updated || "")];
    (d.metals || []).forEach(function (m) {
      var arrow = (m.pct == null) ? "" : ((m.pct >= 0 ? " ▲" : " ▼") + Math.abs(m.pct).toFixed(1) + "%");
      lines.push("- " + m.name + "：" + (m.price_twd != null ? ("NT$ " + comma_(m.price_twd) + "/噸") : "—") + arrow);
    });
    return lines.join("\n");
  } catch (e) { return "【原料行情】暫時取不到。"; }
}

function sendDailyDigest() {
  // 只在平日(週一~週五)寄送；週末工廠休不打擾（以台北時區判斷）
  var dow = Utilities.formatDate(new Date(), "Asia/Taipei", "u");  // 1=一 … 6=六 7=日
  if (dow === "6" || dow === "7") return "週末不寄送";
  var c = erpAlertCounts_();
  var mmdd = Utilities.formatDate(new Date(), "Asia/Taipei", "M/d");
  var warn = [];
  if (c.overdue) warn.push("逾期" + c.overdue);
  var subject = warn.length ? ("⚠️ 九上 ERP：" + warn.join("/") + "（" + mmdd + "）") : ("九上 ERP 早報 " + mmdd);
  var head = "";
  if (warn.length) {
    head = "⚠️ 需注意\n";
    if (c.overdue) head += "- 逾期未出貨 " + c.overdue + " 筆\n";
    head += "\n";
  }
  var body = head + buildBriefText_() + "\n\n" + metalsSignalText_()
    + "\n\n（此信平日每天自動寄送；到網站看即時儀表板。）";
  GmailApp.sendEmail(getNotifyEmails_(), subject, body);
  return subject;
}

function installEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "sendDailyDigest") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyDigest").timeBased().everyDays(1).atHour(9).create();  // 每天早上約 9 點觸發；函式內會跳過週末
  try { SpreadsheetApp.getUi().alert("已開啟每日 ERP 早報 email（平日上午約 9 點）✅"); } catch (e) {}
}
