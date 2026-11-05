// 客戶詢價解析：規則解析、驗收（AI 輸出也走同一關）、重量計算
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../docs/assets/inquiry.js");
const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} 與 ${b} 差太多`);
const run = (t) => { const p = I.ruleParse(t); return { p, r: I.compute(p) }; };

test("圓棒：20 支 Φ30x200 黃銅棒 → 單重 1.202 公斤、共 24.03 公斤（手算 π/4×30²×200×8.5÷10⁶）", () => {
  const { p, r } = run("要 20 支 Φ30x200 黃銅棒，下週要");
  assert.equal(p.material, "黃銅"); assert.equal(p.shape, "round_bar");
  assert.deepEqual(p.dims_mm, { diameter: 30, length: 200 }); assert.equal(p.quantity, 20);
  near(r.unitKg, 1.202, 0.001); near(r.totalKg, 24.03, 0.01);
  assert.ok(r.warnings.some((w) => /沒有即時行情/.test(w)));        // 黃銅沒有行情，要提醒自己填料價
});

test("板材：紫銅板 100*200*5mm 10片 → 對到『銅』（有即時行情）、0.896 公斤／片", () => {
  const { p, r } = run("紫銅板 100*200*5mm 10片");
  assert.equal(p.shape, "plate"); assert.equal(r.material.name, "銅"); assert.equal(r.material.live, "銅");
  near(r.unitKg, 0.896, 0.001); near(r.totalKg, 8.96, 0.01);
});

test("管材：外徑 40、內徑 30、長 500、3 支不鏽鋼管 → 2.18 公斤／支", () => {
  const { p, r } = run("SUS304 不鏽鋼管 外徑40 內徑30 長度500 3支");
  assert.equal(p.shape, "tube"); near(r.unitKg, 2.18, 0.01); near(r.totalKg, 6.54, 0.02);
});

test("鋁：直徑 25 長 150 共 100 支；鋁合金要提醒料價通常比 LME 貴", () => {
  const { r } = run("鋁棒 直徑25 長150 共100支");
  assert.equal(r.material.live, "鋁"); near(r.totalKg, 19.88, 0.02);
  assert.ok(r.warnings.some((w) => /比 LME 鋁貴/.test(w)));
});

test("全形字元與各種直徑、乘號寫法：Φ３０×２００ 6061 鋁 5件", () => {
  const { p, r } = run("Φ３０×２００ 6061 鋁 5件");
  assert.deepEqual(p.dims_mm, { diameter: 30, length: 200 }); assert.equal(p.quantity, 5); near(r.totalKg, 1.91, 0.01);
  for (const sym of ["Ø30x200", "φ30*200", "⌀30×200"]) assert.deepEqual(I.ruleParse("鋁棒 " + sym).dims_mm, { diameter: 30, length: 200 }, sym);
});

test("詢價直接寫了單重就用單重，不再用尺寸算", () => {
  const { r } = run("碳鋼 S45C 50x50x100 方塊 8個，單重 2.0kg");
  assert.equal(r.unitKg, 2); assert.equal(r.totalKg, 16); assert.match(r.weightSource, /單重/);
});

test("讀不出尺寸時：不亂猜、ok 為假，並說明原因", () => {
  const { r } = run("報價一下");
  assert.equal(r.ok, false); assert.equal(r.totalKg, null);
  assert.ok(r.warnings.some((w) => /沒有看到材質/.test(w))); assert.ok(r.warnings.some((w) => /算不出重量/.test(w)));
});

test("沒寫數量：先以 1 件計並提醒", () => {
  const { r } = run("紫銅 Φ20x100 圓棒");
  assert.equal(r.qty, 1); assert.ok(r.warnings.some((w) => /沒有寫數量/.test(w)));
});

test("材質取最先出現的：『黃銅』不會被當成『銅』，『不鏽鋼』不會被當成『碳鋼』", () => {
  assert.equal(I.matchMaterial("黃銅棒").name, "黃銅");
  assert.equal(I.matchMaterial("不鏽鋼板").name, "不鏽鋼");
  assert.equal(I.matchMaterial("6061 鋁板").name, "鋁");
  assert.equal(I.matchMaterial("什麼都沒有"), null);
});

// ---------------- 驗收：AI 的輸出走同一關 ----------------
test("sanitize：不合法的形狀、負數、小數數量、超大尺寸一律丟掉，並留下警告", () => {
  const s = I.sanitize({ source: "ai", material: "黃銅", shape: "火箭", dims_mm: { diameter: -5, length: 999999, width: "abc", height: 12 }, quantity: 2.5, weight_kg_each: -1 });
  assert.equal(s.shape, "unknown"); assert.deepEqual(s.dims_mm, { height: 12 }); assert.equal(s.quantity, null); assert.equal(s.weight_kg_each, null);
  assert.ok(s.warnings.length >= 3); assert.equal(s.source, "ai");
});

test("sanitize：不是物件、全是 null 也不會丟錯", () => {
  for (const bad of [null, undefined, "字串", 42, [], {}, { dims_mm: null, quantity: null }]) assert.doesNotThrow(() => I.compute(bad));
  assert.equal(I.compute(null).ok, false);
});

test("sanitize：字串欄位會截斷，避免超長內容塞進報價備註", () => {
  const s = I.sanitize({ customer: "字".repeat(500), note: "x".repeat(500) });
  assert.equal(s.customer.length, 40); assert.equal(s.note.length, 80);
});

test("AI 回傳的數字是字串（'30'）也能處理；內徑 ≥ 外徑的管視為算不出", () => {
  const r = I.compute({ material: "鋁", shape: "round_bar", dims_mm: { diameter: "30", length: "100" }, quantity: "4" });
  assert.equal(r.ok, true);
  const bad = I.compute({ material: "鋁", shape: "tube", dims_mm: { outer_diameter: 20, inner_diameter: 30, length: 100 } });
  assert.equal(bad.ok, false);
});

test("describe：一行白話，讓使用者核對『我讀到的是什麼』", () => {
  assert.equal(I.describe(I.ruleParse("要 20 支 Φ30x200 黃銅棒")), "黃銅 圓棒 Φ30 × 200 mm × 20");
});
