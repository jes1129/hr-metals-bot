// 生產排程引擎：論文數值重現、排程合理性、插單／急單／外包／故障／取消後的重排
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../docs/assets/sched-engine.js");
const D = require("../docs/assets/sched-data.js");
const EPS = 1e-6;

// ---------- 論文範例（陳建銘 2015 第五章；Lin & Chen 2015） ----------
const TM = E.compile(D.thesisConfig(), D.thesisOrders());
// a / b = [拆批選項, DB 機型, WB 機型, MD 機型]（選項序號）
function tx(a, b, seq = [0, 1]) {
  const x = E.blankX(TM);
  x.split[0] = a[0]; x.split[1] = b[0]; x.seq = Int32Array.from(seq);
  for (let s = 0; s < 3; s++) { x.asg[s] = a[1 + s]; x.asg[3 + s] = b[1 + s]; }
  return x;
}

test("論文：四個方案的平均流程時間與完工時間跟論文一致", () => {
  const cases = [
    ["Alt1：A 500 DB2/WB2/MD2；B 1000 DB1/WB1/MD1", [1, 1, 1, 0], [1, 0, 0, 0], 50000, [26000, 74000]],
    ["Alt2：A DB1/WB1；B DB2/WB2", [1, 0, 0, 0], [1, 1, 1, 0], 44000, [28000, 60000]],
    ["5.1 節方案二：A 拆 250", [0, 1, 1, 0], [1, 0, 0, 0], 48000, [22000, 74000]],
    ["5.1 節方案三：B 拆 500", [1, 0, 0, 0], [0, 1, 1, 0], 42000, [28000, 56000]]
  ];
  for (const [name, a, b, mean, C] of cases) {
    const r = E.simulate(TM, tx(a, b));
    assert.equal(r.meanF, mean, name);
    assert.deepEqual(Array.from(r.C), C, name);
  }
});

test("論文：窮舉全部方案的最佳值，GA 也找得到（且不差於經驗法則）", () => {
  let best = Infinity;
  for (let k = 0; k < 128; k++) {
    const bit = (j) => (k >> j) & 1;
    const r = E.simulate(TM, tx([bit(0), bit(1), bit(2), 0], [bit(3), bit(4), bit(5), 0], bit(6) ? [1, 0] : [0, 1]));
    best = Math.min(best, r.meanF);
  }
  assert.equal(best, 39000);
  const o = E.optimize(TM, { weights: { flow: 1, tardy: 0, out: 0 }, timeLimit: 3000 });
  assert.equal(o.kpi.meanF, best);
  assert.ok(o.kpi.meanF <= o.heur.practical.kpi.meanF);
});

// ---------- 預設工廠 ----------
function demo() {
  const cfg = D.defaultConfig();
  cfg.calendar.start = "2026-10-12";        // 星期一
  const cal = E.calendar(cfg.calendar);
  return { cfg, cal, orders: D.demoOrders(cal) };
}

// 排程合理性：機台不重疊、合格機型、同站同機型、站與站的先後、數量守恆、批量上限、不早於投料
function checkPlan(M, res, label) {
  const ops = res.ops;
  const byUnit = {};
  for (const op of ops) if (op.unit >= 0) (byUnit[op.unit] = byUnit[op.unit] || []).push(op);
  for (const u in byUnit) {
    const a = byUnit[u].sort((x, y) => x.start - y.start);
    for (let k = 1; k < a.length; k++) assert.ok(a[k].start >= a[k - 1].end - EPS, `${label}：機台 ${u} 重疊`);
  }
  const done = {};   // 每張單每站每個子批的完成時間
  for (const op of ops) {
    const od = M.orders[op.o];
    assert.ok(op.start >= od.release - EPS, `${label}：${od.id} 早於投料`);
    if (op.type >= 0) {
      assert.ok(od.optType[op.s].includes(op.type), `${label}：${od.id} 用了不合格機型`);
      const T = M.types[op.type];
      assert.ok(op.unit >= T.base && op.unit < T.base + T.count, `${label}：機台不屬於該機型`);
    }
    if (op.kind === "batch" && od.batch > 0) assert.ok(op.qty <= Math.max(od.batch, od.splits[0]) + EPS, `${label}：超過批量`);
    for (let x = op.a; x <= op.b; x++) {
      const t = op.kind === "whole" && op.streams ? op.streams[x] : op.end;
      done[`${op.o}|${op.s}|${x}`] = t;
    }
  }
  for (let i = 0; i < M.n; i++) {
    const od = M.orders[i];
    for (let s = 0; s < M.S; s++) {
      const mine = ops.filter((op) => op.o === i && op.s === s);
      if (od.optType[s][0] === E.SKIP) { assert.equal(mine.length, 0); continue; }
      assert.ok(mine.length > 0, `${label}：${od.id} 第 ${s} 站沒排`);
      assert.equal(new Set(mine.map((op) => op.type)).size, 1, `${label}：${od.id} 同一站用了兩種機型`);
      assert.equal(mine.reduce((q, op) => q + op.qty, 0), od.qty, `${label}：${od.id} 數量不守恆`);
      if (s > 0) for (const op of mine) for (let x = op.a; x <= op.b; x++) {
        const prev = done[`${i}|${s - 1}|${x}`];
        if (prev != null && op.kind !== "whole") assert.ok(op.start >= prev - EPS, `${label}：${od.id} 子批 ${x} 上一站還沒做完就開工`);
        if (prev != null && op.kind === "whole" && x === 0) assert.ok(op.start >= prev - EPS, `${label}：${od.id} 整批流動提早開工`);
      }
    }
    assert.ok(Math.abs(res.C[i] - Math.max(...ops.filter((op) => op.o === i).map((op) => op.end))) < EPS);
  }
}

