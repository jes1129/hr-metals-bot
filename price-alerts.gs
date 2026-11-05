/**
 * 九上科技儀表板 — 價格提醒信（Google Apps Script）
 *
 * 用途：每個人在儀表板「原料行情」頁設好自己的提醒（例如「銅超過 NT$480,000/噸就通知我」），
 *       這支程式在行情更新後檢查全部規則，符合的就寄 Email 給設定的人。
 *
 * 規則存在試算表的「價格提醒」分頁（程式內部代號 alerts，主檔 SHEET_MAP 會自動對應）（由網頁的通用資料表功能寫入）：
 *   id, email, metal(copper|aluminum), type(above|below|week_up|week_down), value, fired, firedAt …
 *
 * 防止重複轟炸：同一條規則觸發寄信後標記 fired=1；要等價格回到線的另一邊（fired 清掉）才會再通知。
 *
 * 安裝（貼進「同一個」Apps Script 專案，當一個檔案）：
 *   1. 試算表 → 擴充功能 → Apps Script → 「＋ → 指令碼」新增檔案，貼上本檔 → 儲存。
 *   2. 函式選 checkPriceAlerts → 執行一次 → 授權（需要寄信權限）。
 *   3. 執行一次 installAlertTriggers → 每天兩次（行情更新後）自動檢查。
 *   4.（選用）執行 installWeeklyDigestTrigger → 每週一早上寄「本週行情摘要」給有設提醒的人。
 *
 * 行情資料來自網站公開的 signals.json（不需要登入）。寄信額度：一般 Google 帳號每天約 100 封。
 */

var ALERT_TABLE = "alerts";
var ALERT_SITE = "https://jes1129.github.io/hr-metals-bot/";

// 不會卡住的提示：右下角小提示 + 執行記錄。
// （不要用 getUi().alert：從 Apps Script 編輯器執行時，提示框會跑到試算表分頁，編輯器就一直等你按確定，直到逾時。）
function note_(msg) {
  try { Logger.log(msg); } catch (e) {}
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, "九上儀表板", 8); } catch (e) {}
}

// ---- 觸發器 ----
function installAlertTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "checkPriceAlerts") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkPriceAlerts").timeBased().everyDays(1).atHour(11).create();   // 台灣 10:00 行情更新後
  ScriptApp.newTrigger("checkPriceAlerts").timeBased().everyDays(1).atHour(23).create();   // 台灣 22:00 行情更新後
  note_("已開啟價格提醒（每天約 11 點與 23 點檢查）✅");
}
function installWeeklyDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sendWeeklyDigest") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendWeeklyDigest").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  note_("已開啟每週一早上的行情摘要信 ✅");
}

// ---- 規則判斷（純函式，方便測試）----
var METAL_NAME_ = { copper: "銅", aluminum: "鋁" };
function alertTypeText_(r) {
  var n = METAL_NAME_[r.metal] || r.metal, v = Number(r.value);
  if (r.type === "above") return n + "價格超過 NT$" + Math.round(v).toLocaleString("en-US") + " / 噸";
  if (r.type === "below") return n + "價格低於 NT$" + Math.round(v).toLocaleString("en-US") + " / 噸";
  if (r.type === "week_up") return n + "近 7 天漲幅超過 " + v + "%";
  if (r.type === "week_down") return n + "近 7 天跌幅超過 " + v + "%";
  return n + " " + r.type + " " + v;
}
// 目前是否達標；資料缺就回 null（不要亂通知）
function alertMet_(r, stat) {
  if (!stat) return null;
  var v = Number(r.value);
  if (isNaN(v)) return null;
  if (r.type === "above") return stat.price_twd == null ? null : stat.price_twd >= v;
  if (r.type === "below") return stat.price_twd == null ? null : stat.price_twd <= v;
  if (r.type === "week_up") return stat.d7 == null ? null : stat.d7 >= v;
  if (r.type === "week_down") return stat.d7 == null ? null : stat.d7 <= -v;
  return null;
}
function alertStats_(sig) {
  var out = {};
  ((sig && sig.metals) || []).forEach(function (m) { out[m.key] = { price_twd: m.price_twd, d7: null }; });
  (((sig && sig.advice) || {}).metals || []).forEach(function (m) {
    if (!out[m.key]) out[m.key] = { price_twd: m.price_twd, d7: null };
    out[m.key].d7 = m.d7;
    if (out[m.key].price_twd == null) out[m.key].price_twd = m.price_twd;
  });
  return out;
}
function alertActive_(r) { return !(r.active === 0 || r.active === "0" || r.active === false || String(r.active).toLowerCase() === "false"); }
function alertFired_(r) { return r.fired === 1 || r.fired === "1" || r.fired === true; }
function validEmail_(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || "")); }

