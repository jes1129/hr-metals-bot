// 主檔：資料表代號對應中文分頁名稱；舊的英文分頁要自動改名（只改名、不複製不刪資料）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

function load(sheets) {
  const inserted = [];
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { const sh = { name: n, appendRow() {}, setName(x) { sheets[x] = sheets[this.name]; delete sheets[this.name]; this.name = x; } }; sheets[n] = sh; inserted.push(n); return sh; },
  };
  const ctx = { console, SpreadsheetApp: { getActiveSpreadsheet: () => ss } };
  vm.createContext(ctx);
  vm.runInContext(read("google-apps-script.gs"), ctx, { filename: "google-apps-script.gs" });
  return { ctx, sheets, inserted };
}

test("價格提醒、報價紀錄、收藏標記都有中文分頁名稱", () => {
  const { ctx } = load({});
  const map = vm.runInContext("SHEET_MAP", ctx);
  assert.equal(map.alerts, "價格提醒"); assert.equal(map.quotes, "報價紀錄"); assert.equal(map.marks, "收藏標記");
});

test("舊的英文 alerts 分頁會被改名成「價格提醒」，不會另外多出一張空白的", () => {
  const old = { name: "alerts", setName(x) { w.sheets[x] = old; delete w.sheets["alerts"]; this.name = x; } };
  const w = load({ alerts: old });
  const sh = w.ctx.resolveSheet_("alerts", ["id"]);
  assert.equal(sh, old);
  assert.ok(w.sheets["價格提醒"]); assert.ok(!w.sheets["alerts"]); assert.deepEqual(w.inserted, []);
});

test("兩個名稱都沒有時，直接建立中文名稱的分頁", () => {
  const w = load({});
  w.ctx.resolveSheet_("alerts", ["id"]);
  assert.deepEqual(w.inserted, ["價格提醒"]);
});
