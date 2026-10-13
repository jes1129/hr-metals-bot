// 每日早報信：帶進「排程風險」，並在寄信當下重新判斷「逾時沒回報」與「資料太久沒更新」
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const K = require("../docs/assets/sched-kri.js");
const root = new URL("../", import.meta.url);
const src = (f) => fs.readFileSync(new URL(f, root), "utf8");

function pad(n) { return String(n).padStart(2, "0"); }
function fmt(d, f) {
  const m = { yyyy: d.getFullYear(), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), M: d.getMonth() + 1, d: d.getDate(), u: d.getDay() || 7 };
  return f.replace(/yyyy|MM|dd|HH|mm|M|d|u/g, (k) => m[k]);
}
// 在 Node 裡跑「真的」email-notify.gs＋notebooklm-export.gs，用假試算表與假 Gmail
function run({ kri, erpWo } = {}) {
  const sheets = {};
  const mk = (header, rows) => ({ getDataRange: () => ({ getValues: () => [header].concat(rows) }) });
  sheets.orders = mk(["id", "customer", "product", "qty", "price", "amount", "status", "order_date", "due"], []);
  if (kri) {
    const str = JSON.stringify(kri), rows = [];
    for (let i = 0, k = 0; i < str.length; i += 30000, k++) rows.push(["kri." + k, "~" + str.slice(i, i + 30000)]);
    sheets.sched_kri = mk(["id", "data"], rows);
  }
  const sent = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }), getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }), alert() {} }) },
    Utilities: { formatDate: (d, tz, f) => fmt(d, f) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Session: { getActiveUser: () => ({ getEmail: () => "boss@example.test" }) },
    UrlFetchApp: { fetch: () => { throw new Error("no network in test"); } },
    GmailApp: { sendEmail: (to, subject, body) => sent.push({ to, subject, body }) }, console
  };
  if (erpWo) ctx.erpLoad_ = () => ({ workorders: erpWo });
  vm.createContext(ctx);
  vm.runInContext(src("notebooklm-export.gs"), ctx);
  vm.runInContext(src("email-notify.gs"), ctx);
  ctx.sendDailyDigest();
  return sent[0];
}

const HOUR = 3600000;
function snap(items, extra = {}) {
  const ctx = { nowMin: 10000, grace: 120, stageName: (s) => s, orders: [], plan: { ageDays: 0, fresh: 0, cfgChanged: false }, stats: { hasDue: 10, late: 0, onTimeRate: 1, maxLate: 0, outCost: 0, shaky: 0 }, util: 0.5 };
  return K.snapshot(K.evaluate(Object.assign(ctx, items || {})), extra);
}

test("沒用過排程（沒有快照）：早報信照舊，不會多出排程段落", () => {
  const m = run({});
  assert.ok(!/排程風險/.test(m.subject + m.body));
  assert.match(m.subject, /九上 ERP 早報/);
});

test("有紅燈：主旨會帶「排程紅燈」，信裡列出指標、現值、負責人與建議", () => {
  const s = snap({ util: 0.99, stats: { hasDue: 10, late: 4, onTimeRate: 0.6, maxLate: 9 * 60, outCost: 30000, shaky: 4 } }, { by: "boss@example.test", orders: [] });
  const m = run({ kri: s });
  assert.match(m.subject, /排程紅燈\d+/);
  assert.match(m.body, /【排程風險】/);
  assert.match(m.body, /【紅燈】瓶頸站忙碌程度（99%）/);
  assert.match(m.body, /負責人：生管/);
  assert.match(m.body, /排程風險：\d+ 項紅燈/);
});

test("全部正常：信裡寫「全部正常」，主旨不亂喊", () => {
  const m = run({ kri: snap({}, { orders: [] }) });
  assert.match(m.body, /【排程風險】[\s\S]*全部正常/);
  assert.ok(!/排程紅燈|排程黃燈/.test(m.subject));
});

test("寄信當下重新算：預計完工已超過 2 小時還沒回報 → 逾時；3 張以上就是紅燈", () => {
  const now = Date.now();
  const o = (id, pe, ae = null) => ({ id, pe, ae, due: null, erp: null });
  const one = run({ kri: snap({}, { orders: [o("A", now - 3 * HOUR), o("B", now - 30 * 60000), o("C", now - 5 * HOUR, now - 4 * HOUR)] }) });
  assert.match(one.body, /【黃燈】預計完工已超過 120 分鐘仍沒回報完工：A（共 1 張）/);
  assert.match(one.subject, /排程黃燈/);
  const three = run({ kri: snap({}, { orders: [o("A", now - 3 * HOUR), o("B", now - 4 * HOUR), o("C", now - 6 * HOUR)] }) });
  assert.match(three.body, /【紅燈】預計完工已超過/);
  assert.match(three.subject, /排程紅燈/);
});

test("ERP 工單已完工的單，不算逾時沒回報", () => {
  const now = Date.now();
  const s = snap({}, { orders: [{ id: "WO-1", pe: now - 6 * HOUR, ae: null, due: null, erp: null }, { id: "SO-9", pe: now - 6 * HOUR, ae: null, due: null, erp: "WO-9" }] });
  const m = run({ kri: s, erpWo: [{ no: "WO-1", status: "完工" }, { no: "WO-9", status: "完工" }] });
  assert.ok(!/仍沒回報完工/.test(m.body));
  assert.ok(!/排程黃燈|排程紅燈/.test(m.subject));
});

test("燈號資料太久沒更新：超過 24 小時黃燈、72 小時紅燈（監控自己也被監控）", () => {
  const stale = (h) => run({ kri: Object.assign(snap({}, { orders: [] }), { ts: Date.now() - h * HOUR }) });
  const y = stale(30); assert.match(y.body, /【黃燈】排程風險資料已 30 小時沒有更新/); assert.match(y.subject, /排程黃燈/);
  const r = stale(80); assert.match(r.body, /【紅燈】排程風險資料已 80 小時沒有更新/); assert.match(r.subject, /排程紅燈/);
  assert.ok(!/沒有更新/.test(stale(5).body));
});
