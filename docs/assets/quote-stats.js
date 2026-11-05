/* 報價勝率分析：從「已標記成交／流失」的報價，算出成交率，並依利潤、材質、金額分組比較。
 *
 * 誠實原則：
 *   - 只有標了「成交」或「流失」的報價才算；「等待中」不算，也不會被當成流失。
 *   - 每一組少於 MIN_BUCKET 筆就標「樣本太少」，不拿來下結論；全部已結案少於 MIN_TOTAL 筆時整體加警語。
 *   - 這是「你們自己資料裡的相關性」，不是因果：客戶、品項、當時行情都不同，不能說降價就一定成交。
 * 同一支檔案在瀏覽器（window.QuoteStats）與 Node 測試（module.exports）共用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuoteStats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STATUSES = ["等待中", "成交", "流失"];
  var MIN_BUCKET = 5;      // 一組至少幾筆才算有參考價值
  var MIN_TOTAL = 10;      // 全部已結案至少幾筆，整體結論才不加「樣本偏少」警語
  var GAP = 15;            // 最高與最低成交率至少差幾個百分點，才說「有差異」

  var MARGIN_BUCKETS = [
    { label: "利潤 15% 以下", lo: -Infinity, hi: 15 },
    { label: "利潤 15～20%", lo: 15, hi: 20 },
    { label: "利潤 20～25%", lo: 20, hi: 25 },
    { label: "利潤 25～30%", lo: 25, hi: 30 },
    { label: "利潤 30% 以上", lo: 30, hi: Infinity }
  ];
  var AMOUNT_BUCKETS = [
    { label: "報價 3,000 以下", lo: -Infinity, hi: 3000 },
    { label: "報價 3,000～10,000", lo: 3000, hi: 10000 },
    { label: "報價 10,000～30,000", lo: 10000, hi: 30000 },
    { label: "報價 30,000 以上", lo: 30000, hi: Infinity }
  ];

  function statusOf(q) { return STATUSES.indexOf(q && q.status) >= 0 ? q.status : "等待中"; }
  function pct(won, n) { return n ? Math.round(won / n * 100) : null; }

  function group(decided, defs, pick) {
    return defs.map(function (b) {
      var rows = decided.filter(function (q) { var v = Number(pick(q)); return isFinite(v) && v >= b.lo && v < b.hi; });
      var won = rows.filter(function (q) { return q.status === "成交"; }).length;
      return { label: b.label, n: rows.length, won: won, rate: pct(won, rows.length), enough: rows.length >= MIN_BUCKET };
    }).filter(function (g) { return g.n > 0; });
  }

  function byMaterial(decided) {
    var map = {};
    decided.forEach(function (q) { var k = q.material || "（未填）"; (map[k] = map[k] || []).push(q); });
    return Object.keys(map).map(function (k) {
      var rows = map[k], won = rows.filter(function (q) { return q.status === "成交"; }).length;
      return { label: k, n: rows.length, won: won, rate: pct(won, rows.length), enough: rows.length >= MIN_BUCKET };
    }).sort(function (a, b) { return b.n - a.n; });
  }

  function compare(groups, what) {
    var ok = groups.filter(function (g) { return g.enough; });
    if (ok.length < 2) return null;
    var best = ok.reduce(function (a, b) { return b.rate > a.rate ? b : a; }), worst = ok.reduce(function (a, b) { return b.rate < a.rate ? b : a; });
    if (best === worst || best.rate - worst.rate < GAP) return null;
    return what + "：「" + best.label + "」成交率最高（" + best.rate + "%，" + best.n + " 筆），「" + worst.label + "」最低（" + worst.rate + "%，" + worst.n + " 筆）。";
  }

  function winStats(quotes) {
    var qs = Array.isArray(quotes) ? quotes : [];
    var counts = { "等待中": 0, "成交": 0, "流失": 0 };
    qs.forEach(function (q) { counts[statusOf(q)]++; });
    var decided = qs.filter(function (q) { return statusOf(q) !== "等待中"; }).map(function (q) { return { status: statusOf(q), margin: q.margin, material: q.material, quote: q.quote }; });
    var out = {
      counts: counts, decided: decided.length, rate: pct(counts["成交"], decided.length),
      byMargin: group(decided, MARGIN_BUCKETS, function (q) { return q.margin; }),
      byAmount: group(decided, AMOUNT_BUCKETS, function (q) { return q.quote; }),
      byMaterial: byMaterial(decided), notes: [], minBucket: MIN_BUCKET
    };
    if (!decided.length) { out.notes.push("還沒有標記成交或流失的報價。到下面表格把報價的狀態改成「成交」或「流失」，這裡就會開始統計。"); return out; }
    if (decided.length < MIN_TOTAL) out.notes.push("已結案 " + decided.length + " 筆，樣本還不夠多（建議累積 " + MIN_TOTAL + " 筆以上），下面的比例只供參考。");
    [compare(out.byMargin, "依利潤"), compare(out.byMaterial, "依材質"), compare(out.byAmount, "依報價金額")].forEach(function (s) { if (s) out.notes.push(s); });
    if (out.notes.length && decided.length >= MIN_TOTAL) out.notes.push("提醒：這是你們自己資料裡的關聯，不代表降利潤一定能成交，客戶、品項與當時行情都不同。");
    return out;
  }

  return { STATUSES: STATUSES, MIN_BUCKET: MIN_BUCKET, MIN_TOTAL: MIN_TOTAL, statusOf: statusOf, winStats: winStats };
});
