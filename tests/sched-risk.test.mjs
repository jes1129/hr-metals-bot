// 排程的風險監控：KRI 門檻與觸發、採用檢查、現場回報（實際進度）對排程的影響
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../docs/assets/sched-engine.js");
const D = require("../docs/assets/sched-data.js");
const K = require("../docs/assets/sched-kri.js");
const EPS = 1e-6;

const H = 60;
const stageName = (s) => ({ CUT: "下料", CNC: "CNC 加工" }[s] || s);
function order(id, predEnd, actEnd, o = {}) {
  return { id, planned: true, predEnd, actEnd: actEnd ?? null, actInferred: !!o.inferred, stages: o.stages || [] };
}
function ctx(orders, extra = {}) {
  return Object.assign({ nowMin: 10000, grace: 120, stageName, orders, plan: { ageDays: 0, fresh: 0, cfgChanged: false },
    stats: { hasDue: 10, late: 0, onTimeRate: 1, maxLate: 0, outCost: 0, shaky: 0 }, util: 0.5 }, extra);
}
const get = (items, id) => items.find((x) => x.id === id);

test("預測誤差：超過 2 小時黃燈、4 小時紅燈（早或晚都算）", () => {
  const mk = (err) => get(K.evaluate(ctx([order("A", 1000, 1000 + err * H)])), "D1");
  assert.equal(mk(1.9).level, "green");
  assert.equal(mk(2).level, "yellow");
  assert.equal(mk(-2.5).level, "yellow");          // 提早也算
  assert.equal(mk(4).level, "red");
  assert.match(mk(3).msg, /晚 3 小時/);
});

test("漂移＝連續超標：只有一張超標是黃燈，連續兩張是紅燈", () => {
  const a = order("A", 1000, 1000 + 3 * H), b = order("B", 2000, 2000 + 30), c = order("C", 3000, 3000 + 3 * H);
  assert.equal(get(K.evaluate(ctx([a, b, c])), "D2").level, "yellow");   // 最近一張超標、前一張正常 → 連續 1 張
  const d = order("D", 4000, 4000 + 5 * H);
  const r = get(K.evaluate(ctx([a, b, c, d])), "D2");                    // C、D 連續超標
  assert.equal(r.level, "red"); assert.equal(r.value, 2);
  assert.equal(get(K.evaluate(ctx([a, b])), "D2").level, "green");       // 最近一張正常 → 連續 0
});

test("ERP 推定的完工不算預測誤差，也不算回報率", () => {
  const o = order("A", 1000, 1000 + 9 * H, { inferred: true, stages: [{ sid: "CUT", pred: [0, 500], act: { s: null, e: 500, inferred: true } }] });
  const it = K.evaluate(ctx([o]));
  assert.equal(get(it, "D1").level, "na");
  assert.equal(get(it, "D5").value, 0);                                   // 該回報的站 1 個、有效回報 0 個
  assert.equal(get(it, "D5").level, "red");
});

test("工時偏差：實際耗時 ÷ 排程耗時，取偏差最大的站", () => {
  const st = (pS, pE, aS, aE) => ({ sid: "CNC", pred: [pS, pE], act: { s: aS, e: aE } });
  const it = K.evaluate(ctx([order("A", 1, null, { stages: [st(0, 100, 0, 112)] }), order("B", 1, null, { stages: [st(0, 100, 0, 118)] })]));
  const d3 = get(it, "D3");
  assert.equal(Math.round(d3.value), 15);                                 // 平均 +15%
  assert.equal(d3.level, "yellow");
  assert.match(d3.msg, /CNC 加工.*多 15%/);
  const red = get(K.evaluate(ctx([order("A", 1, null, { stages: [st(0, 100, 0, 70)] })])), "D3");
  assert.equal(red.level, "red"); assert.match(red.msg, /少 30%/);
});

test("逾時沒回報與回報率：超過預計完工 2 小時才算", () => {
  const stg = (e, act) => ({ sid: "CUT", pred: [0, e], act });
  const o1 = order("A", 5000, null, { stages: [stg(5000, null)] });          // 預計 5000，現在 10000 → 逾時
  const o2 = order("B", 9900, null, { stages: [stg(9900, null)] });          // 才過 100 分鐘，在寬限內
  const o3 = order("C", 8000, 8100, { stages: [stg(8000, { s: 7000, e: 8100 })] });
  const it = K.evaluate(ctx([o1, o2, o3]));
  assert.equal(get(it, "D4").value, 1);
  assert.equal(get(it, "D4").level, "yellow");
  assert.match(get(it, "D4").msg, /A/);
  assert.equal(Math.round(get(it, "D5").value), 50);                         // 到期 2 站（A、C），回報 1 站
  assert.equal(get(it, "D5").level, "red");
});

