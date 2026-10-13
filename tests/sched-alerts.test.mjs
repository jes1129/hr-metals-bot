// 排程風險自動通知（sched-alerts.gs）：用真的主 Apps Script ＋ 假試算表 ＋ 假 Gmail 跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const K = require("../docs/assets/sched-kri.js");
const root = new URL("../", import.meta.url);
const src = (f) => fs.readFileSync(new URL(f, root), "utf8");
const MIN = 60000, HOUR = 3600000;

function world({ cfg, erpWo } = {}) {
  const sheets = {};
  function Sheet() { this.rows = []; }
  Sheet.prototype = {
    getLastRow() { return this.rows.length; }, getLastColumn() { return Math.max(0, ...this.rows.map((r) => r.length)); }, getMaxRows() { return 100000; },
    insertRowsAfter() {}, setFrozenRows() {}, setName() {}, deleteRow(r) { this.rows.splice(r - 1, 1); },
    appendRow(r) { this.rows.push(r.map((x) => (x instanceof Date ? x.toISOString() : x))); },
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.rows.length), Math.max(1, this.getLastColumn())); },
    getRange(r, c, nr, nc) {
      const s = this; nr = nr || 1; nc = nc || 1;
      const rg = { setNumberFormat() { return rg; }, setFontWeight() { return rg; },
        setValues(v) { v.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x instanceof Date ? x.toISOString() : x; }); }); return rg; },
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((s.rows[r - 1 + i] || [])[c - 1 + j]) ?? ""); o.push(row); } return o; },
        getDisplayValues() { return rg.getValues().map((x) => x.map(String)); } };
      return rg;
    } };
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet()) };
  const sent = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ alert() {} }) }, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, Session: { getActiveUser: () => ({ getEmail: () => "owner@example.test" }) },
    GmailApp: { sendEmail: (to, subject, body) => sent.push({ to, subject, body }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
    UrlFetchApp: { fetch: () => ({ getContentText: () => "{}" }) }, ContentService: { MimeType: { JSON: 1 }, createTextOutput: (t) => ({ setMimeType() { return t; } }) }, console
  };
  if (erpWo) ctx.erpLoad_ = () => ({ workorders: erpWo.map(([no]) => ({ no, status: "完工" })), moves: erpWo.map(([no, ts]) => ({ type: "完工入庫", ref: no, ts: new Date(ts).toISOString() })) });
  vm.createContext(ctx);
  vm.runInContext("var __T = null; var __D = Date; Date = class extends __D { constructor(...a) { if (a.length) super(...a); else super(__T == null ? __D.now() : __T); } static now() { return __T == null ? __D.now() : __T; } };", ctx);
  vm.runInContext(src("google-apps-script.gs"), ctx);
  vm.runInContext(src("sched-alerts.gs"), ctx);
  const at = (ms) => vm.runInContext("__T = " + ms, ctx);
  const rows = (n) => (sheets[n] ? sheets[n].rows : []);
  const table = (n) => { const r = rows(n); if (!r.length) return []; return r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))); };
  const put = (table, row) => vm.runInContext("tUpsert_(" + JSON.stringify(table) + ", " + JSON.stringify(row) + ", null, 'test')", ctx);
  const publish = (snap) => {                              // 排程頁存快照（分段、前綴 ~）
    const str = JSON.stringify(snap); let k = 0;
    for (let i = 0; i < str.length; i += 30000) put("sched_kri", { id: "kri." + k++, data: "~" + str.slice(i, i + 30000) });
  };
  if (cfg) put("sched_cfg", { id: "notify", data: JSON.stringify(cfg) });
  return { ctx, sent, at, table, publish, put, run: (e) => vm.runInContext("checkSchedAlerts(" + (e ? "{}" : "") + ")", ctx) };
}

// 週二 10:00（台北）＝ UTC 02:00
const TUE = Date.UTC(2026, 9, 13, 2, 0, 0);
function snap({ util, overdueOrders, ts = TUE, extra = {} } = {}) {
  const base = { nowMin: 10000, grace: 120, stageName: (s) => s, orders: [], plan: { ageDays: 0, fresh: 0, cfgChanged: false },
    stats: { hasDue: 10, late: 0, onTimeRate: 1, maxLate: 0, outCost: 0, shaky: 0 }, util: util == null ? 0.5 : util };
  const s = K.snapshot(K.evaluate(base), Object.assign({ orders: overdueOrders || [], grace: 120, by: "boss@example.test" }, extra));
  s.ts = ts; return s;
}
const lvOf = (w, k) => (w.table("sched_alert").find((r) => r.id === k) || {});

test("沒有快照：不亂寄；有心跳讓網頁知道排程有在跑", () => {
  const w = world(); w.at(TUE);
  assert.match(w.run(), /還沒有存過燈號/);
  assert.equal(w.sent.length, 0);
  assert.ok(w.table("sched_alert").some((r) => r.id === "_hb" && Number(r.t) === TUE));
});

