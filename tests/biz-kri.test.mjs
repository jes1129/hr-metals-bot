// 全公司營運風險指標（biz-kri.js）：每個指標的算法、門檻、成本權限、說明文字
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../docs/assets/erp-engine.js");
require("../docs/assets/erp-admin.js");
const B = require("../docs/assets/biz-kri.js");
const S = require("../docs/assets/sched-kri.js");

const T = "2026-10-14";
const base = { by: "boss@x", today: T, now: T + "T08:00:00Z" };
const act = (w, a, p, c) => E.apply(w, a, p, Object.assign({}, base, c)).result;
const ev = (w, tol, opts) => Object.fromEntries(B.evaluate(w, T, tol, opts).map((x) => [x.id, x]));
const ship = (w, id, qty, ctx) => act(w, "order.ship", { id, lines: [{ line: 1, qty }] }, ctx);
const AUG = { today: "2026-08-01", now: "2026-08-01T08:00:00Z" };

function shop() {                       // 一個有料、有客戶的小工廠
  const w = E.empty();
  const cu = act(w, "item.save", { sku: "RM-CU", name: "黃銅棒", kind: "原料", unit: "kg", std_cost: 300, price: 500 });
  const fg = act(w, "item.save", { sku: "FG-1", name: "接頭", kind: "成品", unit: "個", std_cost: 100, price: 250 });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: cu, qty: 100, unit_cost: 300 }] }, { today: "2026-09-01", now: "2026-09-01T08:00:00Z" });
  const c1 = act(w, "customer.save", { name: "大雅精密" }), c2 = act(w, "customer.save", { name: "清水五金" });
  return { w, cu, fg, c1, c2 };
}
const order = (s, cust, item, qty, price, extra, ctx) => act(s.w, "order.create", Object.assign({ customer_id: cust, lines: [{ item_id: item, qty, price }] }, extra || {}), ctx);

test("沒有任何資料：所有指標都是 na（不是綠燈，不假裝正常）", () => {
  const r = B.evaluate(E.empty(), T, {}, {});
  assert.equal(r.length, B.DEFS.length);
  r.forEach((x) => assert.equal(x.level, "na", x.id));
});

test("B1 負毛利：售價低於標準成本的未出貨訂單、已出貨但實際虧損的訂單", () => {
  const s = shop();
  order(s, s.c1, s.cu, 10, 250);                                   // 未出貨，售價 250 < 成本 300
  let r = ev(s.w); assert.equal(r.B1.value, 1); assert.equal(r.B1.level, "yellow"); assert.match(r.B1.msg, /SO-/);
  const o3 = order(s, s.c2, s.cu, 5, 600); ship(s.w, o3, 5);
  assert.equal(ev(s.w).B1.value, 1, "賺錢的單不算");
  for (let i = 0; i < 2; i++) order(s, s.c1, s.cu, 1, 100);
  r = ev(s.w); assert.equal(r.B1.value, 3); assert.equal(r.B1.level, "red");
});

test("成本權限：沒有成本權限的職務，需要成本的指標是 na（不能用被遮掉的 0 算出假結果）", () => {
  const s = shop(); order(s, s.c1, s.cu, 10, 250);
  const r = ev(s.w, {}, { seeCost: false });
  ["B1", "B7", "B8"].forEach((id) => { assert.equal(r[id].level, "na", id); assert.equal(r[id].display, "需成本權限"); });
  assert.notEqual(r.B5.level, "na");
});

test("B2/B3 逾期應收：出貨後超過帳款天數還沒收齊", () => {
  const s = shop();
  const o = order(s, s.c1, s.cu, 10, 500, {}, AUG);
  ship(s.w, o, 10, AUG);                         // 出貨 8/1，30 天後 8/31 到期
  let r = ev(s.w);
  assert.equal(r.B2.value, 5000); assert.equal(r.B2.level, "green");                              // 5,000 < 黃燈 100,000
  assert.equal(r.B3.value, 44); assert.equal(r.B3.level, "yellow");                               // 10/14 − 8/31 = 44 天
  r = ev(s.w, { B2: { y: 1000, r: 4000 } }); assert.equal(r.B2.level, "red"); assert.match(r.B2.msg, /NT\$ 5,000/);
  act(s.w, "order.pay", { id: o, amount: 5000 }); r = ev(s.w); assert.equal(r.B2.value, 0); assert.equal(r.B3.value, 0);
  const s2 = shop(); const o2 = order(s2, s2.c1, s2.cu, 10, 500, {}, AUG); ship(s2.w, o2, 10, AUG);
  assert.equal(ev(s2.w, {}, { terms: 90 }).B3.value, 0, "帳款天數可調");
});

test("B4 客戶集中度：近 90 天銷售；銷售額太少不判斷", () => {
  const s = shop();
  const a = order(s, s.c1, s.cu, 50, 500), b = order(s, s.c2, s.cu, 20, 500);
  ship(s.w, a, 50); ship(s.w, b, 20);   // 25,000 vs 10,000 → 71%
  assert.equal(ev(s.w).B4.value, null, "35,000 < 最低銷售額 50,000 → 不判斷");
  const r = ev(s.w, {}, { minSales: 10000 });
  assert.ok(Math.abs(r.B4.value - 71.43) < 0.1); assert.equal(r.B4.level, "red"); assert.match(r.B4.msg, /71\.4%/);
});

