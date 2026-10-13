// 營運風險的自動通知：用真正的 Apps Script（主檔＋ERP 後端檔＋sched-alerts.gs）配假試算表，驗證
// 越線 → 寄信給負責人／老闆、寫通知中心、記歷史、可改門檻、恢復後關閉
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

function gasWorld() {
  const sheets = {};
  function Sheet(name) { this.name = name; this.rows = []; }
  Sheet.prototype = {
    getName() { return this.name; }, getLastRow() { return this.rows.length; }, getLastColumn() { return Math.max(0, ...this.rows.map((r) => r.length)); }, getMaxRows() { return 100000; },
    insertRowsAfter() {}, setFrozenRows() {}, setName() {}, deleteRow(r) { this.rows.splice(r - 1, 1); },
    appendRow(r) { this.rows.push(r.map((x) => (x instanceof Date ? x.toISOString() : x))); },
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.rows.length), Math.max(1, this.getLastColumn())); },
    getRange(r, c, nr, nc) {
      const s = this; nr = nr || 1; nc = nc || 1;
      const rg = {
        setNumberFormat() { return rg; }, setFontWeight() { return rg; }, clearContent() { for (let i = 0; i < nr; i++) s.rows[r - 1 + i] = []; return rg; },
        setValues(v) { v.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x instanceof Date ? x.toISOString() : x; }); }); return rg; },
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((s.rows[r - 1 + i] || [])[c - 1 + j]) ?? ""); o.push(row); } return o; },
        getDisplayValues() { return rg.getValues().map((x) => x.map(String)); }, getDisplayValue() { return String(((s.rows[r - 1] || [])[c - 1]) ?? ""); },
      };
      return rg;
    },
  };
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet(n)), getSheets: () => Object.values(sheets) };
  const mails = [], cache = {};
  const ctx = {
    console, SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ alert() {} }) }, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: (d, tz) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10) }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Session: { getActiveUser: () => ({ getEmail: () => "boss@x.test" }) }, GmailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ aud: "填你的-OAuth-用戶端-ID.apps.googleusercontent.com", email: "boss@x.test" }) }) },
    ContentService: { MimeType: { JSON: 1 }, createTextOutput: (t) => ({ setMimeType() { return t; } }) },
  };
  vm.createContext(ctx);
  ["google-apps-script.gs", "google-apps-script-erp.gs", "sched-alerts.gs"].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  vm.runInContext('ALLOWED_EMAILS = ["boss@x.test"];', ctx);
  const call = (action, payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: "t", action, payload: payload || {} }) } }));
  const rows = (n) => { const r = (sheets[n] || { rows: [] }).rows; return r.length ? r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))) : []; };
  const erp = (action, payload) => { const r = call("erpAct", { action, payload }); if (r.error) throw new Error(r.error); return r.result; };
  call("tUpsert", { table: "sched_cfg", row: { id: "notify", data: JSON.stringify({ boss: "boss@x.test", owners: { 倉管: "store@x.test", 生管: "ops@x.test" } }) }, header: ["id", "data"] });
  return { ctx, call, erp, rows, mails, run: () => vm.runInContext("checkSchedAlerts()", ctx) };
}

// 缺料 + 逾期工單：兩個營運指標亮燈
function shortage(g) {
  const cu = g.erp("item.save", { sku: "RM", name: "黃銅棒", kind: "原料", unit: "kg", std_cost: 300, price: 500 });
  const fg = g.erp("item.save", { sku: "FG", name: "接頭", kind: "成品", unit: "個", std_cost: 100, price: 250 });
  g.erp("bom.save", { item_id: fg, components: [{ item_id: cu, qty: 2 }] });
  const c = g.erp("customer.save", { name: "大雅精密" });
  g.erp("order.create", { customer_id: c, lines: [{ item_id: cu, qty: 50, price: 500 }] });          // 預留 50、庫存 0 → 缺料
  g.erp("wo.create", { item_id: fg, qty: 5, due: "2020-01-01" });                                     // 交期早已過
}

test("越線 → 寄信：缺料給倉管、逾期工單給生管；紅燈才加老闆；信標題是「營運風險」", () => {
  const g = gasWorld(); shortage(g);
  g.call("tUpsert", { table: "sched_cfg", row: { id: "biz_tol", data: JSON.stringify({ B5: { y: 1, r: 1 } }) }, header: ["id", "data"] });   // 缺料 1 項就紅燈
  const msg = g.run();
  assert.match(msg, /寄出 \d+ 封/);
  const store = g.mails.find((m) => m.to === "store@x.test"), ops = g.mails.find((m) => m.to === "ops@x.test"), boss = g.mails.find((m) => m.to === "boss@x.test");
  assert.ok(store && ops && boss, g.mails.map((m) => m.to + " " + m.subject).join("\n"));
  assert.match(store.subject, /^【營運風險・紅燈】缺料品項/);
  assert.match(ops.subject, /^【營運風險・黃燈】已逾期未完工的工單/);
  assert.match(boss.subject, /營運風險・紅燈/); assert.match(boss.body, /erp\.html#tab=risk/);
  assert.equal(g.mails.length, 3, "每個人一封");
  const alerts = g.rows("sched_alert").filter((r) => r.id !== "_hb");
  assert.deepEqual(alerts.map((r) => r.id).sort(), ["B5", "B9"]);
  assert.equal(g.rows("sched_notice").some((r) => r.key === "B5" && r.kind === "lv"), true, "通知中心也有");
});

test("同一件事 24 小時內不重複寄；歷史每 25 分鐘以上才記一筆", () => {
  const g = gasWorld(); shortage(g);
  g.run(); const n = g.mails.length; g.run();
  assert.equal(g.mails.length, n);
  assert.equal(g.rows("biz_hist").length, 1, "第二次距離太近不重複記");
  const h = JSON.parse(g.rows("biz_hist")[0].v); assert.equal(h.B5, 1); assert.equal(h.B9, 1);
});

test("在通知中心按已知悉後不再催；問題解決後自動關閉並留一則「已恢復」", () => {
  const g = gasWorld(); shortage(g); g.run();
  g.call("tUpsert", { table: "sched_alert", row: { id: "B9", ack: 1, ackBy: "ops@x.test", ackAt: Date.now() }, header: ["id", "level", "active", "first", "lastN", "nlevel", "ack", "ackBy", "ackAt", "esc", "name", "display", "msg", "owner", "t"] });
  const n = g.mails.length; g.run(); assert.equal(g.mails.length, n);
  const wo = g.call("erpLoad").world.workorders[0]; g.erp("wo.cancel", { id: wo.id }); g.run();
  assert.equal(Number(g.rows("sched_alert").find((r) => r.id === "B9").active), 0);
  assert.equal(g.rows("sched_notice").some((r) => r.key === "B9" && r.kind === "ok"), true);
});

test("沒有排程快照也能跑營運檢查（只裝了 ERP 沒用排程的公司）", () => {
  const g = gasWorld(); shortage(g);
  assert.doesNotMatch(g.run(), /排程頁還沒有存過燈號/);
  assert.equal(g.rows("sched_alert").some((r) => r.id === "B5"), true);
});

test("門檻可改：調高之後不再亮燈", () => {
  const g = gasWorld(); shortage(g);
  g.call("tUpsert", { table: "sched_cfg", row: { id: "biz_tol", data: JSON.stringify({ B5: { y: 99, r: null }, B9: { y: 99, r: null } }) }, header: ["id", "data"] });
  g.run(); assert.equal(g.mails.length, 0);
});