test("預設工廠：最佳化的排程合理，且綜合分數不輸經驗法則、EDD、ATC", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders, { cal });
  const o = E.optimize(M, { weights: { flow: 1, tardy: 1 }, timeLimit: 4000 });
  checkPlan(M, o.res, "最佳化");
  const f = E.makeEval(M, { weights: { flow: 1, tardy: 1, out: 1 }, base: o.base });
  const mine = f(o.res, o.X);
  for (const k of ["practical", "edd", "atc"]) {
    const h = o.heur[k];
    const r = E.simulate(M, h.X, { rule: h.rule, collect: true });
    checkPlan(M, r, k);
    assert.ok(mine <= f(r, h.X) + EPS, `不輸 ${k}`);
  }
  assert.ok(o.kpi.meanF < o.heur.practical.kpi.meanF, "平均週期比經驗法則短");
  assert.ok(o.kpi.twt <= o.heur.practical.kpi.twt + EPS, "延遲不比經驗法則多");
  assert.ok(o.pareto.length >= 1 && o.pareto.some((p) => p.best));
  assert.equal(o.robust.length, M.n);
  for (const x of o.robust) assert.ok(x.onTimeProb >= 0 && x.onTimeProb <= 1 && x.p10 <= x.p90);
  const A = E.analyze(M, o.res);
  assert.equal(A.bottleneck.name, "CNC 加工");
  assert.ok(A.stageUtil.every((s) => s.util >= 0 && s.util <= 1 + EPS));
});

test("隨機加工時間：GA＋OCBA 會多分配模擬次數，結果仍合理", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders.slice(0, 8), { cal });
  const o = E.optimize(M, { cv: 0.15, timeLimit: 3000, budget: 60 });
  assert.ok(o.stochastic);
  assert.ok(o.reps > o.evals, "OCBA 有追加模擬");
  checkPlan(M, o.res, "隨機");
  const al = E.ocbaAlloc([10, 10.5, 30], [2, 2, 2], 100);
  assert.ok(al[2] < al[1] && Math.abs(al.reduce((a, b) => a + b, 0) - 100) < 1e-6, "差很多的方案分到的次數少");
  const p = E.apcs([10, 30], [1, 1], [10, 10]);
  assert.ok(p > 0.99 && p <= 1);
});

test("機台停機：停機時段內不會排工", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders, { cal });
  const cl1 = M.types.find((t) => t.id === "CL").base;   // CNC 車床 #1
  const down = { [cl1]: [[0, cal.per * 3]] };
  const o = E.optimize(M, { down, timeLimit: 2000 });
  for (const op of o.res.ops) if (op.unit === cl1) assert.ok(op.start >= cal.per * 3 - EPS, "停機中還在做");
  checkPlan(M, o.res, "停機");
});

