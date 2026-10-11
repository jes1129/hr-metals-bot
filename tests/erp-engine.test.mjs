// ERP 核心規則測試：node --test tests/
// 驗算 FIFO 成本、出貨/退貨、工單成本轉移、報價流程與各種防呆（對照 freedom-erp-crm 的守恆規則）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const E = createRequire(import.meta.url)("../docs/assets/erp-engine.js");
const T = "2026-10-11";
const ctx = { by: "tester@x", today: T, now: T + "T08:00:00Z" };

function world() { return E.empty(); }
function act(w, a, p, c) { return E.apply(w, a, p, Object.assign({}, ctx, c)).result; }
function item(w, sku, extra) { return act(w, "item.save", Object.assign({ sku, name: sku, kind: "成品", std_cost: 10, price: 20 }, extra)); }
function get(w, t, id) { return w[t].find((x) => x.id === id); }
function ok(w) { assert.deepEqual(E.check(w), []); }

test("進貨形成 FIFO 成本層，出貨先扣最早批次", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "大雅精密" });
  act(w, "stock.receive", { supplier: "供應商甲", lines: [{ item_id: a, qty: 10, unit_cost: 100 }] });
  act(w, "stock.receive", { supplier: "供應商乙", lines: [{ item_id: a, qty: 10, unit_cost: 130 }] });
  assert.equal(E.stockValue(w, a), 2300);
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 15, price: 200 }] });
  assert.equal(get(w, "items", a).reserved, 15);
  act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 15 }] });
  const it = get(w, "items", a);
  assert.equal(it.on_hand, 5);
  assert.equal(it.reserved, 0);
  assert.equal(E.stockValue(w, a), 650);              // 剩下 5 個都是 130 那批
  const r = E.report(w, T);
  assert.equal(r.sales_month, 3000);
  assert.equal(r.cogs_month, 1650);                   // 10×100 + 5×130
  assert.equal(r.gp_month, 1350);
  assert.equal(E.orderState(get(w, "orders", so)), "已出貨");
  ok(w);
});

test("退貨依出貨當時的成本層還原，毛利與庫存價值對得起來", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: a, qty: 2, unit_cost: 100 }] });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: a, qty: 2, unit_cost: 300 }] });
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 3, price: 500 }] });
  act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 3 }] });   // 成本 100+100+300
  act(w, "order.return", { id: so, lines: [{ line: 1, qty: 2 }] });  // 還原 100、100
  assert.equal(get(w, "items", a).on_hand, 3);
  assert.equal(E.stockValue(w, a), 500);              // 剩 300 + 退回 100×2
  const r = E.report(w, T);
  assert.equal(r.sales_month, 500);
  assert.equal(r.cogs_month, 300);
  assert.equal(E.orderState(get(w, "orders", so)), "部分退貨");
  assert.throws(() => act(w, "order.return", { id: so, lines: [{ line: 1, qty: 2 }] }), /退貨不能超過已出貨/);
  ok(w);
});

test("可先接單後備料：缺料會列出，出貨時庫存不足會擋", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 4, price: 10 }] });
  const r = E.report(w, T);
  assert.equal(r.shortage.length, 1);
  assert.equal(r.shortage[0].short, 4);
  assert.throws(() => act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 1 }] }), /庫存不足/);
  ok(w);
});

test("失敗的操作不留下半套資料（呼叫端複製後再套用）", () => {
  const w = world();
  const a = item(w, "A"), b = item(w, "B");
  const c = act(w, "customer.save", { name: "客戶" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: a, qty: 5, unit_cost: 1 }] });
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 5, price: 1 }, { item_id: b, qty: 5, price: 1 }] });
  const copy = JSON.parse(JSON.stringify(w));
  assert.throws(() => E.apply(copy, "order.ship", { id: so, lines: [{ line: 1, qty: 5 }, { line: 2, qty: 5 }] }, ctx), /庫存不足/);
  assert.equal(get(w, "items", a).on_hand, 5);        // 原資料沒動
});

