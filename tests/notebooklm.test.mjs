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