test("紅燈：寄給負責人＋老闆（沒設就寄給預設信箱）、寫通知中心；30 分鐘後不重複，但沒人處理會升級一次", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.99 })); w.at(TUE);
  w.run();
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].subject, /排程風險・紅燈】瓶頸站忙碌程度（99%）/);
  assert.equal(w.sent[0].to, "boss@example.test");
  assert.match(w.sent[0].body, /schedule\.html#tab=dash/);
  assert.equal(w.table("sched_notice").length, 1);
  assert.equal(lvOf(w, "C1").active, 1);
  w.at(TUE + 30 * MIN); w.run(); w.publish(snap({ util: 0.99, ts: TUE + 25 * MIN }));
  assert.equal(w.sent.length, 2, "紅燈 30 分鐘沒人按已知悉 → 升級通知老闆");
  assert.match(w.sent[1].subject, /升級/);
  w.at(TUE + 60 * MIN); w.run();
  assert.equal(w.sent.length, 2, "升級只寄一次，24 小時內也不重複");
  assert.ok(w.table("sched_notice").some((n) => n.kind === "esc"));
});

test("按「已知悉」之後不再重複通知；變得更糟（黃→紅）才會再通知", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.92 })); w.at(TUE); w.run();                       // 黃燈
  assert.equal(w.sent.length, 1); assert.match(w.sent[0].subject, /黃燈/);
  w.put("sched_alert", { id: "C1", ack: 1, ackBy: "boss@example.test", ackAt: TUE + MIN });
  w.at(TUE + 30 * HOUR + 2 * HOUR); w.publish(snap({ util: 0.92, ts: TUE + 31 * HOUR }));
  w.run();
  assert.equal(w.sent.length, 1, "已知悉 → 即使過了 24 小時也不再催");
  w.publish(snap({ util: 0.99, ts: TUE + 32 * HOUR })); w.at(TUE + 32 * HOUR); w.run();
  assert.equal(w.sent.length, 2, "黃→紅：重新通知");
  assert.match(w.sent[1].subject, /紅燈/);
});

test("沒按已知悉：24 小時後會再提醒一次（不是每 30 分鐘）", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.92 })); w.at(TUE); w.run();
  for (let i = 1; i < 40; i++) { w.publish(snap({ util: 0.92, ts: TUE + i * 30 * MIN })); w.at(TUE + i * 30 * MIN); w.run(); }
  assert.equal(w.sent.length, 1, "19 小時內只寄過一次");
  w.publish(snap({ util: 0.92, ts: TUE + 24 * HOUR + MIN })); w.at(TUE + 24 * HOUR + MIN); w.run();
  assert.equal(w.sent.length, 2); assert.match(w.sent[1].body, /尚未按已知悉/);
});

test("恢復正常：關掉警示、留一則系統通知、不寄信", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.99 })); w.at(TUE); w.run();
  w.publish(snap({ util: 0.5, ts: TUE + 30 * MIN })); w.at(TUE + 30 * MIN); w.run();
  assert.equal(w.sent.length, 1);
  assert.equal(lvOf(w, "C1").active, 0);
  assert.ok(w.table("sched_notice").some((n) => n.kind === "ok" && n.key === "C1"));
});

test("負責人對應：黃燈只寄給該負責人；紅燈再加老闆；沒設的角色就寄給老闆", () => {
  const w = world({ cfg: { boss: "boss@example.test", owners: { 生管: "planner@example.test" } } });
  w.publish(snap({ util: 0.92 })); w.at(TUE); w.run();
  assert.equal(w.sent[0].to, "planner@example.test");
  w.publish(snap({ util: 0.99, ts: TUE + HOUR })); w.at(TUE + HOUR); w.run();
  assert.deepEqual(w.sent.slice(1).map((m) => m.to).sort(), ["boss@example.test", "planner@example.test"]);   // 每人一封
  const w2 = world({ cfg: { boss: "boss@example.test", owners: {} } });
  w2.publish(snap({ util: 0.92 })); w2.at(TUE); w2.run();
  assert.equal(w2.sent[0].to, "boss@example.test");
});

test("趨勢預警只放在網頁，不寄信", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.5, extra: { rising: 1, soon: [{ id: "L1", name: "未來負荷", to: "yellow", days: 1.2 }] } })); w.at(TUE); w.run();
  assert.equal(w.sent.length, 0);
});

