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

var EMAIL_API = 1;                              // 版本（網頁會檢查；改了行為才加 1）
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
    // 資料來源自檢：signals.json 自己帶的 health，加上「這份檔案本身是不是太舊」（機器人整個停擺時只有這裡看得到）
    var warn = [];
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(d.updated || "");
    if (m) {
      var h = (Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5])) / 3600000;
      if (h > 30) warn.push("🔴 原料資料已 " + Math.floor(h) + " 小時沒更新（正常一天更新兩次），排程可能停了，請看 GitHub Actions。");
    }
    ((d.health && d.health.items) || []).forEach(function (i) {
      if (i.level !== "green") warn.push((i.level === "red" ? "🔴 " : "🟡 ") + i.name + "：" + i.display + (i.msg ? "（" + i.msg + "）" : ""));
    });
    var bs = backupWarn_(); if (bs) warn.push(bs);
    if (warn.length) lines.push("", "⚠️ 資料來源警示：報價先別直接照用", warn.join("\n"));
    return lines.join("\n");
  } catch (e) { return "【原料行情】暫時取不到（網站資料讀不到，請確認排程是否正常）。"; }
}

// 備份自檢：早報是「另一個觸發器」，備份壞了或根本沒裝，這裡才看得到（backup.gs 要先貼進去）
function backupWarn_() {
  if (typeof backupStatus_ !== "function") return "💾 備份功能尚未安裝（貼上 backup.gs 並執行 installBackupTrigger），目前資料沒有自動備份。";
  try {
    var b = backupStatus_();
    if (!b.installed || b.backupDays === null) return "💾 還沒有任何成功的備份紀錄，請執行 backupNow。";
    if (b.backupDays >= 3) return "🔴 已經 " + b.backupDays + " 天沒有成功備份（正常每天一次）" + (b.failStreak ? "，連續失敗 " + b.failStreak + " 次" : "") + "。";
    if (b.backupDays >= 2) return "🟡 已經 " + b.backupDays + " 天沒有成功備份。";
    if (b.drillDays === null || b.drillDays > 90) return "🟡 還原演練" + (b.drillDays === null ? "從來沒做過" : "已超過 " + b.drillDays + " 天沒做") + "，請執行 restoreDrill。";
  } catch (e) { return "💾 備份狀態讀不到：" + e; }
  return "";
}

// ---- 排程風險（排程頁存在小表 sched_kri：格子前面有「~」避免被當數字，資料切段 kri.0、kri.1…）----
function schedKri_() {
  try {
    var parts = readTable_("sched_kri").filter(function (r) { return /^kri\.\d+$/.test(String(r.id)); })
      .sort(function (a, b) { return Number(String(a.id).split(".")[1]) - Number(String(b.id).split(".")[1]); });
    if (!parts.length) return null;
    return JSON.parse(parts.map(function (r) { return String(r.data).replace(/^~/, ""); }).join(""));
  } catch (e) { return null; }
}
// 回傳 {red, yellow, text}；沒用過排程（沒有快照）回傳 null。
// 「逾時沒回報」「資料太久沒更新」在「寄信當下」重新算，不是排程頁存檔當下，所以沒人打開排程頁也抓得到。
function schedRiskInfo_() {
  var s = schedKri_(); if (!s) return null;
  var now = Date.now(), grace = (s.grace != null ? s.grace : 120) * 60000, red = s.red || 0, yellow = s.yellow || 0, lines = [];
  var ageH = (now - (s.ts || 0)) / 3600000;
  (s.items || []).forEach(function (x) { lines.push("- " + (x.level === "red" ? "【紅燈】" : "【黃燈】") + x.name + "（" + x.display + "）" + (x.msg ? " " + x.msg : "") + "　負責人：" + (x.owner || "—") + "；建議：" + (x.actionLabel || "")); });
  var erpDone = {};
  try { if (typeof erpLoad_ === "function") { (erpLoad_().workorders || []).forEach(function (w) { if (w.status === "完工") erpDone[w.no] = 1; }); } } catch (e) {}
  var overdue = [];
  (s.orders || []).forEach(function (o) {
    if (o.ae != null || erpDone[o.erp || o.id]) return;
    if (o.pe != null && o.pe + grace < now) overdue.push(o.id);
  });
  if (overdue.length) {
    lines.push("- " + (overdue.length >= 3 ? "【紅燈】" : "【黃燈】") + "預計完工已超過 " + Math.round(grace / 60000) + " 分鐘仍沒回報完工：" + overdue.slice(0, 6).join("、") + (overdue.length > 6 ? "…" : "") + "（共 " + overdue.length + " 張）；請現場回報，或 ERP 工單按完工。");
    if (overdue.length >= 3) red++; else yellow++;
  }
  if (ageH > 24) {
    lines.push("- " + (ageH > 72 ? "【紅燈】" : "【黃燈】") + "排程風險資料已 " + Math.floor(ageH) + " 小時沒有更新（沒人打開排程頁），上面的燈號可能已經過時；監控本身失靈也是風險。");
    if (ageH > 72) red++; else yellow++;
  }
  return { red: red, yellow: yellow, ageH: ageH, text: "【排程風險】燈號最近更新：" + Math.floor(ageH) + " 小時前（" + (s.by || "") + "）\n" + (lines.length ? lines.join("\n") : "- 全部正常") };
}

function sendDailyDigest(e) {
  // 自動排程(e 有值)時，週末(六/日)不寄；手動從編輯器執行(e 為空)則一律寄，方便測試（台北時區）
  var dow = Utilities.formatDate(new Date(), "Asia/Taipei", "u");  // 1=一 … 6=六 7=日
  if (e && (dow === "6" || dow === "7")) return "週末不寄送（自動排程）";
  var c = erpAlertCounts_();
  var mmdd = Utilities.formatDate(new Date(), "Asia/Taipei", "M/d");
  var warn = [];
  if (c.overdue) warn.push("逾期" + c.overdue);
  var sr = schedRiskInfo_();
  if (sr && sr.red) warn.push("排程紅燈" + sr.red); else if (sr && sr.yellow) warn.push("排程黃燈" + sr.yellow);
  var subject = warn.length ? ("⚠️ 九上 ERP：" + warn.join("/") + "（" + mmdd + "）") : ("九上 ERP 早報 " + mmdd);
  var head = "";
  if (warn.length) {
    head = "⚠️ 需注意\n";
    if (c.overdue) head += "- 逾期未出貨 " + c.overdue + " 筆\n";
    if (sr && (sr.red || sr.yellow)) head += "- 排程風險：" + (sr.red ? sr.red + " 項紅燈" : "") + (sr.red && sr.yellow ? "、" : "") + (sr.yellow ? sr.yellow + " 項黃燈" : "") + "（細節在下面）\n";
    head += "\n";
  }
  var body = head + (sr ? sr.text + "\n\n" : "") + buildBriefText_() + "\n\n" + metalsSignalText_()
    + "\n\n（此信平日每天自動寄送；到網站看即時儀表板。）";
  GmailApp.sendEmail(getNotifyEmails_(), subject, body);
  return subject;
}

function installEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "sendDailyDigest") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyDigest").timeBased().everyDays(1).atHour(9).create();  // 每天早上約 9 點觸發；函式內會跳過週末
  try { SpreadsheetApp.getUi().alert("已開啟每日 ERP 早報 email（平日上午約 9 點）✅"); } catch (e) {}
}
