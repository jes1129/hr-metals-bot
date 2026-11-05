// 價格提醒信：規則判斷、只通知一次、回到線另一邊才重置、資料紅燈不寄、週摘要
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

function world(sig, rows, quoteRows = [], props = {}) {
  const mails = [], upserts = [];
  const ctx = {
    console, mails, upserts, props,
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => (sig ? 200 : 500), getContentText: () => JSON.stringify(sig) }) },
    MailApp: { sendEmail: (a, b, c) => mails.push(typeof a === "object" ? { to: a.to, subject: a.subject, body: a.body, html: a.htmlBody } : { to: a, subject: b, body: c }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: () => "2026-11-06 11:00" },
    tList_: () => ({ header: [], rows }),
    tUpsert_: (t, row) => upserts.push({ t, row }),
    sheet_: () => ({ getDataRange: () => ({ getValues: () => [["ts", "material", "weight", "price", "proc", "margin", "quote", "by", "note"], ...quoteRows] }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(read("price-alerts.gs"), ctx, { filename: "price-alerts.gs" });
  return ctx;
}
const SIG = (over = {}) => ({
  updated: "2026-11-06 10:00",
  metals: [{ key: "copper", name: "銅", price_twd: 480000, pct: 0.5 }, { key: "aluminum", name: "鋁", price_twd: 100000, pct: -0.2 }],
  advice: { headline: "今天沒有需要處理的事，行情平穩", items: [], metals: [{ key: "copper", name: "銅", price_twd: 480000, d7: 4.2 }, { key: "aluminum", name: "鋁", price_twd: 100000, d7: -1 }],
            week: [{ name: "銅", d7: 4.2, d30: 1, lo: 470000, hi: 481000 }] },
  health: { level: "green" }, ...over,
});
const R = (o) => ({ id: "a1", email: "me@example.com", metal: "copper", type: "above", value: 470000, active: 1, fired: 0, ...o });

test("超過價格線 → 寄信給設定的人，並標記已通知", () => {
  const w = world(SIG(), [R()]);
  const r = w.checkPriceAlerts();
  assert.equal(r.sent, 1);
  assert.equal(w.mails[0].to, "me@example.com");
  assert.match(w.mails[0].subject, /銅價格超過 NT\$470,000/);
  assert.equal(w.upserts[0].row.fired, 1);
});

test("同一條規則已通知過 → 不重複寄", () => {
  const w = world(SIG(), [R({ fired: 1 })]);
  assert.equal(w.checkPriceAlerts().sent, 0);
  assert.equal(w.mails.length, 0);
});

test("價格回到線的另一邊 → 清掉已通知標記（之後才會再通知）", () => {
  const w = world(SIG(), [R({ fired: 1, value: 490000 })]);
  const r = w.checkPriceAlerts();
  assert.equal(r.sent, 0); assert.equal(r.reset, 1);
  assert.equal(w.upserts[0].row.fired, 0);
});

test("四種條件都判斷正確", () => {
  const w = world(SIG(), []);
  const st = { price_twd: 480000, d7: 4.2 };
  assert.equal(w.alertMet_(R({ type: "above", value: 490000 }), st), false);
  assert.equal(w.alertMet_(R({ type: "below", value: 490000 }), st), true);
  assert.equal(w.alertMet_(R({ type: "week_up", value: 4 }), st), true);
  assert.equal(w.alertMet_(R({ type: "week_down", value: 1 }), st), false);
  assert.equal(w.alertMet_(R({ type: "week_up", value: 4 }), { price_twd: 1, d7: null }), null);
});

test("資料紅燈時不寄信；抓不到行情也不寄", () => {
  const w = world(SIG({ health: { level: "red" } }), [R()]);
  assert.equal(w.checkPriceAlerts().ok, false); assert.equal(w.mails.length, 0);
  const w2 = world(null, [R()]);
  assert.equal(w2.checkPriceAlerts().ok, false); assert.equal(w2.mails.length, 0);
});

test("停用的規則、壞掉的 email 都略過", () => {
  const w = world(SIG(), [R({ active: 0 }), R({ id: "a2", email: "不是信箱" })]);
  assert.equal(w.checkPriceAlerts().sent, 0);
});

test("週摘要：每個有設提醒的人只寄一封", () => {
  const w = world(SIG(), [R(), R({ id: "a2" }), R({ id: "a3", email: "b@example.com" })]);
  assert.equal(w.sendWeeklyDigest().sent, 2);
  assert.match(w.mails[0].body, /本週行情摘要/);
  assert.match(w.mails[0].body, /【銅】近 7 天 \+4.2%/);
});

// ---------------- 報價盯盤 ----------------
const NOW = Date.now();
const Q = (o = {}) => [NOW - 2 * 86400000, "銅", 5, 440, 0, 20, 2640, "boss@example.com", "大成機械", ...[]].map((v, i) => (o[i] !== undefined ? o[i] : v));

test("報價盯盤：料價漲超過 3% → 寄給存報價的人，且只通知一次", () => {
  const props = {};
  const w = world(SIG(), [], [Q()], props);          // 銅現價 480 元/kg，報價時 440 → +9%
  const r = w.checkQuoteWatch();
  assert.equal(r.sent, 1);
  assert.equal(w.mails[0].to, "boss@example.com");
  assert.match(w.mails[0].subject, /1 筆報價可能需要重報/);
  assert.match(w.mails[0].body, /大成機械 銅 報價 NT\$2,640：料價 440 → 480/);
  const again = world(SIG(), [], [Q()], props).checkQuoteWatch();   // 同一份屬性再跑一次
  assert.equal(again.sent, 0);
});

test("報價盯盤：漲幅不到 3%、太舊、其他材料、沒有 email 都不寄", () => {
  const w = world(SIG(), [], [Q({ 3: 470 }), Q({ 0: NOW - 40 * 86400000 }), Q({ 1: "不鏽鋼 304" }), Q({ 7: "" })]);
  assert.equal(w.checkQuoteWatch().sent, 0);
});

test("checkPriceAlerts 會順便跑報價盯盤，盯盤出錯不影響價格提醒", () => {
  const w = world(SIG(), [R()], [Q()]);
  const r = w.checkPriceAlerts();
  assert.equal(r.sent, 1); assert.equal(r.quoteWatch.sent, 1);
  const w2 = world(SIG(), [R()], []); w2.sheet_ = () => { throw new Error("boom"); };
  const r2 = w2.checkPriceAlerts();
  assert.equal(r2.sent, 1); assert.equal(r2.quoteWatch.ok, false);
});

// ---------------- 週報 HTML ----------------
test("週報：同時有文字版與 HTML 版，內含解讀、走勢、新聞標籤；HTML 會跳脫", () => {
  const sig = SIG({ insight: { source: "ai", text: "銅小漲 <b>x</b>" }, news: [{ title: "LME 期銅下跌", link: "https://x/y", tag: "偏空" }] });
  sig.advice.metals[0].spark = [1, 2, 3, 4, 5, 6, 7, 8];
  const w = world(sig, [R()]);
  assert.equal(w.sendWeeklyDigest().sent, 1);
  const m = w.mails[0];
  assert.match(m.body, /AI 行情解讀：銅小漲/);
  assert.match(m.html, /本週行情摘要/);
  assert.match(m.html, /▁▂▃▄▅▆▇█/);
  assert.match(m.html, /偏空/);
  assert.doesNotMatch(m.html, /<b>x<\/b>/);          // 使用者/AI 文字不能原樣進 HTML
});

test("週報：WEEKLY_EMAILS 指令碼屬性可以加收件人，並與提醒使用者去重", () => {
  const w = world(SIG(), [R()], [], { WEEKLY_EMAILS: "me@example.com, c@example.com ,不是信箱" });
  assert.equal(w.sendWeeklyDigest().sent, 2);
  assert.deepEqual(w.mails.map((m) => m.to).sort(), ["c@example.com", "me@example.com"]);
});

test("sparkText_：長度對、最低最高對應 ▁ 與 █", () => {
  const w = world(SIG(), []);
  const t = w.sparkText_([1, 5, 10]);
  assert.equal(t.length, 3); assert.equal(t[0], "▁"); assert.equal(t[2], "█");
});

// ---------------- 安裝觸發器：不能用會卡住的提示框 ----------------
function installWorld(file) {
  const created = [], toasts = [];
  const trig = (fn) => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => created.push(fn) }) }), onWeekDay: () => ({ atHour: () => ({ create: () => created.push(fn) }) }) }) });
  const ctx = {
    console, created, toasts, Logger: { log: () => {} },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: trig, WeekDay: { MONDAY: 1 } },
    // 若有人呼叫 getUi().alert，就代表從編輯器執行時會卡到逾時 → 直接讓測試失敗
    SpreadsheetApp: { getUi: () => { throw new Error("getUi().alert 會讓編輯器等到逾時"); }, getActiveSpreadsheet: () => ({ toast: (m) => toasts.push(m) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(read(file), ctx, { filename: file });
  return ctx;
}

test("installAlertTriggers／installWeeklyDigestTrigger：建好觸發器、用 toast 提示、不呼叫會卡住的 getUi().alert", () => {
  const w = installWorld("price-alerts.gs");
  w.installAlertTriggers(); w.installWeeklyDigestTrigger();
  assert.deepEqual(w.created, ["checkPriceAlerts", "checkPriceAlerts", "sendWeeklyDigest"]);
  assert.equal(w.toasts.length, 2);
});

test("notebooklm-export 的 installDailyTrigger 同樣不卡住", () => {
  const w = installWorld("notebooklm-export.gs");
  w.installDailyTrigger();
  assert.deepEqual(w.created, ["updateNotebookDoc"]);
  assert.equal(w.toasts.length, 1);
});
