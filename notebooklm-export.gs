/**
 * 九上科技儀表板 — NotebookLM 匯出橋樑（Google Apps Script）【原料行情版】
 *
 * 用途：每天把銅、鋁的最新行情寫成一份固定的 Google 文件「九上科技 原料行情每日簡報」，
 *       讓 NotebookLM 當來源，可以直接問「銅這週走勢如何」「現在適合報價嗎」。
 *
 * 資料來源（都是公開網址，不需要 ERP，也不需要登入）：
 *   - 網站的 signals.json   ：目前價格、今日漲跌、資料健康燈號
 *   - repo 的 data/daily.json：一年的日線，算 7／30／90 天漲跌與區間高低
 *   - 試算表的 quotes 分頁   ：最近的報價紀錄（有登入存過才有；沒有就略過）
 *
 * 安裝（貼進「同一個」Apps Script 專案，當一個檔案；舊的 ERP 版請整個取代）：
 *   1. 試算表 → 擴充功能 → Apps Script → 開啟 notebooklm-export 檔，貼上本檔 → 儲存。
 *   2. 上方函式選 updateNotebookDoc → 執行一次 → 授權 → 完成後彈窗會給你文件連結。
 *   3. 執行一次 installDailyTrigger → 每天上午自動更新（會先把舊的觸發器換掉）。
 *   4. 同一份文件仍沿用原本的 NOTEBOOK_DOC_ID，NotebookLM 裡該來源按「同步」即可，不必重加。
 *
 * 註：本檔只「讀公開網址 + 讀 quotes 分頁 + 寫一份文件」，與網頁後端 google-apps-script.gs 互不影響。
 */

var NOTEBOOK_DOC_NAME = "九上科技 原料行情每日簡報";
var SITE_BASE = "https://jes1129.github.io/hr-metals-bot/";
var DATA_BASE = "https://raw.githubusercontent.com/jes1129/hr-metals-bot/main/data/";

// 不會卡住的提示：右下角小提示 + 執行記錄。
// （不要用 getUi().alert：從 Apps Script 編輯器執行時，提示框會跑到試算表分頁，編輯器就一直等你按確定，直到逾時。）
function note_(msg) {
  try { Logger.log(msg); } catch (e) {}
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, "九上儀表板", 8); } catch (e) {}
}

// ---- 試算表選單 ----
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🧠 NotebookLM")
    .addItem("🔄 立即更新行情簡報", "menuUpdate_")
    .addItem("🔗 顯示簡報文件連結", "menuLink_")
    .addItem("⏰ 開啟每日自動更新", "installDailyTrigger")
    .addToUi();
}
function menuUpdate_() {
  var url = updateNotebookDoc();
  SpreadsheetApp.getUi().alert("行情簡報已更新 ✅\n\n文件連結：\n" + url);
}
function menuLink_() {
  var id = PropertiesService.getScriptProperties().getProperty("NOTEBOOK_DOC_ID");
  if (!id) { SpreadsheetApp.getUi().alert("尚未建立簡報。請先點「🔄 立即更新行情簡報」。"); return; }
  SpreadsheetApp.getUi().alert("行情簡報文件連結：\n" + DocumentApp.openById(id).getUrl());
}

// ---- 每日自動更新（時間觸發器）----
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "updateNotebookDoc") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("updateNotebookDoc").timeBased().everyDays(1).atHour(11).create();  // 行情 10:00 更新，11 點之後讀才是新的
  note_("已開啟自動更新（每天上午約 11 點）✅");
}

// ---- 主流程：抓行情 → 算摘要 → 寫進固定的 Google 文件 ----
function updateNotebookDoc() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("NOTEBOOK_DOC_ID");
  var doc = null;
  if (id) { try { doc = DocumentApp.openById(id); } catch (e) { doc = null; } }
  if (!doc) { doc = DocumentApp.create(NOTEBOOK_DOC_NAME); props.setProperty("NOTEBOOK_DOC_ID", doc.getId()); }
  doc.setName(NOTEBOOK_DOC_NAME);
  doc.getBody().setText(buildBriefText_());
  doc.saveAndClose();
  return doc.getUrl();
}