test("B5/B6 缺料與安全庫存", () => {
  const s = shop();
  act(s.w, "item.save", { id: s.cu, sku: "RM-CU", name: "黃銅棒", kind: "原料", unit: "kg", std_cost: 300, price: 500, safety: 150 });
  let r = ev(s.w, { B6: { y: 1, r: 5 } }); assert.equal(r.B6.value, 1); assert.match(r.B6.msg, /黃銅棒/);
  s.w.items.find((x) => x.id === s.cu).reserved = 130;
  r = ev(s.w); assert.equal(r.B5.value, 1); assert.equal(r.B5.level, "yellow");
});

test("B7 盤點調整佔庫存價值", () => {
  const s = shop();                                                                       // 庫存 100kg × 300 = 30,000
  act(s.w, "stock.adjust", { item_id: s.cu, qty: -3, note: "盤點" });                    // −3kg = −900
  const r = ev(s.w); assert.ok(Math.abs(r.B7.value - 900 / 29100 * 100) < 0.01);
  assert.equal(r.B7.level, "red", "3.09% ≥ 紅燈 3%");
});

test("B8 工單用料成本超標；B9 工單逾期", () => {
  const s = shop();
  act(s.w, "bom.save", { item_id: s.fg, components: [{ item_id: s.cu, qty: 2 }] });
  const wo = act(s.w, "wo.create", { item_id: s.fg, qty: 10, due: "2026-10-01" });
  assert.equal(ev(s.w).B9.value, 1); assert.match(ev(s.w).B9.msg, /WO-/);
  act(s.w, "wo.reserve", { id: wo }); act(s.w, "wo.start", { id: wo });
  s.w.items.find((x) => x.id === s.cu).std_cost = 250;             // 標準成本改低 → 實際 300 比標準 250 多 20%
  act(s.w, "wo.complete", { id: wo, extra_cost: 0 });
  const r = ev(s.w); assert.ok(Math.abs(r.B8.value - 20) < 0.01); assert.equal(r.B8.level, "red"); assert.equal(r.B9.value, 0);
});

test("B10 逾期未出貨", () => {
  const s = shop(); order(s, s.c1, s.cu, 1, 500, { due: "2026-10-01" }); order(s, s.c1, s.cu, 1, 500, { due: "2026-12-01" });
  assert.equal(ev(s.w).B10.value, 1);
});

test("A1 申請卡關：送出後等了幾天", () => {
  const w = E.empty();
  const u = act(w, "unit.save", { name: "辦公室", kind: "辦公室" }), st = act(w, "staff.save", { code: "E1", name: "小王", unit_id: u });
  const r1 = act(w, "request.save", { staff_id: st, kind: "請假", leave_type: "事假", start_date: "2026-10-08", end_date: "2026-10-08", hours: 8, reason: "x" }, { today: "2026-10-05" });
  act(w, "request.submit", { id: r1 }, { today: "2026-10-05" });
  let r = ev(w); assert.equal(r.A1.value, 9); assert.equal(r.A1.level, "red");
  act(w, "request.approve", { id: r1 }, { by: "boss2@x" }); r = ev(w); assert.equal(r.A1.value, 0); assert.equal(r.A1.level, "green");
});

test("A2 設備保養逾期：按已保養就恢復；週期不能是負數", () => {
  const w = E.empty();
  const e1 = act(w, "equipment.save", { name: "CNC 車床", maint_days: 30, last_maint: "2026-08-01" });
  act(w, "equipment.save", { name: "堆高機", maint_days: 0 });
  let r = ev(w); assert.equal(r.A2.value, 1); assert.match(r.A2.msg, /CNC 車床/);
  act(w, "equipment.maintained", { id: e1 }); r = ev(w); assert.equal(r.A2.value, 0);
  assert.equal(w.equipment.find((x) => x.id === e1).last_maint, T);
  assert.equal(E.admin.nextMaint(w.equipment.find((x) => x.id === e1)), "2026-11-13");
  assert.throws(() => act(w, "equipment.save", { name: "x", maint_days: -1 }), /保養週期/);
});

test("A3 加班：本月已核准時數，預設依勞基法第 32 條每月 46 小時", () => {
  const w = E.empty();
  const u = act(w, "unit.save", { name: "工廠", kind: "工廠" }), st = act(w, "staff.save", { code: "E1", name: "小王", unit_id: u });
  const ot = (d, h) => { const id = act(w, "request.save", { staff_id: st, kind: "加班", start_date: d, end_date: d, hours: h, reason: "趕貨" }); act(w, "request.submit", { id }); act(w, "request.approve", { id }, { by: "boss2@x" }); };
  ot("2026-10-02", 20); ot("2026-10-09", 18);
  let r = ev(w); assert.equal(r.A3.value, 38); assert.equal(r.A3.level, "yellow");
  ot("2026-10-10", 10); r = ev(w); assert.equal(r.A3.level, "red"); assert.match(r.A3.msg, /小王.*48/);
  ot("2026-09-20", 40); assert.equal(ev(w).A3.value, 48, "不同月份不累計");
  assert.equal(ev(w, { A3: { y: 50, r: 60 } }).A3.level, "green", "公司另有約定可調門檻");
});

test("門檻與負責人可改；id 不和排程指標撞號", () => {
  const r = B.evaluate(E.empty(), T, { B5: { y: 9, r: null, owner: "老闆" } });
  const b5 = r.find((x) => x.id === "B5"); assert.equal(b5.y, 9); assert.equal(b5.r, null); assert.equal(b5.owner, "老闆");
  assert.deepEqual(B.ORDER, B.DEFS.map((d) => d.id));
  const sid = new Set(S.DEFS.map((d) => d.id));
  B.DEFS.forEach((d) => { assert.ok(!sid.has(d.id), d.id); assert.ok(/^[AB]\d+$/.test(d.id)); });
});
