/*
 * sched-engine.js — 九上生產排程引擎（純計算：不碰畫面；瀏覽器背景執行緒、Node 測試共用）
 *
 * 問題：混合流線型排程（Hybrid Flow Shop, HFS）——多站、每站多種機型、同型多台平行；
 *       訂單依產品只能上合格機型、同一訂單在同一站的所有子批必須用同一種機型、
 *       換產品要整備（換線）、可拆批平行加工與併批加工、可選擇整站外包、機台可停機。
 *
 * 方法（融合文獻，見 help.html「生產排程」與 README）：
 *   1. 離散事件模擬評估方案（Lin & Chen, 2015, Simulation Modelling Practice and Theory 51:100–114；陳建銘 2015 清大博論）
 *      ——各站「整批流動／拆批平行／併批」生產行為、FIFO 等派工、隨機加工時間。
 *   2. 決策＝每張訂單每站的機型（或外包）＋拆批大小（論文）＋訂單優先順序（本系統擴充）。
 *   3. 基因演算法 GA（論文：菁英保留前 50%、兩點交配 0.8、突變 0.4）＋ OCBA 分配模擬次數（Chen et al. 2000）。
 *   4. 迭代貪婪局部搜尋 IG（Ruiz & Stützle 2007 EJOR；Öztop et al. 2019 C&OR；Li et al. 2024 IJPR——併批機台＋可變子批的混合流線型）。
 *   5. 好的初始解：經驗法則（論文 5.3.2）、EDD、ATC（Vepsalainen & Morton 1987 Management Science）、NEH 式插入（Pan & Ruiz 2013 C&OR）。
 *   6. 多目標：平均流程時間＋加權延遲（Neufeld et al. 2023 EJOR），並保留效率／準時的取捨前緣（Pareto）。
 *   7. 事件驅動重排程：已開工工序凍結、穩定度懲罰（Peng et al. 2019 SWEVO 混合流線型重排程：機台故障、新單插入，目標含「系統不穩定度」；Baykasoğlu et al. 2020 JMS；Uhlmann et al. 2022 IJPR）；
 *      外包選項（Qi 2011 IJPE）。
 *
 * 時間單位：分鐘（「工作分鐘」——依工作日曆換算成日期）。
 */
