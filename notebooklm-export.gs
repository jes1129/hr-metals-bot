/**
 * 九上科技儀表板 — NotebookLM 匯出橋樑（Google Apps Script）
 *
 * 用途：每天（或手動）把試算表裡的 ERP 現況（訂單/營收/待出貨/逾期/報價/往來）
 *       寫成一份固定的 Google 文件「九上科技 ERP 每日簡報」，讓 NotebookLM 當來源。
 *
 * 安裝（貼進「同一個」Apps Script 專案，當第二個檔案）：
 *   1. 試算表 → 擴充功能 → Apps Script → 左側「＋ → 指令碼」新增檔案，貼上本檔 → 儲存。
 *   2. 上方函式選 updateNotebookDoc → 執行一次 → 授權 → 完成後彈窗會給你文件連結。
 *   3. 執行一次 installDailyTrigger → 每天上午自動更新。
 *   4. 打開那份 Google 文件 → 共用設「知道連結者可檢視」→ 複製連結。
 *   5. notebooklm.google.com → 新增筆記本 → 新增來源 → Google 文件 → 選這份（第一次手動加）。
 *      之後改寫同一份文件、在 NotebookLM 該來源按「同步」即可，不必重加。
 *
 * 註：本檔只「讀試算表 + 寫一份文件」，與網頁後端 google-apps-script.gs 互不影響。
 */

var NOTEBOOK_DOC_NAME = "九上科技 ERP 每日簡報";

// ---- 試算表選單（打開試算表時出現）----
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🧠 NotebookLM")
    .addItem("🔄 立即更新簡報", "menuUpdate_")
    .addItem("🔗 顯示簡報連結", "menuLink_")
    .addItem("⏰ 開啟每日自動更新", "installDailyTrigger")
    .addToUi();
}
function menuUpdate_() {
  var url = updateNotebookDoc();
  SpreadsheetApp.getUi().alert("ERP 簡報已更新 ✅\n\n文件連結：\n" + url);
}
function menuLink_() {
  var id = PropertiesService.getScriptProperties().getProperty("NOTEBOOK_DOC_ID");
  if (!id) { SpreadsheetApp.getUi().alert("尚未建立簡報。請先點「🔄 立即更新簡報」。"); return; }
  SpreadsheetApp.getUi().alert("ERP 簡報文件連結：\n" + DocumentApp.openById(id).getUrl());
}

// ---- 每日自動更新（時間觸發器）----
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "updateNotebookDoc") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("updateNotebookDoc").timeBased().everyDays(1).atHour(9).create();  // 每天早上約 9 點觸發；函式內會跳過週末
  try { SpreadsheetApp.getUi().alert("已開啟自動更新（平日上午約 9 點）✅"); } catch (e) {}
}

// ---- 主流程：算摘要 → 寫進固定的 Google 文件 ----
function updateNotebookDoc(e) {
  // 自動排程(e 有值)時，週末(六/日)不更新；手動從編輯器執行(e 為空)則一律更新，方便測試（台北時區）
  var dow = Utilities.formatDate(new Date(), "Asia/Taipei", "u");  // 1=一 … 6=六 7=日
  if (e && (dow === "6" || dow === "7")) return "週末不更新（自動排程）";
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("NOTEBOOK_DOC_ID");
  var doc = null;
  if (id) { try { doc = DocumentApp.openById(id); } catch (e) { doc = null; } }
  if (!doc) { doc = DocumentApp.create(NOTEBOOK_DOC_NAME); props.setProperty("NOTEBOOK_DOC_ID", doc.getId()); }
  doc.getBody().setText(buildBriefText_());
  doc.saveAndClose();
  return doc.getUrl();
}

// ===========================================================================
// 讀試算表 + 計算 + 組出簡報文字
// ===========================================================================
function readTable_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var hdr = vals[0], rows = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {}, empty = true;
    for (var c = 0; c < hdr.length; c++) { o[hdr[c]] = vals[i][c]; if (vals[i][c] !== "") empty = false; }
    if (!empty) rows.push(o);
  }
  return rows;
}
function n_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
function comma_(v) { return String(Math.round(n_(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function nt_(v) { return "NT$ " + comma_(v); }
function ymd_(v) { return (v instanceof Date) ? Utilities.formatDate(v, "Asia/Taipei", "yyyy-MM-dd") : String(v || ""); }
function amt_(o) { var a = Number(o.amount); return (!isNaN(a) && o.amount !== "" && o.amount != null) ? a : n_(o.qty) * n_(o.price); }

function buildBriefText_() {
  var orders = readTable_("orders"),
      quotes = readTable_("quotes"), marks = readTable_("marks");
  var today = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  var month = today.slice(0, 7);
  var now = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm");

  function overdue(o) { var d = ymd_(o.due); return d && d < today && ["報價", "接單", "生產"].indexOf(o.status) >= 0; }

  // KPI
  var rev = 0, cnt = 0, ship = 0, overdueList = [], shipList = [];
  orders.forEach(function (o) {
    if (o.status === "取消") return;
    if (ymd_(o.order_date).slice(0, 7) === month) { rev += amt_(o); cnt++; }
    if (o.status === "接單" || o.status === "生產") { ship++; shipList.push(o); }
    if (overdue(o)) overdueList.push(o);
  });

  var L = [];
  L.push("九上科技 ERP 每日簡報");
  L.push("更新時間：" + now + "（此文件由系統自動產生，供 NotebookLM 問答/摘要用）");
  L.push("");
  L.push("【本月營收與訂單】月份 " + month);
  L.push("- 本月營收：" + nt_(rev));
  L.push("- 本月訂單數：" + cnt + " 筆");
  L.push("- 待出貨（接單/生產中）：" + ship + " 筆");
  L.push("- 逾期未出貨：" + overdueList.length + " 筆");
  L.push("");

  L.push("【逾期訂單（交期已過、尚未出貨）】");
  if (!overdueList.length) L.push("- 無");
  else overdueList.forEach(function (o) { L.push("- " + (o.customer || "?") + "／" + (o.product || "") + "：交期 " + ymd_(o.due) + "，狀態 " + o.status + "，數量 " + n_(o.qty)); });
  L.push("");

  L.push("【待出貨清單（接單/生產中）】");
  if (!shipList.length) L.push("- 無");
  else shipList.forEach(function (o) { L.push("- " + (o.customer || "?") + "／" + (o.product || "") + " ×" + n_(o.qty) + "（交期 " + (ymd_(o.due) || "未定") + "，金額 " + nt_(amt_(o)) + "）"); });
  L.push("");


  L.push("【最近報價（近 8 筆）】");
  var qz = quotes.slice().sort(function (a, b) { return n_(b.ts) - n_(a.ts); }).slice(0, 8);
  if (!qz.length) L.push("- 無");
  else qz.forEach(function (q) { L.push("- " + (q.material || "") + " " + n_(q.weight) + "kg → 報價 " + nt_(q.quote) + "（料價 " + comma_(q.price) + "/kg）"); });
  L.push("");

  L.push("【往來標記重點（合作中／已收藏）】");
  var hi = marks.filter(function (m) { return m.status === "合作中" || m.fav === true || m.fav === "TRUE" || m.fav === "true"; });
  if (!hi.length) L.push("- 無");
  else hi.forEach(function (m) { L.push("- " + m.id + "：" + (m.status || "已收藏") + (m.note ? "（備註：" + m.note + "）" : "")); });
  L.push("");

  L.push("— 以上為系統即時彙整。若需最新數字，回網站儀表板查看；本文件每天自動更新一次。");
  return L.join("\n");
}
