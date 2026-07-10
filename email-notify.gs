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

// 從訂單/庫存/BOM 算「需注意」數字（重用 notebooklm-export.gs 的 readTable_/n_/ymd_）
function erpAlertCounts_() {
  var orders = readTable_("orders"), items = readTable_("items"), bom = readTable_("bom");
  var today = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  var overdue = 0;
  orders.forEach(function (o) { var d = ymd_(o.due); if (d && d < today && ["報價", "接單", "生產"].indexOf(o.status) >= 0) overdue++; });
  var demand = {};
  orders.forEach(function (o) {
    if (o.status !== "接單" && o.status !== "生產") return;
    bom.forEach(function (b) { if (String(b.product) === String(o.product)) demand[b.item_code] = (demand[b.item_code] || 0) + n_(o.qty) * n_(b.per); });
  });
  var shortN = 0, buy = 0, lowN = 0;
  items.forEach(function (it) {
    var sh = Math.max(0, (demand[it.code] || 0) + n_(it.safety) - n_(it.stock) - n_(it.on_order));
    if (sh > 0) { shortN++; buy += sh * n_(it.cost); }
    if (n_(it.stock) < n_(it.safety)) lowN++;
  });
  return { shortN: shortN, buy: buy, lowN: lowN, overdue: overdue };
}

// 原料現況（讀網站 signals.json）
function metalsSignalText_() {
  try {
    var r = UrlFetchApp.fetch(EMAIL_SIGNALS_URL, { muteHttpExceptions: true });
    var d = JSON.parse(r.getContentText());
    var lines = ["【原料行情】更新 " + (d.updated || "")];
    (d.metals || []).forEach(function (m) {
      var mark = m.status === "break_high" ? "🔴漲破上線" : (m.status === "break_low" ? "🟢跌破下線" : "🟢區間內");
      lines.push("- " + m.name + "：" + (m.price_twd != null ? ("NT$ " + comma_(m.price_twd) + "/噸") : "—") + " " + mark);
    });
    if ((d.alerts || []).length) lines.push("⚠️ 突破告警：" + d.alerts.join("；"));
    return lines.join("\n");
  } catch (e) { return "【原料行情】暫時取不到。"; }
}

function sendDailyDigest() {
  var c = erpAlertCounts_();
  var mmdd = Utilities.formatDate(new Date(), "Asia/Taipei", "M/d");
  var warn = [];
  if (c.shortN) warn.push("缺料" + c.shortN);
  if (c.overdue) warn.push("逾期" + c.overdue);
  if (c.lowN) warn.push("低庫存" + c.lowN);
  var subject = warn.length ? ("⚠️ 九上 ERP：" + warn.join("/") + "（" + mmdd + "）") : ("九上 ERP 早報 " + mmdd);
  var head = "";
  if (warn.length) {
    head = "⚠️ 需注意\n";
    if (c.shortN) head += "- 缺料 " + c.shortN + " 項，建議採購約 NT$ " + comma_(c.buy) + "\n";
    if (c.overdue) head += "- 逾期未出貨 " + c.overdue + " 筆\n";
    if (c.lowN) head += "- 低於安全庫存 " + c.lowN + " 項\n";
    head += "\n";
  }
  var body = head + buildBriefText_() + "\n\n" + metalsSignalText_()
    + "\n\n（此信每天自動寄送；到網站看即時儀表板。）";
  GmailApp.sendEmail(getNotifyEmails_(), subject, body);
  return subject;
}

function installEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "sendDailyDigest") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyDigest").timeBased().everyDays(1).atHour(7).create();
  try { SpreadsheetApp.getUi().alert("已開啟每日 ERP 早報 email（每天上午約 7 點）✅"); } catch (e) {}
}
