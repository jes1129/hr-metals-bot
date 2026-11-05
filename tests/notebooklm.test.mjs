// NotebookLM 行情簡報：用真實的 daily.json / signals.json 跑一次，確認文字有銅鋁行情、沒有 ERP 殘留
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

function world(over = {}) {
  const files = { "signals.json": read("docs/signals.json"), "daily.json": read("data/daily.json"), ...over };
  const ctx = {
    console,
    UrlFetchApp: { fetch: (u) => { const k = Object.keys(files).find((n) => u.endsWith(n)); return { getResponseCode: () => (k && files[k] != null ? 200 : 404), getContentText: () => files[k] }; } },
    Utilities: { formatDate: () => "2026-11-06 11:00" },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
  };
  vm.createContext(ctx);
  vm.runInContext(read("notebooklm-export.gs"), ctx, { filename: "notebooklm-export.gs" });
  return ctx;
}

test("行情簡報：有銅、鋁、漲跌幅、資料健康，沒有 ERP 字樣", () => {
  const t = world().buildBriefText_();
  assert.match(t, /原料行情每日簡報/);
  assert.match(t, /【銅】最新/);
  assert.match(t, /【鋁】最新/);
  assert.match(t, /近 30 天：[+-]?\d/);
  assert.match(t, /【資料健康】/);
  assert.doesNotMatch(t, /ERP|訂單|營收/);
});

test("行情簡報：抓不到資料時不丟錯，改寫提示", () => {
  const t = world({ "signals.json": null, "daily.json": null }).buildBriefText_();
  assert.match(t, /抓不到行情資料/);
});

test("最近報價：分頁實際名稱是中文「報價紀錄」時也讀得到（不能再永遠顯示『無』）", () => {
  const files = { "signals.json": read("docs/signals.json"), "daily.json": read("data/daily.json") };
  const rows = [["ts", "material", "weight", "price", "proc", "margin", "quote", "by", "note"], [Date.now(), "銅", 5, 440, 0, 20, 2640, "a@example.com", "大成機械"]];
  const sheets = { "報價紀錄": { getDataRange: () => ({ getValues: () => rows }) } };   // 沒有名為 quotes 的分頁
  const ctx = {
    console, SHEET_MAP: { quotes: "報價紀錄" },
    UrlFetchApp: { fetch: (u) => { const k = Object.keys(files).find((n) => u.endsWith(n)); return { getResponseCode: () => 200, getContentText: () => files[k] }; } },
    Utilities: { formatDate: () => "2026-11-06 11:00" },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }) },
  };
  vm.createContext(ctx);
  vm.runInContext(read("notebooklm-export.gs"), ctx, { filename: "notebooklm-export.gs" });
  const t = ctx.buildBriefText_();
  assert.match(t, /銅 5kg → 報價 NT\$ 2,640/);
  assert.doesNotMatch(t, /【最近報價（近 8 筆）】\n- 無/);
});

// ---------------- 簡報加入「今天該做什麼／行情解讀／新聞」 ----------------
function briefWith(sig, daily = JSON.parse(read("data/daily.json"))) {
  const files = { "signals.json": JSON.stringify(sig), "daily.json": JSON.stringify(daily) };
  const ctx = {
    console,
    UrlFetchApp: { fetch: (u) => { const k = Object.keys(files).find((n) => u.endsWith(n)); return { getResponseCode: () => 200, getContentText: () => files[k] }; } },
    Utilities: { formatDate: () => "2026-11-06 11:00" },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
  };
  vm.createContext(ctx);
  vm.runInContext(read("notebooklm-export.gs"), ctx, { filename: "notebooklm-export.gs" });
  return ctx.buildBriefText_();
}
const SIGX = (over = {}) => ({
  updated: "2026-11-06 10:00",
  metals: [{ key: "copper", name: "銅", price_twd: 480000, pct: 0.5 }],
  health: { level: "green", items: [] },
  advice: { headline: "今天有 1 件事要注意", items: [{ level: "attention", text: "鋁今天漲 1.72%，今天要報價的話，確認一下是否需要加價。" }] },
  insight: { source: "ai", updated: "2026-11-06 10:01", text: "銅目前 NT$480,000／噸。 新聞面庫存回升與需求回溫並存。" },
  news: [{ title: "全球庫存回升 LME期銅下跌", tag: "偏空", source: "富聯網", date: "11/05" }, { title: "需求轉好 金屬上漲", tag: "偏多" }],
  ...over,
});

test("簡報有『今天該做什麼』『行情解讀』『最近相關新聞』，並標示 AI 與新聞標籤", () => {
  const t = briefWith(SIGX());
  assert.match(t, /【今天該做什麼】今天有 1 件事要注意\n- 鋁今天漲 1\.72%/);
  assert.match(t, /【行情解讀】（行情數字由程式計算；新聞面的說明由 AI 依新聞標題撰寫） 更新於 2026-11-06 10:01\n銅目前/);
  assert.match(t, /【最近相關新聞】.*\n- \[偏空\] 全球庫存回升 LME期銅下跌（富聯網 11\/05）\n- \[偏多\] 需求轉好 金屬上漲/);
});

test("簡報說明『最新價漲跌』與『日線收盤漲跌』來源不同，避免被當成矛盾", () => {
  assert.match(briefWith(SIGX()), /兩者資料來源不同，數字會有落差，不是矛盾/);
});

test("規則整理的解讀會標示『依規則自動整理』，不假裝是 AI", () => {
  const t = briefWith(SIGX({ insight: { source: "rule", text: "銅目前 NT$480,000／噸。" } }));
  assert.match(t, /【行情解讀】（依規則自動整理）/);
  assert.doesNotMatch(t, /由 AI 依新聞標題撰寫/);
});

test("signals.json 沒有 advice／insight／news（舊版資料）時，簡報不出錯也不出現空區塊", () => {
  const t = briefWith({ updated: "x", metals: [{ key: "copper", name: "銅", price_twd: 480000, pct: 0.5 }], health: { level: "green", items: [] } });
  assert.match(t, /【今日行情】/);
  assert.doesNotMatch(t, /【今天該做什麼】|【行情解讀】|【最近相關新聞】/);
});