// ---- 主流程 ----
function fetchSignals_() {
  try {
    var r = UrlFetchApp.fetch(ALERT_SITE + "signals.json", { muteHttpExceptions: true });
    return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null;
  } catch (e) { return null; }
}
function checkPriceAlerts() {
  var sig = fetchSignals_();
  if (!sig) return { ok: false, reason: "抓不到行情" };
  // 資料紅燈時不寄（資料不可信，通知只會誤導）
  if (sig.health && sig.health.level === "red") return { ok: false, reason: "資料紅燈，暫不通知" };
  var stats = alertStats_(sig), rows = tList_(ALERT_TABLE).rows, sent = 0, reset = 0;
  rows.forEach(function (r) {
    if (!alertActive_(r) || !validEmail_(r.email)) return;
    var met = alertMet_(r, stats[r.metal]);
    if (met === null) return;
    if (met && !alertFired_(r)) {
      var st = stats[r.metal];
      var body = "你設定的提醒已達標：\n\n" + alertTypeText_(r) + "\n\n"
        + "目前 " + (METAL_NAME_[r.metal] || r.metal) + "：NT$" + Math.round(st.price_twd).toLocaleString("en-US") + " / 噸"
        + (st.d7 != null ? "（近 7 天 " + (st.d7 > 0 ? "+" : "") + st.d7 + "%）" : "") + "\n\n"
        + "同一條提醒只會通知一次，價格回到線的另一邊後才會再通知。\n儀表板：" + ALERT_SITE + "metals.html";
      MailApp.sendEmail(String(r.email), "【九上行情提醒】" + alertTypeText_(r), body);
      tUpsert_(ALERT_TABLE, { id: r.id, fired: 1, firedAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm") }, null, "alert-bot");
      sent++;
    } else if (!met && alertFired_(r)) {
      tUpsert_(ALERT_TABLE, { id: r.id, fired: 0 }, null, "alert-bot");
      reset++;
    }
  });
  var qw = null;
  try { qw = checkQuoteWatch(sig); } catch (e) { qw = { ok: false, reason: String(e) }; }   // 報價盯盤：順便檢查，失敗不影響價格提醒
  return { ok: true, sent: sent, reset: reset, quoteWatch: qw };
}

// ---- 報價盯盤：存過的報價，料價漲超過 3% 就寄信給「存這筆報價的人」----
var QW_TH = 3;        // 料價比報價當時高出幾 % 就提醒
var QW_DAYS = 30;     // 只看最近幾天的報價
var QW_MAT = { 銅: "copper", 鋁: "aluminum" };
function quoteWatchPrices_(sig) {          // 每公斤現價（新台幣）
  var out = {};
  ((sig && sig.metals) || []).forEach(function (m) {
    Object.keys(QW_MAT).forEach(function (zh) { if (QW_MAT[zh] === m.key && m.price_twd) out[zh] = m.price_twd / 1000; });
  });
  return out;
}
function checkQuoteWatch(sig) {
  sig = sig || fetchSignals_();
  if (!sig) return { ok: false, reason: "抓不到行情" };
  var nt = quoteWatchPrices_(sig), props = PropertiesService.getScriptProperties(), done = {}, now = Date.now();
  try { JSON.parse(props.getProperty("QW_DONE") || "[]").forEach(function (t) { done[t] = 1; }); } catch (e) { done = {}; }
  var vals = sheet_("quotes", ["ts", "material", "weight", "price", "proc", "margin", "quote", "by", "note"]).getDataRange().getValues();
  var byMail = {}, marked = [];
  for (var i = 1; i < vals.length; i++) {
    var v = vals[i], ts = Number(v[0]), mat = String(v[1] || ""), price = Number(v[3]), w = Number(v[2]), by = String(v[7] || "").toLowerCase();
    if (!ts || now - ts > QW_DAYS * 86400000 || done[ts] || !nt[mat] || !(price > 0) || !validEmail_(by)) continue;
    var dp = (nt[mat] / price - 1) * 100;
    if (dp < QW_TH) continue;
    (byMail[by] = byMail[by] || []).push({ ts: ts, mat: mat, note: String(v[8] || ""), quote: Number(v[6]), price: price, cur: nt[mat], dp: dp, dc: (nt[mat] - price) * w });
    marked.push(ts);
  }
  var sent = 0;
  Object.keys(byMail).forEach(function (to) {
    var L = ["你存過的報價，原料價格已經比當時高了，這些報價可能偏低，建議確認是否需要重報：", ""];
    byMail[to].forEach(function (x) {
      L.push("・" + (x.note ? x.note + " " : "") + x.mat + " 報價 NT$" + Math.round(x.quote).toLocaleString("en-US") + "：料價 " + x.price + " → " + (Math.round(x.cur * 10) / 10)
        + "（+" + (Math.round(x.dp * 10) / 10) + "%），成本多了約 NT$" + Math.round(x.dc).toLocaleString("en-US"));
    });
    L.push("", "每筆報價只會通知一次。到報價紀錄看全部：" + ALERT_SITE + "records.html");
    MailApp.sendEmail(to, "【九上報價盯盤】" + byMail[to].length + " 筆報價可能需要重報", L.join("\n"));
    sent++;
  });
  if (marked.length) {                          // 記住已通知的，並清掉太舊的，避免屬性越存越大
    var keep = Object.keys(done).map(Number).concat(marked).filter(function (t) { return now - t <= 60 * 86400000; });
    props.setProperty("QW_DONE", JSON.stringify(keep.slice(-400)));
  }
  return { ok: true, sent: sent, quotes: marked.length };
}

// ---- 每週行情摘要（週一早上）：文字版 + 好看的 HTML 版 ----
function esc_(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function sparkText_(arr) {                      // 文字迷你走勢：▁▂▃▄▅▆▇█（信件裡不能跑 JS，用這個最穩）
  var a = (arr || []).filter(function (x) { return x != null; }), blocks = "▁▂▃▄▅▆▇█";
  if (a.length < 2) return "";
  var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a), span = hi - lo || 1;
  return a.map(function (v) { return blocks.charAt(Math.min(7, Math.floor((v - lo) / span * 8))); }).join("");
}
function weeklyDigestText_(sig) {
  var a = (sig && sig.advice) || {}, L = ["本週行情摘要（" + ((sig && sig.updated) || "") + "）", ""];
  (a.week || []).forEach(function (w) {
    L.push("【" + w.name + "】近 7 天 " + (w.d7 > 0 ? "+" : "") + w.d7 + "%，近 30 天 " + (w.d30 == null ? "—" : (w.d30 > 0 ? "+" : "") + w.d30 + "%")
      + "；近 5 個交易日區間 NT$" + Math.round(w.lo).toLocaleString("en-US") + " ～ NT$" + Math.round(w.hi).toLocaleString("en-US"));
  });
  if (!(a.week || []).length) L.push("（這次抓不到週摘要資料）");
  if (sig && sig.insight && sig.insight.text) L.push("", (sig.insight.source === "ai" ? "AI 行情解讀：" : "行情整理：") + sig.insight.text);
  var news = (sig && sig.news) || [];
  if (news.length) { L.push("", "本週相關新聞："); news.slice(0, 5).forEach(function (n) { L.push("・[" + (n.tag || "中性") + "] " + n.title); }); }
  L.push("", "今天的建議：" + (a.headline || "—"));
  (a.items || []).forEach(function (i) { L.push("・" + i.text); });
  L.push("", "僅供參考，不構成投資建議。儀表板：" + ALERT_SITE);
  return L.join("\n");
}
function weeklyDigestHtml_(sig) {
  var a = (sig && sig.advice) || {}, ins = (sig && sig.insight) || null, news = (sig && sig.news) || [];
  var tagColor = { "偏多": "#b3402f", "偏空": "#2f7d55", "中性": "#777" };
  var h = '<div style="font-family:-apple-system,Segoe UI,Microsoft JhengHei,sans-serif;max-width:640px;margin:auto;color:#222">'
    + '<div style="background:#22313f;color:#fff;padding:16px 20px;border-bottom:3px solid #b34d20"><div style="font-size:12px;opacity:.8">九上科技 · 智慧儀表板</div><div style="font-size:20px;font-weight:700">本週行情摘要</div>'
    + '<div style="font-size:12px;opacity:.8">' + esc_((sig && sig.updated) || "") + '</div></div>';
  if (ins && ins.text) {
    h += '<div style="border-left:4px solid #b34d20;background:#faf3ee;padding:12px 16px;margin:14px 0"><div style="font-size:12px;font-weight:700;color:#8c3815">'
      + (ins.source === "ai" ? "AI 行情解讀" : "行情整理") + '</div><div style="font-size:14.5px;line-height:1.8">' + esc_(ins.text) + '</div></div>';
  }
  h += '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0"><tr style="background:#f2f2f2;text-align:left"><th style="padding:8px">金屬</th><th>現價 / 噸</th><th>近 7 天</th><th>近 30 天</th><th>近 30 天走勢</th></tr>';
  var spark = {}; (a.metals || []).forEach(function (m) { spark[m.name] = m; });
  (a.week || []).forEach(function (w) {
    var m = spark[w.name] || {}, c7 = w.d7 > 0 ? "#b3402f" : "#2f7d55", c30 = w.d30 > 0 ? "#b3402f" : "#2f7d55";
    h += '<tr style="border-top:1px solid #ddd"><td style="padding:8px"><b>' + esc_(w.name) + '</b></td><td>' + (m.price_twd ? "NT$" + Math.round(m.price_twd).toLocaleString("en-US") : "—")
      + '</td><td style="color:' + c7 + ';font-weight:700">' + (w.d7 > 0 ? "+" : "") + w.d7 + '%</td><td style="color:' + c30 + ';font-weight:700">' + (w.d30 == null ? "—" : (w.d30 > 0 ? "+" : "") + w.d30 + "%")
      + '</td><td style="font-size:16px;letter-spacing:1px;color:#b34d20">' + esc_(sparkText_(m.spark)) + '</td></tr>';
  });
  h += '</table>';
  if (news.length) {
    h += '<div style="font-weight:700;margin:14px 0 4px">本週相關新聞</div>';
    news.slice(0, 5).forEach(function (n) {
      h += '<div style="padding:5px 0;border-top:1px solid #eee;font-size:13.5px"><span style="color:#fff;background:' + (tagColor[n.tag] || "#777") + ';font-size:11px;padding:0 6px;border-radius:3px;margin-right:6px">' + esc_(n.tag || "中性") + '</span>'
        + '<a href="' + esc_(n.link) + '" style="color:#222;text-decoration:none">' + esc_(n.title) + '</a></div>';
    });
  }
  h += '<div style="font-weight:700;margin:14px 0 4px">今天的建議：' + esc_(a.headline || "—") + '</div>';
  (a.items || []).forEach(function (i) { h += '<div style="font-size:13.5px;padding:2px 0">・' + esc_(i.text) + '</div>'; });
  h += '<div style="font-size:12px;color:#888;margin-top:16px;border-top:1px solid #ddd;padding-top:8px">僅供參考，不構成投資建議。<a href="' + ALERT_SITE + '">開啟儀表板</a></div></div>';
  return h;
}
function sendWeeklyDigest() {
  var sig = fetchSignals_();
  if (!sig) return { ok: false, reason: "抓不到行情" };
  var seen = {}, to = [];
  function add(e) { e = String(e || "").trim().toLowerCase(); if (validEmail_(e) && !seen[e]) { seen[e] = 1; to.push(e); } }
  tList_(ALERT_TABLE).rows.forEach(function (r) { add(r.email); });                                   // 有設價格提醒的人
  String(PropertiesService.getScriptProperties().getProperty("WEEKLY_EMAILS") || "").split(",").forEach(add);   // 另外指定的收件人（指令碼屬性 WEEKLY_EMAILS，逗號分隔）
  var text = weeklyDigestText_(sig), html = weeklyDigestHtml_(sig);
  to.forEach(function (e) { MailApp.sendEmail({ to: e, subject: "【九上行情】本週行情摘要", body: text, htmlBody: html }); });
  return { ok: true, sent: to.length };
}