test("插單＋急單＋外包＋取消：已開工的不動，其餘重排", () => {
  const { cfg, cal, orders } = demo();
  const M0 = E.compile(cfg, orders, { cal });
  const o0 = E.optimize(M0, { timeLimit: 2000 });
  const now = cal.per * 2 + 300;            // 第 3 天 13:00
  const L = E.freezeAt(M0, o0.X, o0.res, now);
  assert.ok(Object.keys(L.fixed).length > 0);

  // 插一張急單（今天投料、後天要）、WO-104 表面處理外包 2 天、取消 WO-110
  const next = orders.filter((x) => x.id !== "WO-110").map((x) => Object.assign({}, x));
  next.find((x) => x.id === "WO-104").force = { SURF: "out" };
  next.find((x) => x.id === "WO-104").outLead = { SURF: 2 };
  next.push({ id: "RUSH-1", product: "FG-JNT-001", qty: 300, release: now, due: cal.dayDate(4), weight: 5 });
  const M1 = E.compile(cfg, next, { cal });
  const lock = E.bindLock(M1, L);
  const ref = E.planGenes(M0, o0.X);
  const o1 = E.optimize(M1, { lock, ref, weights: { flow: 1, tardy: 1, stable: 0.5 }, timeLimit: 3000 });
  checkPlan(M1, o1.res, "重排");

  // 已開工的工序原封不動
  const idx = Object.fromEntries(M1.orders.map((od, i) => [od.id, i]));
  let frozen = 0;
  for (const op of o0.res.ops) {
    if (op.start >= now) continue;
    const id = M0.orders[op.o].id;
    if (id === "WO-110") continue;
    const same = o1.res.ops.find((x) => x.o === idx[id] && x.s === op.s && x.a === op.a);
    assert.ok(same && same.frozen && same.unit === op.unit && same.start === op.start && same.end === op.end, `${id} 已開工工序被動到`);
    frozen++;
  }
  assert.ok(frozen > 0);
  // 新工序都在「現在」之後
  for (const op of o1.res.ops) if (!op.frozen) assert.ok(op.start >= now - EPS, "新排的工序不能早於現在");
  // 外包：整單送出、前置 2 天
  const out = o1.res.ops.find((x) => x.o === idx["WO-104"] && x.kind === "out");
  assert.ok(out && Math.abs(out.end - out.start - 2 * cal.per) < EPS);
  assert.ok(o1.res.cost > 0);
  // 急單有排、而且凍結過的訂單機型沒變
  assert.ok(o1.res.C[idx["RUSH-1"]] > now);
  assert.ok(!o1.res.ops.some((x) => M1.orders[x.o].id === "WO-110"));
});

test("重排的穩定度：沿用原計畫當起點＋穩定度權重，其他單的完工時間幾乎不動", () => {
  const { cfg, cal, orders } = demo();
  const M0 = E.compile(cfg, orders, { cal });
  const o0 = E.optimize(M0, { timeLimit: 2000, seed: 5 });
  const now = cal.per * 2 + 300;
  const L = E.freezeAt(M0, o0.X, o0.res, now);
  const next = orders.concat([{ id: "NEW-1", product: "FG-BRK-002", qty: 500, release: cal.dayDate(2), due: cal.dayDate(7), weight: 2 }]);
  const M1 = E.compile(cfg, next, { cal });
  const C0 = {}; M0.orders.forEach((od, i) => { C0[od.id] = o0.res.C[i]; });
  const ref = { genes: E.planGenes(M0, o0.X), C: C0 };
  // 沿用原計畫（新單排最後、機型現場決定）當種子
  const seed = E.blankX(M1), pos = Object.fromEntries(Array.from(o0.X.seq).map((i, k) => [M0.orders[i].id, k]));
  const refIdx = E.refIndex(M1, ref.genes);
  seed.seq = Int32Array.from(M1.orders.map((_, i) => i).sort((a, b) => (pos[M1.orders[a].id] ?? 999) - (pos[M1.orders[b].id] ?? 999)));
  M1.orders.forEach((od, i) => {
    const g = refIdx[i]; seed.split[i] = g && g.split >= 0 ? g.split : 0;
    for (let s = 0; s < M1.S; s++) seed.asg[i * M1.S + s] = g && g.asg[s] >= 0 ? g.asg[s] : od.optType[s][0] === E.SKIP ? 0 : E.AUTO;
  });
  const run = (stable) => E.optimize(M1, { lock: E.bindLock(M1, L), ref, extraSeeds: [seed], weights: { flow: 1, tardy: 1, stable }, timeLimit: 2500, seed: 7 });
  const loose = run(0), tight = run(1);
  assert.ok(tight.instabParts.shift <= loose.instabParts.shift + EPS, "穩定度權重越高，完工時間挪動越小");
  assert.ok(tight.instabParts.shift < cal.per * 0.25, "平均挪動小於 1/4 個工作天");
  assert.ok(tight.res.C[M1.orders.length - 1] > now, "新單有排進去");
  // 沿用原計畫的種子本身就是可行方案：結果不會比「原計畫＋新單排最後」差
  const naive = E.simulate(M1, E.cloneX(seed), E.lockSim(E.bindLock(M1, L), { collect: true }));
  const f = E.makeEval(M1, { weights: { flow: 1, tardy: 1, out: 1, stable: 1 }, base: tight.base, ref: refIdx, refC: M1.orders.map((od) => C0[od.id] ?? null) });
  assert.ok(f(tight.res, tight.X) <= f(naive, seed) + EPS);
});