// ===========================================================================
// 讀資料 + 計算 + 組出簡報文字
// ===========================================================================
function fetchJson_(url) {
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    return JSON.parse(r.getContentText());
  } catch (e) { return null; }
}
function readTable_(name) {
  // 分頁顯示名稱是中文（主檔的 SHEET_MAP：quotes → 報價紀錄），先用中文名找，找不到再試英文代號
  var zh = (typeof SHEET_MAP !== "undefined" && SHEET_MAP[name]) || name, ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(zh) || ss.getSheetByName(name);
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
function pct_(v) { return (v > 0 ? "+" : "") + (Math.round(v * 100) / 100) + "%"; }

// 日線 → 每天的台幣價（元/噸）
function twdSeries_(rows) {
  return (rows || []).filter(function (r) { return r.usd != null && r.rate != null; })
    .map(function (r) { return { ts: r.ts, v: r.usd * r.rate }; });
}
// 距今 n 天前的價格（取不超過該日期的最近一筆）
function priceAgo_(s, n) {
  if (!s.length) return null;
  var last = new Date(s[s.length - 1].ts), cut = new Date(last.getTime() - n * 86400000), hit = null;
  for (var i = 0; i < s.length; i++) { if (new Date(s[i].ts) <= cut) hit = s[i]; else break; }
  return hit ? hit.v : null;
}
function metalLines_(label, rows) {
  var s = twdSeries_(rows), L = [];
  if (s.length < 2) { L.push("- " + label + "：資料不足"); return L; }
  var last = s[s.length - 1], vs = s.map(function (x) { return x.v; });
  var hi = Math.max.apply(null, vs), lo = Math.min.apply(null, vs);
  var ma20 = vs.slice(-20).reduce(function (a, b) { return a + b; }, 0) / Math.min(20, vs.length);
  L.push("【" + label + "】最新（" + last.ts + "）：" + nt_(last.v) + " / 噸");
  [["7 天", 7], ["30 天", 30], ["90 天", 90]].forEach(function (p) {
    var old = priceAgo_(s, p[1]);
    if (old) L.push("- 近 " + p[0] + "：" + pct_((last.v / old - 1) * 100) + "（當時 " + nt_(old) + "）");
  });
  L.push("- 近一年區間：最低 " + nt_(lo) + "、最高 " + nt_(hi) + "；目前位於區間的 " + Math.round((last.v - lo) / (hi - lo || 1) * 100) + "% 位置");
  L.push("- 20 日均價 " + nt_(ma20) + "，目前" + (last.v >= ma20 ? "高於" : "低於") + "均價 " + pct_((last.v / ma20 - 1) * 100));
  return L;
}

function buildBriefText_() {
  var now = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm");
  var sig = fetchJson_(SITE_BASE + "signals.json");
  var daily = fetchJson_(DATA_BASE + "daily.json");

  var L = [];
  L.push("九上科技 原料行情每日簡報");
  L.push("更新時間：" + now + "（此文件由系統自動產生，供 NotebookLM 問答/摘要用；價格單位為新台幣／噸）");
  L.push("");

  if (!sig && !daily) {
    L.push("⚠️ 這次抓不到行情資料（網站或資料檔暫時無法連線），請稍後再更新。");
    return L.join("\n");
  }

  if (sig && sig.metals) {
    L.push("【今日行情】資料時間 " + (sig.updated || "—"));
    sig.metals.forEach(function (m) {
      L.push("- " + m.name + "：" + nt_(m.price_twd) + " / 噸，單日 " + pct_(m.pct) + (m.note ? "（" + m.note + "）" : ""));
    });
    L.push("");
  }

  if (sig && sig.health) {
    var h = sig.health, bad = (h.items || []).filter(function (i) { return i.level !== "green"; });
    L.push("【資料健康】" + (h.level === "green" ? "全部正常（綠燈）。報價可以使用。" : (h.red ? "有紅燈" : "有黃燈") + "，報價先別直接照用："));
    bad.forEach(function (i) { L.push("- " + (i.level === "red" ? "紅燈" : "黃燈") + " " + i.name + "：" + i.display + (i.msg ? "，" + i.msg : "")); });
    L.push("");
  }

  if (daily) {
    metalLines_("銅", daily.copper).forEach(function (x) { L.push(x); });
    L.push("");
    metalLines_("鋁", daily.aluminum).forEach(function (x) { L.push(x); });
    L.push("");
  }

  L.push("【最近報價（近 8 筆）】");
  var qz = [];
  try { qz = readTable_("quotes").sort(function (a, b) { return n_(b.ts) - n_(a.ts); }).slice(0, 8); } catch (e) { qz = []; }
  if (!qz.length) L.push("- 無");
  else qz.forEach(function (q) { L.push("- " + (q.material || "") + " " + n_(q.weight) + "kg → 報價 " + nt_(q.quote) + "（料價 " + comma_(q.price) + "/kg）"); });
  L.push("");

  L.push("— 以上為系統自動彙整，僅供參考，不構成投資建議。最新數字請看網站：" + SITE_BASE);
  return L.join("\n");
}
