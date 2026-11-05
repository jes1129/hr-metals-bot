// 報價勝率分析：只算已標記的、樣本太少要說、不亂下結論
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../docs/assets/quote-stats.js");
const Q = (status, margin, material = "銅", quote = 5000) => ({ status, margin, material, quote });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("沒有任何結案的報價：不報比例，提示去標記狀態；「等待中」不被當成流失", () => {
  const r = S.winStats([Q("等待中", 20), Q(undefined, 20), Q("亂寫", 20)]);
  assert.equal(r.decided, 0); assert.equal(r.rate, null); assert.equal(r.counts["等待中"], 3);
  assert.match(r.notes[0], /還沒有標記成交或流失/);
});

test("整體成交率只算已結案：3 成交、1 流失、5 等待中 → 75%", () => {
  const r = S.winStats([Q("成交", 20), Q("成交", 20), Q("成交", 20), Q("流失", 20), ...many(5, () => Q("等待中", 20))]);
  assert.equal(r.decided, 4); assert.equal(r.rate, 75); assert.deepEqual(r.counts, { "等待中": 5, "成交": 3, "流失": 1 });
});

test("樣本少於 10 筆：加『樣本還不夠多』警語；少於 5 筆的組標記 enough=false", () => {
  const r = S.winStats([Q("成交", 18), Q("成交", 18), Q("流失", 28)]);
  assert.ok(r.notes.some((n) => /樣本還不夠多/.test(n)));
  assert.ok(r.byMargin.every((g) => g.enough === false));
});

test("利潤分組：15～20% 成交率高、25～30% 低 → 產生比較句，並附『關聯不是因果』提醒", () => {
  const rows = [
    ...many(6, (i) => Q(i < 5 ? "成交" : "流失", 18)),       // 15～20%：5/6 ≈ 83%
    ...many(6, (i) => Q(i < 1 ? "成交" : "流失", 27))        // 25～30%：1/6 ≈ 17%
  ];
  const r = S.winStats(rows);
  const g1520 = r.byMargin.find((g) => g.label === "利潤 15～20%"), g2530 = r.byMargin.find((g) => g.label === "利潤 25～30%");
  assert.equal(g1520.rate, 83); assert.equal(g2530.rate, 17); assert.ok(g1520.enough && g2530.enough);
  assert.ok(r.notes.some((n) => /依利潤：「利潤 15～20%」成交率最高（83%，6 筆），「利潤 25～30%」最低（17%，6 筆）/.test(n)));
  assert.ok(r.notes.some((n) => /不代表降利潤一定能成交/.test(n)));
});

test("差距小於 15 個百分點，或只有一組夠大：不說『有差異』", () => {
  const close = S.winStats([...many(5, (i) => Q(i < 3 ? "成交" : "流失", 18)), ...many(5, (i) => Q(i < 3 ? "成交" : "流失", 27))]);
  assert.ok(!close.notes.some((n) => /依利潤/.test(n)));
  const one = S.winStats([...many(7, (i) => Q(i < 5 ? "成交" : "流失", 18)), Q("流失", 40)]);
  assert.ok(!one.notes.some((n) => /依利潤/.test(n)));
});

test("依材質分組，排序以筆數多的在前；沒填材質歸『（未填）』", () => {
  const r = S.winStats([...many(6, () => Q("成交", 20, "銅")), ...many(2, () => Q("流失", 20, "鋁")), Q("成交", 20, "")]);
  assert.equal(r.byMaterial[0].label, "銅"); assert.equal(r.byMaterial[0].n, 6);
  assert.ok(r.byMaterial.some((g) => g.label === "（未填）"));
});

test("壞資料不會丟錯：null、非陣列、缺欄位", () => {
  for (const bad of [null, undefined, "x", 5, {}, [null], [{}], [{ status: "成交" }]]) assert.doesNotThrow(() => S.winStats(bad));
});