test("交期、產能、成本與計畫新舊的門檻", () => {
  const base = ctx([]);
  const mk = (o) => K.evaluate(Object.assign({}, base, o));
  assert.equal(get(mk({ stats: { hasDue: 20, late: 1, onTimeRate: 0.95, maxLate: 30, outCost: 4999, shaky: 0 } }), "S1").level, "green");
  assert.equal(get(mk({ stats: { hasDue: 20, late: 2, onTimeRate: 0.9, maxLate: 30, outCost: 0, shaky: 0 } }), "S1").level, "yellow");
  assert.equal(get(mk({ stats: { hasDue: 20, late: 4, onTimeRate: 0.8, maxLate: 9 * H, outCost: 20000, shaky: 3 } }), "S1").level, "red");
  assert.equal(get(mk({ stats: { hasDue: 20, late: 4, onTimeRate: 0.8, maxLate: 9 * H, outCost: 20000, shaky: 3 } }), "S2").level, "red");
  assert.equal(get(mk({ stats: { hasDue: 20, late: 4, onTimeRate: 0.8, maxLate: 9 * H, outCost: 20000, shaky: 3 } }), "C2").level, "red");
  assert.equal(get(mk({ stats: { hasDue: 20, late: 4, onTimeRate: 0.8, maxLate: 9 * H, outCost: 20000, shaky: 3 } }), "S3").level, "red");
  assert.equal(get(mk({ util: 0.91 }), "C1").level, "yellow");
  assert.equal(get(mk({ util: 0.98 }), "C1").level, "red");
  assert.equal(get(mk({ plan: { ageDays: 2.5, fresh: 0, cfgChanged: false } }), "P1").level, "yellow");
  assert.equal(get(mk({ plan: { ageDays: 4, fresh: 3, cfgChanged: true } }), "P1").level, "red");
  assert.equal(get(mk({ plan: { ageDays: 4, fresh: 3, cfgChanged: true } }), "P2").level, "red");
  assert.equal(get(mk({ plan: { ageDays: 0, fresh: 0, cfgChanged: true } }), "P3").level, "yellow");
  assert.equal(get(mk({ plan: { ageDays: 0, fresh: 0, cfgChanged: false } }), "P3").level, "green");
});

test("容忍度可以自訂；沒有資料的指標顯示「—」而不是亮燈", () => {
  const tol = { D1: { y: 1, r: 1.5 }, C1: { y: 50, r: null } };
  const it = K.evaluate(ctx([order("A", 1000, 1000 + 2 * H)]), tol);
  assert.equal(get(it, "D1").level, "red");
  assert.equal(get(it, "C1").level, "yellow");             // 紅燈門檻關掉，只剩黃燈
  assert.equal(K.evaluate(ctx([]), {}).filter((x) => x.level === "na").length >= 4, true);
  assert.equal(get(K.evaluate(ctx([])), "D1").display, "—");
});

test("採用檢查：全綠直接採用；黃燈要確認；紅燈要原因＋二次確認", () => {
  const mk = (o) => K.gate(K.evaluate(Object.assign(ctx([]), o)));
  const ok = mk({ stats: { hasDue: 10, late: 0, onTimeRate: 1, maxLate: 0, outCost: 0, shaky: 0 } });
  assert.ok(ok.clear && !ok.needAck && !ok.needReason);
  const y = mk({ util: 0.92 });
  assert.ok(!y.clear && y.needAck && !y.needReason && y.yellow.length === 1);
  const r = mk({ util: 0.99, stats: { hasDue: 10, late: 3, onTimeRate: 0.7, maxLate: 3 * H, outCost: 0, shaky: 0 } });
  assert.ok(r.needReason && r.needAck && r.red.length >= 2);
});

test("觸發紀錄：只有燈號真的變了才記，變好也記", () => {
  const a = K.evaluate(ctx([]), {}), prev = K.levels(a);
  assert.deepEqual(K.transitions(prev, a), []);
  const b = K.evaluate(ctx([], { util: 0.99 }), {});
  const ev = K.transitions(prev, b);
  assert.equal(ev.length, 1); assert.equal(ev[0].id, "C1"); assert.equal(ev[0].to, "red"); assert.ok(ev[0].up);
  const back = K.transitions(K.levels(b), a);
  assert.equal(back[0].to, "green"); assert.ok(!back[0].up);
});

test("快照：只放黃燈與紅燈，供首頁、選單紅點、早報使用", () => {
  const it = K.evaluate(ctx([], { util: 0.99 }));
  const s = K.snapshot(it, { orders: [] });
  assert.equal(s.worst, "red"); assert.equal(s.red, 1); assert.ok(s.items.every((x) => x.level !== "green"));
  assert.equal(K.worst(K.evaluate(ctx([]), {})), "green");
});