test("不主動外包：只有指定的單才會外包", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders, { cal, noOut: true });
  assert.ok(M.orders.every((od) => od.optType.every((o) => !o.includes(E.OUT))));
  const forced = orders.map((x) => (x.id === "WO-104" ? Object.assign({}, x, { force: { CNC: "out" } }) : x));
  const M2 = E.compile(cfg, forced, { cal, noOut: true });
  const i = M2.orders.findIndex((od) => od.id === "WO-104"), s = M2.stages.findIndex((st) => st.id === "CNC");
  assert.deepEqual(M2.orders[i].optType[s], [E.OUT]);
  const o = E.optimize(M2, { timeLimit: 1000 });
  assert.ok(o.res.ops.some((op) => op.o === i && op.s === s && op.kind === "out"));
});

test("機台故障：正在做的工序中斷改排，修好前不會再用那台", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders, { cal });
  const o0 = E.optimize(M, { timeLimit: 1500 });
  const now = cal.per + 120;
  const busyOp = o0.res.ops.find((op) => op.unit >= 0 && op.start < now && op.end > now);
  assert.ok(busyOp, "現在有機台在做");
  const L = E.freezeAt(M, o0.X, o0.res, now);
  const repair = now + 8 * 60;
  const { lock, dropped, shifted } = E.breakdown(L, busyOp.unit, now, repair);
  assert.equal(dropped.length + shifted.length, 1);
  const o1 = E.optimize(M, { lock: E.bindLock(M, lock), down: { [busyOp.unit]: [[now, repair]] }, timeLimit: 1500 });
  for (const op of o1.res.ops) if (op.unit === busyOp.unit && !op.frozen) assert.ok(op.start >= repair - EPS || op.end <= now + EPS);
  for (const k of shifted) assert.ok(Math.abs(lock.fixed[k].end - L.fixed[k].end - (repair - now)) < EPS);
  checkPlan(M, o1.res, "故障");
});

test("機台故障：整批流動（下料）中斷時，已送出的子批不受影響、下游不會提早開工", () => {
  const { cfg, cal, orders } = demo();
  const M = E.compile(cfg, orders, { cal });
  const o0 = E.optimize(M, { timeLimit: 1500 });
  const cut = o0.res.ops.find((op) => op.kind === "whole" && op.streams && op.streams.length > 2 && op.end - op.start > 60);
  const now = (cut.streams[0] + cut.end) / 2, repair = now + 240;
  const L = E.freezeAt(M, o0.X, o0.res, now);
  const { lock, shifted } = E.breakdown(L, cut.unit, now, repair);
  assert.equal(shifted.length, 1);
  const o1 = E.optimize(M, { lock: E.bindLock(M, lock), down: { [cut.unit]: [[now, repair]] }, timeLimit: 1500 });
  checkPlan(M, o1.res, "下料故障");
  const after = o1.res.ops.find((op) => op.o === cut.o && op.s === cut.s);
  assert.ok(after.frozen && Math.abs(after.end - cut.end - 240) < EPS);
});

test("工作日曆：週日不上班、交期算到當天下班、時間可來回換算", () => {
  const cal = E.calendar({ start: "2026-10-12", days: [1, 2, 3, 4, 5, 6], dayStart: 8, hours: 16 });
  assert.equal(cal.per, 960);
  assert.equal(cal.dayDate(5), "2026-10-17");   // 星期六
  assert.equal(cal.dayDate(6), "2026-10-19");   // 跳過星期日
  assert.equal(cal.endOfDay("2026-10-12"), 960);
  assert.equal(cal.startOfDay("2026-10-19"), 6 * 960);
  assert.equal(cal.endOfDay("2026-10-18"), 6 * 960);   // 星期日的交期 → 星期六下班
  const t = cal.toDate(960 + 90);
  const d = new Date(t);
  assert.equal(d.getDate(), 13); assert.equal(d.getHours(), 9); assert.equal(d.getMinutes(), 30);
  assert.equal(cal.fromDate(t), 960 + 90);
  assert.equal(new Date(cal.toDate(960, true)).getHours(), 0);   // 第一天 08:00 + 16 小時 = 24:00（當天下班）
});