test("收款與退款不能超額，已出貨不能取消", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: a, qty: 5, unit_cost: 1 }] });
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 2, price: 50 }] });
  assert.throws(() => act(w, "order.pay", { id: so, amount: 101 }), /超過訂單金額/);
  act(w, "order.pay", { id: so, amount: 60 });
  assert.equal(E.payState(get(w, "orders", so)), "部分收款");
  act(w, "order.pay", { id: so, amount: 40 });
  assert.equal(E.payState(get(w, "orders", so)), "已收清");
  assert.throws(() => act(w, "order.refund", { id: so, amount: 101 }), /超過已收/);
  assert.throws(() => act(w, "order.cancel", { id: so }), /先退還/);
  act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 1 }] });
  act(w, "order.refund", { id: so, amount: 100 });
  assert.throws(() => act(w, "order.cancel", { id: so }), /已出貨/);
  assert.throws(() => act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 2 }] }), /超量出貨/);
});

test("取消未出貨訂單會釋放預留", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  const so = act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 3, price: 1 }] });
  act(w, "order.cancel", { id: so });
  assert.equal(get(w, "items", a).reserved, 0);
  assert.equal(E.orderState(get(w, "orders", so)), "已取消");
});

test("BOM 版本化、防循環；工單完工把用料成本＋加工費轉入成品", () => {
  const w = world();
  const fg = item(w, "FG", { kind: "成品" });
  const steel = item(w, "STEEL", { kind: "原料", unit: "kg" });
  const bolt = item(w, "BOLT", { kind: "原料" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: steel, qty: 10, unit_cost: 50 }, { item_id: bolt, qty: 100, unit_cost: 2 }] });
  const b1 = act(w, "bom.save", { item_id: fg, components: [{ item_id: steel, qty: 1 }] });
  const b2 = act(w, "bom.save", { item_id: fg, components: [{ item_id: steel, qty: 1.5 }, { item_id: bolt, qty: 4 }] });
  assert.equal(get(w, "boms", b1).active, false);
  assert.equal(get(w, "boms", b2).revision, 2);
  assert.throws(() => act(w, "bom.save", { item_id: steel, components: [{ item_id: fg, qty: 1 }] }), /循環/);
  assert.throws(() => act(w, "bom.save", { item_id: fg, components: [{ item_id: fg, qty: 1 }] }), /成品自己/);

  const wo = act(w, "wo.create", { item_id: fg, qty: 4 });
  assert.throws(() => act(w, "wo.complete", { id: wo }), /請先開工/);
  act(w, "wo.reserve", { id: wo });
  assert.equal(get(w, "items", steel).reserved, 6);
  act(w, "wo.start", { id: wo });
  act(w, "wo.complete", { id: wo, extra_cost: 200 });
  const o = get(w, "workorders", wo);
  assert.equal(o.actual_cost, 6 * 50 + 16 * 2 + 200);  // 532
  assert.equal(get(w, "items", fg).on_hand, 4);
  assert.equal(E.stockValue(w, fg), 532);
  assert.equal(get(w, "items", steel).on_hand, 4);
  assert.equal(get(w, "items", steel).reserved, 0);
  // 之後改 BOM 不影響已開工單的快照
  assert.equal(o.bom.revision, 2);
  ok(w);
});

test("工單用料不足時整批不扣", () => {
  const w = world();
  const fg = item(w, "FG"), m = item(w, "M", { kind: "原料" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: m, qty: 1, unit_cost: 5 }] });
  act(w, "bom.save", { item_id: fg, components: [{ item_id: m, qty: 2 }] });
  const wo = act(w, "wo.create", { item_id: fg, qty: 1 });
  act(w, "wo.reserve", { id: wo }); act(w, "wo.start", { id: wo });
  assert.throws(() => act(w, "wo.complete", { id: wo }), /用料「M」不足/);
  assert.equal(get(w, "items", m).on_hand, 1);
  act(w, "wo.cancel", { id: wo });
  assert.equal(get(w, "items", m).reserved, 0);
});