(function (root) {
  "use strict";
  var SKIP = -1, OUT = -2, AUTO = -9;

  // ===========================================================================
  // 小工具
  // ===========================================================================
  function SchedError(msg) { this.name = "SchedError"; this.message = msg; }
  SchedError.prototype = Object.create(Error.prototype);
  function need(c, m) { if (!c) throw new SchedError(m); }
  function rngOf(seed) {                       // mulberry32：可重現的亂數
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function tri(r, v) {                          // 三角分配 (1-v, 1, 1+v)：加工時間的隨機變異倍率
    var u = r();
    return u < 0.5 ? 1 - v + v * Math.sqrt(2 * u) : 1 + v - v * Math.sqrt(2 * (1 - u));
  }
  function phi(x) {                             // 標準常態 CDF（Abramowitz–Stegun 近似）
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989423 * Math.exp(-x * x / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function shuffle(a, r) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function maxOf(a) { var m = -Infinity; for (var k = 0; k < a.length; k++) if (a[k] > m) m = a[k]; return m; }

  // 二元堆積（優先佇列）
  function Heap(less) { this.a = []; this.less = less; }
  Heap.prototype.push = function (x) {
    var a = this.a, i = a.length; a.push(x);
    while (i > 0) { var p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; var t = a[i]; a[i] = a[p]; a[p] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && this.less(a[l], a[m])) m = l;
        if (r < n && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  };

  // ===========================================================================
  // 工作日曆：工作分鐘 ↔ 日期（例：週一到週六、每天 08:00 起 16 小時）
  //   第 0 分鐘＝起算日（第一個工作日）上班時間；每個工作日有 per 分鐘；c.holidays（日期字串）當作不上班
  // ===========================================================================
  function calendar(c) {
    c = c || {};
    var days = c.days && c.days.length ? c.days.map(Number) : [1, 2, 3, 4, 5, 6];
    var h0 = c.dayStart != null && c.dayStart !== "" ? Number(c.dayStart) : 8;
    var hrs = Math.max(1, Math.min(24, Number(c.hours) || 16));
    var per = Math.round(hrs * 60);
    var startStr = c.start || ymd(new Date());
    var base = parseDay(startStr), memo = {}, hol = {};
    (c.holidays || []).forEach(function (h) { var m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(h)); if (m) hol[m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2)] = 1; });
    function ymd(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
    function parseDay(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
    function isWork(d) { return days.indexOf(d.getDay()) >= 0 && !hol[ymd(d)]; }
    function nthWorkDay(k) {                    // 第 k 個工作日（k 從 0 起，可為負）
      if (memo[k]) return memo[k];
      var d = new Date(base.getTime()), n = 0;
      if (k >= 0) { while (!isWork(d)) d.setDate(d.getDate() + 1); while (n < k) { d.setDate(d.getDate() + 1); if (isWork(d)) n++; } }
      else { while (!isWork(d)) d.setDate(d.getDate() + 1); while (n > k) { d.setDate(d.getDate() - 1); if (isWork(d)) n--; } }
      memo[k] = d;
      return d;
    }
    function dayStartMs(k) { var d = nthWorkDay(k); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(h0), Math.round((h0 % 1) * 60), 0, 0).getTime(); }
    function toDate(m, asEnd) {
      var k = Math.floor(m / per), rem = m - k * per;
      if (asEnd && rem < 1e-6 && m > 0) { k -= 1; rem = per; }   // 完工剛好在下班那一刻 → 算當天下班，不跳到隔天早上
      return dayStartMs(k) + rem * 60000;
    }
    function dayIndex(s) {                      // 某日期是第幾個工作日（非工作日 → 前一個工作日）
      var d = parseDay(s), k = 0, x = new Date(base.getTime());
      while (!isWork(x)) x.setDate(x.getDate() + 1);
      if (d >= x) { while (x < d) { x.setDate(x.getDate() + 1); if (x <= d && isWork(x)) k++; } }
      else { while (x > d) { x.setDate(x.getDate() - 1); if (isWork(x) && x >= d) k--; } if (!isWork(d)) k--; }
      return k;
    }
    function fromDate(ts) {                     // 實際時間 → 工作分鐘（下班時間 → 當天下班那一刻）
      var d = new Date(ts), k = dayIndex(ymd(d)), m = (ts - dayStartMs(k)) / 60000;
      return k * per + Math.max(0, Math.min(per, m));
    }
    return {
      per: per, hours: hrs, dayStart: h0, days: days, start: startStr,
      toDate: toDate, fromDate: fromDate, dayIndex: dayIndex, ymd: ymd,
      dayDate: function (k) { return ymd(nthWorkDay(k)); },
      endOfDay: function (s) { return (dayIndex(s) + 1) * per; },          // 交期：當天下班
      startOfDay: function (s) { return Math.max(0, dayIndex(s) * per); }, // 投料日：當天上班（不早於起算日）
      daysToMin: function (dd) { return Math.round(Number(dd || 0) * per); }
    };
  }

  // ===========================================================================
  // 模型編譯：設定（站別、機型、產品途程）＋ 訂單 → 計算用結構
  //   cfg.stages[]  : {id, name, mode: "whole"|"parallel"|"batch", setup(分), out:{allowed, leadDays|leadMin, cost}}
  //   cfg.types[]   : {id, stage, name, count, fixed(每次上機固定分鐘)}
  //   cfg.products[]: {id, name, split:[小, 大], batch, route:{stageId:{typeId: 單件分鐘 | {unit, fixed}}}, setup?:{stageId:分}}
  //   orders[]      : {id, product, qty, release(分|"YYYY-MM-DD"), due(分|"YYYY-MM-DD"|null), weight,
  //                    allowOut(預設可), force:{stageId: typeId|"out"}, outLead:{stageId: 天}}
  // ===========================================================================
  function compile(cfg, orders, o) {
    o = o || {};
    need(cfg && cfg.stages && cfg.stages.length, "請先設定站別");
    var cal = o.cal || calendar(cfg.calendar);
    var S = cfg.stages.length, stages = [], sIdx = {};
    cfg.stages.forEach(function (st, s) {
      need(["whole", "parallel", "batch"].indexOf(st.mode) >= 0, "站別「" + st.name + "」的生產方式不符");
      need(sIdx[st.id] == null, "站別代號重複：" + st.id);
      sIdx[st.id] = s;
      var out = st.out || {};
      stages.push({ id: st.id, name: st.name || st.id, mode: st.mode, setup: Number(st.setup) || 0,
        out: { allowed: !!out.allowed, lead: out.leadMin != null ? Number(out.leadMin) : cal.daysToMin(out.leadDays || 0), cost: Number(out.cost) || 0 }, types: [] });
    });
    var types = [], tIdx = {}, nUnits = 0;
    (cfg.types || []).forEach(function (t) {
      var s = sIdx[t.stage]; need(s != null, "機型「" + (t.name || t.id) + "」的站別不存在");
      var cnt = Math.max(0, Math.floor(Number(t.count) || 0)); if (!cnt) return;
      need(tIdx[t.id] == null, "機型代號重複：" + t.id);
      tIdx[t.id] = types.length;
      types.push({ id: t.id, name: t.name || t.id, stage: s, count: cnt, base: nUnits, fixed: Number(t.fixed) || 0 });
      stages[s].types.push(types.length - 1);
      nUnits += cnt;
    });
    var pIdx = {}; (cfg.products || []).forEach(function (p, k) { pIdx[p.id] = k; });
    var M = { S: S, stages: stages, types: types, nUnits: nUnits, n: orders.length, orders: [], cal: cal,
      prodIds: (cfg.products || []).map(function (p) { return p.id; }),
      prodNames: (cfg.products || []).map(function (p) { return p.name || p.id; }),
      sig: stages.map(function (st) { return st.id + ":" + st.types.map(function (ti) { return types[ti].id + "x" + types[ti].count; }).join(","); }).join(";") };
    function tm(v, end) {                        // 工作分鐘 | "YYYY-MM-DD" | "YYYY-MM-DDTHH:MM"
      if (v == null || v === "") return null;
      if (typeof v === "number") return v;
      var t = String(v), m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(t);
      if (m) return cal.fromDate(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime());
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return end ? cal.endOfDay(t) : cal.startOfDay(t);
      var x = Number(t); return isNaN(x) ? null : x;
    }
    var seen = {};
    orders.forEach(function (od, i) {
      var pk = pIdx[od.product]; need(pk != null, "訂單 " + (od.id || i + 1) + " 的產品「" + od.product + "」沒有設定途程");
      var p = cfg.products[pk], qty = Math.max(1, Math.round(Number(od.qty) || 0));
      var id = od.id != null && od.id !== "" ? String(od.id) : String(i + 1);
      need(!seen[id], "訂單編號重複：" + id); seen[id] = 1;
      var splits = (p.split || []).map(Number).filter(function (x) { return x > 0; });
      if (!splits.length) splits = [qty];
      var rec = { id: id, label: od.label || id, product: pk, qty: qty,
        release: Math.max(0, tm(od.release, false) || 0), due: tm(od.due, true), weight: Number(od.weight) || 1,
        splits: splits, batch: Math.max(0, Number(p.batch) || 0), optType: [], optUnit: [], optFixed: [], setup: [], outLead: [] };
      for (var s = 0; s < S; s++) {
        var sid = stages[s].id, r = (p.route || {})[sid] || {}, ot = [], ou = [], of = [];
        stages[s].types.forEach(function (ti) {
          var v = r[types[ti].id]; if (v == null || v === "" || v === false) return;
          var unit = typeof v === "object" ? Number(v.unit) || 0 : Number(v), fix = typeof v === "object" && v.fixed != null ? Number(v.fixed) || 0 : types[ti].fixed;
          if (!(unit > 0 || fix > 0)) return;
          ot.push(ti); ou.push(unit); of.push(fix);
        });
        var fc = od.force && od.force[sid];
        if (!ot.length) { ot = [SKIP]; ou = [0]; of = [0]; }
        else {
          if ((stages[s].out.allowed && od.allowOut !== false && !o.noOut) || fc === "out") { ot.push(OUT); ou.push(0); of.push(0); }
          if (fc != null && fc !== "") {        // 指定：強制外包或指定機型
            var kk = ot.indexOf(fc === "out" ? OUT : tIdx[fc]);
            if (kk >= 0) { ot = [ot[kk]]; ou = [ou[kk]]; of = [of[kk]]; }
          }
        }
        rec.optType.push(ot); rec.optUnit.push(ou); rec.optFixed.push(of);
        rec.setup.push(p.setup && p.setup[sid] != null ? Number(p.setup[sid]) : stages[s].setup);
        rec.outLead.push(od.outLead && od.outLead[sid] != null && od.outLead[sid] !== "" ? cal.daysToMin(od.outLead[sid]) : stages[s].out.lead);
      }
      M.orders.push(rec);
    });
    return M;
  }

  // ===========================================================================
  // 離散事件模擬：給一組決策 X，模擬整個工廠跑完的結果
  //   X = {seq: 訂單優先順序, split: 每單拆批選項, asg: 每單每站選哪個機型（選項序號；AUTO＝現場即時決定）}
  //   opt = {rule:"seq"|"fifo"|"edd"|"atc", cv: 加工時間變異, seed, now, fixed:{"i|s|a":op}, init:{free,last},
  //          down:{unit:[[from,to]...]}, active, collect}
  // ===========================================================================
  function simulate(M, X, opt) {
    opt = opt || {};
    var n = M.n, S = M.S, rule = opt.rule || "seq", now = opt.now || 0, collect = !!opt.collect;
    var r = opt.cv > 0 ? rngOf(opt.seed || 1) : null, cv = opt.cv || 0;
    var fixed = opt.fixed || null, down = opt.down || null, act = opt.active || null;
    var rank = new Int32Array(n).fill(1 << 30);
    for (var k = 0; k < X.seq.length; k++) rank[X.seq[k]] = k;
    var asg = X.asg;
    var ready = new Array(n), qtys = new Array(n);
    for (var i = 0; i < n; i++) {
      if (act && !act[i]) continue;
      var od = M.orders[i], L = od.splits[Math.min(X.split[i], od.splits.length - 1)], q = od.qty;
      var ns = Math.ceil(q / L), qs = new Array(ns);
      for (var j = 0; j < ns; j++) qs[j] = j < ns - 1 ? L : q - L * (ns - 1);
      qtys[i] = qs; ready[i] = new Float64Array(ns).fill(od.release);
    }
    var freeU = new Float64Array(M.nUnits), lastU = new Int32Array(M.nUnits).fill(-1);
    if (opt.init) { for (var g = 0; g < M.nUnits; g++) { freeU[g] = Math.max(now, opt.init.free[g] || 0); lastU[g] = opt.init.last[g]; } }
    else if (now) freeU.fill(now);
    var ops = collect ? [] : null, busy = collect ? new Float64Array(M.nUnits) : null, info = collect ? [] : null;
    var cost = 0, outQty = 0, totQty = 0, setups = 0;
    for (i = 0; i < n; i++) if (!act || act[i]) totQty += M.orders[i].qty;

    for (var s = 0; s < S; s++) {
      var st = M.stages[s], pools = {}, poolKeys = [];
      // 現場即時決定機型（經驗法則）：依「最早可完工」把訂單分給機型
      var autoList = [];
      for (i = 0; i < n; i++) if ((!act || act[i]) && asg[i * S + s] === AUTO) autoList.push(i);
      if (autoList.length) autoAssign(M, asg, s, autoList, ready, qtys, freeU, now, rank);
      for (i = 0; i < n; i++) {
        if (act && !act[i]) continue;
        od = M.orders[i];
        var ki = asg[i * S + s], typ = od.optType[s][ki];
        if (typ === SKIP) continue;
        var rdyAll = maxOf(ready[i]);
        if (collect) info.push({ o: i, s: s, ready: rdyAll });
        if (typ === OUT) {                      // 整站外包：整單送出、前置時間後一起回來
          var fk = fixed && fixed[i + "|" + s + "|0"];
          var t0 = fk ? fk.start : Math.max(rdyAll, now), t1 = fk ? fk.end : t0 + od.outLead[s] * (r ? tri(r, cv) : 1);
          ready[i].fill(t1); cost += od.qty * st.out.cost; outQty += od.qty;
          if (collect) { ops.push({ o: i, s: s, type: -1, unit: -1, start: t0, end: t1, setup: 0, qty: od.qty, a: 0, b: qtys[i].length - 1, kind: "out", frozen: !!fk }); info[info.length - 1].start = t0; info[info.length - 1].end = t1; }
          continue;
        }
        var unit = od.optUnit[s][ki], fix = od.optFixed[s][ki], qs2 = qtys[i], ns2 = qs2.length;
        if (!pools[typ]) { pools[typ] = []; poolKeys.push(typ); }
        var P = pools[typ];
        if (st.mode === "whole") {
          P.push({ i: i, a: 0, b: ns2 - 1, q: od.qty, rdy: rdyAll, unit: unit, fix: fix, whole: true, qs: qs2 });
        } else if (st.mode === "parallel") {
          for (j = 0; j < ns2; j++) P.push({ i: i, a: j, b: j, q: qs2[j], rdy: ready[i][j], unit: unit, fix: fix });
        } else {                                // 併批：連續的子批湊成一批（批量 ≥ 子批量；0＝整張單一批）
          var m = od.batch > 0 ? Math.max(1, Math.floor(od.batch / qs2[0])) : ns2;
          for (j = 0; j < ns2; j += m) {
            var b = Math.min(ns2 - 1, j + m - 1), qq = 0, rd = 0;
            for (var x = j; x <= b; x++) { qq += qs2[x]; if (ready[i][x] > rd) rd = ready[i][x]; }
            P.push({ i: i, a: j, b: b, q: qq, rdy: rd, unit: unit, fix: fix });
          }
        }
      }
      for (var pk = 0; pk < poolKeys.length; pk++) {
        setups += runPool(M, s, poolKeys[pk], pools[poolKeys[pk]], ready, rank, rule, r, cv, now, freeU, lastU, fixed, down, ops, busy, info);
      }
    }
    // 結果
    var C = new Float64Array(n), sumF = 0, maxF = 0, mk = 0, twt = 0, tardy = 0, cnt = 0, hasDue = 0, onTime = 0;
    for (i = 0; i < n; i++) {
      if (act && !act[i]) continue;
      od = M.orders[i]; var c = maxOf(ready[i]); C[i] = c; cnt++;
      var F = c - od.release; sumF += F; if (F > maxF) maxF = F; if (c > mk) mk = c;
      if (od.due != null) { hasDue++; var T = c - od.due; if (T > 1e-6) { tardy++; twt += od.weight * T; } else onTime++; }
    }
    return { C: C, meanF: cnt ? sumF / cnt : 0, maxF: maxF, makespan: mk, twt: twt, tardy: tardy, onTimeRate: hasDue ? onTime / hasDue : 1,
      cost: cost, outFrac: totQty ? outQty / totQty : 0, setups: setups, ops: ops, busy: busy, info: info };
  }

  // 經驗法則的機型選擇（論文 5.3.2）：依訂單到站先後，選「最早可完工」的合格機型（快的機台優先、讓機台不停）
  function autoAssign(M, asg, s, list, ready, qtys, freeU, now, rank) {
    var S = M.S, shadow = {}, whole = M.stages[s].mode === "whole";
    function sh(typ) { var T = M.types[typ]; return shadow[typ] || (shadow[typ] = Array.prototype.slice.call(freeU, T.base, T.base + T.count)); }
    list.sort(function (a, b) { return maxOf(ready[a]) - maxOf(ready[b]) || rank[a] - rank[b]; });
    list.forEach(function (i) {
      var od = M.orders[i], rd = Math.max(maxOf(ready[i]), now), best = -1, bestEnd = Infinity, nsub = qtys[i].length;
      od.optType[s].forEach(function (typ, k) {
        if (typ < 0) return;                    // 經驗法則不自動外包
        var T = M.types[typ], f = sh(typ);
        var work = od.optFixed[s][k] * (whole ? 1 : nsub) + od.qty * od.optUnit[s][k];
        var par = whole ? 1 : Math.min(T.count, nsub);
        var end = Math.max(rd, Math.min.apply(null, f)) + work / par;
        if (end < bestEnd - 1e-9) { bestEnd = end; best = k; }
      });
      if (best < 0) best = 0;
      asg[i * S + s] = best;
      var typ = od.optType[s][best];
      if (typ >= 0) {                           // 把工作量攤到影子機台上（估算後面訂單的可用時間）
        var T2 = M.types[typ], f2 = sh(typ);
        var work2 = od.qty * od.optUnit[s][best] + od.optFixed[s][best] * (whole ? 1 : nsub);
        var par2 = whole ? 1 : Math.min(T2.count, nsub);
        f2.sort(function (a, b) { return a - b; });
        for (var u = 0; u < par2; u++) f2[u] = Math.max(f2[u], rd) + work2 / par2;
      }
    });
  }

  // 某一種機型（同型多台）的派工：機台一空就從「已到站」的工作挑優先的做（非延遲派工）
  function runPool(M, s, typ, jobs, ready, rank, rule, r, cv, now, freeU, lastU, fixed, down, ops, busy, info) {
    var T = M.types[typ], base = T.base, cnt = T.count, setups = 0, todo = [], k, x, u;
    for (k = 0; k < jobs.length; k++) {
      var jb = jobs[k], fk = fixed && fixed[jb.i + "|" + s + "|" + jb.a];
      if (fk) { applyDone(s, jb, fk, ready, ops, busy, info); continue; }
      if (jb.rdy < now) jb.rdy = now;
      todo.push(jb);
    }
    todo.sort(function (p, q) { return p.rdy - q.rdy; });
    var less = rule === "fifo" ? function (p, q) { return p.rdy < q.rdy || (p.rdy === q.rdy && (rank[p.i] < rank[q.i] || (rank[p.i] === rank[q.i] && p.a < q.a))); }
      : rule === "edd" ? function (p, q) { var dp = M.orders[p.i].due, dq = M.orders[q.i].due; dp = dp == null ? Infinity : dp; dq = dq == null ? Infinity : dq; return dp < dq || (dp === dq && (rank[p.i] < rank[q.i] || (rank[p.i] === rank[q.i] && p.a < q.a))); }
      : function (p, q) { return rank[p.i] < rank[q.i] || (rank[p.i] === rank[q.i] && (p.rdy < q.rdy || (p.rdy === q.rdy && p.a < q.a))); };
    var H = rule === "atc" ? null : new Heap(less), avail = rule === "atc" ? [] : null;
    var ptr = 0, N = todo.length, done = 0, pbar = 0;
    if (rule === "atc") { for (k = 0; k < N; k++) pbar += todo[k].fix + todo[k].q * todo[k].unit; pbar = N ? pbar / N : 1; }
    while (done < N) {
      var mi = 0; for (u = 1; u < cnt; u++) if (freeU[base + u] < freeU[base + mi]) mi = u;
      var t = freeU[base + mi], size = H ? H.a.length : avail.length;
      if (!size) t = Math.max(t, todo[ptr].rdy);
      while (ptr < N && todo[ptr].rdy <= t) { if (H) H.push(todo[ptr]); else avail.push(todo[ptr]); ptr++; }
      var job;
      if (H) job = H.pop();
      else {                                    // ATC：加權延遲成本最高的先做（Vepsalainen & Morton 1987）
        var bi = 0, bv = -Infinity;
        for (k = 0; k < avail.length; k++) {
          var c = avail[k], od = M.orders[c.i], p = c.fix + c.q * c.unit || 1;
          var slack = od.due == null ? 1e12 : od.due - t - p;
          var v = (od.weight / p) * Math.exp(-Math.max(slack, 0) / (2 * pbar));
          if (v > bv || (v === bv && rank[c.i] < rank[avail[bi].i])) { bv = v; bi = k; }
        }
        job = avail[bi]; avail[bi] = avail[avail.length - 1]; avail.pop();
      }
      var od2 = M.orders[job.i], prod = od2.product, stp = od2.setup[s], work = job.fix + job.q * job.unit;
      var proc = work * (r ? tri(r, cv) : 1);
      // 挑「最早做完」的機台：同產品免換線、避開停機時段
      var g = -1, start = 0, su = 0, end = Infinity;
      for (u = 0; u < cnt; u++) {
        var gg = base + u, su2 = stp > 0 && lastU[gg] !== -1 && lastU[gg] !== prod ? stp : 0;
        var st2 = Math.max(freeU[gg], job.rdy);
        if (down && down[gg]) st2 = avoidDown(down[gg], st2, su2 + proc);
        if (st2 + su2 + proc < end - 1e-9) { g = gg; start = st2; su = su2; end = st2 + su2 + proc; }
      }
      var ps = start + su, streams = null;
      freeU[g] = end; lastU[g] = prod; if (su > 0) setups++;
      if (job.whole) {                          // 整批流動：每做滿一個子批就先往下一站送（lot streaming）
        var qs = job.qs, cum = 0, f = proc / Math.max(1e-9, work);
        for (x = 0; x < qs.length; x++) { cum += qs[x]; ready[job.i][x] = x < qs.length - 1 ? ps + (job.fix + cum * job.unit) * f : end; }
        if (ops) streams = Array.prototype.slice.call(ready[job.i]);
      } else for (x = job.a; x <= job.b; x++) ready[job.i][x] = end;
      if (ops) {
        ops.push({ o: job.i, s: s, type: typ, unit: g, start: start, end: end, setup: su, qty: job.q, a: job.a, b: job.b, kind: job.whole ? "whole" : job.a === job.b ? "sub" : "batch", streams: streams });
        busy[g] += end - start;
        markInfo(info, job.i, s, start, end);
      }
      done++;
    }
    return setups;
  }
  function markInfo(info, i, s, start, end) {
    for (var k = info.length - 1; k >= 0; k--) if (info[k].o === i && info[k].s === s) {
      if (info[k].start == null || start < info[k].start) info[k].start = start;
      if (info[k].end == null || end > info[k].end) info[k].end = end;
      return;
    }
  }
  function avoidDown(w, start, dur) {            // 停機時段不能開工；跨到停機就延到修好後
    for (var guard = 0; guard < 50; guard++) {
      var moved = false;
      for (var k = 0; k < w.length; k++) if (start < w[k][1] && start + dur > w[k][0]) { start = w[k][1]; moved = true; }
      if (!moved) break;
    }
    return start;
  }
  function applyDone(s, jb, fk, ready, ops, busy, info) {   // 已開工（凍結）的工序：照原計畫
    var x;
    if (jb.whole && fk.streams && fk.streams.length === ready[jb.i].length) for (x = 0; x < fk.streams.length; x++) ready[jb.i][x] = fk.streams[x];
    else for (x = jb.a; x <= jb.b; x++) ready[jb.i][x] = fk.end;
    if (ops) {
      ops.push({ o: jb.i, s: s, type: fk.type, unit: fk.unit, start: fk.start, end: fk.end, setup: fk.setup || 0, qty: jb.q, a: jb.a, b: jb.b, kind: fk.kind || "sub", streams: fk.streams || null, frozen: true, paused: fk.paused || null });
      if (fk.unit >= 0) busy[fk.unit] += fk.end - fk.start;
      markInfo(info, jb.i, s, fk.start, fk.end);
    }
  }

  // ===========================================================================
  // 決策的建立、複製、比較
  // ===========================================================================
  function blankX(M) { return { seq: Int32Array.from({ length: M.n }, function (_, i) { return i; }), split: new Uint8Array(M.n), asg: new Int16Array(M.n * M.S) }; }
  function cloneX(X) { return { seq: Int32Array.from(X.seq), split: Uint8Array.from(X.split), asg: Int16Array.from(X.asg) }; }
  function keyX(X) { return X.seq.join(",") + "|" + X.split.join("") + "|" + X.asg.join(","); }
  function bigSplit(M, i) { var sp = M.orders[i].splits, b = 0; for (var k = 1; k < sp.length; k++) if (sp[k] > sp[b]) b = k; return b; }
  function bySeq(M, keyFn) { var a = []; for (var i = 0; i < M.n; i++) a.push(i); a.sort(function (x, y) { return keyFn(x) - keyFn(y) || x - y; }); return Int32Array.from(a); }
  function lockSim(lock, extra) {
    return Object.assign({ now: lock ? lock.now : 0, init: lock && lock.init, fixed: lock && lock.fixed, down: lock && lock.down }, extra || {});
  }

  // 經驗法則（論文的實務做法）：先到先做（FIFO）＋固定整匣拆批＋現場挑最快可完工的機型
  function practicalX(M, lock) {
    var X = blankX(M);
    X.seq = bySeq(M, function (i) { return M.orders[i].release; });
    for (var i = 0; i < M.n; i++) {
      X.split[i] = bigSplit(M, i);
      for (var s = 0; s < M.S; s++) X.asg[i * M.S + s] = M.orders[i].optType[s][0] === SKIP ? 0 : AUTO;
    }
    applyLock(M, X, lock);
    simulate(M, X, lockSim(lock, { rule: "fifo" }));   // 把 AUTO 實際決定下來（之後才能交配／比較）
    return X;
  }
  function eddX(M, lock) {                       // 交期最早先做（EDD）
    var X = practicalX(M, lock);
    X.seq = bySeq(M, function (i) { var d = M.orders[i].due; return d == null ? 1e15 : d - M.orders[i].weight * 1e-3; });
    return X;
  }
  function applyLock(M, X, lock) {
    if (!lock || !lock.genes) return;
    lock.genes.forEach(function (g, i) {
      if (!g) return;
      if (g.split != null) X.split[i] = g.split;
      for (var s = 0; s < M.S; s++) if (g.asg[s] != null) X.asg[i * M.S + s] = g.asg[s];
    });
  }

  // ===========================================================================
  // 評估：目標函數（越小越好）＝ 效率 × 平均流程時間 ＋ 準時 × 加權延遲 ＋ 外包比例 ＋ 變動懲罰
  //   以「經驗法則」的成績當基準做正規化（經驗法則的平均週期＝1；它的加權延遲＝1）
  // ===========================================================================
  function makeEval(M, o) {
    o = o || {};
    var w = Object.assign({ flow: 1, tardy: 1, out: 1, stable: 0 }, o.weights || {});
    var base = o.base || { meanF: 1, twt: 0 };
    var F0 = Math.max(1, base.meanF), T0 = Math.max(base.twt, F0 * 0.25);   // 經驗法則都準時時，延遲以「平均週期的 1/4」為一單位
    var ref = o.ref || null, refC = o.refC || null, S = M.S;
    function parts(X, res) {                     // 跟原計畫比：改了幾成機型／拆批、每張單完工時間平均挪動多少分鐘
      var ch = 0, tot = 0, sh = 0, n = 0, i, s;
      if (ref) for (i = 0; i < M.n; i++) {
        var rg = ref[i]; if (!rg) continue;
        tot += S + 1;
        if (rg.split !== X.split[i]) ch++;
        for (s = 0; s < S; s++) if (rg.asg[s] !== X.asg[i * S + s]) ch++;
      }
      if (refC && res) for (i = 0; i < M.n; i++) { if (refC[i] == null) continue; sh += Math.abs(res.C[i] - refC[i]); n++; }
      return { assign: tot ? ch / tot : 0, shift: n ? sh / n : 0 };
    }
    function instab(X, res) {                    // 0～1：完工時間平均挪動達「平均週期的 1/4」就算滿分
      if (!ref && !refC) return 0;
      var p = parts(X, res);
      return 0.5 * p.assign + 0.5 * Math.min(1, p.shift / (0.25 * F0));
    }
    function f(res, X) {
      return w.flow * res.meanF / F0 + w.tardy * res.twt / T0 + w.out * res.outFrac + (w.stable ? w.stable * instab(X, res) : 0);
    }
    f.instab = instab; f.parts = parts;
    return f;
  }

  // OCBA：把有限的模擬次數，分給「平均差不多、變異又大」的方案（Chen et al. 2000）
  function ocbaAlloc(mean, sd, total) {
    var k = mean.length, b = 0, i;
    for (i = 1; i < k; i++) if (mean[i] < mean[b]) b = i;
    var ratio = new Array(k), eps = 1e-9;
    for (i = 0; i < k; i++) {
      if (i === b) continue;
      var d = Math.max(mean[i] - mean[b], eps), si = Math.max(sd[i], eps);
      ratio[i] = (si / d) * (si / d);
    }
    var sum = 0;
    for (i = 0; i < k; i++) if (i !== b) { var si2 = Math.max(sd[i], eps); sum += (ratio[i] * ratio[i]) / (si2 * si2); }
    ratio[b] = Math.max(sd[b], eps) * Math.sqrt(sum);
    var tot = 0; for (i = 0; i < k; i++) tot += ratio[i];
    return ratio.map(function (x) { return tot > 0 ? x / tot * total : total / k; });
  }
  function apcs(mean, sd, n) {                   // 近似正確選擇機率（Bonferroni）
    var k = mean.length, b = 0, i, p = 1;
    for (i = 1; i < k; i++) if (mean[i] < mean[b]) b = i;
    for (i = 0; i < k; i++) {
      if (i === b) continue;
      var v = sd[b] * sd[b] / Math.max(1, n[b]) + sd[i] * sd[i] / Math.max(1, n[i]);
      p -= v <= 0 ? (mean[i] > mean[b] ? 0 : 1) : phi(-(mean[i] - mean[b]) / Math.sqrt(v));
    }
    return Math.max(0, p);
  }

  // ===========================================================================
  // 最佳化：GA（論文）＋ OCBA（論文）＋ IG 局部搜尋 ＋ 啟發式種子 ＋ Pareto 前緣
  //   o = {weights, cv, pop, gens, timeLimit, stall, cr, mr, n0, delta, pcs, budget, seed, lock, ref, down, onProgress, riskCv}
  // ===========================================================================
  function optimize(M, o) {
    o = o || {};
    var t0 = Date.now(), r = rngOf(o.seed || 20151), S = M.S, n = M.n;
    need(n > 0, "沒有要排的訂單");
    var lock = o.lock || null, simBase = lockSim(lock);
    if (o.down) simBase.down = o.down;
    var cv = Number(o.cv) || 0, stochastic = cv > 0;
    var pop = o.pop || 30, gens = o.gens || 400, timeLimit = o.timeLimit || 15000, cr = o.cr != null ? o.cr : 0.8, mr = o.mr != null ? o.mr : 0.4;
    var n0 = o.n0 || (stochastic ? 3 : 1), delta = o.delta || 10, pstar = o.pcs || 0.9, budget = o.budget || pop * 4;
    var evals = 0, reps = 0, cache = {}, history = [];
    // 凍結的基因（已開工的訂單：拆批不能改、已開工的站機型不能改）
    var lockS = new Uint8Array(n), lockA = new Uint8Array(n * S), free = [];
    if (lock && lock.genes) lock.genes.forEach(function (g, i) {
      if (!g) return;
      if (g.split != null) lockS[i] = 1;
      for (var s = 0; s < S; s++) if (g.asg[s] != null) lockA[i * S + s] = 1;
    });
    for (var i0 = 0; i0 < n; i0++) for (var s0 = 0; s0 < S; s0++) if (!lockA[i0 * S + s0] && M.orders[i0].optType[s0].length > 1) free.push(i0 * S + s0);
    var splitFree = []; for (i0 = 0; i0 < n; i0++) if (!lockS[i0] && M.orders[i0].splits.length > 1) splitFree.push(i0);

    function sim(X, rep, collect, cvOverride) {
      var c = cvOverride != null ? cvOverride : stochastic ? cv : 0;
      return simulate(M, X, Object.assign({}, simBase, { cv: c, seed: 1000 + rep * 7919, collect: !!collect }));
    }
    // 基準：經驗法則
    var practical = practicalX(M, lock), baseRes = sim(practical, 0);
    var refG = o.ref && o.ref.genes ? o.ref.genes : o.ref, refCid = o.ref && o.ref.genes ? o.ref.C : null;   // ref：原計畫（機型／拆批、完工時間，以訂單編號記錄）
    var ref = refG ? refIndex(M, refG) : null;
    var refC = refCid ? M.orders.map(function (od) { return refCid[od.id] != null ? refCid[od.id] : null; }) : null;
    var feval = makeEval(M, { weights: o.weights, base: { meanF: baseRes.meanF, twt: baseRes.twt }, ref: ref, refC: refC });
    function evaluate(ind, times) {              // 給個體 ind 再跑 times 次模擬（共同亂數 CRN）
      for (var k = 0; k < times; k++) {
        var res = sim(ind.X, ind.n), v = feval(res, ind.X);
        ind.n++; ind.sum += v; ind.sq += v * v; ind.mf += res.meanF; ind.tw += res.twt; ind.ot += res.onTimeRate; ind.oc += res.cost; reps++;
      }
      ind.mean = ind.sum / ind.n;
      ind.sd = ind.n > 1 ? Math.sqrt(Math.max(0, (ind.sq - ind.sum * ind.sum / ind.n) / (ind.n - 1))) : 0;
    }
    function make(X) {
      var key = keyX(X);
      if (cache[key]) return cache[key];
      var ind = { X: X, key: key, n: 0, sum: 0, sq: 0, mf: 0, tw: 0, ot: 0, oc: 0, mean: Infinity, sd: 0 };
      evaluate(ind, n0); evals++;
      cache[key] = ind;
      return ind;
    }
    function repair(X) {
      for (var i = 0; i < n; i++) {
        var od = M.orders[i];
        if (!lockS[i] && X.split[i] >= od.splits.length) X.split[i] = od.splits.length - 1;
        for (var s = 0; s < S; s++) { if (lockA[i * S + s]) continue; var v = X.asg[i * S + s]; if (v < 0 || v >= od.optType[s].length) X.asg[i * S + s] = Math.floor(r() * od.optType[s].length); }
      }
      return X;
    }
    function randomX() {
      var X = blankX(M); X.seq = Int32Array.from(shuffle(Array.from(X.seq), r));
      for (var i = 0; i < n; i++) { X.split[i] = Math.floor(r() * M.orders[i].splits.length); for (var s = 0; s < S; s++) X.asg[i * S + s] = Math.floor(r() * M.orders[i].optType[s].length); }
      applyLock(M, X, lock); return X;
    }
    // ---- 初始族群：啟發式種子＋隨機（文獻：好的初始解加快收斂）
    var P = [], edd = eddX(M, lock);
    var atcX = cloneX(practical), atcRes = simulate(M, atcX, Object.assign({}, simBase, { rule: "atc", collect: true }));
    atcX.seq = orderByFirstStart(M, atcRes);
    var small = cloneX(edd); for (var i1 = 0; i1 < n; i1++) if (!lockS[i1]) small.split[i1] = 0;
    var seeds = [practical, edd, atcX, small];
    if (o.extraSeeds) o.extraSeeds.forEach(function (x) {    // 例如「沿用原計畫、只把新單插進去」：先把 AUTO（現場決定的機型）定下來
      if (!x || !x.seq || x.seq.length !== n) return;
      var c = cloneX(x); applyLock(M, c, lock); simulate(M, c, Object.assign({}, simBase, { rule: "seq" })); seeds.push(c);
    });
    if (n <= (o.nehMax || 30)) seeds.push(nehX(M, edd, feval, simBase));
    seeds.forEach(function (x) { P.push(make(repair(cloneX(x)))); });
    while (P.length < pop) P.push(make(randomX()));
    var eddRes = simulate(M, edd, Object.assign({}, simBase, { rule: "edd" }));
    var heur = {
      practical: { kpi: summarize(baseRes), X: practical, rule: "fifo", f: feval(baseRes, practical) },
      edd: { kpi: summarize(eddRes), X: edd, rule: "edd", f: feval(eddRes, edd) },
      atc: { kpi: summarize(atcRes), X: cloneX(practical), rule: "atc", f: feval(atcRes, atcX) }
    };
    var best = null, stall = 0, g;
    function sortP() { P.sort(function (a, b) { return a.mean - b.mean; }); }
    function runOcba() {                         // 每代用 OCBA 把預算花在難分高下的方案上
      if (!stochastic) return;
      var used = 0;
      while (used < budget) {
        var mean = P.map(function (x) { return x.mean; }), sd = P.map(function (x) { return x.sd; }), nn = P.map(function (x) { return x.n; });
        if (apcs(mean, sd, nn) >= pstar) break;
        var total = nn.reduce(function (a, b) { return a + b; }, 0) + delta, al = ocbaAlloc(mean, sd, total), moved = 0;
        for (var k = 0; k < P.length && used < budget; k++) {
          var extra = Math.min(Math.max(0, Math.ceil(al[k]) - P[k].n), budget - used, 30);
          if (extra > 0) { evaluate(P[k], extra); used += extra; moved += extra; }
        }
        if (!moved) break;
      }
    }
    var stallMax = o.stall || 80;
    for (g = 0; g < gens; g++) {
      runOcba(); sortP();
      if (!best || P[0].mean < best.mean - 1e-9) { best = P[0]; stall = 0; } else stall++;
      history.push({ gen: g, f: best.mean, meanF: best.mf / best.n, twt: best.tw / best.n, onTime: best.ot / best.n, reps: reps, t: Date.now() - t0 });
      if (o.onProgress) o.onProgress({ gen: g, gens: gens, best: { f: best.mean, meanF: best.mf / best.n, twt: best.tw / best.n, onTime: best.ot / best.n }, evals: evals, reps: reps, elapsed: Date.now() - t0, limit: timeLimit });
      if (Date.now() - t0 > timeLimit || stall >= stallMax) break;
      // ---- 下一代：保留前 50%（菁英），其餘由交配＋突變產生
      var elite = P.slice(0, Math.max(2, Math.floor(pop / 2))), next = elite.slice();
      while (next.length < pop) {
        var pa = elite[Math.floor(r() * elite.length)].X, pb = elite[Math.floor(r() * elite.length)].X;
        var child = r() < cr ? crossover(pa, pb) : cloneX(pa);
        if (r() < mr) mutate(child);
        if (r() < mr * 0.5) mutate(child);
        next.push(make(repair(child)));
      }
      P = next;
      // ---- 迭代貪婪（IG）：把最好的方案拆掉幾張單、再一張張插回最好的位置；機型局部搜尋
      var ig = igStep(P[0].X); if (ig) P.push(make(ig));
      var ls = assignStep(P[0].X); if (ls) P.push(make(ls));
      sortP(); P = P.slice(0, pop);
    }
    runOcba(); sortP();
    if (!best || P[0].mean < best.mean) best = P[0];
    var plan = sim(best.X, 0, true);
    var riskCv = o.riskCv != null ? o.riskCv : stochastic ? cv : 0.1;
    var robust = riskCv > 0 ? robustness(best.X, riskCv) : null;
    return {
      X: best.X, res: plan, kpi: summarize(plan), f: best.mean, heur: heur, history: history, evals: evals, reps: reps,
      elapsed: Date.now() - t0, pareto: paretoFront(), robust: robust, riskCv: riskCv,
      base: { meanF: baseRes.meanF, twt: baseRes.twt }, instab: feval.instab(best.X, plan), instabParts: feval.parts(best.X, plan), stochastic: stochastic
    };

    function crossover(a, b) {                   // 順序：OX 交配；機型＋拆批：以訂單為單位的兩點交配
      var c = cloneX(a), i1 = Math.floor(r() * n), i2 = Math.floor(r() * n), t;
      if (i1 > i2) { t = i1; i1 = i2; i2 = t; }
      var seg = {}, k;
      for (k = i1; k <= i2; k++) seg[a.seq[k]] = 1;
      var fill = []; for (k = 0; k < n; k++) if (!seg[b.seq[k]]) fill.push(b.seq[k]);
      var p = 0; for (k = 0; k < n; k++) if (k < i1 || k > i2) c.seq[k] = fill[p++];
      var j1 = Math.floor(r() * n), j2 = Math.floor(r() * n); if (j1 > j2) { t = j1; j1 = j2; j2 = t; }
      for (var i = j1; i <= j2; i++) {
        if (!lockS[i]) c.split[i] = b.split[i];
        for (var s = 0; s < S; s++) if (!lockA[i * S + s]) c.asg[i * S + s] = b.asg[i * S + s];
      }
      return c;
    }
    function mutate(c) {
      var kind = r();
      if (kind < 0.35 || (!free.length && !splitFree.length)) {   // 順序：插入移動
        var a = Math.floor(r() * n), b = Math.floor(r() * n), arr = Array.from(c.seq), v = arr.splice(a, 1)[0]; arr.splice(b, 0, v); c.seq = Int32Array.from(arr);
      } else if ((kind < 0.55 && splitFree.length) || !free.length) {
        var i = splitFree[Math.floor(r() * splitFree.length)]; c.split[i] = Math.floor(r() * M.orders[i].splits.length);
      } else {
        var gi = free[Math.floor(r() * free.length)], oi = Math.floor(gi / S), s = gi % S;
        c.asg[gi] = Math.floor(r() * M.orders[oi].optType[s].length);
      }
    }
    function quick(X) { var res = sim(X, 0); return feval(res, X); }
    function igStep(X) {
      if (n < 3) return null;
      var d = Math.min(4, Math.max(2, Math.round(n * 0.1))), arr = Array.from(X.seq), removed = [];
      for (var k = 0; k < d; k++) removed.push(arr.splice(Math.floor(r() * arr.length), 1)[0]);
      var cur = cloneX(X), maxPos = n > 40 ? 16 : n;
      for (var q = 0; q < removed.length; q++) {
        var o2 = removed[q], rest = removed.slice(q + 1), bestV = Infinity, bestArr = null, len = arr.length + 1, step = Math.max(1, Math.floor(len / maxPos));
        for (var pos = 0; pos < len; pos += step) {
          var cand = arr.slice(); cand.splice(pos, 0, o2);
          cur.seq = Int32Array.from(cand.concat(rest));
          var v = quick(cur); if (v < bestV) { bestV = v; bestArr = cand; }
        }
        arr = bestArr;
      }
      cur.seq = Int32Array.from(arr);
      return cur;
    }
    function assignStep(X) {                     // 機型局部搜尋：最慢／最晚的一張單，逐站換成別的合格機型與拆批試試
      var res = sim(X, 0), worst = -1, wv = -Infinity;
      for (var i = 0; i < n; i++) {
        var od = M.orders[i], v = od.due != null ? (res.C[i] - od.due) * od.weight * 4 + res.C[i] - od.release : res.C[i] - od.release;
        if (v > wv && (splitFree.indexOf(i) >= 0 || hasFree(i))) { wv = v; worst = i; }
      }
      if (worst < 0) return null;
      var cur = cloneX(X), curV = feval(res, X), improved = false;
      for (var s = 0; s < S; s++) {
        if (lockA[worst * S + s]) continue;
        var opts = M.orders[worst].optType[s].length;
        for (var k = 0; k < opts; k++) {
          if (k === cur.asg[worst * S + s]) continue;
          var c = cloneX(cur); c.asg[worst * S + s] = k;
          var v2 = quick(c); if (v2 < curV - 1e-9) { cur = c; curV = v2; improved = true; }
        }
      }
      if (!lockS[worst]) for (var sp = 0; sp < M.orders[worst].splits.length; sp++) {
        if (sp === cur.split[worst]) continue;
        var c2 = cloneX(cur); c2.split[worst] = sp; var v3 = quick(c2); if (v3 < curV - 1e-9) { cur = c2; curV = v3; improved = true; }
      }
      return improved ? cur : null;
    }
    function hasFree(i) { for (var s = 0; s < S; s++) if (!lockA[i * S + s] && M.orders[i].optType[s].length > 1) return true; return false; }
    function robustness(X, rcv) { return risk(M, X, simBase, rcv, o.robustReps); }
    function paretoFront() {                     // 效率（平均週期）× 準時（加權延遲）的取捨前緣
      var all = Object.keys(cache).map(function (k) { var x = cache[k]; return { mf: x.mf / x.n, tw: x.tw / x.n, ot: x.ot / x.n, cost: x.oc / x.n, f: x.mean, X: x.X, key: x.key }; });
      all.sort(function (a, b) { return a.mf - b.mf || a.tw - b.tw; });
      var front = [], bt = Infinity;
      all.forEach(function (p) { if (p.tw < bt - 1e-6) { front.push(p); bt = p.tw; } });
      if (front.length > 24) { var keep = []; for (var k = 0; k < 24; k++) keep.push(front[Math.round(k * (front.length - 1) / 23)]); front = keep; }
      if (!front.some(function (p) { return p.key === best.key; })) {   // 綜合最佳（含外包成本）不一定在兩軸前緣上，也放進來
        front.push({ mf: best.mf / best.n, tw: best.tw / best.n, ot: best.ot / best.n, cost: best.oc / best.n, f: best.mean, X: best.X, key: best.key });
      }
      return front.map(function (p) { p.best = p.key === best.key; return p; });
    }
  }
  // 風險：加工時間有 ±cv 誤差時，每張單的完工時間範圍（P10／P50／P90）與準時機率
  function risk(M, X, base, cv, R) {
    R = Math.max(20, R || 40);
    var cs = [];
    for (var k = 0; k < R; k++) cs.push(simulate(M, X, Object.assign({}, base, { cv: cv, seed: 1000 + (500 + k) * 7919, collect: false })).C);
    return M.orders.map(function (od, i) {
      var arr = cs.map(function (c) { return c[i]; }).sort(function (a, b) { return a - b; });
      var ok = od.due == null ? R : arr.filter(function (c) { return c <= od.due + 1e-6; }).length;
      return { p10: arr[Math.floor(R * 0.1)], p50: arr[Math.floor(R * 0.5)], p90: arr[Math.min(R - 1, Math.floor(R * 0.9))], onTimeProb: ok / R };
    });
  }
  function orderByFirstStart(M, res) {          // 從某次模擬的開工順序，反推訂單優先順序
    var first = new Float64Array(M.n).fill(Infinity);
    (res.ops || []).forEach(function (op) { if (op.start < first[op.o]) first[op.o] = op.start; });
    return bySeq(M, function (i) { return first[i] === Infinity ? 1e15 : first[i]; });
  }
  // NEH 式建構：依交期排序後，一張張插入到目前最好的位置（Nawaz et al. 1983；Pan & Ruiz 2013）
  function nehX(M, start, feval, simBase) {
    var orderList = Array.from(start.seq), seq = [], X = cloneX(start), act = new Uint8Array(M.n);
    orderList.forEach(function (o) {
      act[o] = 1;
      var bestV = Infinity, bestSeq = null;
      for (var pos = 0; pos <= seq.length; pos++) {
        var cand = seq.slice(); cand.splice(pos, 0, o);
        var full = cand.concat(orderList.filter(function (x) { return cand.indexOf(x) < 0; }));
        X.seq = Int32Array.from(full);
        var v = feval(simulate(M, X, Object.assign({}, simBase, { active: act })), X);
        if (v < bestV) { bestV = v; bestSeq = cand; }
      }
      seq = bestSeq;
    });
    X.seq = Int32Array.from(seq);
    return X;
  }
  function summarize(res) {
    return { meanF: res.meanF, maxF: res.maxF, makespan: res.makespan, twt: res.twt, tardy: res.tardy, onTimeRate: res.onTimeRate, cost: res.cost, outFrac: res.outFrac, setups: res.setups };
  }

  // ===========================================================================
  // 分析：瓶頸、等待最久的站、延遲原因（白話說明用）
  // ===========================================================================
  function analyze(M, res, from) {
    var t0 = from != null ? from : res.ops.length ? Math.min.apply(null, res.ops.map(function (o) { return o.start; })) : 0;
    var horizon = Math.max(1, res.makespan - t0);
    function busyAfter(u) {                      // 從 t0 起算的忙碌時間
      var b = 0; res.ops.forEach(function (op) { if (op.unit === u) b += Math.max(0, op.end - Math.max(op.start, t0)); }); return b;
    }
    var unitBusy = []; for (var u = 0; u < M.nUnits; u++) unitBusy.push(from != null ? busyAfter(u) : res.busy[u]);
    var stageWait = M.stages.map(function () { return 0; });
    res.info.forEach(function (x) { stageWait[x.s] += Math.max(0, (x.start != null ? x.start : x.ready) - x.ready); });
    var stageUtil = M.stages.map(function (st, s) {
      var units = 0, b = 0;
      st.types.forEach(function (ti) { var T = M.types[ti]; for (var k = 0; k < T.count; k++) { b += unitBusy[T.base + k]; units++; } });
      return { stage: s, name: st.name, util: units ? b / (units * horizon) : 0, wait: stageWait[s] / Math.max(1, M.n), units: units };
    });
    var unitUtil = [];
    M.types.forEach(function (T, ti) { for (var k = 0; k < T.count; k++) unitUtil.push({ unit: T.base + k, type: ti, name: T.name + (T.count > 1 ? " #" + (k + 1) : ""), stage: T.stage, util: unitBusy[T.base + k] / horizon }); });
    var bott = stageUtil.filter(function (x) { return x.units; }).sort(function (a, b) { return b.util - a.util; })[0] || null;
    var orders = M.orders.map(function (od, i) {
      var waits = res.info.filter(function (x) { return x.o === i; }).map(function (x) { return { s: x.s, wait: Math.max(0, (x.start != null ? x.start : x.ready) - x.ready) }; });
      var w = waits.sort(function (a, b) { return b.wait - a.wait; })[0];
      return { i: i, C: res.C[i], late: od.due != null ? res.C[i] - od.due : null, waitStage: w && w.wait > 0 ? w.s : null, wait: w ? w.wait : 0 };
    });
    return { stageUtil: stageUtil, unitUtil: unitUtil, bottleneck: bott, orders: orders, horizon: horizon, from: t0 };
  }

  // ===========================================================================
  // 事件驅動重排程：目前時間 now 之前已開工的工序凍結，其餘依新狀況重排
  //   freezeAt → 以「訂單編號」記錄（訂單可增減後仍對得上）；bindLock → 轉回新模型的索引
  // ===========================================================================
  function planGenes(M, X) {                     // 方案的「機型＋拆批」以編號表示（存檔、比較變動用）
    var out = {};
    M.orders.forEach(function (od, i) {
      var g = { split: od.splits[X.split[i]], asg: [] };
      for (var s = 0; s < M.S; s++) { var t = od.optType[s][X.asg[i * M.S + s]]; g.asg.push(t === OUT ? "out" : t === SKIP || t == null ? null : M.types[t].id); }
      out[od.id] = g;
    });
    return out;
  }
  function refIndex(M, ref) {                    // planGenes → 這個模型的選項序號
    var tIdx = {}; M.types.forEach(function (t, k) { tIdx[t.id] = k; });
    return M.orders.map(function (od) {
      var g = ref[od.id]; if (!g) return null;
      var a = [];
      for (var s = 0; s < M.S; s++) { var v = g.asg[s]; a.push(v == null ? (od.optType[s][0] === SKIP ? 0 : -1) : od.optType[s].indexOf(v === "out" ? OUT : tIdx[v])); }
      return { split: od.splits.indexOf(g.split), asg: a };
    });
  }
  function freezeAt(M, X, res, now) {
    var fixed = {}, genes = {};
    (res.ops || []).forEach(function (op) {
      if (op.start >= now - 1e-9) return;
      var od = M.orders[op.o];
      fixed[od.id + "|" + op.s + "|" + op.a] = { type: op.type, unit: op.unit, start: op.start, end: op.end, setup: op.setup, kind: op.kind, streams: op.streams || null, paused: op.paused || null, prod: M.prodIds[od.product] };
      var g = genes[od.id] || (genes[od.id] = { split: od.splits[X.split[op.o]], asg: [] });
      g.asg[op.s] = op.type === -1 ? "out" : M.types[op.type].id;
    });
    Object.keys(genes).forEach(function (id) { var g = genes[id]; for (var s = 0; s < M.S; s++) if (g.asg[s] === undefined) g.asg[s] = null; });
    return { now: now, sig: M.sig, fixed: fixed, genes: genes };
  }
  // 機台故障（now 壞、until 修好）：正在這台做的工序——
  //   整批流動：已送出的子批不受影響，剩下的修好後接著做（結束時間延後）
  //   子批／併批：中斷、改排（可換到同型的其他機台，或等修好）
  function breakdown(L, unit, now, until) {
    var out = Object.assign({}, L, { fixed: {} }), dropped = [], shifted = [], d = Math.max(0, until - now);
    Object.keys(L.fixed).forEach(function (k) {
      var f = L.fixed[k];
      if (f.unit !== unit || f.end <= now + 1e-9) { out.fixed[k] = f; return; }
      if (f.kind === "whole") {
        out.fixed[k] = Object.assign({}, f, { end: f.end + d, paused: [now, until],
          streams: f.streams ? f.streams.map(function (t) { return t > now + 1e-9 ? t + d : t; }) : null });
        shifted.push(k);
      } else dropped.push(k);
    });
    return { lock: out, dropped: dropped, shifted: shifted };
  }
  function bindLock(M, L) {
    if (!L) return null;
    if (L.sig !== M.sig) throw new SchedError("工廠設定（站別或機台數）已經改過，無法接續進行中的排程；請先「重新排程（從頭）」。");
    var idx = {}, pIdx = {}, tIdx = {};
    M.orders.forEach(function (od, i) { idx[od.id] = i; });
    M.prodIds.forEach(function (p, k) { pIdx[p] = k; });
    M.types.forEach(function (t, k) { tIdx[t.id] = k; });
    var fixed = {}, genes = new Array(M.n), init = { free: new Float64Array(M.nUnits), last: new Int32Array(M.nUnits).fill(-1) }, lastEnd = new Float64Array(M.nUnits).fill(-Infinity);
    Object.keys(L.fixed).forEach(function (k) {
      var f = L.fixed[k], p = k.split("|"), a = p.pop(), s = p.pop(), id = p.join("|"), i = idx[id];
      if (f.unit >= 0 && f.end >= lastEnd[f.unit] && pIdx[f.prod] != null) { lastEnd[f.unit] = f.end; init.last[f.unit] = pIdx[f.prod]; }
      if (i == null) return;                     // 訂單已取消：工序不再接續，機台立刻可用
      fixed[i + "|" + s + "|" + a] = f;
      if (f.unit >= 0 && f.end > init.free[f.unit]) init.free[f.unit] = f.end;
    });
    Object.keys(L.genes).forEach(function (id) {
      var i = idx[id]; if (i == null) return;
      var od = M.orders[i], g = L.genes[id], sp = od.splits.indexOf(g.split), a = [];
      for (var s = 0; s < M.S; s++) {
        var v = g.asg[s], k2 = null;
        if (v != null) { var kk = od.optType[s].indexOf(v === "out" ? OUT : tIdx[v]); if (kk >= 0) k2 = kk; }
        a.push(k2);
      }
      genes[i] = { split: sp >= 0 ? sp : null, asg: a };
    });
    return { now: L.now, fixed: fixed, init: init, genes: genes };
  }

  var api = {
    SKIP: SKIP, OUT: OUT, AUTO: AUTO, SchedError: SchedError,
    calendar: calendar, compile: compile, simulate: simulate, optimize: optimize, analyze: analyze, risk: risk, lockSim: lockSim,
    freezeAt: freezeAt, bindLock: bindLock, breakdown: breakdown, planGenes: planGenes, refIndex: refIndex,
    practicalX: practicalX, eddX: eddX, blankX: blankX, cloneX: cloneX, keyX: keyX, summarize: summarize, makeEval: makeEval,
    ocbaAlloc: ocbaAlloc, apcs: apcs, rngOf: rngOf
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SchedEngine = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