// ---------- 現場回報套用到排程 ----------
function demo() {
  const cfg = D.defaultConfig(); cfg.calendar.start = "2026-10-12";
  const cal = E.calendar(cfg.calendar), orders = D.demoOrders(cal);
  return { cfg, cal, orders, M: E.compile(cfg, orders, { cal }) };
}

test("回報完工：該站工序改成實際時間，機台提早釋放，下游工序依實際時間接著做", () => {
  const { M } = demo();
  const o = E.optimize(M, { timeLimit: 1500, seed: 3 });
  const plan = E.simulate(M, o.X, { collect: true });
  const i = 0, od = M.orders[i], cutOps = plan.ops.filter((op) => op.o === i && op.s === 0);
  const pS = Math.min(...cutOps.map((x) => x.start)), pE = Math.max(...cutOps.map((x) => x.end));
  const actEnd = pE + 180;                                                  // 下料比預計晚 3 小時完工
  const L = E.applyActuals(M, o.X, plan, [{ id: od.id, sid: M.stages[0].id, end: actEnd }], { now: 0, sig: M.sig, fixed: {}, genes: {} });
  const res = E.simulate(M, o.X, Object.assign({ collect: true }, E.lockSim(E.bindLock(M, L))));
  const cut = res.ops.filter((op) => op.o === i && op.s === 0);
  assert.ok(cut.every((op) => op.frozen), "回報過的工序凍結");
  assert.ok(Math.abs(Math.max(...cut.map((x) => x.end)) - actEnd) < 1e-3, "實際完工時間");
  assert.ok(Math.abs(Math.min(...cut.map((x) => x.start)) - pS) < 1e-3, "沒回報開工時間就視為照預計時間開工");
  const next = res.ops.filter((op) => op.o === i && op.s === 1);
  const firstOut = Math.min(...cut.map((op) => (op.kind === "whole" && op.streams ? op.streams[0] : op.end)));   // 整批流動：第一個子批做好就能往下送
  assert.ok(Math.min(...next.map((x) => x.start)) >= firstOut - EPS, "下一站不會早於上一站第一個子批送出的時間");
  assert.ok(res.C[i] >= plan.C[i] - EPS, "晚完工會讓整張單的預計完工往後");
});

test("回報提早完工：機台提早空出來，其他單可以提早", () => {
  const { M } = demo();
  const o = E.optimize(M, { timeLimit: 1500, seed: 3 });
  const plan = E.simulate(M, o.X, { collect: true });
  const i = 1, od = M.orders[i], ops = plan.ops.filter((op) => op.o === i && op.s === 1);
  const pS = Math.min(...ops.map((x) => x.start)), pE = Math.max(...ops.map((x) => x.end));
  const actEnd = pS + (pE - pS) * 0.5;                                      // CNC 只花了一半時間
  const L = E.applyActuals(M, o.X, plan, [{ id: od.id, sid: M.stages[1].id, start: pS, end: actEnd }], { now: 0, sig: M.sig, fixed: {}, genes: {} });
  const res = E.simulate(M, o.X, Object.assign({ collect: true }, E.lockSim(E.bindLock(M, L))));
  const mine = res.ops.filter((op) => op.o === i && op.s === 1);
  assert.ok(Math.abs(Math.max(...mine.map((x) => x.end)) - actEnd) < 1e-3);
  assert.ok(res.meanF <= plan.meanF + EPS, "提早完工不會讓平均週期變長");
});

test("回報後重排：已回報的站固定不動，機型與拆批鎖住", () => {
  const { M, cfg, cal, orders } = demo();
  const o0 = E.optimize(M, { timeLimit: 1500, seed: 3 });
  const plan = E.simulate(M, o0.X, { collect: true });
  const od = M.orders[2], ops = plan.ops.filter((op) => op.o === 2 && op.s === 0);
  const actEnd = Math.max(...ops.map((x) => x.end)) + 90;
  const L0 = E.applyActuals(M, o0.X, plan, [{ id: od.id, sid: M.stages[0].id, end: actEnd }], { now: 0, sig: M.sig, fixed: {}, genes: {} });
  const o1 = E.optimize(M, { lock: E.bindLock(M, L0), timeLimit: 1500, seed: 4 });
  const cut = o1.res.ops.filter((op) => op.o === 2 && op.s === 0);
  assert.ok(cut.every((op) => op.frozen) && Math.abs(Math.max(...cut.map((x) => x.end)) - actEnd) < 1e-3);
  assert.equal(o1.X.split[2], o0.X.split[2], "拆批沒被改");
  assert.equal(o1.X.asg[2 * M.S + 0], o0.X.asg[2 * M.S + 0], "第一站機型沒被改");
  void cfg; void cal; void orders;
});
