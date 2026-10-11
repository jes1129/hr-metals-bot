/*
 * sched-worker.js — 排程最佳化在背景執行緒跑（畫面不會卡）
 *   收：{ id, cfg, orders, opts:{weights, cv, timeLimit, seed, down, lock(以編號表示), ref(planGenes), breakdown:{unit, now, until}} }
 *   回：{ id, type:"progress", p } … { id, type:"done", out } 或 { id, type:"error", message }
 */
/* global importScripts, SchedEngine */
importScripts("sched-engine.js" + (self.location.search || ""));   // 版本參數跟著 worker 網址，避免舊快取

self.onmessage = function (ev) {
  var d = ev.data || {}, E = SchedEngine;
  try {
    var o = d.opts || {};
    var M = E.compile(d.cfg, d.orders, { noOut: !!o.noOut });
    var L = o.lock || null;
    if (L && o.breakdown) L = E.breakdown(L, o.breakdown.unit, o.breakdown.now, o.breakdown.until).lock;
    var lock = L ? E.bindLock(M, L) : o.now ? { now: o.now, fixed: null, init: null, genes: [] } : null;
    var last = 0;
    var out = E.optimize(M, {
      weights: o.weights, cv: o.cv, timeLimit: o.timeLimit, seed: o.seed, down: o.down, lock: lock, ref: o.ref || null,
      stall: o.stall, restarts: o.restarts, pop: o.pop,
      onProgress: function (p) {
        var t = Date.now();
        if (t - last < 120 && p.gen > 0) return;   // 每秒最多回報約 8 次
        last = t;
        self.postMessage({ id: d.id, type: "progress", p: p });
      }
    });
    out.lockUsed = L;
    self.postMessage({ id: d.id, type: "done", out: out });
  } catch (e) {
    self.postMessage({ id: d.id, type: "error", message: e && e.message ? e.message : String(e) });
  }
};
