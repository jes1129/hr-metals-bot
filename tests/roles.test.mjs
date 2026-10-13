// 職能分工：規則（erp-roles.js）＋ 真正的 Apps Script（主檔＋ERP 後端檔）配假試算表，從 doPost 進去驗證
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../docs/assets/erp-roles.js");
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

// ---------- 規則 ----------
test("業務：能報價接單，不能收款、不能調庫存、不能匯入", () => {
  assert.ok(R.can("sales", "quote.save") && R.can("sales", "order.create") && R.can("sales", "order.ship"));
  assert.ok(!R.can("sales", "order.pay") && !R.can("sales", "stock.adjust") && !R.can("sales", "wo.complete") && !R.can("sales", "staff.save"));
  assert.ok(!R.canImport("sales") && R.canImport("manager") && R.canImport("boss"));
});
test("會計只管收付款；生管倉管管庫存工單；行政管人事", () => {
  assert.ok(R.can("finance", "order.pay") && R.can("finance", "service.pay") && !R.can("finance", "stock.adjust") && !R.can("finance", "order.create"));
  assert.ok(R.can("ops", "stock.receive") && R.can("ops", "wo.complete") && !R.can("ops", "order.pay"));
  assert.ok(R.can("admin", "staff.save") && R.can("admin", "request.approve") && !R.can("admin", "item.save"));
  assert.ok(!R.can("viewer", "task.save") && !R.can("nobody", "task.save"));
});
test("只有老闆管帳號；ERP 分頁不能繞過 ERP 動作直接讀寫", () => {
  assert.ok(R.canTable("boss", "acl", true) && !R.canTable("manager", "acl", false) && !R.canTable("sales", "acl", false));
  assert.ok(!R.canTable("sales", "ERP_庫存批次", false) && R.canTable("manager", "ERP_庫存批次", false));
  assert.ok(R.canTable("sales", "orders", true) && !R.canTable("viewer", "orders", true) && R.canTable("viewer", "orders", false));
  assert.ok(R.canTable("sales", "sched_notice", true) && !R.canTable("sales", "sched_cfg", true) && R.canTable("ops", "sched_cfg", true));
});
test("redact：業務看不到成本、進貨單、人事；原資料不被改動；老闆原樣", () => {
  const w = { items: [{ id: "i", std_cost: 50, price: 90 }], lots: [{ unit_cost: 40 }], moves: [{ value: 400 }], receipts: [{ total: 1 }],
    workorders: [{ extra_cost: 5, actual_cost: 99, consumed: [{ name: "x", qty: 1, value: 9 }] }], orders: [{ lines: [{ price: 90, cost_layers: [{ unit_cost: 40 }] }] }],
    staff: [{ id: "s" }], requests: [{ id: "r" }], meta: {} };
  const r = R.redact(w, "sales");
  assert.equal(r.items[0].std_cost, null); assert.equal(r.items[0].price, 90);
  assert.equal(r.lots[0].unit_cost, null); assert.equal(r.moves[0].value, null); assert.deepEqual(r.receipts, []);
  assert.equal(r.workorders[0].actual_cost, null); assert.equal(r.workorders[0].consumed[0].value, undefined); assert.equal(r.orders[0].lines[0].cost_layers, undefined);
  assert.deepEqual(r.staff, []); assert.deepEqual(r.requests, []);
  assert.deepEqual({ ...r.meta.access }, { role: "sales", name: "業務", seeCost: false, seePersonnel: false });
  assert.equal(w.items[0].std_cost, 50, "不改原物件");
  const b = R.redact(w, "boss"); assert.equal(b.items[0].std_cost, 50); assert.equal(b.staff.length, 1);
  assert.equal(R.redact(w, "admin").staff.length, 1, "行政看得到人事"); assert.equal(R.redact(w, "admin").items[0].std_cost, null, "行政看不到成本");
});

// ---------- Apps Script 整合 ----------
function gasWorld({ acl = [] } = {}) {
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
  const mails = [], cache = {}; let who = "boss@x.test";
  const ctx = {
    console, SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({}) }, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace("T", " ") }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Session: { getActiveUser: () => ({ getEmail: () => "boss@x.test" }) }, GmailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ aud: "填你的-OAuth-用戶端-ID.apps.googleusercontent.com", email: who }) }) },
    ContentService: { MimeType: { JSON: 1 }, createTextOutput: (t) => ({ setMimeType() { return t; } }) },
  };
  vm.createContext(ctx);
  ["google-apps-script.gs", "google-apps-script-erp.gs"].forEach((f) => vm.runInContext(read(f), ctx));
  vm.runInContext('ALLOWED_EMAILS = ["boss@x.test","sales@x.test","fin@x.test","gone@x.test","new@x.test"];', ctx);
  const call = (email, action, payload) => { who = email; return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: "t", action, payload: payload || {} }) } })); };
  if (acl.length) { const sh = ss.insertSheet("acl"); sh.appendRow(["id", "role", "active", "name", "ts", "by"]); acl.forEach((r) => sh.appendRow([r[0], r[1], r[2] ?? 1, r[0], "", ""])); }
  return { ctx, call, mails, sheets, ss, rows: (n) => { const r = (sheets[n] || { rows: [] }).rows; return r.length ? r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))) : []; } };
}
const TEAM = [["boss@x.test", "boss"], ["sales@x.test", "sales"], ["fin@x.test", "finance"]];
const STAFF_HDR = ["id", "code", "name", "unit_id", "title", "phone", "email", "hire_date", "active", "note", "created"];