test("準時優先：EDD 能做到全部準時時，最佳化也一定全部準時；效率優先的平均週期不會比準時優先長", () => {
  const cfg = D.defaultConfig(); cfg.calendar.start = "2026-10-12";
  const cal = E.calendar(cfg.calendar), base = D.demoOrders(cal), rnd = E.rngOf(42), orders = [];
  for (let i = 0; i < 40; i++) {
    const b = base[i % base.length], rel = Math.floor(rnd() * 12), due = rel + 3 + Math.floor(rnd() * 8);
    orders.push({ id: "B" + (i + 1), product: b.product, qty: Math.round(b.qty * (0.4 + rnd() * 0.8) / 10) * 10 || 10, release: cal.dayDate(rel), due: cal.dayDate(due), weight: rnd() < 0.15 ? 3 : rnd() < 0.3 ? 2 : 1 });
  }
  const M = E.compile(cfg, orders, { cal });
  const due = E.optimize(M, { weights: { flow: 0.15, tardy: 1, late: 8, out: 6 }, timeLimit: 3000, seed: 3 });
  assert.equal(due.heur.edd.kpi.tardy, 0, "這組資料 EDD 全部準時");
  assert.equal(due.kpi.tardy, 0);
  const eff = E.optimize(M, { weights: { flow: 1, tardy: 0.3, late: 0, out: 6 }, timeLimit: 3000, seed: 3 });
  assert.ok(eff.kpi.meanF <= due.kpi.meanF + EPS, "效率優先的平均週期較短（或相同）");
});

test("休假日：國定假日當天不上班，交期落在假日就算前一個工作日下班", () => {
  const cal = E.calendar({ start: "2026-10-12", days: [1, 2, 3, 4, 5, 6], dayStart: 8, hours: 16, holidays: ["2026-10-14", "2026-10-15"] });
  assert.equal(cal.dayDate(0), "2026-10-12");
  assert.equal(cal.dayDate(1), "2026-10-13");
  assert.equal(cal.dayDate(2), "2026-10-16");   // 跳過 14、15
  assert.equal(cal.endOfDay("2026-10-14"), 2 * 960);   // 假日的交期 → 前一個工作日（13 日）下班
  assert.equal(cal.startOfDay("2026-10-16"), 2 * 960);
  const t = cal.toDate(2 * 960 + 60), d = new Date(t);
  assert.equal(d.getDate(), 16); assert.equal(d.getHours(), 9);
  assert.equal(cal.fromDate(t), 2 * 960 + 60);
  // 起算日本身是假日：第 0 天是下一個工作日
  const c2 = E.calendar({ start: "2026-10-12", days: [1, 2, 3, 4, 5], holidays: ["2026-10-12"] });
  assert.equal(c2.dayDate(0), "2026-10-13");
});

test("設定錯誤會講清楚哪裡錯", () => {
  const cfg = D.defaultConfig();
  assert.throws(() => E.compile(cfg, [{ id: "X", product: "NOPE", qty: 10 }]), /沒有設定途程/);
  assert.throws(() => E.compile(cfg, [{ id: "X", product: "FG-JNT-001", qty: 10 }, { id: "X", product: "FG-JNT-001", qty: 5 }]), /重複/);
  const bad = D.defaultConfig(); bad.stages[0].mode = "?";
  assert.throws(() => E.compile(bad, []), /生產方式/);
  const M0 = E.compile(cfg, [{ id: "A", product: "FG-JNT-001", qty: 100 }]);
  const L = E.freezeAt(M0, E.practicalX(M0), E.simulate(M0, E.practicalX(M0), { collect: true }), 100);
  const cfg2 = D.defaultConfig(); cfg2.types[2].count = 5;
  assert.throws(() => E.bindLock(E.compile(cfg2, [{ id: "A", product: "FG-JNT-001", qty: 100 }]), L), /工廠設定/);
});