test("寄信當下重新算：預計完工超過寬限時間還沒回報；ERP 完工的不算", () => {
  const o = (id, pe, erp) => ({ id, pe, ae: null, due: null, erp: erp || null });
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ overdueOrders: [o("A", TUE - 3 * HOUR), o("B", TUE - 10 * MIN)] })); w.at(TUE); w.run();
  assert.equal(w.sent.length, 1); assert.match(w.sent[0].subject, /黃燈】預計完工已過、卻還沒回報的單（1 張）/); assert.match(w.sent[0].body, /A/);
  const w2 = world({ cfg: { boss: "boss@example.test" }, erpWo: [["WO-1", TUE - 2 * HOUR]] });
  w2.publish(snap({ overdueOrders: [o("WO-1", TUE - 5 * HOUR)] })); w2.at(TUE); w2.run();
  assert.ok(!w2.sent.some((m) => /還沒回報/.test(m.subject)), "ERP 已完工 → 不算逾時");
});

test("ERP 完工誤差：排程頁還沒回報時，伺服器用 ERP 完工時間算漂移", () => {
  const o = [{ id: "WO-7", pe: TUE - 6 * HOUR, ae: null, due: null, erp: null }];
  const w = world({ cfg: { boss: "boss@example.test" }, erpWo: [["WO-7", TUE - 30 * MIN]] });     // 預計 6 小時前，實際 30 分鐘前 → 晚 5.5 小時
  w.publish(snap({ overdueOrders: o, ts: TUE - 2 * HOUR })); w.at(TUE); w.run();
  const m = w.sent.find((x) => /預測誤差/.test(x.subject));
  assert.ok(m, "有寄預測誤差通知"); assert.match(m.subject, /紅燈/); assert.match(m.body, /WO-7 比預計晚 5\.5 小時/);
});

test("監控自己失靈：燈號資料超過 24 小時沒更新就亮黃燈、72 小時紅燈", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ ts: TUE - 30 * HOUR })); w.at(TUE); w.run();
  assert.match(w.sent[0].subject, /黃燈】排程風險資料太久沒更新/);
  const w2 = world({ cfg: { boss: "boss@example.test" } });
  w2.publish(snap({ ts: TUE - 80 * HOUR })); w2.at(TUE); w2.run();
  assert.match(w2.sent[0].subject, /紅燈】排程風險資料太久沒更新/);
});

test("排程觸發只在平日 08:00–18:59（台北）檢查；手動執行不受限；可以關閉", () => {
  const w = world({ cfg: { boss: "boss@example.test" } });
  w.publish(snap({ util: 0.99 }));
  w.at(Date.UTC(2026, 9, 17, 2, 0, 0));                                    // 週六
  assert.match(w.run(true), /非上班時段/); assert.equal(w.sent.length, 0);
  w.at(Date.UTC(2026, 9, 13, 11, 30, 0));                                  // 週二 19:30 台北
  assert.match(w.run(true), /非上班時段/);
  w.at(TUE); w.run(true); assert.equal(w.sent.length, 1);
  const off = world({ cfg: { boss: "boss@example.test", enabled: false } });
  off.publish(snap({ util: 0.99 })); off.at(TUE);
  assert.match(off.run(), /已關閉/); assert.equal(off.sent.length, 0);
});

test("好幾個指標同時亮燈：每個收件人只收一封，全部列在裡面（避免信太多）", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: "X" + i, name: "指標" + i, level: i < 10 ? "red" : "yellow", display: "1", msg: "說明" + i, owner: "生管", actionLabel: "處理" }));
  const w = world({ cfg: { boss: "boss@example.test", owners: { 生管: "planner@example.test" } } });
  const s = snap({ util: 0.5 }); s.items = items; s.red = 10; s.yellow = 15;
  w.publish(s); w.at(TUE); w.run();
  assert.equal(w.sent.length, 2, "生管一封、老闆一封");
  const boss = w.sent.find((m) => m.to === "boss@example.test"), pl = w.sent.find((m) => m.to === "planner@example.test");
  assert.match(boss.subject, /^【排程風險】10 項紅燈$/);                      // 老闆只收紅燈
  assert.match(boss.body, /共 10 項/);
  assert.match(pl.subject, /^【排程風險】10 項紅燈、15 項黃燈$/);              // 負責人收到自己的紅燈與黃燈
  assert.match(pl.body, /共 25 項[\s\S]*25\. 【黃燈】指標24/);
  assert.equal(w.table("sched_notice").length, 25, "通知中心每一項都有一則");
});

test("多個紅燈一起升級：只再通知老闆一封", () => {
  const items = ["A", "B", "C"].map((k) => ({ id: k, name: "指標" + k, level: "red", display: "1", msg: "", owner: "生管", actionLabel: "" }));
  const w = world({ cfg: { boss: "boss@example.test" } });
  const s = snap({ util: 0.5 }); s.items = items; s.red = 3;
  w.publish(s); w.at(TUE); w.run();
  w.at(TUE + 30 * MIN); w.publish(Object.assign(s, { ts: TUE + 29 * MIN })); w.run();
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1].subject, /升級】3 項紅燈 30 分鐘沒人處理/);
});
