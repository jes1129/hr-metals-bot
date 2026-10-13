// backup.gs：用真正的 Apps Script 程式碼配假的試算表／雲端硬碟，驗證備份、保留份數、列數大減警示、還原演練
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

function world() {
  let seq = 0;
  const books = {};                                           // id → {name, sheets:{name:rows[][]}}
  const mk = (name, sheets) => { const id = "ss" + ++seq; books[id] = { name, sheets: JSON.parse(JSON.stringify(sheets)) }; return id; };
  const sheetOf = (bk, n) => {
    const rows = bk.sheets[n]; if (!rows) return null;
    const sh = { getName: () => n, getLastRow: () => rows.length, getLastColumn: () => Math.max(1, ...rows.map((r) => r.length)),
      appendRow: (r) => rows.push(r), setFrozenRows() {}, setName(x) { bk.sheets[x] = rows; delete bk.sheets[n]; n = x; },
      getRange: (r, c, nr, nc) => { const g = { getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? ""); o.push(row); } return o; },
        setValues: (v) => { v.forEach((row, i) => { rows[r - 1 + i] = row.slice(); }); return g; }, getDisplayValues: () => g.getValues().map((x) => x.map(String)), getDisplayValue: () => String((rows[r - 1] || [])[c - 1] ?? "") }; return g; },
      copyTo: (dstSs) => { const dst = dstSs._bk; dst.sheets["Copy of " + n] = rows.map((x) => x.slice()); return sheetOf(dst, "Copy of " + n); } };
    return sh;
  };
  const ssOf = (id) => { const bk = books[id]; if (!bk) throw new Error("找不到檔案 " + id);
    return { _bk: bk, getId: () => id, getName: () => bk.name, getSheetByName: (n) => sheetOf(bk, n), getSheets: () => Object.keys(bk.sheets).map((n) => sheetOf(bk, n)),
      insertSheet: (n) => { bk.sheets[n] = []; return sheetOf(bk, n); } }; };
  const live = mk("九上", { "訂單": Array.from({ length: 21 }, (_, i) => (i ? ["o" + i, "x"] : ["id", "v"])), "我的名單": [["id"], ["a"]] });
  const files = [], mails = []; let now = Date.parse("2026-10-14T03:00:00Z"), failCopy = false;
  const folder = { getFiles: () => { const it = files.filter((f) => !f.trashed); let i = 0; return { hasNext: () => i < it.length, next: () => it[i++] }; } };
  const ctx = {
    console, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ssOf(live), openById: (id) => ssOf(id) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace(/[-T:]/g, "") },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, Session: { getActiveUser: () => ({ getEmail: () => "owner@x.test" }) },
    GmailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    DriveApp: { getFoldersByName: () => ({ hasNext: () => true, next: () => folder }), createFolder: () => folder,
      getFileById: (id) => ({ makeCopy: (name) => { if (failCopy) throw new Error("Drive 空間不足"); const nid = mk(name, books[id].sheets);
        const f = { id: nid, getId: () => nid, getName: () => name, getDateCreated: () => new Date(now), setTrashed(t) { f.trashed = t; }, trashed: false }; files.push(f); return f; } }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => { const t = { timeBased: () => t, everyDays: () => t, onMonthDay: () => t, atHour: () => t, inTimezone: () => t, create() { ctx.created.push(1); } }; return t; }, deleteTrigger() {} }, created: [],
  };
  vm.createContext(ctx);
  vm.runInContext(read("backup.gs"), ctx, { filename: "backup.gs" });
  return { ctx, books, live, files, mails, advance: (d) => { now += d * 86400000; }, failCopy: (v) => { failCopy = v; },
    log: () => { const r = books[live].sheets.backup_log || []; return r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))); } };
}

test("備份：複製整份試算表、寫紀錄；狀態顯示 0 天前", () => {
  const w = world();
  assert.match(w.ctx.backupNow(), /備份完成/);
  assert.equal(w.files.length, 1);
  assert.equal(w.log()[0].kind, "backup"); assert.equal(Number(w.log()[0].ok), 1);
  assert.equal(JSON.parse(w.log()[0].counts)["訂單"], 20);
  const s = w.ctx.backupStatus_(); assert.equal(s.backupDays, 0); assert.equal(s.drillDays, null); assert.equal(s.installed, true);
});