test("報價：草稿可改、發出鎖定、新版取代舊版、過期不能接受、接受轉訂單", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  const d = act(w, "deal.save", { customer_id: c, name: "支架案", amount: 10000 });
  const q1 = act(w, "quote.save", { customer_id: c, deal_id: d, valid_until: "2026-10-31", lines: [{ item_id: a, qty: 10, price: 100 }] });
  act(w, "quote.save", { id: q1, customer_id: c, deal_id: d, valid_until: "2026-10-31", lines: [{ item_id: a, qty: 10, price: 90 }] });
  assert.equal(get(w, "quotes", q1).total, 900);
  act(w, "quote.issue", { id: q1 });
  assert.equal(get(w, "deals", d).stage, "已報價");
  assert.throws(() => act(w, "quote.save", { id: q1, customer_id: c, lines: [{ item_id: a, qty: 1, price: 1 }] }), /不可修改/);
  const q2 = act(w, "quote.save", { customer_id: c, deal_id: d, valid_until: "2026-10-31", lines: [{ item_id: a, qty: 10, price: 95 }] });
  act(w, "quote.issue", { id: q2 });
  assert.equal(get(w, "quotes", q1).status, "已取代");
  assert.throws(() => act(w, "quote.accept", { id: q1 }), /最新版/);
  assert.throws(() => act(w, "quote.accept", { id: q2 }, { today: "2026-11-01" }), /有效期限/);
  const so = act(w, "quote.accept", { id: q2, due: "2026-10-20" });
  assert.equal(get(w, "orders", so).total, 950);
  assert.equal(get(w, "orders", so).due, "2026-10-20");
  assert.equal(get(w, "deals", d).stage, "成交");
  assert.equal(get(w, "items", a).reserved, 10);
  assert.match(get(w, "orders", so).no, /^SO-202610-001$/);
});

test("CRM：失單要填原因、有單據的客戶與料號不能刪", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  assert.throws(() => act(w, "customer.save", { name: "客戶" }), /已存在/);
  assert.throws(() => act(w, "deal.save", { customer_id: c, name: "x", stage: "失單" }), /原因/);
  const d = act(w, "deal.save", { customer_id: c, name: "x" });
  act(w, "deal.followup", { id: d, note: "電話聯繫", next_date: "2026-10-15" });
  assert.equal(get(w, "deals", d).stage, "已聯繫");
  assert.equal(get(w, "deals", d).followups.length, 1);
  assert.throws(() => act(w, "customer.delete", { id: c }), /不能刪除/);
  act(w, "order.create", { customer_id: c, lines: [{ item_id: a, qty: 1, price: 1 }] });
  assert.throws(() => act(w, "item.delete", { id: a }), /停用/);
  const unused = item(w, "Z");
  act(w, "item.delete", { id: unused });
  assert.equal(w.items.length, 1);
  assert.throws(() => item(w, "A"), /已存在/);
});

test("盤點調整：盤虧依 FIFO 扣、要填原因；kg 小數不會累積誤差", () => {
  const w = world();
  const s = item(w, "S", { kind: "原料", unit: "kg" });
  assert.throws(() => act(w, "stock.adjust", { item_id: s, qty: 1 }), /原因/);
  for (let i = 0; i < 10; i++) act(w, "stock.receive", { supplier: "S", lines: [{ item_id: s, qty: 0.1, unit_cost: 3 }] });
  assert.equal(get(w, "items", s).on_hand, 1);
  act(w, "stock.adjust", { item_id: s, qty: -0.3, note: "盤點" });
  assert.equal(get(w, "items", s).on_hand, 0.7);
  assert.equal(E.stockValue(w, s), 2.1);
  ok(w);
});

test("報表：應收、逾期、即將到期報價、銷售漏斗", () => {
  const w = world();
  const a = item(w, "A");
  const c = act(w, "customer.save", { name: "客戶" });
  act(w, "stock.receive", { supplier: "S", lines: [{ item_id: a, qty: 10, unit_cost: 1 }] });
  const so = act(w, "order.create", { customer_id: c, due: "2026-10-01", lines: [{ item_id: a, qty: 4, price: 100 }] });
  act(w, "order.ship", { id: so, lines: [{ line: 1, qty: 2 }] });
  act(w, "order.pay", { id: so, amount: 50 });
  act(w, "deal.save", { customer_id: c, name: "d", amount: 777 });
  const q = act(w, "quote.save", { customer_id: c, valid_until: "2026-10-15", lines: [{ item_id: a, qty: 1, price: 1 }] });
  act(w, "quote.issue", { id: q });
  const r = E.report(w, T);
  assert.equal(r.receivable, 150);                    // 已出 2×100 − 已收 50
  assert.equal(r.overdue_orders.length, 1);
  assert.equal(r.quotes_expiring.length, 1);
  assert.equal(r.pipeline["新開發"].amount, 777);
});

test("google-apps-script-erp.gs 與引擎同步（改了引擎要重跑 scripts/build_erp_gas.py）", async () => {
  const fs = await import("node:fs");
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const gas = read("../google-apps-script-erp.gs");
  assert.ok(gas.includes(read("../docs/assets/erp-engine.js").trimEnd()), "引擎與 GAS 檔不同步");
  assert.ok(gas.includes(read("../gas/erp-adapter.gs")), "adapter 與 GAS 檔不同步");
});