test("沒設定任何帳號：完全維持原狀（所有登入者都能用，不會把人鎖在外面）", () => {
  const g = gasWorld();
  assert.equal(g.call("sales@x.test", "erpLoad").ok, true);
  assert.equal(g.call("sales@x.test", "erpAct", { action: "item.save", payload: { sku: "A", name: "料", kind: "原料", unit: "kg", std_cost: 50, price: 90 } }).ok, true);
  assert.equal(g.call("sales@x.test", "tUpsert", { table: "orders", row: { id: "o1" } }).error, undefined);
  assert.equal(g.call("sales@x.test", "appVersion").access.configured, false);
});
test("accessSetup：把執行的人設為老闆，啟用權限；第二次執行不會重複", () => {
  const g = gasWorld();
  assert.match(vm.runInContext("accessSetup()", g.ctx), /boss@x\.test 是老闆/);
  assert.deepEqual(g.rows("acl").map((r) => [r.id, r.role]), [["boss@x.test", "boss"]]);
  assert.match(vm.runInContext("accessSetup()", g.ctx), /已經設定過/);
  assert.match(g.call("sales@x.test", "erpLoad").error, /還沒有被指派職務/);
});
test("業務：ERP 動作被擋、讀到的資料沒有成本；老闆讀到完整", () => {
  const g = gasWorld({ acl: TEAM });
  const add = g.call("boss@x.test", "erpAct", { action: "item.save", payload: { sku: "A", name: "料", kind: "原料", unit: "kg", std_cost: 50, price: 90 } });
  assert.equal(add.ok, true); assert.equal(add.world.items[0].std_cost, 50);
  const mine = g.call("sales@x.test", "erpLoad");
  assert.equal(mine.world.items[0].std_cost, null); assert.equal(mine.world.items[0].price, 90); assert.equal(mine.world.meta.access.seeCost, false);
  const bad = g.call("sales@x.test", "erpAct", { action: "stock.adjust", payload: { item_id: add.result, qty: 5 } });
  assert.match(bad.error, /業務.*不能執行：stock\.adjust/);
  assert.equal(g.call("fin@x.test", "erpLoad").world.items[0].std_cost, 50, "會計看得到成本");
  const viaAct = g.call("sales@x.test", "erpAct", { action: "customer.save", payload: { name: "大雅精密" } });
  assert.equal(viaAct.ok, true); assert.equal(viaAct.world.items[0].std_cost, null, "動作回傳的資料也要遮");
});
test("業務不能繞過 ERP 動作，直接讀寫 ERP_ 分頁或帳號表", () => {
  const g = gasWorld({ acl: TEAM });
  assert.match(g.call("sales@x.test", "tList", { table: "ERP_庫存批次" }).error, /不能讀取/);
  assert.match(g.call("sales@x.test", "tUpsert", { table: "ERP_庫存批次", row: { id: "x" } }).error, /不能修改/);
  assert.match(g.call("sales@x.test", "tList", { table: "acl" }).error, /不能讀取/);
  assert.match(g.call("sales@x.test", "tUpsert", { table: "acl", row: { id: "sales@x.test", role: "boss" } }).error, /不能修改/);
  assert.equal(g.rows("acl").find((r) => r.id === "sales@x.test").role, "sales");
});
test("匯入備份：業務不行；老闆可以但會寫高風險紀錄並寄信", () => {
  const g = gasWorld({ acl: TEAM });
  assert.match(g.call("sales@x.test", "erpImport", { world: {} }).error, /不能匯入備份/);
  const ok = g.call("boss@x.test", "erpImport", { world: { meta: { seq: {}, lotseq: 0 } } });
  assert.equal(!!ok.error, false, JSON.stringify(ok).slice(0, 160));
  assert.equal(g.rows("高風險操作").some((r) => /匯入備份/.test(r.kind)), true);
  assert.equal(g.mails.some((m) => /高風險操作.*匯入備份/.test(m.subject) && m.to === "boss@x.test"), true);
});
test("短時間大量刪除：第 5 筆起通知老闆（同一人 10 分鐘內只寄一封）", () => {
  const g = gasWorld({ acl: [["boss@x.test", "boss"], ["sales@x.test", "manager"]] });
  for (let i = 0; i < 7; i++) g.call("sales@x.test", "tRemove", { table: "orders", id: "o" + i });
  assert.equal(g.mails.filter((m) => /大量刪除/.test(m.subject)).length, 1);
  assert.equal(g.rows("高風險操作").filter((r) => /大量刪除/.test(r.kind)).length >= 1, true);
});
test("大量匯入（超過 20 列）通知老闆；小量不吵人", () => {
  const g = gasWorld({ acl: TEAM });
  g.call("sales@x.test", "tImport", { table: "orders", rows: Array.from({ length: 25 }, (_, i) => ({ id: "o" + i })) });
  assert.equal(g.mails.some((m) => /大量匯入/.test(m.subject)), true);
  const g2 = gasWorld({ acl: TEAM }); g2.call("sales@x.test", "tImport", { table: "orders", rows: [{ id: "a" }] });
  assert.equal(g2.mails.length, 0);
});
test("停用帳號、或員工資料標為離職：立刻不能用（不必改白名單）", () => {
  const g = gasWorld({ acl: [...TEAM, ["gone@x.test", "ops", 0], ["new@x.test", "ops"]] });
  assert.match(g.call("gone@x.test", "erpLoad").error, /已停用/);
  assert.match(g.call("gone@x.test", "tList", { table: "orders" }).error, /已停用/);
  assert.equal(g.call("new@x.test", "erpLoad").ok, true);
  const sh = g.ss.insertSheet("ERP_員工");
  sh.appendRow(STAFF_HDR); sh.appendRow(["s1", "E1", "新人", "", "", "", "new@x.test", "", "false", "", ""]);
  assert.match(g.call("new@x.test", "erpLoad").error, /已離職/);
});
test("不能把最後一位老闆停用或降級；有第二位老闆就可以；帳號變更通知老闆", () => {
  const g = gasWorld({ acl: TEAM });
  assert.match(g.call("boss@x.test", "tUpsert", { table: "acl", row: { id: "boss@x.test", active: 0 } }).error, /最後一位老闆/);
  assert.match(g.call("boss@x.test", "tUpsert", { table: "acl", row: { id: "boss@x.test", role: "manager" } }).error, /最後一位老闆/);
  assert.match(g.call("boss@x.test", "tRemove", { table: "acl", id: "boss@x.test" }).error, /最後一位老闆/);
  assert.equal(g.call("boss@x.test", "tUpsert", { table: "acl", row: { id: "fin@x.test", role: "boss" } }).error, undefined);
  assert.equal(g.call("boss@x.test", "tUpsert", { table: "acl", row: { id: "boss@x.test", role: "manager" } }).error, undefined);
  assert.equal(g.mails.some((m) => /帳號權限變更/.test(m.subject)), true);
});
test("唯讀：能看（遮成本），不能寫", () => {
  const g = gasWorld({ acl: [...TEAM, ["new@x.test", "viewer"]] });
  assert.equal(g.call("new@x.test", "erpLoad").ok, true);
  assert.match(g.call("new@x.test", "tUpsert", { table: "orders", row: { id: "x" } }).error, /不能修改/);
  assert.match(g.call("new@x.test", "erpAct", { action: "customer.save", payload: { name: "x" } }).error, /不能執行/);
});
test("appVersion 回報我的職務（網頁用）", () => {
  const g = gasWorld({ acl: TEAM });
  assert.deepEqual({ ...g.call("sales@x.test", "appVersion").access }, { configured: true, role: "sales", name: "業務", why: "" });
});
test("每季帳號盤點：標出從未使用、不在白名單、離職未停用的帳號", () => {
  const g = gasWorld({ acl: [...TEAM, ["new@x.test", "ops"], ["ghost@x.test", "ops"]] });
  const sh = g.ss.insertSheet("ERP_員工");
  sh.appendRow(STAFF_HDR); sh.appendRow(["s1", "E1", "新人", "", "", "", "new@x.test", "", "false", "", ""]);
  const body = vm.runInContext("accessReview()", g.ctx);
  assert.match(body, /ghost@x\.test 在 acl 是啟用的，但不在 ALLOWED_EMAILS/);
  assert.match(body, /new@x\.test 對應的員工已離職/);
  assert.match(body, /從未使用/);
  assert.equal(g.mails.at(-1).to, "boss@x.test"); assert.match(g.mails.at(-1).subject, /每季帳號盤點.*待處理/);
});
test("每季帳號盤點：由月初觸發器呼叫時，非 1/4/7/10 月就略過", () => {
  const g = gasWorld({ acl: TEAM });
  const n = g.mails.length;
  const RealDate = Date;
  vm.runInContext("var __D = Date; Date = function () { return new __D(2026, 4, 1); };", g.ctx);   // 5 月
  const r = vm.runInContext("accessReview({})", g.ctx);
  vm.runInContext("Date = __D;", g.ctx);
  assert.equal(r, "非季初，略過"); assert.equal(g.mails.length, n); void RealDate;
});