test("只保留最近 30 份，更舊的移到垃圾桶（不是永久刪除）", () => {
  const w = world();
  for (let i = 0; i < 33; i++) { w.ctx.backupNow(); w.advance(1); }
  assert.equal(w.files.filter((f) => !f.trashed).length, 30);
  assert.equal(w.files.filter((f) => f.trashed).length, 3);
});

test("備份失敗：留下失敗紀錄、寄信給老闆、錯誤照樣丟出", () => {
  const w = world(); w.failCopy(true);
  assert.throws(() => w.ctx.backupNow(), /空間不足/);
  assert.equal(Number(w.log()[0].ok), 0);
  assert.match(w.mails[0].subject, /備份失敗/); assert.equal(w.mails[0].to, "owner@x.test");
  assert.equal(w.ctx.backupStatus_().failStreak, 1);
});

test("某張表列數比上次少超過 30%：備份照做，但警告老闆", () => {
  const w = world(); w.ctx.backupNow(); w.advance(1);
  w.books[w.live].sheets["訂單"].length = 8;                  // 20 → 7 筆
  assert.match(w.ctx.backupNow(), /資料列數大減/);
  assert.match(w.mails.at(-1).subject, /列數突然大減/); assert.match(w.mails.at(-1).body, /訂單：20 → 7/);
});

test("小表正常增減不誤報（少於 10 列不比）", () => {
  const w = world(); w.ctx.backupNow(); w.advance(1);
  w.books[w.live].sheets["我的名單"].length = 1;
  w.ctx.backupNow(); assert.equal(w.mails.length, 0);
});

test("還原演練：備份完好 → 通過、寫紀錄、狀態有演練日期", () => {
  const w = world(); w.ctx.backupNow();
  assert.match(w.ctx.restoreDrill(), /演練通過/);
  assert.equal(w.ctx.backupStatus_().drillDays, 0);
  assert.match(w.mails.at(-1).subject, /還原演練通過/);
});

test("還原演練：備份被動過（少一張分頁／列數對不上）→ 失敗並通知", () => {
  const w = world(); w.ctx.backupNow();
  const bid = w.files[0].id; delete w.books[bid].sheets["我的名單"]; w.books[bid].sheets["訂單"].length = 5;
  const r = w.ctx.restoreDrill();
  assert.match(r, /演練失敗/); assert.match(r, /少了分頁「我的名單」/); assert.match(r, /列數對不上/);
  assert.match(w.mails.at(-1).subject, /還原演練失敗/);
  assert.equal(w.ctx.backupStatus_().drillDays, null, "失敗的演練不算數");
});

test("還原演練：沒有任何備份 → 失敗（不是假通過）", () => {
  const w = world();
  assert.match(w.ctx.restoreDrill(), /找不到任何成功的備份/);
});

test("restoreSheet：現在那張先改名留底，備份那張複製回來，並通知", () => {
  const w = world(); w.ctx.backupNow();
  w.books[w.live].sheets["訂單"].length = 2;                  // 誤刪
  w.ctx.restoreSheet("訂單");
  const names = Object.keys(w.books[w.live].sheets);
  assert.ok(names.some((n) => n.startsWith("_留底_") && n.endsWith("訂單")), "舊的留底");
  assert.equal(w.books[w.live].sheets["訂單"].length, 21, "救回來的是備份時的完整資料");
  assert.match(w.mails.at(-1).subject, /已從備份救回/);
  assert.throws(() => w.ctx.restoreSheet("不存在"), /沒有分頁/);
});

test("backupStatus_ 從沒備份過 → installed:false、天數 null", () => {
  const w = world();
  const s = w.ctx.backupStatus_(); assert.equal(s.installed, false); assert.equal(s.backupDays, null);
});

test("installBackupTrigger：每天備份＋每月演練兩個觸發器", () => {
  const w = world(); w.ctx.installBackupTrigger(); assert.equal(w.ctx.created.length, 2);
});

test("還原演練會用 ERP 引擎檢查備份裡的 ERP 資料（和 ERP 後端檔一起載入時）", () => {
  const w = world();
  vm.runInContext(read("google-apps-script-erp.gs"), w.ctx, { filename: "erp.gs" });
  w.ctx.backupNow();
  assert.match(w.ctx.restoreDrill(), /ERP 資料通過完整檢查/);
});
