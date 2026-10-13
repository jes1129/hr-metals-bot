/*
 * sched.js — 生產排程頁（schedule.html）
 *   排程看板：一鍵最佳化、甘特圖、重點白話說明、方法比較、取捨圖、各站忙碌程度
 *   臨時狀況：插單、急單、外包、機台故障／保養、取消、改交期／數量 → 已開工的不動，其餘重排，前後對照再決定要不要採用
 *   訂單、工廠設定（站別、機型、產品途程、工作日曆）、方法說明（含論文數值驗證）
 * 計算交給 sched-worker.js（背景執行緒）；資料登入後存公司試算表「sched」分頁，未登入存本機瀏覽器。
 */
(function () {
  "use strict";
  var E = window.SchedEngine, D = window.SchedData, K = window.SchedKri;
  var mount = document.getElementById("schedView");
  if (!mount || !E || !D || !K) return;

  var KEY = "sched_state_v1", VER = (document.currentScript && /v=([\w.-]+)/.exec(document.currentScript.src) || [])[1] || "";
  var WD = "日一二三四五六";
  var PRESET = {
    eff: { label: "效率優先", hint: "訂單越快做完越好（平均生產週期最短），準時是其次", w: { flow: 1, tardy: 0.3, late: 0 } },
    bal: { label: "兩者兼顧", hint: "週期短、又盡量準時（建議）", w: { flow: 1, tardy: 1, late: 1.5 } },
    due: { label: "準時優先", hint: "先想辦法讓每張單都準時，其次才求快", w: { flow: 0.15, tardy: 1, late: 8 } }
  };
  var OUTS = {
    no: { label: "不主動外包", hint: "只有你自己指定的單才外包", w: 0 },
    need: { label: "必要時外包", hint: "外包能明顯救到交期或縮短週期才建議（建議）", w: 6 },
    free: { label: "積極外包", hint: "只要外包比較快就建議外包（外包費較高）", w: 1 }
  };
  var SPEED = { fast: { label: "快速", sec: 3, stall: 40, restarts: 5 }, std: { label: "標準", sec: 10, stall: 40, restarts: 15 }, deep: { label: "深入", sec: 30, stall: 50, restarts: 40 } };
  var MODE = { whole: "整批流動", parallel: "拆批平行", batch: "併批" };
  var MODE_HINT = {
    whole: "一張單在一台機台上連續做完，每做好一個子批就先送下一站（例：下料、黏晶）",
    parallel: "把一張單拆成子批，分給多台同型機台同時做（例：CNC、銲線、品檢）",
    batch: "把子批湊成一批一起做，批量有上限（例：陽極、電鍍、熱處理、封膠）"
  };
  var NOISE = 0.15, RISK = 0.1;

  var S = ensureState(load() || fresh());
  var V = { tab: tabFromHash() || "board", preset: S.preset || "bal", out: S.out || "need", speed: "std", noise: !!S.noise, hl: null, zoom: window.innerWidth < 640 ? 4 : 1, show: "new", busy: null };
  var cur = null, pending = null, worker = null, runId = 0;

  // ===========================================================================
  // 小工具
  // ===========================================================================
  function ic(n) { return '<svg class="ic" aria-hidden="true"><use href="assets/icons.svg#' + n + '"/></svg>'; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function pad(n) { return ("0" + n).slice(-2); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function money(n) { return "NT$ " + Math.round(n).toLocaleString(); }
  function pct(x) { return Math.round(x * 100) + "%"; }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function bridge() { return window.__erpBridge || null; }
  function authed() { var b = bridge(); return !!(b && b.authed()); }
  function tabFromHash() { var m = /tab=(\w+)/.exec(location.hash); return m ? m[1] : null; }
  function uid(p) { return p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 36).toString(36); }

  function fresh() {
    var cfg = D.defaultConfig(); cfg.calendar.start = today();
    return { v: 1, cfg: cfg, orders: D.demoOrders(E.calendar(cfg.calendar)), plan: null, down: [], log: [], demo: true, preset: "bal" };
  }
  function ensureState(s) {                            // 風險監控需要的欄位（舊資料也補齊）
    s.act = s.act || {}; s.pred = s.pred || {}; s.tol = s.tol || {}; s.events = s.events || []; s.versions = s.versions || [];
    s.cfgLog = s.cfgLog || []; s.lastLv = s.lastLv || {}; s.hist = s.hist || [];
    s.notify = Object.assign({ enabled: true, boss: "", owners: {}, escalateMin: 30, repeatHours: 24 }, s.notify || {}); s.grace = s.grace != null ? s.grace : 120;
    if (s.cfgPrev == null) s.cfgPrev = JSON.stringify(s.cfg);
    return s;
  }
  function who() { var b = bridge(), u = b && b.user && b.user(); return u ? (u.email || u.name || "已登入") : "本機使用者"; }
  function load() {
    var s = lsGet(KEY);
    return s && s.v === 1 && s.cfg && s.orders ? s : null;
  }
  var saveT = null, chain = Promise.resolve(), wasAuthed = false;
  function save(cloud) {
    S.preset = V.preset; S.noise = V.noise; S.out = V.out;
    lsSet(KEY, S);
    if (cloud !== false && authed()) { clearTimeout(saveT); saveT = setTimeout(cloudSave, 800); }
  }
  // 試算表一格最多 5 萬字：大的資料切成 3 萬字一段（cfg.0、orders.0、plan.0、plan.1…），前面加「~」避免被當成數字
  function strRows(name, str) {
    var rows = [], k = 0;
    for (var i = 0; i < str.length; i += 30000) rows.push({ id: name + "." + k++, data: "~" + str.slice(i, i + 30000) });
    return rows;
  }
  function blobRows(name, obj) { return strRows(name, obj == null ? "" : JSON.stringify(obj)); }
  function blobGet(name, rows) {
    var parts = rows.filter(function (r) { return /^\w+\.\d+$/.test(r.id) && r.id.split(".")[0] === name; })
      .sort(function (a, b) { return +a.id.split(".")[1] - +b.id.split(".")[1]; });
    if (!parts.length) return null;
    try { return JSON.parse(parts.map(function (r) { return r.data; }).join("")); } catch (e) { return null; }
  }
  function putRows(b, rows, table) {                        // 一次寫入；舊版後端沒有 tImport 就一筆一筆存
    return b.call("tImport", { table: table || "sched", rows: rows, header: ["id", "data"] }).then(function (d) {
      if (!(d && d.error && /unknown/i.test(String(d.error)))) return d;
      return rows.reduce(function (pr, r) {
        return pr.then(function (ok) { return b.call("tUpsert", { table: table || "sched", row: r, header: ["id", "data"] }).then(function (x) { return ok && !!x && !x.error; }); });
      }, Promise.resolve(true)).then(function (ok) { return ok ? { ok: true } : { error: "tUpsert failed" }; });
    });
  }
  function syncVers(b) {                              // 離線時採用的版本，登入後補傳排程內容（回復用）
    var loc = verLocal(); S.verSaved = S.verSaved || {};
    S.versions.forEach(function (m) {
      if (S.verSaved[m.id] || !loc[m.id]) return;
      S.verSaved[m.id] = 1; putRows(b, strRows(m.id, loc[m.id]), "sched_ver");
    });
  }
  function publishNotify() {                          // 自動通知的設定（Apps Script 每 30 分鐘讀這張小表）
    var b = bridge(); if (!b || !b.authed()) return;
    b.call("tUpsert", { table: "sched_cfg", row: { id: "notify", data: JSON.stringify(S.notify) }, header: ["id", "data"] });
  }
  function cloudSave() {
    var b = bridge(); if (!b || !b.authed()) return;
    var rows = blobRows("cfg", S.cfg)
      .concat(blobRows("orders", { orders: S.orders, down: S.down, log: S.log.slice(0, 40), preset: S.preset, noise: S.noise, out: S.out }))
      .concat(blobRows("plan", S.plan))
      .concat(blobRows("act", { act: S.act, pred: S.pred }))
      .concat(blobRows("meta", { tol: S.tol, grace: S.grace, events: S.events.slice(0, 80), versions: S.versions, cfgLog: S.cfgLog, lastLv: S.lastLv, notify: S.notify }));
    var ids = rows.map(function (r) { return r.id; }), stale = (S.cloudIds || []).filter(function (id) { return ids.indexOf(id) < 0; });
    chain = chain.then(function () { return putRows(b, rows); }).then(function (d) {
      if (!d || d.error) { toast("存到公司試算表失敗（資料還在這台電腦裡），改動後會再試一次。", true); return; }
      S.cloud = true; S.cloudIds = ids; lsSet(KEY, S); paintMode(); syncVers(b); publishNotify();
      return stale.reduce(function (pr, id) { return pr.then(function () { return b.call("tRemove", { table: "sched", id: id }); }); }, Promise.resolve());
    });
  }
  function cloudLoad() {
    var b = bridge(); if (!b || !b.authed()) return;
    b.call("tList", { table: "sched" }).then(function (d) {
      if (!d || d.error || !d.rows) { paintMode(); return; }
      var rows = d.rows.map(function (r) { return { id: String(r.id), data: String(r.data == null ? "" : r.data).replace(/^~/, "") }; });
      var cfg = blobGet("cfg", rows), od = blobGet("orders", rows), ids = rows.map(function (r) { return r.id; });
      if (!cfg || !od) { S.cloudIds = ids; if (!S.demo) save(); paintMode(); return; }   // 公司端還沒有資料：有真資料才把這台電腦的存上去
      if (!S.cloud && !S.demo && !confirm("公司試算表裡已經有排程資料。\n\n按「確定」＝改用公司的資料；按「取消」＝保留這台電腦的，並覆蓋公司的。")) { S.cloudIds = ids; save(); paintMode(); return; }
      S.cfg = cfg; S.orders = od.orders || []; S.down = od.down || []; S.log = od.log || [];
      if (od.preset) V.preset = od.preset;
      if (od.out) V.out = od.out;
      V.noise = !!od.noise;
      S.plan = blobGet("plan", rows); S.demo = false; S.cloud = true; S.cloudIds = ids;
      var ac = blobGet("act", rows), me = blobGet("meta", rows);
      S.act = ac && ac.act || {}; S.pred = ac && ac.pred || {};
      S.tol = me && me.tol || {}; S.grace = me && me.grace != null ? me.grace : 120; S.events = me && me.events || []; S.versions = me && me.versions || [];
      S.cfgLog = me && me.cfgLog || []; S.lastLv = me && me.lastLv || {}; S.cfgPrev = JSON.stringify(S.cfg);
      S.notify = Object.assign({ enabled: true, boss: "", owners: {}, escalateMin: 30, repeatHours: 24 }, me && me.notify || {});
      loadHist(b);
      S.verSaved = {}; S.versions.forEach(function (m) { S.verSaved[m.id] = 1; });         // 公司端的版本清單裡的，視為排程內容都在 sched_ver
      lsSet(KEY, S); pending = null; V.lastOut = null; V.lastOutPlan = null; rebuild(); render(); syncErp(true);
    });
  }
  window.__refreshSched = function () {            // 登入狀態改變時（app.js 會呼叫）
    var a = authed(); paintMode();
    if (a && !wasAuthed) { wasAuthed = true; kriLast = ""; cloudLoad(); setTimeout(function () { if (cur && cur.M) kriTick(); }, 2500); } else if (!a) wasAuthed = false;
  };

  // ===========================================================================
  // 計劃 ↔ 計算用結構
  // ===========================================================================
  function planCfg(start) { var c = clone(S.cfg); c.calendar = Object.assign({}, c.calendar || {}, { start: start || (S.plan && S.plan.start) || today() }); return c; }
  function downMap(M, list) {                       // S.down：{type, k(第幾台), from, to(毫秒時間戳), note}
    var m = null, cal = M.cal;
    (list || []).forEach(function (w) {
      var T = M.types.filter(function (t) { return t.id === w.type; })[0];
      if (!T || w.k >= T.count) return;
      var a = cal.fromDate(w.from), b = cal.fromDate(w.to);
      if (!(b > a)) return;
      m = m || {}; (m[T.base + w.k] = m[T.base + w.k] || []).push([a, b]);
    });
    return m;
  }
  function bigSplit(od) { var b = 0; for (var k = 1; k < od.splits.length; k++) if (od.splits[k] > od.splits[b]) b = k; return b; }
  function xFromPlan(M, plan) {
    var X = E.blankX(M), pos = {};
    (plan.seq || []).forEach(function (id, k) { pos[id] = k; });
    var idx = M.orders.map(function (_, i) { return i; });
    idx.sort(function (a, b) {
      var pa = pos[M.orders[a].id], pb = pos[M.orders[b].id];
      return (pa == null ? 1e9 + a : pa) - (pb == null ? 1e9 + b : pb);
    });
    X.seq = Int32Array.from(idx);
    var ref = E.refIndex(M, plan.genes || {});
    M.orders.forEach(function (od, i) {
      var g = ref[i];
      X.split[i] = g && g.split >= 0 ? g.split : bigSplit(od);
      for (var s = 0; s < M.S; s++) {
        var v = g ? g.asg[s] : -1;
        X.asg[i * M.S + s] = v >= 0 ? v : od.optType[s][0] === E.SKIP ? 0 : E.AUTO;
      }
    });
    return X;
  }
  function lockFor(M, L, now0) {
    if (L) { try { return { lock: E.bindLock(M, L), ok: true }; } catch (e) { return { lock: { now: now0 || 0 }, ok: false, err: e.message }; } }
    return { lock: now0 ? { now: now0 } : null, ok: true };
  }
  // 依目前的設定與訂單，重建「目前採用的排程」的畫面資料
  function rebuild() {
    cur = null;
    if (!S.plan) { V.kri = null; return; }
    try {
      var cfg = planCfg(S.plan.start), M = E.compile(cfg, S.orders);
      var X = xFromPlan(M, S.plan), down = downMap(M, S.down);
      var sf = simFull(M, X, S.plan.lock, S.plan.now0, down), res = sf.res, base = sf.base, lk = sf.lk;
      var known = {}; (S.plan.seq || []).forEach(function (id) { known[id] = 1; });
      cur = { M: M, X: X, res: res, an: E.analyze(M, res), base: base, lockOk: lk.ok, lockErr: lk.err, plan: S.plan, down: down,
        fresh: M.orders.filter(function (od) { return !known[od.id]; }).map(function (od) { return od.id; }),
        gone: (S.plan.seq || []).filter(function (id) { return !M.orders.some(function (od) { return od.id === id; }); }),
        cfgChanged: !!(S.plan.cfgSig && S.plan.cfgSig !== hash(JSON.stringify(S.cfg))),
        risk: E.risk(M, X, base, S.plan.noise ? NOISE : RISK, M.n > 120 ? 20 : 40) };
      kriTick();
    } catch (e) { cur = { error: e.message }; V.kri = null; }
  }
  function planRecord(M, X, out, extra) {
    return Object.assign({
      v: 1, start: M.cal.start, at: Date.now(), preset: V.preset, noise: V.noise,
      seq: Array.from(X.seq).map(function (i) { return M.orders[i].id; }), genes: E.planGenes(M, X),
      lock: out && out.lockUsed || null, now0: 0,
      cfgSig: hash(JSON.stringify(S.cfg)), baseF: out ? out.heur.practical.f : null,
      heur: out ? { practical: out.heur.practical.kpi, edd: out.heur.edd.kpi, atc: out.heur.atc.kpi } : null,
      stats: out ? { evals: out.evals, reps: out.reps, elapsed: out.elapsed, gens: out.history.length } : null,
      history: out ? thin(out.history, 160).map(function (h) { return [h.gen, +h.f.toFixed(4), Math.round(h.meanF), Math.round(h.twt)]; }) : [],
      pareto: out ? out.pareto.map(function (p) { return { mf: p.mf, tw: p.tw, ot: p.ot, cost: p.cost, best: p.best }; }) : []
    }, extra || {});
  }
  function hash(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function heurOf(P) {                               // 「現場做法／EDD／ATC」的成績（拿來跟最佳化比）
    if (P === pending && pending.out.heur) return { practical: pending.out.heur.practical.kpi, edd: pending.out.heur.edd.kpi, atc: pending.out.heur.atc.kpi };
    return cur && cur.plan && cur.plan.heur || null;
  }
  function thin(a, n) { if (a.length <= n) return a; var o = []; for (var k = 0; k < n; k++) o.push(a[Math.round(k * (a.length - 1) / (n - 1))]); return o; }

  // 現在時間（工作分鐘）
  function nowMin(cal) { return Math.max(0, cal.fromDate(Date.now())); }

  // ===========================================================================
  // 時間格式
  // ===========================================================================
  function calOf(M) { return M ? M.cal : E.calendar(planCfg().calendar); }
  function fmtDT(cal, m, asEnd) {
    var d = new Date(cal.toDate(m, asEnd));
    if (asEnd && d.getHours() === 0 && d.getMinutes() === 0) { var p = new Date(d.getTime() - 60000); return (p.getMonth() + 1) + "/" + p.getDate() + " (" + WD[p.getDay()] + ") 24:00"; }
    return (d.getMonth() + 1) + "/" + d.getDate() + " (" + WD[d.getDay()] + ") " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDur(cal, m) {
    m = Math.max(0, m || 0);
    if (m < 59.5) return Math.round(m) + " 分鐘";
    if (m < cal.per) return (m / 60).toFixed(1).replace(/\.0$/, "") + " 小時";
    return (m / cal.per).toFixed(1).replace(/\.0$/, "") + " 天";
  }
  function dayLabel(cal, k) { var d = new Date(cal.toDate(k * cal.per)); return (d.getMonth() + 1) + "/" + d.getDate() + " (" + WD[d.getDay()] + ")"; }
  function localInput(ts) { var d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function parseLocal(v) { var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(v || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null; }
  var CM = null;                                   // 本次畫面的「訂單 → 色號」對照（render／甘特圖重畫時清掉）
  function colorIndexMap() {
    var m = {}, mx = -1, lists = pending ? [S.orders, pending.orders] : [S.orders];
    lists.forEach(function (l) { l.forEach(function (o) { if (o.c != null && o.c > mx) mx = o.c; }); });
    lists.forEach(function (l) { l.forEach(function (o) { if (o.c == null) o.c = ++mx; m[o.id] = o.c; }); });
    return m;
  }
  function color(id) {
    if (!CM) CM = colorIndexMap();
    var k = CM[id];
    if (k == null) { k = 0; for (var j = 0; j < id.length; j++) k = (k * 31 + id.charCodeAt(j)) % 997; }
    var h = Math.round((k * 137.508 + 18) % 360);
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    return "hsl(" + h + "," + (dark ? 52 : 50) + "%," + (dark ? 58 : 45) + "%)";
  }

  // ===========================================================================
  // 最佳化（背景執行緒）
  // ===========================================================================
  function run(job, done) {
    var id = ++runId, t0 = Date.now(); V.lastSeed = job.opts.seed;
    V.busy = { id: id, label: job.label, gen: 0, elapsed: 0, limit: job.opts.timeLimit, best: null, base: null, pts: [] };
    paintBusy();
    function finish(out) { if (id !== runId) return; V.busy = null; done(out); }
    function fail(msg) { if (id !== runId) return; V.busy = null; render(); toast("排程失敗：" + msg, true); }
    var useWorker = typeof Worker !== "undefined";
    if (useWorker) {
      try {
        if (worker) worker.terminate();
        worker = new Worker("assets/sched-worker.js" + (VER ? "?v=" + VER : ""));
      } catch (e) { useWorker = false; }
    }
    if (useWorker) {
      worker.onmessage = function (ev) {
        var d = ev.data; if (!d || d.id !== id) return;
        if (d.type === "progress") { var b = V.busy; if (!b) return; b.gen = d.p.gen; b.elapsed = d.p.elapsed; b.evals = d.p.evals; b.best = d.p.best; b.pts.push([d.p.elapsed, d.p.best.f]); paintBusy(); }
        else if (d.type === "done") finish(d.out);
        else fail(d.message);
      };
      worker.onerror = function (e) { fail(e.message || "背景計算失敗"); };
      worker.postMessage({ id: id, cfg: job.cfg, orders: job.orders, opts: job.opts });
    } else {
      setTimeout(function () {             // 舊瀏覽器：直接在這裡算（時間縮短）
        try {
          var o = job.opts, M = E.compile(job.cfg, job.orders, { noOut: !!o.noOut }), L = o.lock;
          if (L && o.breakdown) L = E.breakdown(L, o.breakdown.unit, o.breakdown.now, o.breakdown.until).lock;
          var out = E.optimize(M, Object.assign({}, o, { lock: L ? E.bindLock(M, L) : o.now ? { now: o.now } : null, timeLimit: Math.min(o.timeLimit, 4000) }));
          out.lockUsed = L; finish(out);
        } catch (e) { fail(e.message); }
      }, 30);
    }
    return Date.now() - t0;
  }
  function stopRun() { runId++; if (worker) { worker.terminate(); worker = null; } V.busy = null; render(); toast("已停止計算，排程沒有變更。"); }
  function opts(extra) {
    var sp = SPEED[V.speed];
    return Object.assign({ weights: Object.assign({}, PRESET[V.preset].w, { out: OUTS[V.out].w }), noOut: V.out === "no", cv: V.noise ? NOISE : 0,
      timeLimit: sp.sec * 1000, stall: sp.stall, restarts: sp.restarts, seed: (Date.now() % 100000) + 1 }, extra || {});
  }

  // 第一次排程／從頭排程：從「現在」開始排，不管之前的進度
  function planFresh() {
    var cfg = planCfg(today()), cal = E.calendar(cfg.calendar), now = nowMin(cal);
    if (S.demo) S.orders = D.demoOrders(cal);          // 範例訂單的日期跟著今天走
    var M;
    try { M = E.compile(cfg, S.orders); } catch (e) { toast(e.message, true); return; }
    if (!M.n) { toast("還沒有訂單：先到「訂單」新增，或載入範例。", true); return; }
    var dm = downMap(M, S.down), lockL = null, acts = actsList(M);
    if (acts.length) {                                  // 已回報完工的站照實際凍結，其餘從頭排
      var X0 = E.practicalX(M), r0 = E.simulate(M, X0, { collect: true, now: now });
      lockL = E.applyActuals(M, X0, r0, acts, { now: now, sig: M.sig, fixed: {}, genes: {} });
    }
    run({ label: "排程計算中", cfg: cfg, orders: S.orders, opts: opts({ now: now, down: dm, lock: lockL }) }, function (out) {
      if (cur && cur.M) {                               // 已經有排程：先給前後對照，採用時走風險檢查
        showPending({ desc: "重新排程（從頭）· " + PRESET[V.preset].label }, M, out, now, S.orders, S.down);
        return;
      }
      S.plan = planRecord(M, out.X, out, { now0: now, start: cfg.calendar.start });
      S.plan.lock = out.lockUsed || null; V.lastOut = out; V.lastOutPlan = S.plan;
      logAdd("第一次排程 · " + PRESET[V.preset].label + " · " + S.orders.length + " 張單");
      pending = null; save(); rebuild(); updatePred(cur.M, cur.res);
      recordVersion({ desc: "第一次排程", after: E.summarize(cur.res), items: null, ack: null });
      kriTick(); save(); V.tab = "board"; render(); syncErp(true);
      toast("排程完成：試了 " + out.evals.toLocaleString() + " 種排法（" + (out.elapsed / 1000).toFixed(1) + " 秒）");
    });
  }

  // 臨時狀況：已開工的不動、其餘重排，結果先給你看前後對照
  //   ch = { desc, orders, down, breakdown:{type,k,now,until}, at(工作分鐘) }
  function reschedule(ch) {
    if (!cur || !cur.M) { toast("請先按「開始排程」做出第一版排程。", true); return; }
    var M0 = cur.M, cal = M0.cal;
    var now = Math.max(ch.at != null ? ch.at : nowMin(cal), S.plan.now0 || 0);
    var L = E.freezeAt(M0, cur.X, cur.res, now);
    var orders = ch.orders || S.orders, down = ch.down || S.down, cfg = planCfg(S.plan.start);
    var M1;
    try { M1 = E.compile(cfg, orders); } catch (e) { toast(e.message, true); return; }
    if (L.sig !== M1.sig) { toast("工廠設定已改過，請改用「從頭排程」。", true); return; }
    var dm = downMap(M1, down), bd = null;
    if (ch.breakdown) {
      var T = M1.types.filter(function (t) { return t.id === ch.breakdown.type; })[0];
      if (T) bd = { unit: T.base + ch.breakdown.k, now: now, until: ch.breakdown.until };
    }
    var C0 = {}, genes0 = E.planGenes(M0, cur.X);
    M0.orders.forEach(function (od, i) { C0[od.id] = cur.res.C[i]; });
    var seedX = xFromPlan(M1, { seq: Array.from(cur.X.seq).map(function (i) { return M0.orders[i].id; }), genes: genes0 });   // 沿用原計畫、只把新狀況放進去
    var o = opts({ lock: L, ref: { genes: genes0, C: C0 }, extraSeeds: [seedX], down: dm, breakdown: bd });
    o.weights.stable = 0.5;
    run({ label: ch.desc, cfg: cfg, orders: orders, opts: o }, function (out) {
      showPending(ch, M1, out, now, orders, down);
    });
  }
  function showPending(ch, M1, out, now, orders, down) {
    var dm = downMap(M1, down), sf = simFull(M1, out.X, out.lockUsed, now, dm), res = sf.res, base = sf.base;
    pending = { ch: ch, M: M1, X: out.X, res: res, an: E.analyze(M1, res, now), out: out, now: now, orders: orders, down: down, base: base,
      risk: E.risk(M1, out.X, base, V.noise ? NOISE : RISK, M1.n > 120 ? 20 : 40) };
    V.show = "new"; V.tab = "board"; V.hl = null; render();
    var el = document.getElementById("cmpBox"); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function adopt() { adoptGate(); }
  function discard() { pending = null; render(); toast("已放棄，維持原排程。"); }
  var SHIFT = 30;                                   // 完工時間挪動超過 30 分鐘才算「有變」
  function diffStats(P0, P1) {
    var idx0 = {}, n = 0, moved = 0, sh = 0;
    P0.M.orders.forEach(function (od, i) { idx0[od.id] = i; });
    P1.M.orders.forEach(function (od, i) {
      var j = idx0[od.id]; if (j == null) return;
      var d = Math.abs(P1.res.C[i] - convP(P0, P1, P0.res.C[j])); n++; sh += d; if (d > SHIFT) moved++;
    });
    return { n: n, moved: moved, avg: n ? sh / n : 0 };
  }
  function convP(P0, P1, m) { return P0.M.cal.start === P1.M.cal.start ? m : P1.M.cal.fromDate(P0.M.cal.toDate(m, true)); }   // 舊排程的時間換成新排程日曆的工作分鐘
  function logAdd(text) { S.log.unshift({ ts: Date.now(), by: who(), text: text }); S.log = S.log.slice(0, 60); }

  // ===========================================================================
  // 畫面
  // ===========================================================================
  var TABS = [["board", "排程看板", "gantt"], ["report", "進度回報", "check"], ["dash", "風險儀表板", "bars"], ["risk", "門檻設定", "shield"], ["audit", "採用紀錄", "list"], ["orders", "訂單", "clipboard"], ["factory", "工廠設定", "factory"], ["method", "方法說明", "book"]];
  function render() {
    CM = null;
    if (!TABS.some(function (t) { return t[0] === V.tab; })) V.tab = "board";
    var h = '<div id="schedMode"></div>'
      + '<div class="dbtabs erp-tabs">' + TABS.map(function (t) { return '<button class="dbtab' + (V.tab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '">' + ic(t[2]) + t[1] + "</button>"; }).join("") + "</div>"
      + '<div id="schedAlert"></div><div id="schedBusy"></div><div id="schedBody"></div>';
    mount.innerHTML = h;
    paintMode(); paintBusy(); paintAlert();
    var body = document.getElementById("schedBody");
    if (V.tab === "board") body.innerHTML = board();
    else if (V.tab === "report") body.innerHTML = reportTab();
    else if (V.tab === "dash") { body.innerHTML = dashTab(); if (authed() && Date.now() - (V.ntAt || 0) > 60000 && window.__noticePull) { V.ntAt = Date.now(); window.__noticePull(function () { if (V.tab === "dash") render(); }); } }
    else if (V.tab === "risk") body.innerHTML = riskTab();
    else if (V.tab === "audit") body.innerHTML = auditTab();
    else if (V.tab === "orders") body.innerHTML = ordersTab();
    else if (V.tab === "factory") body.innerHTML = factoryTab();
    else body.innerHTML = methodTab();
    if (V.tab === "board") afterBoard();
    if (V.tab === "method") afterMethod();
  }
  function paintMode() {
    var el = document.getElementById("schedMode"); if (!el) return;
    var cloud = authed();
    el.innerHTML = '<div class="erp-mode ' + (cloud ? "cloud" : "local") + '">' + ic(cloud ? "db" : "lock")
      + (cloud ? "公司共用：排程設定、訂單與採用的排程存在公司試算表「sched」分頁，同事登入看到的一樣。"
        : "本機試用：資料只存在這台電腦的瀏覽器；登入後會改用公司試算表。") + (S.demo ? " 目前是<b>範例資料</b>，可到「訂單」改成真的。" : "") + "</div>";
  }
  function paintBusy() {
    var el = document.getElementById("schedBusy"); if (!el) return;
    var b = V.busy;
    if (!b) { el.innerHTML = ""; return; }
    var p = Math.min(100, b.limit ? b.elapsed / b.limit * 100 : 0);
    el.innerHTML = '<div class="sc-busy"><div class="sc-busy-top"><b>' + ic("refresh") + esc(b.label) + "…</b>"
      + '<span>已試 ' + (b.evals || 0).toLocaleString() + " 種排法 · 第 " + (b.gen + 1) + " 代 · " + (b.elapsed / 1000).toFixed(1) + " 秒</span>"
      + '<button class="dbbtn" data-act="stop">' + ic("x") + "停止</button></div>"
      + '<div class="sc-prog"><i style="width:' + p.toFixed(1) + '%"></i></div>'
      + (b.best ? '<div class="sc-busy-sub">目前最好：平均週期 ' + fmtDur(calOf(), b.best.meanF) + "、準時率 " + pct(b.best.onTime) + "</div>" : "")
      + "</div>";
  }

  // ---------------------------------------------------------------------------
  // 排程看板
  // ---------------------------------------------------------------------------
  function controls() {
    var seg = function (name, map, val) {
      return '<div class="btnbar sc-seg" data-seg="' + name + '">' + Object.keys(map).map(function (k) {
        return '<button type="button" class="' + (val === k ? "on" : "") + '" data-v="' + k + '" title="' + esc(map[k].hint || (map[k].sec ? "最多算 " + map[k].sec + " 秒（結果穩定了會提早結束）" : "")) + '">' + esc(map[k].label) + "</button>";
      }).join("") + "</div>";
    };
    var has = !!(cur && cur.M);
    return '<div class="erp-sec sc-ctl"><div class="sc-ctl-row">'
      + '<div class="sc-ctl-item"><span>排程目標</span>' + seg("preset", PRESET, V.preset) + "</div>"
      + '<div class="sc-ctl-item"><span>外包</span>' + seg("outs", OUTS, V.out) + "</div>"
      + '<div class="sc-ctl-item"><span>計算時間</span>' + seg("speed", SPEED, V.speed) + "</div>"
      + '<label class="sc-check" title="加工時間每次不一樣（±' + Math.round(NOISE * 100) + '%）：用模擬多跑幾次＋OCBA 挑出穩的排法"><input type="checkbox" data-act="noise"' + (V.noise ? " checked" : "") + '>考慮加工時間誤差</label>'
      + '<div class="sc-ctl-go">'
      + (has ? '<button class="dbbtn" data-act="fresh" title="不管目前進度，從現在起全部重排">' + ic("refresh") + "從頭排程</button>"
        + '<button class="dbbtn primary" data-act="reopt" title="已開工的不動，其餘重新最佳化">' + ic("play") + "重新最佳化</button>"
        : '<button class="dbbtn primary" data-act="fresh">' + ic("play") + "開始排程</button>")
      + "</div></div>"
      + '<div class="sc-ctl-hint">' + esc(PRESET[V.preset].hint) + "。系統會比較「現場經驗做法」、EDD、ATC 和數千種排法，挑最好的。</div></div>";
  }
  function board() {
    var h = controls();
    if (cur && cur.error) return h + '<div class="erp-sec"><b class="erp-bad">' + ic("alert") + "目前的排程無法顯示：</b>" + esc(cur.error) + '<div class="erp-muted">通常是工廠設定或訂單的產品改過了；按「從頭排程」重新算一次即可。</div></div>';
    if (!cur) return h + emptyBoard();
    h += whatifBar();
    if (pending) h += compareBox();
    var P = pending && V.show === "new" ? pending : cur;
    h += warnings();
    h += kpis(P);
    h += insights(P);
    h += '<div class="erp-sec sc-gsec"><div class="erp-sechead"><h3>' + ic("gantt") + "甘特圖" + (pending ? (V.show === "new" ? "（新排程）" : "（原排程）") : "") + "</h3>"
      + '<div class="erp-row">' + (pending ? '<div class="btnbar sc-seg" data-seg="show"><button class="' + (V.show === "old" ? "on" : "") + '" data-v="old">原排程</button><button class="' + (V.show === "new" ? "on" : "") + '" data-v="new">新排程</button></div>' : "")
      + '<div class="btnbar sc-seg" data-seg="zoom">' + [1, 2, 4, 8].map(function (z) { return '<button class="' + (V.zoom === z ? "on" : "") + '" data-v="' + z + '">' + (z === 1 ? "全部" : "×" + z) + "</button>"; }).join("") + "</div></div></div>"
      + '<div id="hlCard"></div><div id="gantt" class="sc-gantt"></div>'
      + '<div class="sc-legend"><span><i class="lg-setup"></i>換線整備</span><span><i class="lg-frozen"></i>已開工（重排時不動）</span><span><i class="lg-down"></i>停機／故障</span><span><i class="lg-now"></i>現在</span><span>點色塊可看整張單的路線；時間軸只畫上班時間</span></div></div>';
    h += ordersTable(P);
    h += '<div class="erp-grid2">' + utilBox(P) + methodsBox(P) + "</div>";
    h += '<div class="erp-grid2">' + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("chart") + "搜尋過程</h3></div>" + '<div id="convChart" class="sc-chart"></div><div class="erp-muted">每一代保留最好的一半（菁英），其餘交配、突變產生新排法；分數越低越好。虛線＝現場經驗做法。</div></div>'
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("target") + "效率 × 準時 取捨圖</h3></div>" + '<div id="paretoChart" class="sc-chart"></div><div class="erp-muted">每個點是一種「沒有被其他排法同時打敗」的排法：越左越快、越下越準時。點一下可以預覽改用它。</div></div>'
      + "</div>";
    h += logBox();
    return h;
  }
  function emptyBoard() {
    var n = S.orders.length;
    return '<div class="erp-sec sc-empty"><h3>' + ic("gantt") + "還沒有排程</h3>"
      + "<p>目前有 <b>" + n + "</b> 張訂單、" + S.cfg.stages.length + " 個站別（" + S.cfg.stages.map(function (s) { return esc(s.name); }).join(" → ") + "）。"
      + "按上面的 <b>開始排程</b>，系統會在幾秒內排出每台機台什麼時候做哪張單，並告訴你：哪張會延遲、瓶頸在哪、比現場做法好多少。</p>"
      + '<ol class="erp-steps"><li>先到「<b>訂單</b>」確認要排的單（可從 ERP 匯入；現在是範例）。</li><li>到「<b>工廠設定</b>」改成你們實際的站別、機台與工時（現在是預設值，之後可隨時改）。</li>'
      + "<li>選目標（效率／兼顧／準時），按「開始排程」。</li><li>有插單、急單、外包、機台故障時，用看板上的「臨時狀況」按鈕，系統只重排還沒開工的部分。</li></ol></div>";
  }
  function whatifBar() {
    var B = [["insert", "plus", "插單"], ["rush", "alert", "急單"], ["outsource", "truck", "外包"], ["down", "wrench", "機台故障／保養"], ["cancel", "x", "取消／完工"], ["change", "edit", "改交期／數量"]];
    return '<div class="erp-sec sc-whatif"><div class="sc-whatif-row"><b>' + ic("bell") + "臨時狀況</b>"
      + B.map(function (b) { return '<button class="dbbtn" data-wi="' + b[0] + '">' + ic(b[1]) + b[2] + "</button>"; }).join("")
      + '</div><div class="erp-muted">發生狀況時按對應按鈕：系統把「已經開工」的部分固定住，只重排其餘的，並盡量少改原計畫；你看過前後對照再決定要不要採用。</div></div>';
  }
  function warnings() {
    var w = [];
    if (cur.fresh && cur.fresh.length) w.push("有 " + cur.fresh.length + " 張新訂單（" + cur.fresh.slice(0, 4).join("、") + (cur.fresh.length > 4 ? "…" : "") + "）還沒最佳化，先用現場做法暫排；按「重新最佳化」排進去。");
    if (cur.gone && cur.gone.length) w.push("有 " + cur.gone.length + " 張單已從訂單清單移除。");
    if (cur.cfgChanged) w.push("工廠設定在排程之後改過，上面是依新設定重新算的結果；想完整反映新設定，請按「從頭排程」。");
    if (cur.lockOk === false) w.push("工廠設定改過，進行中的工序無法接續（" + esc(cur.lockErr) + "）；建議按「從頭排程」。");
    if (pending) return "";
    return w.length ? '<div class="erp-notice sc-warn">' + ic("info") + "<div>" + w.map(esc).join("<br>") + "</div></div>" : "";
  }
  function kpiCard(label, icon, val, sub, delta, good) {
    return '<div class="card sc-kpi' + (good === false ? " bad" : "") + '"><div class="k">' + ic(icon) + label + '</div><div class="v">' + val + "</div>"
      + (sub ? '<div class="erp-kpisub">' + sub + "</div>" : "") + (delta ? '<div class="sc-delta ' + (delta.good ? "up" : delta.bad ? "down" : "") + '">' + delta.text + "</div>" : "") + "</div>";
  }
  function stats(P) {
    var M = P.M, res = P.res, late = [], maxLate = 0, outCost = 0, outN = 0, n = 0, hasDue = 0;
    M.orders.forEach(function (od, i) {
      n++;
      if (od.due != null) { hasDue++; var L = res.C[i] - od.due; if (L > 1e-6) { late.push(i); maxLate = Math.max(maxLate, L); } }
    });
    var outs = {}; res.ops.forEach(function (op) { if (op.kind === "out") { outs[op.o] = 1; } });
    outN = Object.keys(outs).length; outCost = res.cost;
    return { late: late, maxLate: maxLate, outN: outN, outCost: outCost, n: n, hasDue: hasDue };
  }
  function vs(hp, a, b, fmt) {                       // 跟現場做法比（數字越小越好）
    if (!hp) return null;
    var d = a - b;
    if (Math.abs(d) < 1e-6) return { text: "與現場做法相同" };
    return d < 0 ? { good: true, text: "比現場做法少 " + fmt(-d) } : { bad: true, text: "比現場做法多 " + fmt(d) };
  }
  function kpis(P) {
    var M = P.M, cal = M.cal, k = E.summarize(P.res), st = stats(P), H = heurOf(P), hp = H && H.practical;
    var risk = P.risk && P.risk.length ? P.risk.reduce(function (sum, x) { return sum + x.onTimeProb; }, 0) / P.risk.length : null;
    var dur = function (v) { return fmtDur(cal, v); }, cnt = function (u) { return function (v) { return Math.round(v) + " " + u; }; };
    var onN = st.hasDue - st.late.length, onP = hp ? Math.round(hp.onTimeRate * st.hasDue) : 0;
    var onDelta = !hp ? null : onN === onP ? { text: "與現場做法相同" } : onN > onP ? { good: true, text: "比現場做法多 " + (onN - onP) + " 張準時" } : { bad: true, text: "比現場做法少 " + (onP - onN) + " 張準時" };
    return '<div class="cards sc-kpis">'
      + kpiCard("平均生產週期", "clock", dur(k.meanF), "每張單從投料到完工", vs(hp, k.meanF, hp && hp.meanF, dur))
      + kpiCard("全部完工", "calendar", fmtDT(cal, k.makespan, true), "最後一張單做完", vs(hp, k.makespan, hp && hp.makespan, dur))
      + kpiCard("準時交貨", "check", onN + " / " + st.hasDue + " 張", "準時率 " + pct(k.onTimeRate) + (risk != null ? " · 加工有誤差時約 " + pct(risk) : ""), onDelta, st.late.length ? false : null)
      + kpiCard("延遲", "alert", st.late.length ? st.late.length + " 張" : "沒有", st.late.length ? "最多晚 " + fmtDur(cal, st.maxLate) : "全部趕得上交期", vs(hp, st.late.length, hp && hp.tardy, cnt("張")), st.late.length ? false : null)
      + kpiCard("換線次數", "refresh", k.setups + " 次", "同一台機台換做不同產品", vs(hp, k.setups, hp && hp.setups, cnt("次")))
      + kpiCard("外包", "truck", st.outN ? st.outN + " 張" : "沒有", st.outN ? "外包費約 " + money(st.outCost) : "全部自己做", null)
      + "</div>";
  }
  function routeText(P, i) {
    var M = P.M, od = M.orders[i], parts = [], ops = P.res.ops.filter(function (op) { return op.o === i; });
    for (var s = 0; s < M.S; s++) {
      var mine = ops.filter(function (op) { return op.s === s; });
      if (!mine.length) continue;
      if (mine[0].kind === "out") { parts.push(M.stages[s].name + "：外包"); continue; }
      var T = M.types[mine[0].type], units = {};
      mine.forEach(function (op) { units[op.unit] = 1; });
      var nU = Object.keys(units).length, L = od.splits[P.X.split[i]];
      var mode = M.stages[s].mode;
      parts.push(T.name + (mode === "parallel" ? (nU > 1 ? "×" + nU + "台" : "") + "（每批 " + L + "）" : mode === "batch" ? "（" + mine.length + " 爐）" : ""));
    }
    return parts.join(" → ");
  }
  function orderStatus(P, i, now) {
    var od = P.M.orders[i], a = S.act[od.id] || {}, sids = stageIdsOf(P.M, od), la = a[sids[sids.length - 1]];
    if (la && la.e != null) return ["ok", la.src === "erp" ? "已完工（ERP）" : "已完工"];
    if (sids.some(function (sid) { return a[sid] && (a[sid].s != null || a[sid].e != null); })) return ["info", "生產中"];
    var ops = P.res.ops.filter(function (op) { return op.o === i; });
    if (!ops.length) return ["", ""];
    var C = P.res.C[i], first = Math.min.apply(null, ops.map(function (op) { return op.start; }));
    if (C <= now + 1e-6) return ["warn", "預計已完工（未回報）"];
    if (first < now) return ["info", "生產中"];
    return ["muted", "待生產"];
  }
  function actCell(P, i, od, C) {                    // 預計完工；已回報就顯示實際完工與誤差
    var cal = P.M.cal, a = S.act[od.id] || {}, sids = stageIdsOf(P.M, od), la = a[sids[sids.length - 1]];
    if (!la || la.e == null) return fmtDT(cal, C, true);
    var pr = S.pred[od.id], pe = pr && pr.c != null ? cal.fromDate(pr.c) : C, d = cal.fromDate(la.e) - pe;
    return "✓ " + fmtDT(cal, cal.fromDate(la.e), true) + '<div class="' + (Math.abs(d) >= S.grace ? "erp-bad" : "erp-good") + ' erp-muted">與預計差 ' + signedH(d) + "</div>";
  }
  function fmtD(cal, m, asEnd) {
    var d = new Date(cal.toDate(m, asEnd));
    if (asEnd && d.getHours() === 0 && d.getMinutes() === 0) d = new Date(d.getTime() - 60000);
    return (d.getMonth() + 1) + "/" + d.getDate() + " (" + WD[d.getDay()] + ")";
  }
  function ordersTable(P) {
    var M = P.M, cal = M.cal, now = nowMin(cal), A = P.an;
    var rows = M.orders.map(function (od, i) {
      var src = S.orders.filter(function (x) { return x.id === od.id; })[0] || (pending && pending.orders.filter(function (x) { return x.id === od.id; })[0]) || {};
      var C = P.res.C[i], late = od.due != null ? C - od.due : null, st = orderStatus(P, i, now), rk = P.risk && P.risk[i];
      var lateTxt = late == null ? '<span class="erp-muted">無交期</span>' : late > 1e-6 ? '<span class="erp-bad">晚 ' + fmtDur(cal, late) + "</span>" : '<span class="erp-good">提早 ' + fmtDur(cal, -late) + "</span>";
      var w = A.orders[i], why = late > 1e-6 && w && w.waitStage != null ? '<div class="erp-muted">卡在「' + esc(M.stages[w.waitStage].name) + "」排隊 " + fmtDur(cal, w.wait) + "</div>" : "";
      return '<tr data-o="' + i + '"' + (V.hl === i ? ' class="sc-hlrow"' : "") + '><td class="nw"><span class="sc-dot" style="background:' + color(od.id) + '"></span><b>' + esc(od.id) + "</b>"
        + (od.weight >= 3 ? ' <span class="erp-st warn">急</span>' : od.weight >= 2 ? ' <span class="erp-st info">重要</span>' : "") + '<div class="erp-muted">' + esc(src.customer || "") + "</div></td>"
        + '<td><div class="nw">' + esc(M.prodNames[od.product]) + '</div><div class="erp-muted">' + od.qty.toLocaleString() + " 件</div></td>"
        + '<td class="nw">' + (od.due != null ? fmtD(cal, od.due, true) : "—") + '</td><td class="nw">' + actCell(P, i, od, C) + "</td>"
        + '<td>' + lateTxt + why + "</td>"
        + "<td>" + (rk ? '<div class="sc-prob" title="加工時間有 ±' + Math.round((P === cur && cur.plan.noise || V.noise ? NOISE : RISK) * 100) + '% 誤差時，模擬多次裡準時的比例"><i style="width:' + Math.round(rk.onTimeProb * 100) + "%;background:" + (rk.onTimeProb >= 0.9 ? "var(--down)" : rk.onTimeProb >= 0.6 ? "#d68a2e" : "var(--up)") + '"></i><span>' + pct(rk.onTimeProb) + "</span></div>" : "") + "</td>"
        + '<td><span class="erp-st ' + st[0] + '">' + st[1] + "</span></td>"
        + '<td class="sc-route">' + esc(routeText(P, i)) + "</td>"
        + "</tr>";
    }).join("");
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("clipboard") + "訂單進度</h3><span class=\"erp-muted\">準時機率＝加工時間有誤差時準時的機會（越高越穩）。點一列：在甘特圖標出這張單，並可設為急單、外包、改交期或取消</span></div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-otable"><thead><tr><th>訂單</th><th>產品／數量</th><th>交期</th><th>預計完工</th><th>交期狀況</th><th>準時機率</th><th>狀態</th><th>路線（機型）</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }
  function utilBox(P) {
    var A = P.an, M = P.M;
    var h = A.stageUtil.map(function (su) {
      var hot = A.bottleneck && su.stage === A.bottleneck.stage;
      var units = A.unitUtil.filter(function (u) { return u.stage === su.stage; });
      return '<div class="sc-ustage' + (hot ? " hot" : "") + '"><div class="sc-urow"><b>' + esc(su.name) + (hot ? ' <span class="erp-st warn">瓶頸</span>' : "") + "</b>"
        + '<div class="sc-ubar"><i style="width:' + Math.round(Math.min(1, su.util) * 100) + '%"></i></div><span class="sc-uval">' + pct(su.util) + "</span></div>"
        + '<div class="sc-units">' + units.map(function (u) { return '<div class="sc-unit" title="' + esc(u.name) + " 忙碌 " + pct(u.util) + '"><span>' + esc(u.name) + '</span><div class="sc-ubar sm"><i style="width:' + Math.round(Math.min(1, u.util) * 100) + '%"></i></div><em>' + pct(u.util) + "</em></div>"; }).join("") + "</div></div>";
    }).join("");
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("bars") + "各站忙碌程度</h3></div>" + h + '<div class="erp-muted">忙碌＝機台在做（含換線）的時間 ÷ 排程期間（' + fmtDur(M.cal, A.horizon) + "）。最忙的站決定整廠的速度。</div></div>";
  }
  function methodsBox(P) {
    var cal = P.M.cal, hs = heurOf(P);
    var mine = E.summarize(P.res);
    if (!hs) return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("scale") + "方法比較</h3></div><div class=\"erp-muted\">重新最佳化後會顯示。</div></div>";
    var rows = [["現場經驗做法", "先到先做、挑最快能做完的機台、固定大批", hs.practical], ["EDD 交期優先", "交期最早的先做", hs.edd], ["ATC 加權急迫度", "又急、又重要、又短的先做（Vepsalainen & Morton 1987）", hs.atc], ["本系統最佳化", "模擬＋基因演算法＋迭代貪婪（GA＋IG）", mine]];
    var mx = Math.max.apply(null, rows.map(function (r) { return r[2].meanF; })) || 1;
    var best = Math.min.apply(null, rows.map(function (r) { return r[2].tardy * 1e9 + r[2].meanF; }));
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("scale") + "方法比較</h3></div>"
      + '<table class="sc-mtable"><thead><tr><th>做法</th><th>平均生產週期</th><th class="r">延遲</th><th class="r">換線</th></tr></thead><tbody>'
      + rows.map(function (r, k) {
        var me = k === 3, win = r[2].tardy * 1e9 + r[2].meanF === best;
        return "<tr" + (me ? ' class="me"' : "") + '><td><b>' + r[0] + '</b><div class="erp-muted">' + r[1] + "</div></td>"
          + '<td><div class="sc-mbar"><i style="width:' + Math.round(r[2].meanF / mx * 100) + '%"></i><span>' + fmtDur(cal, r[2].meanF) + (win ? " ✓" : "") + "</span></div></td>"
          + '<td class="r">' + r[2].tardy + ' 張</td><td class="r">' + r[2].setups + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function insights(P) {
    var M = P.M, cal = M.cal, k = E.summarize(P.res), A = P.an, st = stats(P), out = [];
    var H0 = heurOf(P), hp = H0 && H0.practical;
    if (hp) {
      var dF = hp.meanF - k.meanF, dL = hp.tardy - k.tardy, dS = hp.setups - k.setups;
      var parts = [];
      if (dF > 1) parts.push("平均每張單早 <b>" + fmtDur(cal, dF) + "</b> 完成");
      if (dL > 0) parts.push("延遲單從 <b>" + hp.tardy + " 張降到 " + k.tardy + " 張</b>");
      if (dS > 0) parts.push("少換線 <b>" + dS + " 次</b>");
      if (parts.length) out.push(["sparkle", "跟現場經驗做法（先到先做、挑最快的機台）比：" + parts.join("、") + "。"]);
      else out.push(["info", "這批訂單用現場做法就已經很好，最佳化找不到明顯更好的排法。"]);
    }
    if (A.bottleneck) {
      var b = A.bottleneck;
      out.push(["factory", "最忙的是「<b>" + esc(b.name) + "</b>」（機台忙碌 " + pct(b.util) + "），訂單平均在這站排隊 " + fmtDur(cal, b.wait) + "。要再縮短交期，先加這站的產能（加班、外包或增加機台）最有效。"]);
    }
    var lateList = st.late.slice().sort(function (a, c) { return (P.res.C[c] - M.orders[c].due) - (P.res.C[a] - M.orders[a].due); }).slice(0, 3);
    lateList.forEach(function (i) {
      var od = M.orders[i], w = A.orders[i];
      var canOut = M.stages.some(function (st2) { return st2.out.allowed; });
      out.push(["alert", "<b>" + esc(od.id) + "</b>（" + esc(M.prodNames[od.product]) + "）預計晚 <b>" + fmtDur(cal, P.res.C[i] - od.due) + "</b>"
        + (w && w.waitStage != null ? "，主要卡在「" + esc(M.stages[w.waitStage].name) + "」排隊 " + fmtDur(cal, w.wait) : "") + "。可以："
        + (P === cur ? ' <button class="dbmini" data-oact="rush" data-id="' + esc(od.id) + '">設為急單</button>' + (canOut ? '<button class="dbmini" data-oact="outsource" data-id="' + esc(od.id) + '">外包一站</button>' : "") + '<button class="dbmini" data-oact="change" data-id="' + esc(od.id) + '">跟客戶改交期</button>' : "設為急單、外包，或改交期")]);
    });
    if (st.late.length > 3) out.push(["alert", "另外還有 " + (st.late.length - 3) + " 張會延遲，見下方「訂單進度」。"]);
    if (P.risk) {
      var shaky = M.orders.map(function (od, i) { return i; }).filter(function (i) { return M.orders[i].due != null && P.res.C[i] <= M.orders[i].due && P.risk[i].onTimeProb < 0.7; });
      if (shaky.length) out.push(["info", "排得進交期但不穩：" + shaky.slice(0, 4).map(function (i) { return "<b>" + esc(M.orders[i].id) + "</b>（準時機率 " + pct(P.risk[i].onTimeProb) + "）"; }).join("、") + "。加工稍慢就可能延遲，建議提早投料或盯緊。"]);
    }
    var outs = {}; P.res.ops.forEach(function (op) { if (op.kind === "out" && !op.frozen) outs[op.o + "|" + op.s] = op; });
    var ok = Object.keys(outs);
    if (ok.length) out.push(["truck", "系統建議外包：" + ok.slice(0, 4).map(function (key) { var op = outs[key]; return "<b>" + esc(M.orders[op.o].id) + "</b> 的「" + esc(M.stages[op.s].name) + "」"; }).join("、") + "（外包費約 " + money(P.res.cost) + "），可以讓自家機台先做更急的單。"]);
    var idle = A.stageUtil.filter(function (su) { return su.units && su.util < 0.35; });
    if (idle.length) out.push(["users", "「" + idle.map(function (x) { return esc(x.name); }).join("、") + "」比較閒（忙碌 " + idle.map(function (x) { return pct(x.util); }).join("、") + "），人力可以去支援瓶頸站。"]);
    return '<div class="erp-sec sc-ins"><div class="erp-sechead"><h3>' + ic("sparkle") + "重點（白話）</h3>"
      + (cur && cur.plan && cur.plan.stats && P === cur ? '<span class="erp-muted">' + fmtWhen(cur.plan.at) + " 排的 · 試了 " + cur.plan.stats.evals.toLocaleString() + " 種排法 · " + (cur.plan.stats.elapsed / 1000).toFixed(1) + " 秒 · 目標：" + esc((PRESET[cur.plan.preset] || PRESET.bal).label) + "</span>" : "")
      + "</div><ul class=\"sc-inslist\">" + out.map(function (x) { return "<li>" + ic(x[0]) + "<div>" + x[1] + "</div></li>"; }).join("") + "</ul></div>";
  }
  function fmtWhen(ts) { var d = new Date(ts); return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function compareBox() {
    var p = pending, M0 = cur.M, M1 = p.M, cal = M1.cal, a = E.summarize(cur.res), b = E.summarize(p.res);
    var s0 = stats(cur), s1 = stats(p);
    function row(label, x, y, fmt, lowGood) {
      var d = y - x, cls = Math.abs(d) < 1e-6 ? "" : (d < 0) === lowGood ? "erp-good" : "erp-bad";
      return "<tr><td>" + label + "</td><td>" + fmt(x) + "</td><td><b class=\"" + cls + "\">" + fmt(y) + "</b></td></tr>";
    }
    var idx0 = {}; M0.orders.forEach(function (od, i) { idx0[od.id] = i; });
    var ch = [];
    M1.orders.forEach(function (od, i) {
      var j = idx0[od.id], c1 = p.res.C[i];
      if (j == null) { ch.push({ id: od.id, txt: "新加入", c0: null, c1: c1, due: od.due }); return; }
      var c0 = convP(cur, p, cur.res.C[j]);
      if (Math.abs(c1 - c0) > SHIFT) ch.push({ id: od.id, c0: c0, c1: c1, due: od.due, d: c1 - c0 });
    });
    M0.orders.forEach(function (od) { if (!M1.orders.some(function (x) { return x.id === od.id; })) ch.push({ id: od.id, txt: "已取消" }); });
    ch.sort(function (x, y) { return Math.abs(y.d || 1e9) - Math.abs(x.d || 1e9); });
    var dsx = diffStats(cur, p);
    return '<div class="erp-sec sc-cmp" id="cmpBox"><div class="erp-sechead"><h3>' + ic("scale") + "重排結果：" + esc(p.ch.desc) + "</h3>"
      + '<div class="erp-row"><button class="dbbtn" data-act="discard">' + ic("undo") + '放棄</button><button class="dbbtn primary" data-act="adopt">' + ic("check") + "採用新排程</button></div></div>"
      + '<div class="erp-muted">發生時間：' + fmtDT(cal, p.now) + " · 這之前已開工的工序都固定不動 · 原有的 " + dsx.n + " 張單裡，完工時間挪動超過 " + SHIFT + " 分鐘的有 <b>" + dsx.moved + "</b> 張（平均挪動 " + fmtDur(cal, dsx.avg) + "）</div>"
      + gateSummaryHtml()
      + '<div class="sc-cmpgrid"><table class="sc-mtable"><thead><tr><th></th><th>原排程</th><th>新排程</th></tr></thead><tbody>'
      + row("平均生產週期", a.meanF, b.meanF, function (v) { return fmtDur(cal, v); }, true)
      + row("全部完工", convP(cur, p, a.makespan), b.makespan, function (v) { return fmtDT(cal, v, true); }, true)
      + row("延遲張數", s0.late.length, s1.late.length, function (v) { return v + " 張"; }, true)
      + row("最多晚", s0.maxLate, s1.maxLate, function (v) { return v > 0 ? fmtDur(cal, v) : "—"; }, true)
      + row("換線", a.setups, b.setups, function (v) { return v + " 次"; }, true)
      + row("外包費", a.cost, b.cost, function (v) { return v ? money(v) : "—"; }, true)
      + "</tbody></table>"
      + '<div><b>完工時間有變的訂單（' + ch.length + "）</b>" + (ch.length ? '<ul class="sc-chlist">' + ch.slice(0, 12).map(function (c) {
        var lateNow = c.due != null && c.c1 > c.due + 1e-6;
        return '<li><span class="sc-dot" style="background:' + color(c.id) + '"></span><b>' + esc(c.id) + "</b> "
          + (c.txt ? (c.txt === "新加入" ? "新加入 → " + fmtDT(cal, c.c1, true) : c.txt) : (c.d > 0 ? '<span class="erp-bad">延後 ' + fmtDur(cal, c.d) + "</span>" : '<span class="erp-good">提早 ' + fmtDur(cal, -c.d) + "</span>") + " → " + fmtDT(cal, c.c1, true))
          + (lateNow ? ' <span class="erp-st warn">會延遲</span>' : "") + "</li>";
      }).join("") + (ch.length > 12 ? "<li>…還有 " + (ch.length - 12) + " 張</li>" : "") + "</ul>" : '<div class="erp-muted">其他訂單的完工時間都沒變。</div>') + "</div></div></div>";
  }
  function logBox() {
    if (!S.log.length) return "";
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("list") + "異動紀錄</h3></div><ul class=\"sc-log\">"
      + S.log.slice(0, 10).map(function (l) { return "<li><span>" + fmtWhen(l.ts) + "</span>" + (l.by ? "<em>" + esc(l.by) + "</em> " : "") + esc(l.text) + "</li>"; }).join("") + "</ul></div>";
  }

  // ---------------------------------------------------------------------------
  // 甘特圖（SVG）
  // ---------------------------------------------------------------------------
  function drawGantt() {
    var box = document.getElementById("gantt"); if (!box) return;
    CM = null;
    var P = pending && V.show === "new" ? pending : cur;
    if (!P || !P.res) { box.innerHTML = ""; return; }
    var M = P.M, res = P.res, cal = M.cal, per = cal.per, now = pending ? pending.now : nowMin(cal);
    var rows = [], RH = 24, HH = 22, AX = 30, LW = window.innerWidth < 640 ? 108 : 150;
    M.stages.forEach(function (st, s) {
      rows.push({ head: true, s: s, label: st.name, sub: MODE[st.mode] });
      st.types.forEach(function (ti) { var T = M.types[ti]; for (var k = 0; k < T.count; k++) rows.push({ unit: T.base + k, label: T.name + (T.count > 1 ? " #" + (k + 1) : ""), s: s }); });
      if (res.ops.some(function (op) { return op.s === s && op.kind === "out"; })) rows.push({ out: s, label: "外包（協力廠）", s: s });
    });
    var y = AX, rowY = {}, outY = {};
    rows.forEach(function (r) { r.y = y; r.h = r.head ? HH : RH; if (r.unit != null) rowY[r.unit] = y; if (r.out != null) outY[r.out] = y; y += r.h; });
    var H = y + 6;
    var minS = res.ops.length ? Math.min.apply(null, res.ops.map(function (op) { return op.start; })) : 0;
    var d0 = Math.floor(Math.min(minS, now) / per), d1 = Math.max(d0 + 1, Math.ceil((res.makespan + 1) / per));
    var x0 = d0 * per, span = (d1 - d0) * per;
    var avail = Math.max(320, box.clientWidth - LW - 2), W = Math.round(avail * V.zoom), px = W / span;
    function X(t) { return (t - x0) * px; }
    var g = [];
    g.push('<defs><pattern id="hatchS" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="g-setupbg"/><line x1="0" y1="0" x2="0" y2="6" class="g-setupln"/></pattern>'
      + '<pattern id="hatchD" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" class="g-downln"/></pattern></defs>');
    // 日期格
    var pxDay = per * px, hourStep = pxDay > 480 ? 1 : pxDay > 240 ? 2 : pxDay > 130 ? 4 : 0;
    for (var d = d0; d < d1; d++) {
      var xa = X(d * per);
      if ((d - d0) % 2) g.push('<rect x="' + xa + '" y="' + AX + '" width="' + pxDay + '" height="' + (H - AX) + '" class="g-day"/>');
      g.push('<line x1="' + xa + '" y1="0" x2="' + xa + '" y2="' + H + '" class="g-dayln"/>');
      if (pxDay > 46) g.push('<text x="' + (xa + 4) + '" y="13" class="g-axis">' + esc(dayLabel(cal, d)) + "</text>");
      else if ((d - d0) % Math.ceil(46 / pxDay) === 0) g.push('<text x="' + (xa + 2) + '" y="13" class="g-axis">' + esc(dayLabel(cal, d).replace(/\s.*/, "")) + "</text>");
      if (hourStep) for (var hh = hourStep; hh < cal.hours; hh += hourStep) {
        var xh = X(d * per + hh * 60), hour = (cal.dayStart + hh) % 24;
        g.push('<line x1="' + xh + '" y1="' + (AX - 6) + '" x2="' + xh + '" y2="' + H + '" class="g-hrln"/><text x="' + (xh + 2) + '" y="26" class="g-hr">' + pad(Math.floor(hour)) + ":00</text>");
      }
    }
    // 站別標題列
    rows.forEach(function (r) { if (r.head) g.push('<rect x="0" y="' + r.y + '" width="' + W + '" height="' + r.h + '" class="g-head"/>'); else g.push('<line x1="0" y1="' + (r.y + r.h) + '" x2="' + W + '" y2="' + (r.y + r.h) + '" class="g-rowln"/>'); });
    // 停機
    var dm = P.base && P.base.down;
    if (dm) Object.keys(dm).forEach(function (u) {
      if (rowY[u] == null) return;
      dm[u].forEach(function (w) { var xa2 = X(Math.max(w[0], x0)), xb = X(Math.min(w[1], x0 + span)); if (xb > xa2) g.push('<rect x="' + xa2 + '" y="' + (rowY[u] + 1) + '" width="' + (xb - xa2) + '" height="' + (RH - 2) + '" class="g-down"><title>停機／故障</title></rect>'); });
    });
    // 工序
    var hl = V.hl != null && V.hl < M.n ? V.hl : null;
    res.ops.forEach(function (op, k) {
      var yy = op.kind === "out" ? outY[op.s] : rowY[op.unit];
      if (yy == null) return;
      var od = M.orders[op.o], xa3 = X(op.start), w = Math.max(1.5, (op.end - op.start) * px), c = color(od.id);
      var dim = hl != null && hl !== op.o ? " dim" : "", cls = "g-op" + (op.frozen ? " frozen" : "") + (op.kind === "out" ? " out" : "") + dim + (hl === op.o ? " hl" : "");
      g.push('<g class="' + cls + '" data-k="' + k + '"><rect x="' + xa3 + '" y="' + (yy + 3) + '" width="' + w + '" height="' + (RH - 6) + '" fill="' + c + '" rx="1"/>');
      if (op.setup > 0) g.push('<rect x="' + xa3 + '" y="' + (yy + 3) + '" width="' + Math.min(w, op.setup * px) + '" height="' + (RH - 6) + '" fill="url(#hatchS)"/>');
      if (op.paused) { var pa = X(op.paused[0]), pb = X(op.paused[1]); g.push('<rect x="' + pa + '" y="' + (yy + 3) + '" width="' + Math.max(0, pb - pa) + '" height="' + (RH - 6) + '" fill="url(#hatchD)"/>'); }
      var label = od.id.length > 7 ? od.id.slice(-6) : od.id;
      if (w > label.length * 6.6 + 8) g.push('<text x="' + (xa3 + 4) + '" y="' + (yy + RH / 2 + 4) + '" class="g-lbl">' + esc(label) + "</text>");
      g.push("</g>");
    });
    // 交期（標示中的訂單）
    if (hl != null && M.orders[hl].due != null) { var xd = X(M.orders[hl].due); if (xd >= 0 && xd <= W) g.push('<line x1="' + xd + '" y1="' + AX + '" x2="' + xd + '" y2="' + H + '" class="g-due"/><text x="' + (xd + 3) + '" y="' + (AX + 11) + '" class="g-duelbl">交期</text>'); }
    // 現在
    if (now >= x0 && now <= x0 + span) { var xn = X(now); g.push('<line x1="' + xn + '" y1="' + (AX - 4) + '" x2="' + xn + '" y2="' + H + '" class="g-now"/><text x="' + (xn + 3) + '" y="' + (AX - 6) + '" class="g-nowlbl">' + (pending ? "發生" : "現在") + "</text>"); }
    var labels = rows.map(function (r) {
      return '<div class="gl' + (r.head ? " head" : "") + (r.out != null ? " out" : "") + '" style="height:' + r.h + 'px" title="' + esc(r.head ? MODE_HINT[M.stages[r.s].mode] : r.label) + '">' + esc(r.label) + (r.head ? "<small>" + esc(r.sub) + "</small>" : "") + "</div>";
    }).join("");
    box.innerHTML = '<div class="g-labels" style="width:' + LW + 'px"><div class="gl axis" style="height:' + AX + 'px"></div>' + labels + "</div>"
      + '<div class="g-scroll"><svg class="g-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' + g.join("") + "</svg></div>"
      + '<div class="g-tip" hidden></div>';
    var tip = box.querySelector(".g-tip"), svg = box.querySelector("svg");
    function opAt(e) { var t = e.target.closest && e.target.closest(".g-op"); return t ? res.ops[+t.getAttribute("data-k")] : null; }
    svg.addEventListener("mousemove", function (e) {
      var op = opAt(e); if (!op) { tip.hidden = true; return; }
      tip.innerHTML = opTip(P, op); tip.hidden = false;
      var r = box.getBoundingClientRect(), tx = e.clientX - r.left + 14, ty = e.clientY - r.top + 14;
      if (tx + 260 > r.width) tx = Math.max(4, e.clientX - r.left - 270);
      tip.style.left = tx + "px"; tip.style.top = ty + "px";
    });
    svg.addEventListener("mouseleave", function () { tip.hidden = true; });
    svg.addEventListener("click", function (e) {
      var op = opAt(e);
      V.hl = op ? (V.hl === op.o ? null : op.o) : null;
      drawGantt(); paintHl(P);
      if (op && "ontouchstart" in window) { tip.innerHTML = opTip(P, op); tip.hidden = false; tip.style.left = "8px"; tip.style.top = "8px"; }
    });
  }
  function opTip(P, op) {
    var M = P.M, cal = M.cal, od = M.orders[op.o], st = M.stages[op.s];
    var where = op.kind === "out" ? "外包（協力廠）" : M.types[op.type].name + (M.types[op.type].count > 1 ? " #" + (op.unit - M.types[op.type].base + 1) : "");
    var what = op.kind === "whole" ? "整張單 " + op.qty.toLocaleString() + " 件（做好一批就先送下一站）" : op.kind === "batch" ? "併成一批 " + op.qty.toLocaleString() + " 件" : op.kind === "out" ? "整張單 " + op.qty.toLocaleString() + " 件送外包" : "子批 " + (op.a + 1) + "：" + op.qty.toLocaleString() + " 件";
    return "<b>" + esc(od.id) + " · " + esc(M.prodNames[od.product]) + "</b><br>" + esc(st.name) + " · " + esc(where) + "<br>" + what
      + "<br>" + fmtDT(cal, op.start) + " → " + fmtDT(cal, op.end, true)
      + (op.setup > 0 ? "<br>含換線 " + Math.round(op.setup) + " 分鐘" : "") + (op.paused ? "<br>機台故障，修好後接著做" : "") + (op.frozen ? "<br><i>已開工，重排時不動</i>" : "");
  }
  function paintHl(P) {
    var el = document.getElementById("hlCard"); if (!el) return;
    if (V.hl == null || !P || V.hl >= P.M.n) { el.innerHTML = ""; return; }
    var M = P.M, cal = M.cal, i = V.hl, od = M.orders[i], C = P.res.C[i], late = od.due != null ? C - od.due : null;
    el.innerHTML = '<div class="sc-hl"><span class="sc-dot" style="background:' + color(od.id) + '"></span><b>' + esc(od.id) + "</b> " + esc(M.prodNames[od.product]) + " " + od.qty.toLocaleString() + " 件"
      + " · 交期 " + (od.due != null ? fmtDT(cal, od.due, true) : "—") + " · 預計完工 " + fmtDT(cal, C, true)
      + (late != null ? (late > 1e-6 ? ' <span class="erp-bad">（晚 ' + fmtDur(cal, late) + "）</span>" : ' <span class="erp-good">（提早 ' + fmtDur(cal, -late) + "）</span>") : "")
      + '<div class="erp-muted">路線：' + esc(routeText(P, i)) + "</div>"
      + (P === cur ? '<div class="erp-row"><button class="dbmini" data-oact="rush" data-id="' + esc(od.id) + '">' + ic("alert") + '急單</button><button class="dbmini" data-oact="outsource" data-id="' + esc(od.id) + '">' + ic("truck") + '外包</button><button class="dbmini" data-oact="change" data-id="' + esc(od.id) + '">' + ic("edit") + '改交期／數量</button><button class="dbmini" data-oact="cancel" data-id="' + esc(od.id) + '">' + ic("x") + '取消／完工</button><button class="dbmini" data-act="unhl">' + ic("x") + "不標示</button></div>" : '<div class="erp-row"><button class="dbmini" data-act="unhl">' + ic("x") + "不標示</button></div>") + "</div>";
  }

  // 小圖表：收斂曲線、取捨圖
  function drawConv() {
    var el = document.getElementById("convChart"); if (!el) return;
    var P = pending && V.show === "new" && pending.out.history ? pending.out : null;
    var hist = P ? P.history.map(function (h) { return [h.gen, h.f]; }) : (cur.plan.history || []).map(function (h) { return [h[0], h[1]]; });
    if (!hist.length) { el.innerHTML = '<div class="erp-muted">沒有紀錄。</div>'; return; }
    var w = Math.max(260, el.clientWidth), h = 170, L = 40, B = 24, T = 10, R = 10;
    var base = P ? P.heur.practical.f : cur.plan.baseF;
    if (base == null) base = hist[0][1];
    var ys = hist.map(function (p) { return p[1]; }).concat([base]), ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    if (ymax - ymin < 1e-6) { ymax += 0.05; ymin -= 0.05; }
    var gx = hist[hist.length - 1][0] || 1;
    function px(x) { return L + x / gx * (w - L - R); }
    function py(v) { return T + (ymax - v) / (ymax - ymin) * (h - T - B); }
    var d = hist.map(function (p, k) { return (k ? "L" : "M") + px(p[0]).toFixed(1) + "," + py(p[1]).toFixed(1); }).join("");
    el.innerHTML = '<svg width="' + w + '" height="' + h + '" class="sc-svg"><line x1="' + L + '" y1="' + py(base) + '" x2="' + (w - R) + '" y2="' + py(base) + '" class="c-base"/>'
      + '<text x="' + (w - R) + '" y="' + (py(base) + 13) + '" class="c-lbl" text-anchor="end">現場做法的分數</text>'
      + '<path d="' + d + '" class="c-line"/>'
      + '<text x="' + (L - 4) + '" y="' + (py(ymax) + 4) + '" class="c-tick" text-anchor="end">' + ymax.toFixed(2) + "</text>"
      + '<text x="' + (L - 4) + '" y="' + (py(ymin) + 4) + '" class="c-tick" text-anchor="end">' + ymin.toFixed(2) + "</text>"
      + '<text x="' + L + '" y="' + (h - 6) + '" class="c-tick">第 1 代</text><text x="' + (w - R) + '" y="' + (h - 6) + '" class="c-tick" text-anchor="end">第 ' + (gx + 1) + " 代</text>"
      + '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (h - B) + '" class="c-axis"/><line x1="' + L + '" y1="' + (h - B) + '" x2="' + (w - R) + '" y2="' + (h - B) + '" class="c-axis"/></svg>';
  }
  function drawPareto() {
    var el = document.getElementById("paretoChart"); if (!el) return;
    var src = pending && V.show === "new" && pending.out.pareto ? pending.out.pareto : null;
    var pts = src || (cur.plan.pareto || []), M = (pending && V.show === "new" ? pending : cur).M, cal = M.cal;
    var hs = heurOf(pending && V.show === "new" ? pending : cur);
    if (!pts.length) { el.innerHTML = '<div class="erp-muted">沒有資料。</div>'; return; }
    var ref = hs ? [["現場", hs.practical], ["EDD", hs.edd], ["ATC", hs.atc]] : [];
    var xs = pts.map(function (p) { return p.mf; }).concat(ref.map(function (r) { return r[1].meanF; }));
    var ys = pts.map(function (p) { return p.tw; }).concat(ref.map(function (r) { return r[1].twt; }));
    var w = Math.max(260, el.clientWidth), h = 190, L = 46, B = 30, T = 12, R = 46;
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs), ymin = 0, ymax = Math.max.apply(null, ys);
    if (xmax - xmin < 1) { xmax += 30; xmin -= 30; }
    if (ymax < 1) ymax = 60;
    function px(v) { return L + (v - xmin) / (xmax - xmin) * (w - L - R); }
    function py(v) { return T + (ymax - v) / (ymax - ymin) * (h - T - B); }
    var g = ['<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (h - B) + '" class="c-axis"/><line x1="' + L + '" y1="' + (h - B) + '" x2="' + (w - R) + '" y2="' + (h - B) + '" class="c-axis"/>'];
    var sorted = pts.slice().sort(function (a, b) { return a.mf - b.mf; });
    g.push('<path d="' + sorted.map(function (p, k) { return (k ? "L" : "M") + px(p.mf).toFixed(1) + "," + py(p.tw).toFixed(1); }).join("") + '" class="c-front"/>');
    ref.forEach(function (r) {
      var x = px(r[1].meanF), left = x > w - R - 6;   // 太靠右就把標籤放到方塊左邊
      g.push('<g class="c-ref"><rect x="' + (x - 4) + '" y="' + (py(r[1].twt) - 4) + '" width="8" height="8"/><text x="' + (left ? x - 7 : x + 7) + '" y="' + (py(r[1].twt) + 4) + '"' + (left ? ' text-anchor="end"' : "") + ">" + r[0] + "</text></g>");
    });
    pts.forEach(function (p, k) {
      g.push('<circle cx="' + px(p.mf) + '" cy="' + py(p.tw) + '" r="' + (p.best ? 7 : 5) + '" class="c-pt' + (p.best ? " best" : "") + (src ? "" : " pick") + '" data-p="' + k + '"><title>平均週期 ' + fmtDur(cal, p.mf) + "、加權延遲 " + (p.tw / 60).toFixed(1) + " 小時、準時率 " + pct(p.ot) + (p.best ? "（目前採用）" : "（點一下預覽）") + "</title></circle>");
    });
    g.push('<text x="' + ((L + w - R) / 2) + '" y="' + (h - 6) + '" class="c-tick" text-anchor="middle">平均生產週期 →（' + fmtDur(cal, xmin) + " ～ " + fmtDur(cal, xmax) + "）</text>");
    g.push('<text x="12" y="' + ((T + h - B) / 2) + '" class="c-tick" transform="rotate(-90 12 ' + ((T + h - B) / 2) + ')" text-anchor="middle">加權延遲（小時）→</text>');
    g.push('<text x="' + (L - 4) + '" y="' + (py(ymax) + 4) + '" class="c-tick" text-anchor="end">' + (ymax / 60).toFixed(0) + "</text>");
    g.push('<text x="' + (L - 4) + '" y="' + (py(0) + 4) + '" class="c-tick" text-anchor="end">0</text>');
    el.innerHTML = '<svg width="' + w + '" height="' + h + '" class="sc-svg">' + g.join("") + "</svg>";
    if (!src) el.querySelector("svg").addEventListener("click", function (e) {
      var c = e.target.closest && e.target.closest(".c-pt"); if (!c) return;
      previewPareto(+c.getAttribute("data-p"));
    });
  }
  // 取捨圖上的另一個點：這次計算還在記憶體裡就直接換；重新開啟頁面後沒留下各點的排法，就依位置調整目標重新找一個
  function previewPareto(k) {
    var pts = cur && cur.plan && cur.plan.pareto, p = pts && pts[k];
    if (!p || p.best) return;
    var lo = V.lastOut, hit = lo && V.lastOutPlan === S.plan && lo.pareto && lo.pareto[k] && lo.pareto[k].X ? lo.pareto[k] : null;
    var b = pts.filter(function (x) { return x.best; })[0] || p, more = p.tw < b.tw, label = more ? "更準時" : "更快";
    if (hit) { showPending({ desc: "改用「" + label + "」的排法（取捨圖上的點）", at: S.plan.now0, paretoIdx: k }, cur.M, { X: hit.X, lockUsed: S.plan.lock }, S.plan.now0, S.orders, S.down); return; }
    var o = opts({ now: S.plan.now0, lock: S.plan.lock || null, down: downMap(cur.M, S.down) }), wo = o.weights.out;
    o.weights = more ? { flow: 0.3, tardy: 1, out: wo } : { flow: 1, tardy: 0.15, out: wo };
    run({ label: "找一個「" + label + "」的排法", cfg: planCfg(S.plan.start), orders: S.orders, opts: o }, function (out) {
      showPending({ desc: "改用" + label + "的排法", at: S.plan.now0 }, cur.M, out, S.plan.now0, S.orders, S.down);
    });
  }

  function afterBoard() {
    if (!cur || !cur.res) return;
    drawGantt(); paintHl(pending && V.show === "new" ? pending : cur);
    if (cur.plan) { drawConv(); drawPareto(); }
  }

  // ---------------------------------------------------------------------------
  // 臨時狀況：對話框
  // ---------------------------------------------------------------------------
  function dialog(title, intro, fields, onOk, okLabel) {
    var ov = document.createElement("div");
    ov.className = "dbmodal";
    ov.innerHTML = '<div class="dbdialog erp-dialog" role="dialog" aria-label="' + esc(title) + '"><h3>' + esc(title) + "</h3>" + (intro ? '<div class="erp-intro">' + intro + "</div>" : "")
      + '<form class="dbform">' + fields.map(fieldHtml).join("") + '<div class="sc-err erp-bad"></div><div class="dbdlgbtns"><button type="button" class="dbbtn" data-x>取消</button><button type="submit" class="dbbtn primary">' + esc(okLabel || "確定") + "</button></div></form></div>";
    document.body.appendChild(ov);
    var form = ov.querySelector("form");
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov || e.target.hasAttribute("data-x")) close(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = {};
      fields.forEach(function (f) { if (!f.k) return; var el = form.elements[f.k]; if (!el) return; v[f.k] = f.type === "check" ? el.checked : el.value; });
      try { if (onOk(v) !== false) close(); } catch (err) { form.querySelector(".sc-err").textContent = err.message || String(err); }
    });
    fields.forEach(function (f) { if (f.onInput) form.addEventListener("input", function (e) { f.onInput(form, e); }); });
    form.addEventListener("click", function (e) {      // 進度回報的「用預計」：一鍵把預計時間填進去
      var bt = e.target.closest && e.target.closest("[data-fill]"); if (!bt) return;
      var q = bt.getAttribute("data-fill").split("|"), f = form.elements;
      if (f["s_" + q[0]]) f["s_" + q[0]].value = q[1]; if (f["e_" + q[0]]) f["e_" + q[0]].value = q[2];
    });
    var first = form.querySelector("input,select"); if (first) first.focus();
    return form;
  }
  function fieldHtml(f) {
    if (f.html) return f.html;
    var lab = '<span>' + esc(f.label) + (f.hint ? ' <em class="erp-muted">' + esc(f.hint) + "</em>" : "") + "</span>";
    if (f.type === "select") return '<label class="dbfield">' + lab + '<select name="' + f.k + '">' + f.opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(f.value) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select></label>";
    if (f.type === "check") return '<label class="dbfield dbcheck"><input type="checkbox" name="' + f.k + '"' + (f.value ? " checked" : "") + ">" + esc(f.label) + "</label>";
    return '<label class="dbfield">' + lab + '<input name="' + f.k + '" type="' + (f.type || "text") + '" value="' + esc(f.value == null ? "" : f.value) + '"' + (f.step ? ' step="' + f.step + '"' : "") + (f.min != null ? ' min="' + f.min + '"' : "") + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") + (f.req ? " required" : "") + "></label>";
  }
  function atField() {
    var cal = cur.M.cal, t = Math.max(nowMin(cal), S.plan.now0 || 0);
    return { k: "at", label: "發生時間", type: "datetime-local", value: localInput(cal.toDate(t)), hint: "預設是現在；可以改時間來模擬" };
  }
  function atMin(v) {
    var cal = cur.M.cal, ts = parseLocal(v.at);
    var m = ts == null ? nowMin(cal) : cal.fromDate(ts);
    return Math.max(m, S.plan.now0 || 0);
  }
  function startedAt(id, at) {                 // 這張單在 at 之前是否已開工
    var i = cur.M.orders.map(function (o) { return o.id; }).indexOf(id);
    return i >= 0 && cur.res.ops.some(function (op) { return op.o === i && op.start < at; });
  }
  function orderOpts(filter) { return S.orders.filter(filter || function () { return true; }).map(function (o) { return [o.id, o.id + " · " + prodName(o.product) + " " + o.qty + " 件" + (o.customer ? " · " + o.customer : "")]; }); }
  function prodName(id) { var p = S.cfg.products.filter(function (x) { return x.id === id; })[0]; return p ? p.name : id; }
  function weightOpts() { return [["1", "一般"], ["2", "重要"], ["3", "急（優先排）"]]; }
  function dueToDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null; }

  function whatIf(kind, id) {
    if (!cur || !cur.M) { toast("請先按「開始排程」。", true); return; }
    if (pending) { toast("請先決定上一個重排結果要不要採用。", true); return; }
    var cal = cur.M.cal;
    var prodOpts = S.cfg.products.map(function (p) { return [p.id, p.id + " " + p.name]; });
    if (kind === "insert") {
      dialog("插單：加一張新訂單", "新單從「發生時間」起可以開始生產。已經開工的工序不會動，其他訂單會重新安排。", [
        { k: "id", label: "單號", value: "INS-" + pad(new Date().getMonth() + 1) + pad(new Date().getDate()) + "-" + (S.orders.length + 1), req: true },
        { k: "customer", label: "客戶", value: "" },
        { k: "product", label: "產品", type: "select", opts: prodOpts, value: prodOpts[0] && prodOpts[0][0] },
        { k: "qty", label: "數量（件）", type: "number", min: 1, value: 300, req: true },
        { k: "due", label: "交期", type: "date", value: cal.dayDate(cal.dayIndex(cal.ymd(new Date())) + 4) },
        { k: "weight", label: "重要度", type: "select", opts: weightOpts(), value: "2" },
        atField()
      ], function (v) {
        var nid = v.id.trim(); if (!nid) throw new Error("請填單號");
        if (S.orders.some(function (o) { return o.id === nid; })) throw new Error("單號重複");
        var at = atMin(v), od = { id: nid, customer: v.customer, product: v.product, qty: Math.max(1, Math.round(num(v.qty, 0))), release: localInput(cal.toDate(at)), due: dueToDate(v.due), weight: +v.weight };
        reschedule({ desc: "插單 " + od.id + "（" + prodName(od.product) + " " + od.qty + " 件）", orders: S.orders.concat([od]), at: at });
      }, "插單並重排");
    } else if (kind === "rush") {
      var o0 = S.orders.filter(function (o) { return o.id === id; })[0] || S.orders[0];
      dialog("急單：把一張單提前", "設為「急」之後，系統會優先排它（必要時讓其他單稍晚一點）。也可以順便把交期提前。", [
        { k: "id", label: "訂單", type: "select", opts: orderOpts(), value: o0 && o0.id },
        { k: "due", label: "新交期（不改就留原值）", type: "date", value: o0 && o0.due || "" },
        atField()
      ], function (v) {
        var at = atMin(v), next = S.orders.map(function (o) { return o.id === v.id ? Object.assign({}, o, { weight: 3, due: dueToDate(v.due) || o.due }) : o; });
        reschedule({ desc: "急單 " + v.id + (dueToDate(v.due) ? "（交期 " + v.due + "）" : ""), orders: next, at: at });
      }, "設為急單並重排");
    } else if (kind === "outsource") {
      var o1 = S.orders.filter(function (o) { return o.id === id; })[0] || S.orders[0];
      var stOpts = S.cfg.stages.map(function (s) { return [s.id, s.name + (s.out && s.out.allowed ? "" : "（平常不外包）")]; });
      var wi = o1 ? cur.M.orders.map(function (o) { return o.id; }).indexOf(o1.id) : -1, ws = wi >= 0 ? cur.an.orders[wi].waitStage : null;
      var surf = (ws != null && S.cfg.stages[ws].out && S.cfg.stages[ws].out.allowed ? S.cfg.stages[ws] : null)
        || S.cfg.stages.filter(function (s) { return s.out && s.out.allowed; })[0] || S.cfg.stages[0];
      dialog("外包：把一張單的某一站交給協力廠", "整張單在這一站交給外包，前置時間後送回來接著做下一站。已經開工的站不能再外包。", [
        { k: "id", label: "訂單", type: "select", opts: orderOpts(), value: o1 && o1.id },
        { k: "stage", label: "外包哪一站", type: "select", opts: stOpts, value: surf.id, onInput: function (form, e) {
          if (!e || !e.target || e.target.name !== "stage") return;
          var st = S.cfg.stages.filter(function (x) { return x.id === form.elements.stage.value; })[0];
          if (st && form.elements.lead) form.elements.lead.value = st.out && st.out.leadDays != null ? st.out.leadDays : 2;
        } },
        { k: "lead", label: "協力廠幾個工作天交回", type: "number", min: 0, step: "0.5", value: surf.out ? surf.out.leadDays : 2 },
        atField()
      ], function (v) {
        var at = atMin(v), st = S.cfg.stages.filter(function (s) { return s.id === v.stage; })[0];
        var i = cur.M.orders.map(function (o) { return o.id; }).indexOf(v.id), s = S.cfg.stages.indexOf(st);
        if (i >= 0 && cur.M.orders[i].optType[s][0] === E.SKIP) throw new Error("「" + v.id + "」不經過「" + st.name + "」這一站，沒有東西可以外包。");
        if (i >= 0 && cur.res.ops.some(function (op) { return op.o === i && op.s === s && op.start < at; })) throw new Error("這張單在「" + st.name + "」已經開工了，不能再外包；請選後面的站。");
        var next = S.orders.map(function (o) {
          if (o.id !== v.id) return o;
          var f = Object.assign({}, o.force || {}), L = Object.assign({}, o.outLead || {});
          f[v.stage] = "out"; L[v.stage] = Math.max(0, num(v.lead, 0));
          return Object.assign({}, o, { force: f, outLead: L });
        });
        reschedule({ desc: "外包 " + v.id + " 的「" + st.name + "」（" + v.lead + " 個工作天交回）", orders: next, at: at });
      }, "外包並重排");
    } else if (kind === "down") {
      var units = [];
      S.cfg.types.forEach(function (t) { for (var k = 0; k < t.count; k++) units.push([t.id + "|" + k, stageName(t.stage) + " · " + t.name + (t.count > 1 ? " #" + (k + 1) : "")]); });
      var at0 = Math.max(nowMin(cal), S.plan.now0 || 0);
      dialog("機台故障／保養", "這台機台在這段時間不能用。正在做的工序：整批流動的修好後接著做；子批會改排到同型其他機台（或等修好）。", [
        { k: "unit", label: "哪一台", type: "select", opts: units, value: units[0] && units[0][0] },
        atField(),
        { k: "until", label: "預計修好時間", type: "datetime-local", value: localInput(cal.toDate(at0 + 480)), hint: "預設 8 個工時後" },
        { k: "note", label: "原因", value: "故障待修", ph: "例：主軸異常、定期保養" }
      ], function (v) {
        var at = atMin(v), fromTs = parseLocal(v.at) || cal.toDate(at), toTs = parseLocal(v.until);
        if (toTs == null || cal.fromDate(toTs) <= at) throw new Error("修好時間要比發生時間晚（而且要跨到上班時間）。");
        var p = v.unit.split("|"), w = { type: p[0], k: +p[1], from: fromTs, to: toTs, note: v.note };
        var label = units.filter(function (u) { return u[0] === v.unit; })[0][1];
        reschedule({ desc: "機台停機：" + label + "，到 " + fmtDT(cal, cal.fromDate(toTs)) + "（" + (v.note || "") + "）", down: S.down.concat([w]), breakdown: { type: p[0], k: +p[1], until: cal.fromDate(toTs) }, at: at });
      }, "停機並重排");
    } else if (kind === "cancel") {
      var o2 = S.orders.filter(function (o) { return o.id === id; })[0] || S.orders[0];
      dialog("取消訂單／已完工", "把這張單從排程拿掉：還沒做的工序全部拿掉，機台讓給其他訂單。已經做完的部分不受影響。", [
        { k: "id", label: "訂單", type: "select", opts: orderOpts(), value: o2 && o2.id },
        { k: "why", label: "原因", type: "select", opts: [["cancel", "客戶取消"], ["done", "已經完成或已出貨（不用再排）"], ["other", "其他"]], value: "cancel" },
        atField()
      ], function (v) {
        var w = { cancel: "取消訂單", done: "已完成（移出排程）", other: "移出排程" }[v.why] || "移出排程";
        reschedule({ desc: w + " " + v.id, orders: S.orders.filter(function (o) { return o.id !== v.id; }), at: atMin(v) });
      }, "移出並重排");
    } else if (kind === "change") {
      var o3 = S.orders.filter(function (o) { return o.id === id; })[0] || S.orders[0];
      dialog("改交期／數量", "數量只有「還沒開工」的單可以改；交期隨時可以改。", [
        { k: "id", label: "訂單", type: "select", opts: orderOpts(), value: o3 && o3.id },
        { k: "due", label: "新交期", type: "date", value: o3 && o3.due || "" },
        { k: "qty", label: "新數量（件）", type: "number", min: 1, value: o3 && o3.qty },
        atField()
      ], function (v) {
        var at = atMin(v), od = S.orders.filter(function (o) { return o.id === v.id; })[0], q = Math.max(1, Math.round(num(v.qty, od.qty)));
        if (q !== od.qty && startedAt(v.id, at)) throw new Error("這張單已經開工，數量不能改（可以另外插一張補單）。");
        var parts = [];
        if (dueToDate(v.due) !== od.due) parts.push("交期 " + (od.due || "—") + " → " + (v.due || "—"));
        if (q !== od.qty) parts.push("數量 " + od.qty + " → " + q);
        if (!parts.length) throw new Error("沒有改動。");
        var next = S.orders.map(function (o) { return o.id === v.id ? Object.assign({}, o, { due: dueToDate(v.due), qty: q }) : o; });
        reschedule({ desc: v.id + " " + parts.join("、"), orders: next, at: at });
      }, "修改並重排");
    }
  }
  function stageName(id) { var s = S.cfg.stages.filter(function (x) { return x.id === id; })[0]; return s ? s.name : id; }

  // ---------------------------------------------------------------------------
  // 訂單
  // ---------------------------------------------------------------------------
  function ordersTab() {
    var rows = S.orders.map(function (o, k) {
      var f = o.force ? Object.keys(o.force).map(function (sid) { return stageName(sid) + "：" + (o.force[sid] === "out" ? "外包" : typeName(o.force[sid])); }).join("、") : "";
      return "<tr><td><span class=\"sc-dot\" style=\"background:" + color(o.id) + '"></span><b>' + esc(o.id) + "</b></td><td>" + esc(o.customer || "") + "</td><td>" + esc(o.product) + ' <span class="erp-muted">' + esc(prodName(o.product)) + "</span></td>"
        + '<td class="r">' + Number(o.qty).toLocaleString() + "</td><td>" + esc(fmtRel(o.release)) + "</td><td>" + esc(o.due || "—") + "</td><td>" + (o.weight >= 3 ? '<span class="erp-st warn">急</span>' : o.weight >= 2 ? '<span class="erp-st info">重要</span>' : "一般") + "</td>"
        + "<td>" + esc(f) + "</td><td>" + '<button class="dbmini" data-ord="edit" data-k="' + k + '">' + ic("edit") + '</button><button class="dbmini" data-ord="del" data-k="' + k + '">' + ic("trash") + "</button></td></tr>";
    }).join("");
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("clipboard") + "要排的訂單（" + S.orders.length + " 張）</h3>"
      + '<div class="erp-row"><button class="dbbtn primary" data-ord="add">' + ic("plus") + '新增訂單</button><button class="dbbtn" data-ord="erp">' + ic("factory") + '從 ERP 匯入</button><button class="dbbtn" data-ord="demo">' + ic("refresh") + '載入範例</button><button class="dbbtn" data-ord="clear">' + ic("eraser") + "清空</button></div></div>"
      + '<div class="erp-muted">在這裡改訂單後，回「排程看板」按「重新最佳化」（已開工的不動）或「從頭排程」。發生插單、急單等狀況時，建議直接用看板上的「臨時狀況」按鈕，會有前後對照。</div>'
      + '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>單號</th><th>客戶</th><th>產品</th><th class="r">數量</th><th>可開工</th><th>交期</th><th>重要度</th><th>指定</th><th></th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="9" class="dbempty">還沒有訂單。按「新增訂單」或「從 ERP 匯入」。</td></tr>') + "</tbody></table></div></div>";
  }
  function fmtRel(r) {
    if (r == null || r === "") return "隨時";
    if (typeof r === "number") return cur ? fmtDT(cur.M.cal, r) : "—";
    return String(r).replace("T", " ");
  }
  function typeName(id) { var t = S.cfg.types.filter(function (x) { return x.id === id; })[0]; return t ? t.name : id; }
  function editOrder(k) {
    var o = k == null ? { id: "WO-" + (100 + S.orders.length + 1), customer: "", product: S.cfg.products[0] && S.cfg.products[0].id, qty: 500, release: today(), due: "", weight: 1 } : S.orders[k];
    var prodOpts = S.cfg.products.map(function (p) { return [p.id, p.id + " " + p.name]; });
    if (!prodOpts.length) { toast("請先到「工廠設定」新增產品。", true); return; }
    var stOpts = [["", "（交給系統決定）"]];
    dialog(k == null ? "新增訂單" : "編輯訂單 " + o.id, null, [
      { k: "id", label: "單號", value: o.id, req: true },
      { k: "customer", label: "客戶", value: o.customer || "" },
      { k: "product", label: "產品", type: "select", opts: prodOpts, value: o.product },
      { k: "qty", label: "數量（件）", type: "number", min: 1, value: o.qty, req: true },
      { k: "release", label: "最早可開工日（材料到的那天）", type: "date", value: typeof o.release === "string" ? o.release.slice(0, 10) : "" },
      { k: "due", label: "交期", type: "date", value: o.due || "" },
      { k: "weight", label: "重要度", type: "select", opts: weightOpts(), value: String(o.weight || 1) },
      { k: "out", label: "指定外包的站", type: "select", opts: stOpts.concat(S.cfg.stages.map(function (s) { return [s.id, s.name]; })), value: o.force ? Object.keys(o.force).filter(function (x) { return o.force[x] === "out"; })[0] || "" : "" }
    ], function (v) {
      var id = v.id.trim(); if (!id) throw new Error("請填單號");
      if (S.orders.some(function (x, j) { return x.id === id && j !== k; })) throw new Error("單號重複");
      var force = {}; Object.keys(o.force || {}).forEach(function (sid) { if (o.force[sid] !== "out") force[sid] = o.force[sid]; });
      if (v.out) force[v.out] = "out";
      var rec = Object.assign({}, o, { id: id, customer: v.customer, product: v.product, qty: Math.max(1, Math.round(num(v.qty, 1))), release: typeof o.release === "string" && o.release.slice(0, 10) === v.release ? o.release : v.release || "", due: dueToDate(v.due), weight: +v.weight, force: Object.keys(force).length ? force : undefined });
      if (k == null) S.orders.push(rec); else S.orders[k] = rec;
      S.demo = false; save(); rebuild(); render();
    }, "儲存");
  }
  function importErp() {
    var b = bridge();
    var p = b && b.authed() ? b.call("erpLoad", {}).then(function (d) { return d && d.ok ? d.world : null; }) : Promise.resolve(lsGet("erp_world_local"));
    p.then(function (w) {
      if (!w) { toast("讀不到 ERP 資料（未登入時讀本機試用資料）。", true); return; }
      var items = {}; (w.items || []).forEach(function (it) { items[it.id] = it; });
      var cust = {}; (w.customers || []).forEach(function (c) { cust[c.id] = c.name; });
      var prods = {}; S.cfg.products.forEach(function (p2) { prods[p2.id] = p2; });
      var cand = [];
      (w.workorders || []).forEach(function (o) {
        if (["計畫", "已備料", "生產中"].indexOf(o.status) < 0) return;
        var sku = o.bom && o.bom.sku;
        cand.push({ id: o.no, customer: "", product: sku, qty: o.qty, due: o.due || "", src: "工單 · " + o.status, ok: !!prods[sku] });
      });
      (w.orders || []).forEach(function (o) {
        if (o.cancelled) return;
        (o.lines || []).forEach(function (l, k) {
          var it = items[l.item_id], left = (l.qty || 0) - (l.shipped || 0);
          if (!it || left <= 0) return;
          cand.push({ id: o.no + (o.lines.length > 1 ? "-" + (k + 1) : ""), customer: cust[o.customer_id] || "", product: it.sku, qty: left, due: o.due || "", src: "銷售訂單未出貨", ok: !!prods[it.sku] });
        });
      });
      cand = cand.filter(function (c) { return !S.orders.some(function (o) { return o.id === c.id; }); });
      if (!cand.length) { toast("ERP 裡沒有新的工單或未出貨訂單可以匯入。"); return; }
      var html = '<div class="sc-imp">' + cand.map(function (c, k) {
        return '<label class="sc-impr' + (c.ok ? "" : " no") + '"><input type="checkbox" name="c' + k + '"' + (c.ok ? " checked" : " disabled") + "><b>" + esc(c.id) + "</b> " + esc(c.product) + " × " + c.qty + (c.due ? " · 交期 " + esc(c.due) : "") + ' <span class="erp-muted">' + esc(c.src) + (c.ok ? "" : " · 工廠設定沒有這個產品的途程，先到「工廠設定」新增") + "</span></label>";
      }).join("") + "</div>";
      dialog("從 ERP 匯入", "勾選要排的單。同一張銷售訂單若已開工單，建議只匯入工單，避免重複。", [{ html: html }], function () {
        var form = document.querySelector(".dbmodal form"), n = 0;
        cand.forEach(function (c, k) {
          var el = form.elements["c" + k]; if (!el || !el.checked) return;
          S.orders.push({ id: c.id, customer: c.customer, product: c.product, qty: c.qty, release: "", due: c.due || null, weight: 1 }); n++;
        });
        S.demo = false; save(); rebuild(); render(); toast("已匯入 " + n + " 張。");
      }, "匯入");
    });
  }

  // ---------------------------------------------------------------------------
  // 工廠設定
  // ---------------------------------------------------------------------------
  function factoryTab() {
    var c = S.cfg, cl = c.calendar || {};
    var days = [1, 2, 3, 4, 5, 6, 0].map(function (d) { return '<label class="sc-day"><input type="checkbox" data-cal="day" value="' + d + '"' + ((cl.days || []).indexOf(d) >= 0 ? " checked" : "") + ">" + WD[d] + "</label>"; }).join("");
    var stRows = c.stages.map(function (s, k) {
      var o = s.out || {};
      return '<tr data-k="' + k + '"><td class="r">' + (k + 1) + '</td><td><input data-st="name" value="' + esc(s.name) + '"></td>'
        + '<td><select data-st="mode" title="' + esc(MODE_HINT[s.mode]) + '">' + Object.keys(MODE).map(function (m) { return '<option value="' + m + '"' + (m === s.mode ? " selected" : "") + ">" + MODE[m] + "</option>"; }).join("") + "</select></td>"
        + '<td><input data-st="setup" type="number" min="0" value="' + (s.setup || 0) + '"></td>'
        + '<td><input data-st="out" type="checkbox"' + (o.allowed ? " checked" : "") + '></td><td><input data-st="lead" type="number" min="0" step="0.5" value="' + (o.leadDays || 0) + '"></td><td><input data-st="cost" type="number" min="0" step="0.5" value="' + (o.cost || 0) + '"></td>'
        + '<td><button class="dbmini" data-sta="up" title="往前">↑</button><button class="dbmini" data-sta="down" title="往後">↓</button><button class="dbmini" data-sta="del" title="刪除">' + ic("trash") + "</button></td></tr>";
    }).join("");
    var tyRows = c.types.map(function (t, k) {
      return '<tr data-k="' + k + '"><td><select data-ty="stage">' + c.stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === t.stage ? " selected" : "") + ">" + esc(s.name) + "</option>"; }).join("") + "</select></td>"
        + '<td><input data-ty="name" value="' + esc(t.name) + '"></td><td><input data-ty="count" type="number" min="0" value="' + t.count + '"></td><td><input data-ty="fixed" type="number" min="0" value="' + (t.fixed || 0) + '"></td>'
        + '<td><button class="dbmini" data-tya="del">' + ic("trash") + "</button></td></tr>";
    }).join("");
    var prRows = c.products.map(function (p, k) {
      var r = c.stages.map(function (s) {
        var m = (p.route || {})[s.id] || {}, ks = Object.keys(m).filter(function (x) { return m[x] !== "" && m[x] != null; });
        return ks.length ? esc(s.name) + "：" + ks.map(function (x) { return esc(typeName(x)) + " " + (typeof m[x] === "object" ? m[x].unit : m[x]); }).join("／") : "";
      }).filter(Boolean).join("；");
      return "<tr><td><b>" + esc(p.id) + "</b></td><td>" + esc(p.name) + '</td><td class="r">' + esc((p.split || []).join(" / ")) + '</td><td class="r">' + (p.batch || "整單") + '</td><td class="sc-route">' + r + "</td>"
        + '<td><button class="dbmini" data-pra="edit" data-k="' + k + '">' + ic("edit") + '</button><button class="dbmini" data-pra="del" data-k="' + k + '">' + ic("trash") + "</button></td></tr>";
    }).join("");
    return '<div class="erp-notice sc-warn">' + ic("info") + "<div>先用合理的預設值試排；之後照實際情況改（站別、機台數量、每件幾分鐘）。改完回「排程看板」按「從頭排程」。"
      + "時間都是<b>分鐘</b>；「每件分鐘」可以用工時紀錄或標準工時。</div></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("calendar") + '工作日曆</h3></div><div class="sc-calrow"><div><span class="erp-muted">上班日</span><div class="sc-days">' + days + "</div></div>"
      + '<label class="dbfield"><span>每天幾點開工</span><input data-cal="dayStart" type="number" min="0" max="23" value="' + (cl.dayStart != null ? cl.dayStart : 8) + '"></label>'
      + '<label class="dbfield"><span>每天工時（小時；兩班＝16）</span><input data-cal="hours" type="number" min="1" max="24" value="' + (cl.hours || 16) + '"></label>'
      + '<label class="dbfield sc-hol"><span>休假日（國定假日、公司休假；日期用逗號或空白隔開）</span><input data-cal="holidays" type="text" value="' + esc((cl.holidays || []).join(", ")) + '" placeholder="例：2026-10-25, 2026-12-31"></label></div></div>'
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("layers") + "站別（照生產順序）</h3>" + '<button class="dbbtn" data-sta="add">' + ic("plus") + "新增站別</button></div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-cfg"><thead><tr><th>#</th><th>站名</th><th>生產方式</th><th>換線分鐘</th><th>可外包</th><th>外包天數</th><th>外包單價/件</th><th></th></tr></thead><tbody>' + stRows + "</tbody></table></div>"
      + '<ul class="erp-muted sc-modehelp">' + Object.keys(MODE).map(function (m) { return "<li><b>" + MODE[m] + "</b>：" + esc(MODE_HINT[m]) + "</li>"; }).join("") + "<li><b>換線分鐘</b>：同一台機台換做不同產品要多花的整備時間。</li></ul></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("wrench") + "機型與台數</h3>" + '<button class="dbbtn" data-tya="add">' + ic("plus") + "新增機型</button></div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-cfg"><thead><tr><th>站別</th><th>機型名稱</th><th>台數</th><th>每次上機固定分鐘</th><th></th></tr></thead><tbody>' + tyRows + "</tbody></table></div>"
      + '<div class="erp-muted">每次上機固定分鐘：上料、對刀、一爐的固定時間等（不管做幾件都要花）。</div></div>'
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("box") + "產品途程（每件分鐘）</h3>" + '<button class="dbbtn" data-pra="add">' + ic("plus") + "新增產品</button></div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>料號</th><th>品名</th><th class="r">子批大小</th><th class="r">併批上限</th><th>可以在哪些機型做（每件分鐘）</th><th></th></tr></thead><tbody>' + prRows + "</tbody></table></div>"
      + '<div class="erp-muted">料號跟 ERP 一樣，匯入工單時就對得上。子批大小可以填兩種（例：50 / 100），系統會挑比較好的。</div></div>'
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("undo") + "還原</h3></div><div class=\"erp-row\">"
      + '<button class="dbbtn" data-cfg="default">' + ic("refresh") + '還原九上預設工廠</button><button class="dbbtn" data-cfg="thesis">' + ic("book") + "載入論文範例（封裝廠）</button></div>"
      + '<div class="erp-muted">論文範例：黏晶 DB → 銲線 WB → 封膠 MD 兩張單，可以在「方法說明」看到系統算出來跟論文一樣。</div></div>';
  }
  function cfgChanged() {
    try { E.compile(planCfg(), S.orders.filter(function (o) { return S.cfg.products.some(function (p) { return p.id === o.product; }); })); }
    catch (e) { toast("設定有問題：" + e.message, true); }
    S.demo = false; logCfg(); save(); rebuild();
  }
  function editProduct(k) {
    var c = S.cfg, p = k == null ? { id: "", name: "", split: [50, 100], batch: 400, route: {} } : c.products[k];
    var grid = '<div class="sc-routeedit">' + c.stages.map(function (s) {
      var ts = c.types.filter(function (t) { return t.stage === s.id; });
      return '<div class="sc-rs"><b>' + esc(s.name) + '</b><span class="erp-muted">（' + MODE[s.mode] + "）</span><div class=\"sc-rtypes\">" + (ts.length ? ts.map(function (t) {
        var v = ((p.route || {})[s.id] || {})[t.id]; v = v == null ? "" : typeof v === "object" ? v.unit : v;
        return '<label><span>' + esc(t.name) + '</span><input type="number" min="0" step="0.01" name="r_' + esc(s.id) + "__" + esc(t.id) + '" value="' + esc(v) + '" placeholder="不能做"></label>';
      }).join("") : '<span class="erp-muted">這站還沒有機型</span>') + "</div></div>";
    }).join("") + '<div class="erp-muted">每件要幾分鐘；空白＝這個機型不能做。整站都空白＝這個產品不經過這站。</div></div>';
    dialog(k == null ? "新增產品" : "編輯產品 " + p.id, null, [
      { k: "id", label: "料號（跟 ERP 一樣）", value: p.id, req: true },
      { k: "name", label: "品名", value: p.name, req: true },
      { k: "split", label: "子批大小（件，可填兩種，用 / 分開）", value: (p.split || []).join(" / ") },
      { k: "batch", label: "併批上限（件，0＝整張單一批）", type: "number", min: 0, value: p.batch || 0 },
      { html: grid }
    ], function (v) {
      var id = v.id.trim(); if (!id) throw new Error("請填料號");
      if (c.products.some(function (x, j) { return x.id === id && j !== k; })) throw new Error("料號重複");
      var form = document.querySelector(".dbmodal form"), route = {};
      c.stages.forEach(function (s) {
        c.types.filter(function (t) { return t.stage === s.id; }).forEach(function (t) {
          var el = form.elements["r_" + s.id + "__" + t.id], x = el ? Number(el.value) : 0;
          if (el && el.value !== "" && x > 0) { route[s.id] = route[s.id] || {}; route[s.id][t.id] = x; }
        });
      });
      if (!Object.keys(route).length) throw new Error("至少要有一站可以做");
      var split = String(v.split).split(/[\/,、\s]+/).map(Number).filter(function (x) { return x > 0; }).slice(0, 4);
      var rec = { id: id, name: v.name, split: split.length ? split : [100], batch: Math.max(0, num(v.batch, 0)), route: route };
      if (k == null) c.products.push(rec);
      else {
        var old = c.products[k].id; c.products[k] = rec;
        if (old !== id) S.orders.forEach(function (o) { if (o.product === old) o.product = id; });
      }
      cfgChanged(); render();
    }, "儲存");
  }

  // ---------------------------------------------------------------------------
  // 方法說明（含論文驗證）
  // ---------------------------------------------------------------------------
  function methodTab() {
    return '<div class="erp-sec sc-method"><div class="erp-sechead"><h3>' + ic("book") + "這個排程怎麼算的（白話）</h3></div>"
      + "<ol class=\"erp-steps\">"
      + "<li><b>先把工廠「模擬」一遍</b>：照你設定的站別、機台、每件工時，電腦把每張單一站一站做下去，算出每台機台什麼時候做什麼、每張單幾點完工（論文的「模擬」）。</li>"
      + "<li><b>每張單要決定三件事</b>：每一站用哪一種機台（或外包）、要拆成多大的子批、誰先做。照論文的限制：同一張單在同一站的所有子批，要用同一種機型。</li>"
      + "<li><b>讓排法「演化」</b>：先放幾個好的起點（現場做法、交期優先 EDD、加權急迫度 ATC、NEH 插入法），再用<b>基因演算法</b>：好的排法留下一半，互相交配、隨機突變，一代代變好（論文的 GA：菁英 50%、交配 0.8、突變 0.4）。</li>"
      + "<li><b>局部再修</b>：每一代把最好的排法拆掉幾張單、一張張插回最好的位置（<b>迭代貪婪 IG</b>），也試著把最慢那張單換機台、換子批大小。</li>"
      + "<li><b>加工時間有誤差時</b>：勾「考慮加工時間誤差」，每種排法模擬多次取平均，並用 <b>OCBA</b> 把模擬次數集中在「差不多好、難分高下」的排法上，省時間又選得準（論文方法）。</li>"
      + "<li><b>兩個目標一起顧</b>：平均生產週期（效率）＋加權延遲（準時）；「取捨圖」列出各種不被打敗的選擇，你可以挑偏快或偏準時的。</li>"
      + "<li><b>臨時狀況</b>：插單、急單、外包、機台故障、取消、改交期時，已開工的工序固定不動，只重排其餘的，而且盡量不大改原計畫（穩定度），讓現場不用一直改。</li>"
      + "</ol></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("check") + "跟論文對答案</h3><button class=\"dbbtn\" data-act=\"verify\">" + ic("play") + "再算一次</button></div>"
      + '<div class="erp-muted">陳建銘（2015）論文的範例：半導體封裝廠兩張訂單（A 2,000 件、B 4,000 件），黏晶 DB → 銲線 WB → 封膠 MD。下表是系統用同一組資料算出來的平均流程時間（時間單位同論文），和論文逐項比對。</div>'
      + '<div id="verifyBox"></div></div>'
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("book") + "參考文獻</h3></div><ul class=\"sc-refs\">"
      + "<li>陳建銘（2015）。模擬最佳化應用於半導體後段封裝廠混合流線型排程問題之研究。國立清華大學博士論文。</li>"
      + "<li>Lin, J. T., &amp; Chen, C.-M. (2015). Simulation optimization approach for hybrid flow shop scheduling problem in semiconductor back-end manufacturing. <i>Simulation Modelling Practice and Theory</i>, 51, 100–114.</li>"
      + "<li>Ruiz, R., &amp; Vázquez-Rodríguez, J. A. (2010). The hybrid flow shop scheduling problem. <i>European Journal of Operational Research</i>, 205(1), 1–18.</li>"
      + "<li>Neufeld, J. S., Schulz, S., &amp; Buscher, U. (2023). A systematic review of multi-objective hybrid flow shop scheduling. <i>European Journal of Operational Research</i>, 309(1), 1–23.</li>"
      + "<li>Ruiz, R., &amp; Stützle, T. (2007). A simple and effective iterated greedy algorithm for the permutation flowshop scheduling problem. <i>EJOR</i>, 177(3), 2033–2049.</li>"
      + "<li>Öztop, H., Tasgetiren, M. F., Eliiyi, D. T., &amp; Pan, Q.-K. (2019). Metaheuristic algorithms for the hybrid flowshop scheduling problem. <i>Computers &amp; Operations Research</i>, 111, 177–196.</li>"
      + "<li>Pan, Q.-K., &amp; Ruiz, R. (2013). A comprehensive review and evaluation of permutation flowshop heuristics to minimize flowtime. <i>Computers &amp; Operations Research</i>, 40(1), 117–128.</li>"
      + "<li>Li, C., Han, Y., Zhang, B., Wang, Y., Li, J., &amp; Gao, K. (2024). A novel collaborative iterative greedy algorithm for hybrid flowshop scheduling problem with batch processing machines and variable sublots. <i>International Journal of Production Research</i>, 62(11), 4076–4096.</li>"
      + "<li>Vepsalainen, A. P. J., &amp; Morton, T. E. (1987). Priority rules for job shops with weighted tardiness costs. <i>Management Science</i>, 33(8), 1035–1047.</li>"
      + "<li>Peng, K., Pan, Q.-K., Gao, L., Li, X., Das, S., &amp; Zhang, B. (2019). A multi-start variable neighbourhood descent algorithm for hybrid flowshop rescheduling. <i>Swarm and Evolutionary Computation</i>, 45, 92–112.（機台故障、新單插入，目標含「系統不穩定度」）</li>"
      + "<li>Baykasoğlu, A., Madenoğlu, F. S., &amp; Hamzadayı, A. (2020). Greedy randomized adaptive search for dynamic flexible job-shop scheduling. <i>Journal of Manufacturing Systems</i>, 56, 425–451.</li>"
      + "<li>Uhlmann, I. R., Zanella, R. M., &amp; Frazzon, E. M. (2022). Hybrid flow shop rescheduling for contract manufacturing services. <i>International Journal of Production Research</i>, 60(3), 1069–1085.</li>"
      + "<li>Qi, X. (2011). Outsourcing and production scheduling for a two-stage flow shop. <i>International Journal of Production Economics</i>, 129(1), 43–50.</li>"
      + "<li>Chen, C.-H., Lin, J., Yücesan, E., &amp; Chick, S. E. (2000). Simulation budget allocation for further enhancing the efficiency of ordinal optimization. <i>Discrete Event Dynamic Systems</i>, 10(3), 251–270.（OCBA）</li>"
      + "<li>Serrano-Ruiz, J. C., Mula, J., &amp; Poler, R. (2021). Smart manufacturing scheduling: A literature review. <i>Journal of Manufacturing Systems</i>, 61, 265–287.（深度強化學習等方向；本系統未採用：需要大量歷史資料訓練）</li>"
      + "</ul></div>";
  }
  function afterMethod() { verify(); }
  function verify() {
    var el = document.getElementById("verifyBox"); if (!el) return;
    var M = E.compile(D.thesisConfig(), D.thesisOrders());
    function tx(a, b, seq) { var x = E.blankX(M); x.split[0] = a[0]; x.split[1] = b[0]; x.seq = Int32Array.from(seq || [0, 1]); for (var s = 0; s < 3; s++) { x.asg[s] = a[1 + s]; x.asg[3 + s] = b[1 + s]; } return x; }
    var cases = [["第 2 章範例 方案一：A 子批 500 用 DB2／WB2；B 子批 1000 用 DB1／WB1", [1, 1, 1, 0], [1, 0, 0, 0], 50000],
      ["第 2 章範例 方案二：A 用 DB1／WB1；B 用 DB2／WB2", [1, 0, 0, 0], [1, 1, 1, 0], 44000],
      ["5.1 節範例 方案二：A 改子批 250（其餘同方案一）", [0, 1, 1, 0], [1, 0, 0, 0], 48000],
      ["5.1 節範例 方案三：A 用 DB1／WB1；B 改子批 500 用 DB2／WB2", [1, 0, 0, 0], [0, 1, 1, 0], 42000]];
    var t0 = Date.now(), rows = cases.map(function (c) { var r = E.simulate(M, tx(c[1], c[2])); return "<tr><td>" + c[0] + '</td><td class="r">' + c[3].toLocaleString() + '</td><td class="r"><b>' + r.meanF.toLocaleString() + "</b></td><td>" + (r.meanF === c[3] ? '<span class="erp-good">' + ic("check") + "一致</span>" : '<span class="erp-bad">不同</span>') + "</td></tr>"; });
    var o = E.optimize(M, { weights: { flow: 1, tardy: 0, out: 0 }, timeLimit: 1500 });
    var best = Infinity;
    for (var k = 0; k < 128; k++) { var bit = function (j) { return (k >> j) & 1; }; best = Math.min(best, E.simulate(M, tx([bit(0), bit(1), bit(2), 0], [bit(3), bit(4), bit(5), 0], bit(6) ? [1, 0] : [0, 1])).meanF); }
    el.innerHTML = '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>方案</th><th class="r">論文</th><th class="r">本系統</th><th></th></tr></thead><tbody>' + rows.join("")
      + '<tr class="sc-hlrow"><td><b>本系統最佳化</b>（GA＋IG，' + o.evals + " 種排法、" + (o.elapsed / 1000).toFixed(2) + ' 秒）</td><td class="r">—</td><td class="r"><b>' + o.kpi.meanF.toLocaleString() + "</b></td><td>"
      + (o.kpi.meanF === best ? '<span class="erp-good">' + ic("check") + "＝窮舉 128 種的最佳值</span>" : "窮舉最佳 " + best.toLocaleString()) + "</td></tr></tbody></table></div>"
      + '<div class="erp-muted">論文自己註明這幾個方案只是用來說明（for illustrations），不是在找最佳解。系統用同一個模擬器，把「子批大小 × 機型 × 先後順序」全部 128 種組合都算過，最好的是 <b>' + best.toLocaleString() + "</b>；演化搜尋只試了 " + o.evals + " 種就找到同一個答案。全部計算 " + (Date.now() - t0) + " 毫秒。</div>";
  }

  // ===========================================================================
  // 事件
  // ===========================================================================
  // ===========================================================================
  // 風險監控（KRI）：評估、觸發紀錄、警示列、給首頁／選單／早報用的快照
  //   風險 → 監控指標(KRI) → 容忍度門檻(黃／紅) → 觸發（畫面警示、建議動作、紀錄）→ 處理
  // ===========================================================================
  function stageIdsOf(M, od) { return M.stages.filter(function (st, s) { return od.optType[s][0] !== E.SKIP; }).map(function (st) { return st.id; }); }
  function stagePredOf(P, i, sid) {                  // 目前這個畫面的排程，這張單在這一站的預計 [開始, 完成]（工作分鐘）
    var s = -1; P.M.stages.forEach(function (x, k) { if (x.id === sid) s = k; });
    var ops = P.res.ops.filter(function (op) { return op.o === i && op.s === s; });
    if (!ops.length) return null;
    return [Math.min.apply(null, ops.map(function (o) { return o.start; })), Math.max.apply(null, ops.map(function (o) { return o.end; }))];
  }
  function actsList(M) {                             // 現場回報 → 引擎用的格式（工作分鐘）
    var cal = M.cal, out = [];
    M.orders.forEach(function (od) {
      var a = S.act[od.id]; if (!a) return;
      M.stages.forEach(function (st) {
        var x = a[st.id]; if (!x || x.e == null) return;
        out.push({ id: od.id, sid: st.id, start: x.s != null ? Math.max(0, cal.fromDate(x.s)) : undefined, end: Math.max(0, cal.fromDate(x.e)) });
      });
    });
    return out;
  }
  // 依決策 X 模擬出排程；已回報完工的站，照實際時間凍結（機台提早／延後釋放、下游跟著動）
  function simFull(M, X, lockL, now0, down) {
    var lk = lockFor(M, lockL, now0), base = E.lockSim(lk.lock);
    if (down) base.down = down;
    var res = E.simulate(M, X, Object.assign({}, base, { collect: true })), acts = actsList(M);
    if (acts.length) {
      var L0 = lk.ok && lockL ? lockL : { now: now0 || 0, sig: M.sig, fixed: {}, genes: {} };
      var lk2 = lockFor(M, E.applyActuals(M, X, res, acts, L0), now0);
      if (lk2.ok) { base = E.lockSim(lk2.lock); if (down) base.down = down; res = E.simulate(M, X, Object.assign({}, base, { collect: true })); lk = lk2; }
    }
    return { res: res, base: base, lk: lk, acts: acts };
  }
  // ---------------------------------------------------------------------------
  // 風險儀表板：歷史、趨勢、熱度圖、最近惡化、單一指標的曲線
  // ---------------------------------------------------------------------------
  function leadCtx(P) {                             // 領先指標：未來 5 個工作日的負荷、交期緩衝、準時機率、外包佔比
    var M = P.M, cal = M.cal, per = cal.per, now = nowMin(cal), W = 5 * per, end = now + W, res = P.res;
    var units = M.stages.map(function (st) { var n = 0; st.types.forEach(function (ti) { n += M.types[ti].count; }); return n; });
    var done = M.orders.map(function (od) { var a = S.act[od.id] || {}, sids = stageIdsOf(M, od), la = a[sids[sids.length - 1]]; return !!(la && la.e != null); });
    var load = M.stages.map(function () { return 0; }), slackSum = 0, slackN = 0, probSum = 0, probN = 0, outQ = 0, totQ = 0, outOrd = {};
    res.ops.forEach(function (op) {
      if (done[op.o]) return;
      if (op.kind === "out") { outOrd[op.o] = 1; return; }
      var od = M.orders[op.o];
      if (od.due != null && od.due <= end && op.end > now) load[op.s] += op.end - Math.max(op.start, now);
    });
    M.orders.forEach(function (od, i) {
      if (done[i]) return;
      totQ += od.qty; if (outOrd[i]) outQ += od.qty;
      if (od.due != null) { slackSum += od.due - res.C[i]; slackN++; if (P.risk && P.risk[i]) { probSum += P.risk[i].onTimeProb; probN++; } }
    });
    var best = null, name = "";
    M.stages.forEach(function (st, s) { if (!units[s]) return; var r = load[s] / (units[s] * W); if (best == null || r > best) { best = r; name = st.name; } });
    return { load: best, loadName: name, slack: slackN ? slackSum / slackN : null, prob: probN ? probSum / probN : null, outPct: totQ ? outQ / totQ : null };
  }
  function histPush(items, changed) {               // 每 30 分鐘最多記一筆（燈號有變就立刻記），最多留 600 筆
    var now = Date.now(), last = S.hist[S.hist.length - 1];
    if (last && now - last.t < 30 * 60000 && !changed) return false;
    var v = {}; items.forEach(function (x) { if (x.value != null && isFinite(x.value)) v[x.id] = Math.round(x.value * 100) / 100; });
    S.hist.push({ t: now, v: v });
    if (S.hist.length > 600) { var old = S.hist.splice(0, 200).filter(function (p, k) { return k % 2 === 0; }); S.hist = old.concat(S.hist); }
    return true;
  }
  var histT = null;
  function publishHist() {
    if (!authed()) return;
    clearTimeout(histT);
    histT = setTimeout(function () {
      var b = bridge(); if (!b || !b.authed()) return;
      var rows = strRows("hist", JSON.stringify(S.hist)), ids = rows.map(function (r) { return r.id; }), stale = (S.histIds || []).filter(function (id) { return ids.indexOf(id) < 0; });
      putRows(b, rows, "sched_hist").then(function (d) { if (d && !d.error) { S.histIds = ids; stale.forEach(function (id) { b.call("tRemove", { table: "sched_hist", id: id }); }); } });
    }, 2000);
  }
  function loadHist(b) {                            // 登入後讀回公司端累積的歷史（比較長的那份留下）
    b.call("tList", { table: "sched_hist" }).then(function (d) {
      if (!d || !d.rows || !d.rows.length) return;
      var rows = d.rows.map(function (r) { return { id: String(r.id), data: String(r.data == null ? "" : r.data).replace(/^~/, "") }; }), arr = blobGet("hist", rows);
      S.histIds = rows.map(function (r) { return r.id; });
      if (arr && arr.length >= S.hist.length) { S.hist = arr; lsSet(KEY, S); if (cur && cur.M) { kriTick(); if (V.tab === "dash") render(); } }
    });
  }
  function histOf(id, days) { var cut = Date.now() - days * 86400000; return S.hist.filter(function (p) { return p.t >= cut && p.v[id] != null; }).map(function (p) { return [p.t, p.v[id]]; }); }
  function trendText(x, tr) {
    if (!tr || tr.dir === "none") return '<span class="sc-tr none">資料累積中</span>';
    var t = tr.dir === "worse" ? '<span class="sc-tr worse">▲ 惡化中</span>' : tr.dir === "better" ? '<span class="sc-tr better">▼ 改善中</span>' : '<span class="sc-tr flat">● 持平</span>';
    if (tr.eta) t += ' <span class="sc-eta">預計 ' + (tr.eta.days < 1 ? "不到 1 天" : tr.eta.days.toFixed(1).replace(/\.0$/, "") + " 天") + "後轉" + (tr.eta.to === "red" ? "紅燈" : "黃燈") + "</span>";
    return t;
  }
  function svgChart(x, w, h, days, big) {
    var pts = histOf(x.id, days);
    if (pts.length < 2) return '<span class="erp-muted">歷史累積中（每 30 分鐘記一筆）</span>';
    var vs = pts.map(function (p) { return p[1]; }).concat([x.y]); if (x.r != null) vs.push(x.r);
    var mn = Math.min.apply(null, vs), mx = Math.max.apply(null, vs); if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var padv = (mx - mn) * 0.08; mn -= padv; mx += padv;
    var L = big ? 44 : 2, R = big ? 8 : 2, T = big ? 8 : 3, B = big ? 22 : 3, t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    function X(t) { return L + (t - t0) / Math.max(1, t1 - t0) * (w - L - R); }
    function Y(v) { return T + (mx - v) / (mx - mn) * (h - T - B); }
    var d = pts.map(function (p, k) { return (k ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join("");
    var g = '<line class="ch-y" x1="' + L + '" x2="' + (w - R) + '" y1="' + Y(x.y) + '" y2="' + Y(x.y) + '"/>';
    if (x.r != null) g += '<line class="ch-r" x1="' + L + '" x2="' + (w - R) + '" y1="' + Y(x.r) + '" y2="' + Y(x.r) + '"/>';
    g += '<path class="ch-l" d="' + d + '"/><circle class="ch-d lv-' + x.level + '" cx="' + X(t1) + '" cy="' + Y(pts[pts.length - 1][1]) + '" r="' + (big ? 4 : 2.6) + '"/>';
    if (big) {
      g += '<text class="ch-t" x="' + (L - 4) + '" y="' + (Y(mx - padv) + 4) + '" text-anchor="end">' + (+(mx - padv).toFixed(1)) + '</text><text class="ch-t" x="' + (L - 4) + '" y="' + (Y(mn + padv) + 4) + '" text-anchor="end">' + (+(mn + padv).toFixed(1)) + "</text>"
        + '<text class="ch-t" x="' + L + '" y="' + (h - 6) + '">' + esc(fmtWhen(t0)) + '</text><text class="ch-t" x="' + (w - R) + '" y="' + (h - 6) + '" text-anchor="end">' + esc(fmtWhen(t1)) + "</text>"
        + '<text class="ch-ty" x="' + (w - R - 2) + '" y="' + (Y(x.y) - 3) + '" text-anchor="end">黃線 ' + x.y + "</text>" + (x.r != null ? '<text class="ch-tr" x="' + (w - R - 2) + '" y="' + (Y(x.r) - 3) + '" text-anchor="end">紅線 ' + x.r + "</text>" : "");
    }
    return '<svg class="sc-spark' + (big ? " big" : "") + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' + g + "</svg>";
  }
  function alertsBox() {                             // 自動通知送出的警示：誰收到、有沒有人處理
    if (!authed()) return "";
    var nt = lsGet("sched_notice_v1") || {}, al = nt.alerts || {}, hb = nt.hb || 0;
    var act = Object.keys(al).map(function (k) { return al[k]; }).filter(function (x) { return Number(x.active) === 1; });
    var rows = act.map(function (x) {
      var ack = Number(x.ack) === 1;
      return "<tr><td>" + lvTag(x.level) + "<b>" + esc(x.name) + "</b>（" + esc(x.display) + ")</td><td class=\"nw\">" + esc(x.owner || "") + "</td><td class=\"nw\">" + (x.first ? fmtWhen(Number(x.first)) : "—") + "</td><td>" + (ack ? '<span class="erp-good">✓ ' + esc(x.ackBy || "") + " 已知悉</span>" : x.level === "red" && Number(x.esc) === 1 ? '<span class="erp-bad">已升級通知老闆，尚未處理</span>' : '<span class="erp-warn">尚未處理</span>') + "</td><td>" + (ack ? "" : '<button class="dbmini" data-nack="' + esc(x.id) + '">已知悉</button>') + "</td></tr>";
    }).join("");
    var warn = !hb ? "自動通知排程還沒啟用（要貼上 sched-alerts.gs 並執行 installSchedAlertTrigger）" : "";
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("bell") + "待處理的警示（自動通知）</h3><button class=\"dbmini\" data-tab=\"risk\">通知設定</button></div>"
      + (warn ? '<div class="erp-bad">' + esc(warn) + "</div>" : "")
      + (rows ? '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>警示</th><th>負責人</th><th>開始時間</th><th>處理狀態</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<div class="erp-muted">' + (hb ? "目前沒有待處理的警示。" : "") + "</div>") + "</div>";
  }
  function dashTab() {
    if (!cur || !cur.M || !V.kri) return '<div class="erp-sec sc-empty"><h3>' + ic("bars") + "風險儀表板</h3><p>要先到「排程看板」按「開始排程」，儀表板才有東西可以看。</p></div>";
    var items = V.kri, tr = V.trend || {}, c = K.counts(items), now = Date.now();
    var rising = items.filter(function (x) { return tr[x.id] && tr[x.id].dir === "worse"; }), soon = items.filter(function (x) { return tr[x.id] && tr[x.id].eta; });
    var wk = {}; S.events.forEach(function (e) { if (!e.type && e.up && now - e.ts < 7 * 86400000 && e.to !== "green") wk[e.id] = 1; });
    var sel = items.filter(function (x) { return x.id === V.dsel; })[0] || rising[0] || items.filter(function (x) { return x.level === "red"; })[0] || items.filter(function (x) { return x.level === "yellow"; })[0] || items.filter(function (x) { return x.level !== "na"; })[0] || items[0];
    var grp = "", tiles = "";
    items.forEach(function (x) {
      if (x.grp !== grp) { tiles += (grp ? "</div>" : "") + '<div class="sc-tilegrp">' + esc(x.grp) + '</div><div class="sc-tiles">'; grp = x.grp; }
      var t = tr[x.id];
      tiles += '<div class="sc-tile lv-' + x.level + (x.id === sel.id ? " sel" : "") + (t && t.dir === "worse" ? " worse" : "") + '" data-dsel="' + x.id + '" title="' + esc(x.hint) + '"><div class="sc-tile-h">' + lvTag(x.level) + "<b>" + esc(x.name) + '</b></div><div class="sc-tile-v">' + esc(x.display) + " " + trendText(x, t) + '</div><div class="sc-tile-s">' + (x.level === "na" ? '<span class="erp-muted">還沒有資料</span>' : svgChart(x, 150, 30, 7, false)) + "</div></div>";
    });
    tiles += "</div>";
    var rank = items.filter(function (x) { return x.level !== "na" && ((tr[x.id] && tr[x.id].dir === "worse") || x.level !== "green"); }).sort(function (a, b) {
      var ea = tr[a.id] && tr[a.id].eta ? tr[a.id].eta.days : 99, eb = tr[b.id] && tr[b.id].eta ? tr[b.id].eta.days : 99;
      return ea - eb || K.LV[b.level] - K.LV[a.level];
    }).slice(0, 6);
    var rk = rank.map(function (x, k) { return '<li data-dsel="' + x.id + '"><span class="sc-rk">' + (k + 1) + "</span>" + lvTag(x.level) + "<b>" + esc(x.name) + "</b>（" + esc(x.display) + "） " + trendText(x, tr[x.id]) + "</li>"; }).join("");
    var st = tr[sel.id], hasH = histOf(sel.id, 14).length;
    var detail = '<div class="sc-detail lv-' + sel.level + '"><div class="sc-dh">' + lvTag(sel.level) + "<b>" + esc(sel.name) + '</b><span class="erp-muted">　' + esc(sel.risk) + "</span></div>"
      + '<div class="sc-dgrid"><div><div class="sc-big">' + esc(sel.display) + "</div><div>" + trendText(sel, st) + "</div>"
      + '<div class="erp-muted" style="margin-top:6px">門檻：' + esc(K.thresholdText(sel)) + "<br>負責人：" + esc(sel.owner) + "<br>" + esc(sel.hint) + "</div>"
      + (sel.msg ? '<div class="sc-dmsg">' + esc(sel.msg) + ' <button class="dbmini" data-kact="' + sel.action + '">' + esc(sel.actionLabel) + "</button></div>" : "") + "</div>"
      + "<div>" + (sel.level === "na" ? '<span class="erp-muted">還沒有資料</span>' : svgChart(sel, 620, 170, 14, true)) + (hasH < 2 ? "" : '<div class="erp-muted">最近 14 天；虛線是黃線、紅線。</div>') + "</div></div></div>";
    var ev = S.events.filter(function (e) { return !e.type; }).slice(0, 8).map(function (e) { return "<li><span>" + fmtWhen(e.ts) + "</span>" + (e.up ? "▲ " : "▼ ") + lvTag(e.from === "na" ? "green" : e.from) + " → " + lvTag(e.to) + " <b>" + esc(e.name) + "</b>（" + esc(e.display) + "）</li>"; }).join("");
    return alertsBox() + '<div class="cards sc-kpis four">'
      + kpiCard("紅燈", "alert", c.red + " 項", "已經越線、要處理", null, c.red ? false : null)
      + kpiCard("黃燈", "info", c.yellow + " 項", "接近風險、要注意", null)
      + kpiCard("惡化中", "chart", rising.length + " 項", "連續往壞的方向走" + (Object.keys(wk).length ? "；本週新轉壞 " + Object.keys(wk).length + " 項" : ""), null, rising.length ? false : null)
      + kpiCard("預計 3 天內轉壞", "clock", soon.length + " 項", soon.length ? soon.slice(0, 2).map(function (x) { return x.name; }).join("、") : "照目前速度，3 天內不會碰到下一道門檻", null, soon.length ? false : null) + "</div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("bars") + "風險熱度圖（點一格看曲線）</h3><span class=\"erp-muted\">顏色＝燈號；小曲線＝最近 7 天；虛線＝黃線、紅線</span></div>" + tiles + "</div>"
      + '<div class="erp-grid2"><div class="erp-sec"><div class="erp-sechead"><h3>' + ic("alert") + "最近惡化排行（最該先處理的在最上面）</h3></div>" + (rk ? '<ol class="sc-rank">' + rk + "</ol>" : '<div class="erp-muted">目前沒有亮燈或惡化中的指標。</div>') + "</div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("list") + "最近燈號變化</h3><button class=\"dbmini\" data-tab=\"risk\">門檻與完整紀錄</button></div>" + (ev ? '<ul class="sc-log sc-evlog">' + ev + "</ul>" : '<div class="erp-muted">還沒有燈號變化。</div>') + "</div></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("bars") + "指標明細</h3></div>" + detail + "</div>"
      + '<div class="erp-muted">歷史每 30 分鐘記一筆（燈號變化時立刻記），最多保留 600 筆；趨勢要累積至少 3 筆、跨 2 小時以上才會判斷。「預計 N 天後轉黃／紅」是用最近幾筆的速度外推，只是預警，不是保證。</div>';
  }

  function kriCtx(P, isPending) {
    var M = P.M, cal = M.cal, tm = function (ms) { return cal.fromDate(ms); }, nowMs = Date.now(), st = stats(P);
    var orders = M.orders.map(function (od, i) {
      var a = S.act[od.id] || {}, pr = S.pred[od.id] || null, sids = stageIdsOf(M, od), la = a[sids[sids.length - 1]];
      return {
        id: od.id, planned: !!pr, predEnd: pr && pr.c != null ? tm(pr.c) : P.res.C[i],
        actEnd: la && la.e != null ? tm(la.e) : null, actInferred: !!(la && la.inferred),
        stages: sids.map(function (sid) {
          var ps = pr && pr.st && pr.st[sid] ? [tm(pr.st[sid][0]), tm(pr.st[sid][1])] : stagePredOf(P, i, sid), x = a[sid];
          return { sid: sid, pred: ps, act: x ? { s: x.s != null ? tm(x.s) : null, e: x.e != null ? tm(x.e) : null, inferred: !!x.inferred } : null };
        })
      };
    });
    var shaky = 0; if (P.risk) P.risk.forEach(function (r, i) { if (M.orders[i].due != null && r.onTimeProb < 0.7) shaky++; });
    var sum = E.summarize(P.res);
    return { nowMin: nowMin(cal), grace: S.grace, stageName: stageName, orders: orders,
      plan: isPending ? { ageDays: 0, fresh: 0, cfgChanged: false } : { ageDays: (nowMs - (S.plan.at || nowMs)) / 86400000, fresh: cur.fresh.length, cfgChanged: !!cur.cfgChanged },
      stats: { hasDue: st.hasDue, late: st.late.length, onTimeRate: sum.onTimeRate, maxLate: st.maxLate, outCost: st.outCost, shaky: P.risk ? shaky : null },
      util: P.an && P.an.bottleneck ? P.an.bottleneck.util : null, lead: leadCtx(P) };
  }
  function kriTick() {                               // 重算燈號；有變化就寫「觸發紀錄」並更新快照
    if (!cur || !cur.M || !cur.res) { V.kri = null; return []; }
    var items = K.evaluate(kriCtx(cur, false), S.tol), ev = K.transitions(S.lastLv, items);
    if (ev.length) {
      var by = who();
      ev.forEach(function (e) { S.events.unshift(Object.assign({ ts: Date.now(), by: by }, e)); });
      S.events = S.events.slice(0, 150);
    }
    S.lastLv = K.levels(items); V.kri = items;
    var pushed = histPush(items, ev.length > 0); V.trend = K.trends(S.hist, items);
    if (ev.length || pushed) { save(); if (pushed) publishHist(); }
    publishKri(items);
    return ev;
  }
  var kriT = null, kriLast = "";
  function publishKri(items) {
    if (!items || !cur || !cur.M) return;
    var M = cur.M, cal = M.cal;
    var ob = M.orders.map(function (od, i) {
      var pr = S.pred[od.id], a = S.act[od.id] || {}, sids = stageIdsOf(M, od), la = a[sids[sids.length - 1]], src = S.orders.filter(function (x) { return x.id === od.id; })[0] || {};
      return { id: od.id, pe: pr && pr.c != null ? pr.c : cal.toDate(cur.res.C[i], true), ae: la && la.e != null ? la.e : null, due: od.due != null ? cal.toDate(od.due, true) : null, erp: src.erpRef || null };
    });
    var tr = V.trend || {}, soonL = items.filter(function (x) { return tr[x.id] && tr[x.id].eta; }).map(function (x) { return { id: x.id, name: x.name, to: tr[x.id].eta.to, days: Math.round(tr[x.id].eta.days * 10) / 10 }; });
    var snap = K.snapshot(items, { by: who(), orders: ob, grace: S.grace, rising: items.filter(function (x) { return tr[x.id] && tr[x.id].dir === "worse"; }).length, soon: soonL });
    lsSet("sched_kri_v1", snap);
    var sig = JSON.stringify(snap.items) + snap.worst + JSON.stringify(ob);
    if (sig === kriLast) return;
    kriLast = sig;
    if (!authed()) return;
    clearTimeout(kriT);
    kriT = setTimeout(function () {                  // 另存一張小表 sched_kri：首頁、選單紅點、每日早報讀這張，不必載入整份排程
      var b = bridge(); if (!b || !b.authed()) return;
      var rows = strRows("kri", JSON.stringify(snap)), ids = rows.map(function (r) { return r.id; }), stale = (S.kriIds || []).filter(function (id) { return ids.indexOf(id) < 0; });
      putRows(b, rows, "sched_kri").then(function (d) { if (d && !d.error) { S.kriIds = ids; stale.forEach(function (id) { b.call("tRemove", { table: "sched_kri", id: id }); }); } });
    }, 1500);
  }
  function lvTag(level) { return '<span class="sc-lv lv-' + level + '">' + K.LABEL[level] + "</span>"; }
  function paintAlert() {
    var el = document.getElementById("schedAlert"); if (!el) return;
    var items = V.kri;
    if (!items) { el.innerHTML = ""; return; }
    var c = K.counts(items), bad = items.filter(function (x) { return x.level === "red" || x.level === "yellow"; }).sort(function (a, b) { return K.LV[b.level] - K.LV[a.level]; });
    if (!bad.length) {
      el.innerHTML = '<div class="sc-alert ok">' + ic("check") + "<b>風險燈號：全部正常</b><span>（" + c.green + " 項正常、" + c.na + " 項還沒有資料）</span>"
        + '<button class="dbmini" data-tab="dash">看風險儀表板</button></div>'; return;
    }
    el.innerHTML = '<div class="sc-alert ' + (c.red ? "red" : "yellow") + '"><div class="sc-alert-head">' + ic("alert") + "<b>風險燈號：" + (c.red ? c.red + " 項紅燈" : "") + (c.red && c.yellow ? "、" : "") + (c.yellow ? c.yellow + " 項黃燈" : "") + "</b>"
      + '<button class="dbmini" data-tab="dash">看風險儀表板</button></div>'
      + bad.slice(0, 5).map(function (x) {
        return '<div class="sc-alrow">' + lvTag(x.level) + "<span><b>" + esc(x.name) + "</b>（" + esc(x.display) + "）" + esc(x.msg) + "</span>"
          + '<button class="dbmini" data-kact="' + x.action + '">' + esc(x.actionLabel) + "</button></div>";
      }).join("") + (bad.length > 5 ? '<div class="erp-muted">…另外還有 ' + (bad.length - 5) + " 項，到「風險儀表板」看。</div>" : "") + "</div>";
  }
  function doKact(a) {                               // 警示列／監控表的「建議動作」
    if (a === "report") { V.tab = "report"; history.replaceState(null, "", "#tab=report"); render(); }
    else if (a === "factory") { V.tab = "factory"; history.replaceState(null, "", "#tab=factory"); render(); }
    else if (a === "board") { V.tab = "board"; history.replaceState(null, "", "#tab=board"); render(); }
    else if (a === "reopt") { V.tab = "board"; render(); reschedule({ desc: "重新最佳化（風險燈號建議）" }); }
    else if (a === "fresh") { V.tab = "board"; render(); if (!confirm("從頭排程會把還沒做的全部重排（已回報完工的站不動），確定？")) return; planFresh(); }
  }

  // ---------------------------------------------------------------------------
  // 進度回報：每一站的實際開工／完工；ERP 工單完工自動帶入整張單完工
  // ---------------------------------------------------------------------------
  function msOf(x) { return x == null ? null : x; }
  function fmtMs(cal, ms, asEnd) { return fmtDT(cal, cal.fromDate(ms), asEnd); }
  function signedH(min) { var h = Math.abs(min) / 60; return (min >= 0 ? "+" : "−") + (h >= 10 ? h.toFixed(0) : h.toFixed(1)).replace(/\.0$/, "") + " 小時"; }
  function reportTab() {
    if (!cur || !cur.M) return '<div class="erp-sec sc-empty"><h3>' + ic("check") + "進度回報</h3><p>要先到「排程看板」按「開始排程」，才有「預計時間」可以和現場實際對照。</p></div>";
    var M = cur.M, cal = M.cal, nowM = nowMin(cal), grace = S.grace, items = V.kri || [];
    var pick = function (id) { return items.filter(function (x) { return x.id === id; })[0] || { display: "—", level: "na" }; };
    var rows = M.orders.map(function (od, i) {
      var sids = stageIdsOf(M, od), a = S.act[od.id] || {}, pr = S.pred[od.id];
      var predEnd = pr && pr.c != null ? cal.fromDate(pr.c) : cur.res.C[i];
      return { i: i, od: od, sids: sids, a: a, pr: pr, predEnd: predEnd };
    }).sort(function (x, y) { return x.predEnd - y.predEnd; });
    var head = M.stages.map(function (s) { return "<th>" + esc(s.name) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      var cells = M.stages.map(function (st, s) {
        if (r.sids.indexOf(st.id) < 0) return '<td class="erp-muted">—</td>';
        var x = r.a[st.id], pp = r.pr && r.pr.st && r.pr.st[st.id] ? [cal.fromDate(r.pr.st[st.id][0]), cal.fromDate(r.pr.st[st.id][1])] : stagePredOf(cur, r.i, st.id);
        var pe = pp ? pp[1] : null;
        if (x && x.e != null) {
          var d = pe != null ? cal.fromDate(x.e) - pe : null, cls = d == null ? "" : Math.abs(d) >= grace ? "erp-bad" : "erp-good";
          return '<td class="sc-rc done"><div>' + (x.inferred ? '<span class="erp-st muted" title="ERP 工單完工，這一站是推定做完；請補上實際時間">~ 推定</span>' : "✓ ") + " " + esc(fmtMs(cal, x.e, true)) + "</div>"
            + (d != null ? '<div class="' + cls + ' sc-rd">' + signedH(d) + (x.src === "erp" ? " · ERP" : "") + "</div>" : "") + "</td>";
        }
        if (x && x.s != null) return '<td class="sc-rc"><div>◐ 開工 ' + esc(fmtMs(cal, x.s)) + '</div><div class="erp-muted sc-rd">預計 ' + (pe != null ? esc(fmtDT(cal, pe, true)) : "—") + "</div></td>";
        if (pe != null && pe + grace < nowM) return '<td class="sc-rc late"><div class="erp-bad">! 逾時未回報</div><div class="erp-muted sc-rd">預計 ' + esc(fmtDT(cal, pe, true)) + "</div></td>";
        return '<td class="sc-rc"><div class="erp-muted">預計 ' + (pe != null ? esc(fmtDT(cal, pe, true)) : "—") + "</div></td>";
      }).join("");
      var lastA = r.a[r.sids[r.sids.length - 1]], tot = "";
      if (lastA && lastA.e != null) {
        var e = cal.fromDate(lastA.e) - r.predEnd; tot = '<span class="' + (Math.abs(e) >= grace ? "erp-bad" : "erp-good") + '">' + (lastA.inferred ? "ERP 完工 " : "已完工 ") + signedH(e) + "</span>";
      } else tot = '<span class="erp-muted">未完工</span>';
      return '<tr data-rep="' + r.i + '"><td class="nw"><span class="sc-dot" style="background:' + color(r.od.id) + '"></span><b>' + esc(r.od.id) + '</b><div class="erp-muted">' + esc(M.prodNames[r.od.product]) + "</div></td>" + cells + "<td class=\"nw\">" + tot + "</td></tr>";
    }).join("");
    var erpN = 0; M.orders.forEach(function (od) { var a = S.act[od.id] || {}, sids = stageIdsOf(M, od), la = a[sids[sids.length - 1]]; if (la && la.src === "erp") erpN++; });
    return '<div class="cards sc-kpis four">'
      + kpiCard("各站完工回報率", "check", pick("D5").display, "已到期的站有幾成回報（寬限 " + fmtDur(cal, grace) + "）", null, pick("D5").level === "red" ? false : null)
      + kpiCard("逾時沒回報", "alert", pick("D4").display, "預計完工已過寬限時間", null, pick("D4").level === "red" ? false : null)
      + kpiCard("最近完工的預測誤差", "clock", pick("D1").display, "實際完工 − 預計完工", null, pick("D1").level === "red" ? false : null)
      + kpiCard("ERP 自動帶入", "factory", erpN + " 張", "ERP 工單完工 → 整張單完工", null) + "</div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("check") + "進度回報（每一站）</h3><div class=\"erp-row\">"
      + '<button class="dbbtn" data-act="erpsync">' + ic("factory") + "從 ERP 帶入完工</button></div></div>"
      + '<div class="erp-muted">點一列回報那張單的每一站「實際開工／完工」。ERP 的工單一按完工，會自動帶入「整張單完工」；各站的時間請現場補上（ERP 推定的站不算已回報）。預計完工過了 ' + esc(fmtDur(cal, grace)) + " 還沒回報會亮燈。回報後排程會照實際進度調整，之後重排也以它為準。</div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-reptbl"><thead><tr><th>訂單</th>' + head + "<th>整張單</th></tr></thead><tbody>" + (body || '<tr><td colspan="9" class="dbempty">沒有訂單。</td></tr>') + "</tbody></table></div></div>";
  }
  function reportDialog(oi) {
    var M = cur.M, cal = M.cal, od = M.orders[oi], sids = stageIdsOf(M, od), a0 = S.act[od.id] || {}, pr = S.pred[od.id];
    var rowsH = sids.map(function (sid) {
      var x = a0[sid], pp = pr && pr.st && pr.st[sid] ? [pr.st[sid][0], pr.st[sid][1]] : (function () { var q = stagePredOf(cur, oi, sid); return q ? [cal.toDate(q[0]), cal.toDate(q[1], true)] : null; })();
      var tag = x && x.inferred ? ' <span class="erp-st muted">ERP 推定</span>' : x && x.src === "erp" ? ' <span class="erp-st info">ERP</span>' : "";
      return "<tr><td class=\"nw\"><b>" + esc(stageName(sid)) + "</b>" + tag + '</td><td class="erp-muted">' + (pp ? esc(fmtMs(cal, pp[0])) + " → " + esc(fmtMs(cal, pp[1], true)) : "—") + "</td>"
        + '<td><input type="datetime-local" name="s_' + esc(sid) + '" value="' + (x && x.s != null ? localInput(x.s) : "") + '"></td>'
        + '<td><input type="datetime-local" name="e_' + esc(sid) + '" value="' + (x && x.e != null ? localInput(x.e) : "") + '"></td>'
        + "<td>" + (pp ? '<button type="button" class="dbmini" data-fill="' + esc(sid) + "|" + localInput(Math.min(pp[0], Date.now())) + "|" + localInput(Math.min(pp[1], Date.now())) + '" title="預計時間；還在未來的就填現在">用預計</button>' : "") + "</td></tr>";
    }).join("");
    var html = '<div class="sc-rep"><table class="sc-reptbl2"><thead><tr><th>站別</th><th>預計</th><th>實際開工</th><th>實際完工</th><th></th></tr></thead><tbody>' + rowsH + "</tbody></table></div>";
    dialog("回報進度：" + od.id + " " + M.prodNames[od.product], "填每一站的實際時間；沒開工紀錄可以只填完工（視為照預計時間開工）；留白＝還沒做。<b>前面的站要先回報，後面的站才能回報。</b>", [{ html: html }], function () {
      var form = document.querySelector(".dbmodal form"), now = Date.now(), na = {}, prevE = null, prevS = null, missing = false, changed = [];
      sids.forEach(function (sid) {
        var nm = stageName(sid), sv = form.elements["s_" + sid].value, ev = form.elements["e_" + sid].value, s = parseLocal(sv), e = parseLocal(ev);
        if ((sv && s == null) || (ev && e == null)) throw new Error(nm + "：時間格式不對");
        if (s != null && e != null && e <= s) throw new Error(nm + "：完工時間要晚於開工時間");
        if ((e != null && e > now + 600000) || (s != null && s > now + 600000)) throw new Error(nm + "：不能填未來的時間");
        if (e != null && missing) throw new Error(nm + "：前面的站還沒回報完工，請先回報前面的站");
        if (e != null && prevE != null && e < prevE) throw new Error(nm + "：完工時間不能早於前一站的完工時間");
        if (s != null && prevS != null && s < prevS) throw new Error(nm + "：開工時間不能早於前一站的開工時間");
        if (e == null) missing = true;
        if (e != null) prevE = e; if (s != null) prevS = s;
        var old = a0[sid];
        if (s == null && e == null) return;
        if (old && (old.e == null ? null : old.e) === e && (old.s == null ? null : old.s) === s) na[sid] = old;
        else { na[sid] = { s: s, e: e, by: who(), src: "manual", ts: now }; changed.push(sid); }
      });
      if (Object.keys(na).length) S.act[od.id] = na; else delete S.act[od.id];
      afterReport(od, sids, changed);
    }, "儲存回報");
  }
  function afterReport(od, sids, changed) {
    save(); rebuild(); render();
    var d1 = (V.kri || []).filter(function (x) { return x.id === "D1"; })[0], lastA = (S.act[od.id] || {})[sids[sids.length - 1]];
    if (lastA && lastA.e != null && changed.indexOf(sids[sids.length - 1]) >= 0 && d1 && d1.msg) toast("已回報。" + (d1.level === "green" ? "預測誤差在容忍度內。" : K.LABEL[d1.level] + "：" + d1.msg), d1.level === "red");
    else toast("已回報，排程已照實際進度調整。");
  }
  function syncErp(silent) {                         // ERP 工單完工 → 整張單完工（只補還沒有手動回報的）
    if (!cur || !cur.M) return;
    var b = bridge();
    var p = b && b.authed() ? b.call("erpLoad", {}).then(function (d) { return d && d.ok ? d.world : null; }) : Promise.resolve(lsGet("erp_world_local"));
    p.then(function (w) {
      if (!w) { if (!silent) toast("讀不到 ERP 資料（未登入時讀本機試用資料）。", true); return; }
      var wo = {}, mv = {}, n = 0, M = cur.M;
      (w.workorders || []).forEach(function (x) { wo[x.no] = x; });
      (w.moves || []).forEach(function (m) { if (m.type === "完工入庫" && m.ref) mv[m.ref] = m; });
      S.orders.forEach(function (o) {
        var ref = o.erpRef || o.id, x = wo[ref], m = mv[ref]; if (!x || x.status !== "完工" || !m) return;
        var ts = Date.parse(m.ts); if (!isFinite(ts)) return;
        var i = -1; M.orders.forEach(function (od, k) { if (od.id === o.id) i = k; }); if (i < 0) return;
        var sids = stageIdsOf(M, M.orders[i]), last = sids[sids.length - 1], a = S.act[o.id] || (S.act[o.id] = {}), cl = a[last];
        if (cl && cl.e != null && (cl.src === "manual" || cl.e === ts)) return;
        a[last] = { s: cl && cl.s != null ? cl.s : null, e: ts, by: m.by || "ERP", src: "erp", ts: Date.now() };
        sids.slice(0, -1).forEach(function (sid) {
          if (a[sid] && a[sid].e != null && !a[sid].inferred) return;
          var pp = S.pred[o.id] && S.pred[o.id].st && S.pred[o.id].st[sid];
          a[sid] = { s: null, e: Math.min(ts, pp ? pp[1] : ts), inferred: true, src: "erp", by: "ERP（推定）", ts: Date.now() };
        });
        n++;
      });
      if (n) { save(); rebuild(); render(); toast("已從 ERP 帶入 " + n + " 張工單的完工。各站的實際時間請現場補上。"); }
      else if (!silent) toast("ERP 沒有新的完工工單可以帶入（單號要和工單號相同）。");
    });
  }

  // ---------------------------------------------------------------------------
  // 風險監控頁：風險登錄表（風險 → 指標 → 門檻 → 觸發）＋觸發紀錄
  // ---------------------------------------------------------------------------
  function notifyBox() {
    var n = S.notify, nt = lsGet("sched_notice_v1") || {}, hb = nt.hb || 0;
    var hbText = !authed() ? "登入公司帳號後，設定才會存到公司試算表、自動通知才讀得到。" : !hb ? "<b class=\"erp-bad\">自動通知排程還沒啟用</b>：要在 Apps Script 貼上 <code>sched-alerts.gs</code>，執行一次 <code>installSchedAlertTrigger</code>。" : "自動通知最近一次檢查：" + Math.round((Date.now() - hb) / 60000) + " 分鐘前（平日 08:00–18:59 每 30 分鐘）。";
    var owners = ["生管", "班長", "業務"].map(function (r) { return '<label class="dbfield"><span>' + r + ' Email（空白＝寄給老闆）</span><input type="text" data-ntf-owner="' + r + '" value="' + esc(n.owners[r] || "") + '" placeholder="例：user@example.com"></label>'; }).join("");
    return '<div class="erp-sec sc-notify"><div class="erp-sechead"><h3>' + ic("bell") + "自動通知設定</h3></div>"
      + '<div class="erp-muted">指標越線時，由 Apps Script 每 30 分鐘檢查並寄信，也寫進網頁右上角的「通知中心」（鈴鐺）。<b>黃燈</b>通知該指標的負責人；<b>紅燈</b>通知負責人加老闆；<b>趨勢預警</b>只放在通知中心，不寄信。同一件事 ' + S.notify.repeatHours + " 小時內不重複寄；紅燈 " + S.notify.escalateMin + " 分鐘沒有人按「已知悉」，會再通知老闆一次。</div>"
      + '<div class="sc-nform"><label class="dbfield"><span>老闆 Email（可填多個，用逗號分開；空白＝用 Apps Script 的 NOTIFY_EMAILS 或試算表擁有者）</span><input type="text" data-ntf="boss" value="' + esc(n.boss) + '" placeholder="例：admin@example.com"></label>' + owners
      + '<label class="dbfield"><span>紅燈沒人處理幾分鐘後，再通知老闆一次</span><input type="number" min="5" step="5" data-ntf="escalateMin" value="' + n.escalateMin + '"></label>'
      + '<label class="dbfield"><span>同一件事幾小時內不重複通知</span><input type="number" min="1" step="1" data-ntf="repeatHours" value="' + n.repeatHours + '"></label>'
      + '<label class="dbfield dbcheck"><input type="checkbox" data-ntf="enabled"' + (n.enabled ? " checked" : "") + ">啟用自動通知</label></div>"
      + '<div class="erp-muted">' + hbText + "</div></div>";
  }
  function setNotify(t) {
    var f = t.getAttribute("data-ntf"), ow = t.getAttribute("data-ntf-owner"), v = t.type === "checkbox" ? t.checked : String(t.value).trim();
    var bad = function (txt) { return txt && txt.split(/[,;\s]+/).some(function (m) { return m && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(m); }); };
    if ((f === "boss" || ow) && bad(v)) { toast("Email 格式不對，沒有儲存。", true); return; }
    if (ow) S.notify.owners[ow] = v;
    else if (f === "boss") S.notify.boss = v;
    else if (f === "enabled") S.notify.enabled = !!v;
    else { var x = Number(v); if (!isFinite(x) || x <= 0) return; S.notify[f] = x; }
    S.events.unshift({ ts: Date.now(), type: "tol", id: "notify", name: "自動通知設定", by: who(), text: ow ? ow + " 的信箱改了" : f === "boss" ? "老闆信箱改了" : f === "enabled" ? (v ? "啟用" : "關閉") : f + " = " + v });
    save(); publishNotify(); render(); toast("通知設定已儲存。");
  }
  function riskTab() {
    if (!cur || !cur.M || !V.kri) return '<div class="erp-sec sc-empty"><h3>' + ic("alert") + "門檻設定</h3><p>要先到「排程看板」按「開始排程」，監控才有東西可以看。</p></div>";
    var items = V.kri, c = K.counts(items), grp = "";
    var rows = items.map(function (x) {
      var g = x.grp !== grp ? '<tr class="sc-grp"><td colspan="8">' + esc(x.grp) + "</td></tr>" : ""; grp = x.grp;
      var lo = x.dir === "lo";
      return g + '<tr class="lv-row lv-' + x.level + '"><td><b>' + esc(x.risk) + '</b></td><td title="' + esc(x.hint) + '">' + esc(x.name) + '<div class="erp-muted">' + esc(x.hint) + "</div></td>"
        + '<td class="nw"><b>' + esc(x.display) + "</b></td><td>" + lvTag(x.level) + '</td>'
        + '<td class="nw">' + (lo ? "低於 " : "≥ ") + '<input class="sc-tin" type="number" step="any" data-kri="' + x.id + '" data-f="y" value="' + x.y + '"> ' + esc(x.unit === "NT$" ? "" : x.unit) + "</td>"
        + '<td class="nw">' + (lo ? "低於 " : "≥ ") + '<input class="sc-tin" type="number" step="any" data-kri="' + x.id + '" data-f="r" value="' + (x.r == null ? "" : x.r) + '" placeholder="關閉"> ' + esc(x.unit === "NT$" ? "" : x.unit) + "</td>"
        + '<td><input class="sc-tin wide" type="text" data-kri="' + x.id + '" data-f="owner" value="' + esc(x.owner) + '"></td>'
        + "<td>" + (x.level === "red" || x.level === "yellow" ? esc(x.msg) + ' <button class="dbmini" data-kact="' + x.action + '">' + esc(x.actionLabel) + "</button>" : '<span class="erp-muted">不用處理</span>') + "</td></tr>";
    }).join("");
    var ev = S.events.slice(0, 40).map(function (e) {
      if (e.type === "tol") return '<li><span>' + fmtWhen(e.ts) + "</span>" + ic("edit") + "<b>" + esc(e.name) + "</b> 門檻改成 " + esc(e.text) + "（" + esc(e.by || "") + "）</li>";
      return "<li><span>" + fmtWhen(e.ts) + "</span>" + (e.up ? "▲ " : "▼ ") + lvTag(e.from === "na" ? "green" : e.from) + " → " + lvTag(e.to) + " <b>" + esc(e.name) + "</b>（" + esc(e.display) + "）" + (e.msg ? " " + esc(e.msg) : "") + "</li>";
    }).join("");
    return '<div class="cards sc-kpis four">'
      + kpiCard("紅燈", "alert", c.red + " 項", "要處理；採用新排程要填原因", null, c.red ? false : null)
      + kpiCard("黃燈", "info", c.yellow + " 項", "注意；採用新排程要確認", null)
      + kpiCard("正常", "check", c.green + " 項", "在容忍度內", null)
      + kpiCard("還沒有資料", "clock", c.na + " 項", "例如還沒有任何完工回報", null) + "</div>"
      + '<div class="erp-sec sc-riskhow"><div class="erp-sechead"><h3>' + ic("shield") + "風險怎麼監控與通知</h3></div>"
      + "<ol class=\"erp-steps\"><li><b>每個風險都連到一個監控指標（KRI）</b>：例如「排程預測和現場脫節」→「完工預測誤差」。</li>"
      + "<li><b>每個指標有黃燈、紅燈兩道門檻</b>（下表可以改）。<b>預測漂移用「連續超標」才升級</b>：連續兩張完工誤差都超過門檻才算紅燈，避免被單次意外嚇到。</li>"
      + "<li><b>亮燈就觸發</b>：排程頁最上方出現警示列、選單出現紅點、首頁出現燈號卡、<b>寫進觸發紀錄</b>；Apps Script 每 30 分鐘自己檢查一次，越線就<b>寄信通知負責人</b>並寫進「通知中心」（右上角鈴鐺）；平日早報信也會帶進去。</li>"
      + "<li><b>採用新排程前再檢查一次</b>：有黃燈要勾選確認、有紅燈要寫原因並二次確認，全部連同你的名字寫進「採用紀錄」。</li>"
      + "<li><b>監控自己也被監控</b>：「回報率」低、「燈號資料太久沒更新」都會亮燈，因為沒人回報的話，漂移指標就是空的。</li></ol>"
      + '<label class="dbfield sc-grace"><span>回報寬限時間（分鐘）：預計完工過了這麼久還沒回報才算逾時</span><input type="number" min="0" step="10" data-grace value="' + S.grace + '"></label>'
      + '<div class="erp-muted">燈號在排程頁開著時每 5 分鐘自動重算一次；也會在回報、採用、改設定時重算。評估時間 ' + fmtWhen(Date.now()) + "。</div></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("shield") + "風險登錄表（風險 → 指標 → 容忍度 → 觸發）</h3>"
      + '<button class="dbbtn" data-act="tolreset">' + ic("undo") + "全部還原預設門檻</button></div>"
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-risktbl"><thead><tr><th>風險</th><th>監控指標（KRI）</th><th>現值</th><th>燈號</th><th>黃燈門檻</th><th>紅燈門檻</th><th>負責人</th><th>亮燈後怎麼辦</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>"
      + notifyBox()
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("list") + "觸發紀錄（燈號變化）</h3></div>"
      + (ev ? '<ul class="sc-log sc-evlog">' + ev + "</ul>" : '<div class="erp-muted">還沒有燈號變化。</div>') + "</div>";
  }

  // ---------------------------------------------------------------------------
  // 採用紀錄與版本回復；工廠設定變更紀錄
  // ---------------------------------------------------------------------------
  var VER_KEY = "sched_ver_v1";
  function pickK(k) { return k ? { meanF: k.meanF, makespan: k.makespan, tardy: k.tardy, onTimeRate: k.onTimeRate, setups: k.setups, cost: k.cost } : null; }
  function slimPlan(p) { var q = Object.assign({}, p); delete q.history; delete q.pareto; return q; }
  function verLocal() { return lsGet(VER_KEY) || {}; }
  function recordVersion(info) {
    var vid = "v" + Date.now().toString(36), snap = JSON.stringify({ plan: slimPlan(S.plan), down: S.down }), rows = strRows(vid, snap);
    var lights = (info.items || []).filter(function (x) { return x.level === "red" || x.level === "yellow"; }).map(function (x) { return { id: x.id, name: x.name, level: x.level, display: x.display }; });
    var meta = { id: vid, ts: Date.now(), by: who(), desc: info.desc, preset: V.preset, out: V.out, noise: V.noise, speed: V.speed, engine: E.VERSION, kri: "1", cfgSig: S.plan.cfgSig, seed: V.lastSeed,
      before: pickK(info.before), after: pickK(info.after), lights: lights, reason: info.ack && info.ack.reason || "", second: !!(info.ack && info.ack.second), restoredFrom: info.restoredFrom || null, chunks: rows.length };
    S.versions.unshift(meta);
    var cut = S.versions.splice(30);                   // 只留最近 30 版的完整排程
    var loc = verLocal(); loc[vid] = snap; cut.forEach(function (m) { delete loc[m.id]; }); lsSet(VER_KEY, loc);
    var b = bridge();
    if (b && b.authed()) {
      S.verSaved = S.verSaved || {}; S.verSaved[vid] = 1;
      putRows(b, rows, "sched_ver");
      cut.forEach(function (m) { for (var k = 0; k < (m.chunks || 1); k++) b.call("tRemove", { table: "sched_ver", id: m.id + "." + k }); });
    }
    return meta;
  }
  function loadVerSnap(vid, cb) {
    var loc = verLocal(); if (loc[vid]) { try { cb(JSON.parse(loc[vid])); return; } catch (e) {} }
    var b = bridge();
    if (!b || !b.authed()) { toast("這個版本的排程內容不在這台電腦上（登入後可從公司試算表讀取）。", true); return; }
    b.call("tList", { table: "sched_ver" }).then(function (d) {
      var rows = d && d.rows ? d.rows.map(function (r) { return { id: String(r.id), data: String(r.data == null ? "" : r.data).replace(/^~/, "") }; }) : [], snap = blobGet(vid, rows);
      if (!snap) { toast("讀不到這個版本的排程內容。", true); return; }
      loc = verLocal(); loc[vid] = JSON.stringify(snap); lsSet(VER_KEY, loc); cb(snap);
    });
  }
  function restoreVersion(vid) {                     // 預覽並回復：走一般的「前後對照 → 採用前檢查 → 採用」流程
    if (!cur || !cur.M) { toast("請先有一份排程。", true); return; }
    if (pending) { toast("請先決定上一個重排結果要不要採用。", true); return; }
    var meta = S.versions.filter(function (m) { return m.id === vid; })[0];
    loadVerSnap(vid, function (snap) {
      var M1;
      try { M1 = E.compile(planCfg(snap.plan.start), S.orders); } catch (e) { toast(e.message, true); return; }
      var X = xFromPlan(M1, snap.plan);
      V.tab = "board";
      showPending({ desc: "回復到 " + fmtWhen(meta ? meta.ts : Date.now()) + " 的排程版本" + (meta ? "（" + meta.desc + "）" : ""), restoredFrom: vid }, M1, { X: X, lockUsed: snap.plan.lock || null }, snap.plan.now0 || 0, S.orders, snap.down || S.down);
    });
  }
  function cfgDiff(a, b) {
    var out = [], i;
    function j(x) { return JSON.stringify(x); }
    var ca = a.calendar || {}, cb = b.calendar || {};
    [["days", "上班日"], ["dayStart", "開工時間"], ["hours", "每天工時"], ["holidays", "休假日"]].forEach(function (f) { if (j(ca[f[0]]) !== j(cb[f[0]])) out.push("日曆「" + f[1] + "」改了"); });
    function byId(l) { var m = {}; (l || []).forEach(function (x) { m[x.id] = x; }); return m; }
    var sa = byId(a.stages), sb = byId(b.stages);
    Object.keys(sb).forEach(function (id) { if (!sa[id]) out.push("新增站別「" + sb[id].name + "」"); else if (j(sa[id]) !== j(sb[id])) out.push("站別「" + sb[id].name + "」改了" + ["name", "mode", "setup", "out"].filter(function (k) { return j(sa[id][k]) !== j(sb[id][k]); }).map(function (k) { return { name: "名稱", mode: "生產方式", setup: "換線分鐘", out: "外包設定" }[k]; }).join("、")); });
    Object.keys(sa).forEach(function (id) { if (!sb[id]) out.push("刪除站別「" + sa[id].name + "」"); });
    var ta = byId(a.types), tb = byId(b.types);
    Object.keys(tb).forEach(function (id) { if (!ta[id]) out.push("新增機型「" + tb[id].name + "」"); else if (j(ta[id]) !== j(tb[id])) out.push("機型「" + tb[id].name + "」" + (ta[id].count !== tb[id].count ? "台數 " + ta[id].count + " → " + tb[id].count : "設定改了")); });
    Object.keys(ta).forEach(function (id) { if (!tb[id]) out.push("刪除機型「" + ta[id].name + "」"); });
    var pa = byId(a.products), pb = byId(b.products);
    Object.keys(pb).forEach(function (id) { if (!pa[id]) out.push("新增產品 " + id); else if (j(pa[id]) !== j(pb[id])) out.push("產品 " + id + (j(pa[id].route) !== j(pb[id].route) ? " 的工時（途程）改了" : " 的批量設定改了")); });
    Object.keys(pa).forEach(function (id) { if (!pb[id]) out.push("刪除產品 " + id); });
    void i; return out;
  }
  function logCfg() {                                // 工廠設定的每次修改：誰、何時、改了什麼，並留可還原的版本
    var now = JSON.stringify(S.cfg);
    if (S.cfgPrev == null) { S.cfgPrev = now; return; }
    if (S.cfgPrev === now) return;
    var t = Date.now(), by = who(), last = S.cfgLog[0], base = S.cfgPrev;
    if (last && last.by === by && t - last.ts < 90000 && last.base) base = last.base;       // 90 秒內連續修改併成一筆
    var text = cfgDiff(JSON.parse(base), S.cfg).join("；") || "設定調整";
    var rec = { ts: t, by: by, text: text, base: base, snap: now };
    if (base !== S.cfgPrev) S.cfgLog[0] = rec; else S.cfgLog.unshift(rec);
    S.cfgLog = S.cfgLog.slice(0, 40);
    S.cfgLog.forEach(function (x, k) { if (k >= 8) { x.base = null; x.snap = null; } });
    S.cfgPrev = now;
  }
  function auditTab() {
    var cal = cur && cur.M ? cur.M.cal : E.calendar(planCfg().calendar);
    var vrows = S.versions.map(function (m, k) {
      var a = m.after, b = m.before;
      var kp = a ? "週期 " + fmtDur(cal, a.meanF) + (b ? "（原 " + fmtDur(cal, b.meanF) + "）" : "") + " · 延遲 " + a.tardy + " 張" + (b ? "（原 " + b.tardy + "）" : "") + (a.cost ? " · 外包費 " + money(a.cost) : "") : "—";
      var lights = m.lights && m.lights.length ? m.lights.map(function (x) { return lvTag(x.level) + esc(x.name); }).join("<br>") : '<span class="erp-good">全綠</span>';
      return "<tr><td class=\"nw\">" + esc(fmtWhen(m.ts)) + (k === 0 ? ' <span class="erp-st ok">目前採用</span>' : "") + '</td><td class="nw">' + esc(m.by || "") + "</td><td>" + esc(m.desc || "") + (m.restoredFrom ? ' <span class="erp-st info">回復</span>' : "") + '<div class="erp-muted">' + esc((PRESET[m.preset] || PRESET.bal).label) + " · " + esc((OUTS[m.out] || OUTS.need).label) + (m.noise ? " · 含加工誤差" : "") + " · 引擎 " + esc(m.engine || "") + (m.seed ? " · 種子 " + m.seed : "") + "</div></td>"
        + "<td>" + kp + "</td><td>" + lights + "</td><td>" + (m.reason ? esc(m.reason) + (m.second ? ' <span class="erp-st warn">已二次確認</span>' : "") : '<span class="erp-muted">—</span>') + "</td>"
        + "<td class=\"nw\">" + (k === 0 ? "" : '<button class="dbmini" data-ver="' + m.id + '">' + ic("undo") + "預覽並回復</button>") + "</td></tr>";
    }).join("");
    var crows = S.cfgLog.map(function (c) {
      return "<tr><td class=\"nw\">" + esc(fmtWhen(c.ts)) + '</td><td class="nw">' + esc(c.by || "") + "</td><td>" + esc(c.text) + "</td><td class=\"nw\">" + (c.base ? '<button class="dbmini" data-cfgrest="' + c.ts + '">' + ic("undo") + "還原到改動前</button>" : '<span class="erp-muted">版本已過期</span>') + "</td></tr>";
    }).join("");
    return '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("list") + "排程採用紀錄（最近 " + S.versions.length + " 版）</h3></div>"
      + '<div class="erp-muted">每次「採用」都留一筆：誰、何時、為什麼、用什麼設定算的、前後差多少、採用當下有哪些燈號、風險確認的原因。可以預覽任何一版並回復（回復也會走一次風險檢查，並多一筆紀錄，歷史不會被刪）。回復只換回當時的排法，已回報的實際進度仍然有效。</div>'
      + '<div class="dbtablewrap"><table class="dbtable erp-table sc-audtbl"><thead><tr><th>時間</th><th>誰</th><th>事由與設定</th><th>前後成績</th><th>採用當下的燈號</th><th>風險確認原因</th><th></th></tr></thead><tbody>'
      + (vrows || '<tr><td colspan="7" class="dbempty">還沒有紀錄；第一次排程之後就會有。</td></tr>') + "</tbody></table></div></div>"
      + '<div class="erp-sec"><div class="erp-sechead"><h3>' + ic("factory") + "工廠設定變更紀錄</h3></div>"
      + '<div class="erp-muted">工時、機台數、站別這些是排程的「參數」，改一個數字就會改變結果，所以每次修改都留紀錄，並保留最近 8 次可還原的版本。</div>'
      + '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>時間</th><th>誰</th><th>改了什麼</th><th></th></tr></thead><tbody>'
      + (crows || '<tr><td colspan="4" class="dbempty">還沒有修改紀錄。</td></tr>') + "</tbody></table></div></div>";
  }

  // ---------------------------------------------------------------------------
  // 採用前的風險檢查：全綠直接採用；黃燈要勾選確認；紅燈要填原因＋二次確認
  // ---------------------------------------------------------------------------
  function gateList(g) {
    return g.red.concat(g.yellow).map(function (x) {
      return '<div class="sc-gl lv-' + x.level + '">' + lvTag(x.level) + "<b>" + esc(x.name) + "</b>：" + esc(x.display)
        + '<div class="erp-muted">' + esc(x.msg || x.risk) + "（" + esc(K.thresholdText(x)) + "；負責人：" + esc(x.owner) + "）</div></div>";
    }).join("");
  }
  function adoptGate() {
    if (!pending) return;
    var items = K.evaluate(kriCtx(pending, true), S.tol), g = K.gate(items);
    if (g.clear) { doAdopt(null, items); return; }
    var html = '<div class="sc-gate">' + gateList(g)
      + '<label class="dbfield"><span>' + (g.needReason ? "有紅燈：請寫下為什麼還是要採用（至少 6 個字）" : "備註（選填）") + '</span><textarea name="reason" rows="3" placeholder="例：客戶指定這週一定要出，先硬排，下週補產能"></textarea></label>'
      + '<label class="dbfield dbcheck"><input type="checkbox" name="ack">我已經看過上面的風險，仍然要採用</label></div>';
    dialog("採用前風險確認：" + (g.red.length ? g.red.length + " 項紅燈" : "") + (g.red.length && g.yellow.length ? "、" : "") + (g.yellow.length ? g.yellow.length + " 項黃燈" : ""),
      g.needReason ? "有紅燈：要寫原因，並在下一步再確認一次。這筆會連同你的名字寫進「採用紀錄」。" : "有黃燈：看過、勾選確認後才能採用。", [{ html: html }], function () {
        var form = document.querySelector(".dbmodal form"), reason = form.elements.reason.value.trim();
        if (!form.elements.ack.checked) throw new Error("請勾選「我已經看過上面的風險，仍然要採用」。");
        if (g.needReason && reason.length < 6) throw new Error("紅燈一定要寫原因（至少 6 個字）。");
        if (g.needReason) { setTimeout(function () { adoptConfirm2(g, items, reason); }, 0); return true; }
        doAdopt({ reason: reason, by: who(), ts: Date.now() }, items); return true;
      }, g.needReason ? "下一步：二次確認" : "確認採用");
  }
  function adoptConfirm2(g, items, reason) {
    if (!pending) return;
    dialog("二次確認：採用含紅燈的排程", "你即將採用一份有 <b>" + g.red.length + " 項紅燈、" + g.yellow.length + " 項黃燈</b> 的排程。<br>原因：「" + esc(reason) + "」<br>這筆會連同你的名字、時間和上面的風險寫進「採用紀錄」，之後可以稽核。", [], function () {
      doAdopt({ reason: reason, second: true, by: who(), ts: Date.now() }, items); return true;
    }, "確定採用（含紅燈）");
  }
  function updatePred(M, res) {                      // 記下「這次採用時的預測」；已回報的站不再更新（才量得出誤差）
    var cal = M.cal;
    M.orders.forEach(function (od, i) {
      var a = S.act[od.id] || {}, sids = stageIdsOf(M, od), pr = S.pred[od.id] || (S.pred[od.id] = { st: {} });
      pr.st = pr.st || {};
      sids.forEach(function (sid) {
        if (a[sid] && a[sid].e != null) return;
        var s = -1; M.stages.forEach(function (x, k) { if (x.id === sid) s = k; });
        var ops = res.ops.filter(function (op) { return op.o === i && op.s === s; }); if (!ops.length) return;
        pr.st[sid] = [cal.toDate(Math.min.apply(null, ops.map(function (o) { return o.start; }))), cal.toDate(Math.max.apply(null, ops.map(function (o) { return o.end; })), true)];
      });
      var la = a[sids[sids.length - 1]];
      if (!(la && la.e != null)) pr.c = cal.toDate(res.C[i], true);
      pr.at = Date.now();
    });
    var ids = {}; M.orders.forEach(function (od) { ids[od.id] = 1; });
    Object.keys(S.pred).forEach(function (id) { if (!ids[id] && !S.act[id]) delete S.pred[id]; });
  }
  function doAdopt(ack, items) {
    if (!pending) return;
    var p = pending, old = cur && cur.plan, before = cur && cur.res ? E.summarize(cur.res) : null, after = E.summarize(p.res);
    S.orders = p.orders; S.down = p.down;
    S.plan = planRecord(p.M, p.X, p.out.heur ? p.out : null, { now0: p.now, start: p.M.cal.start });
    S.plan.lock = p.out.lockUsed || null;
    if (!p.out.heur && old) {                         // 取捨圖上換一個點、或回復舊版：沿用原本的比較資料
      S.plan.heur = old.heur; S.plan.baseF = old.baseF; S.plan.history = old.history; S.plan.stats = old.stats;
      S.plan.pareto = (old.pareto || []).map(function (q, k) { return Object.assign({}, q, { best: k === p.ch.paretoIdx }); });
    } else V.lastOut = p.out;
    V.lastOutPlan = S.plan;
    updatePred(p.M, p.res);
    recordVersion({ desc: p.ch.desc, before: before, after: after, items: items, ack: ack, restoredFrom: p.ch.restoredFrom });
    logAdd(p.ch.desc + (ack && ack.reason ? "（風險確認：" + ack.reason + "）" : ""));
    pending = null; S.demo = false; save(); rebuild(); render(); syncErp(true);
    toast("已採用新排程，並寫進採用紀錄。");
  }
  function gateSummaryHtml() {                       // 對照框裡先預告：按「採用」時會被檢查到什麼
    if (!pending) return "";
    var g = K.gate(K.evaluate(kriCtx(pending, true), S.tol));
    if (g.clear) return '<div class="sc-gatehint ok">' + ic("check") + "採用前風險檢查：全部在容忍度內，可以直接採用。</div>";
    return '<div class="sc-gatehint ' + (g.red.length ? "red" : "yellow") + '">' + ic("alert") + "<b>採用前風險檢查：" + (g.red.length ? g.red.length + " 項紅燈" : "") + (g.red.length && g.yellow.length ? "、" : "") + (g.yellow.length ? g.yellow.length + " 項黃燈" : "") + "</b>（按「採用」時需要"
      + (g.red.length ? "填原因並二次確認" : "勾選確認") + "）<div>" + g.red.concat(g.yellow).map(function (x) { return lvTag(x.level) + esc(x.name) + "：" + esc(x.display); }).join("　") + "</div></div>";
  }

  function restoreCfg(ts) {
    var c = S.cfgLog.filter(function (x) { return x.ts === ts; })[0];
    if (!c || !c.base) { toast("這個版本已過期，無法還原。", true); return; }
    if (!confirm("把工廠設定還原到「" + c.text + "」之前的樣子？（這次還原也會留一筆紀錄）")) return;
    S.cfg = JSON.parse(c.base); cfgChanged(); render(); toast("已還原工廠設定；建議按「從頭排程」。");
  }
  function setTol(id, f, raw) {                      // 改容忍度門檻：記一筆、立刻重算燈號
    var def = K.DEFS.filter(function (d) { return d.id === id; })[0]; if (!def) return;
    var o = S.tol[id] = S.tol[id] || {};
    if (f === "owner") o.owner = String(raw).trim();
    else if (raw === "") { if (f === "r") o.r = null; else return; }
    else { var n = Number(raw); if (!isFinite(n)) return; o[f] = n; }
    var t = K.tolOf(def, S.tol);
    S.events.unshift({ ts: Date.now(), type: "tol", id: id, name: def.name, by: who(), text: K.thresholdText({ dir: def.dir, y: t.y, r: t.r, unit: def.unit }) + "；負責人 " + t.owner });
    save(); kriTick(); render();
  }
  var toastT = null;
  function toast(msg, bad) {
    var el = document.getElementById("schedToast");
    if (!el) { el = document.createElement("div"); el.id = "schedToast"; el.className = "sc-toast"; document.body.appendChild(el); }
    el.textContent = msg; el.className = "sc-toast show" + (bad ? " bad" : "");
    clearTimeout(toastT); toastT = setTimeout(function () { el.className = "sc-toast"; }, bad ? 6000 : 3500);
  }
  mount.addEventListener("click", function (e) {
    var t = e.target.closest("button, .dbtab, [data-o], [data-rep], [data-dsel]"); if (!t || !mount.contains(t)) return;
    var a;
    if ((a = t.getAttribute("data-dsel")) && t.tagName !== "BUTTON") { V.dsel = a; render(); return; }
    if ((a = t.getAttribute("data-nack"))) { if (window.__noticeAck) window.__noticeAck(null, a, function () { render(); }); return; }
    if ((a = t.getAttribute("data-tab"))) { V.tab = a; V.hl = null; history.replaceState(null, "", "#tab=" + a); render(); if (a === "report") syncErp(true); return; }
    var seg = t.parentNode && t.parentNode.getAttribute && t.parentNode.getAttribute("data-seg");
    if (seg) {
      var v = t.getAttribute("data-v");
      if (seg === "preset") V.preset = v; else if (seg === "outs") V.out = v; else if (seg === "speed") V.speed = v; else if (seg === "zoom") V.zoom = +v; else if (seg === "show") { V.show = v; V.hl = null; }
      if (seg === "preset" || seg === "outs") save(false);
      if (seg === "zoom") { drawGantt(); t.parentNode.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === t); }); return; }
      render(); return;
    }
    if ((a = t.getAttribute("data-act"))) {
      if (a === "fresh") { if (cur && cur.M && !confirm("從頭排程會把還沒做的全部重排（已回報完工的站不動），結果會先給你對照，確定？")) return; planFresh(); }
      else if (a === "reopt") reschedule({ desc: "重新最佳化（" + PRESET[V.preset].label + "）" });
      else if (a === "stop") stopRun();
      else if (a === "adopt") adopt();
      else if (a === "discard") discard();
      else if (a === "unhl") { V.hl = null; drawGantt(); paintHl(cur); }
      else if (a === "verify") verify();
      else if (a === "erpsync") syncErp(false);
      else if (a === "tolreset") { if (confirm("全部門檻還原成預設值？（會留一筆紀錄）")) { S.tol = {}; S.events.unshift({ ts: Date.now(), type: "tol", id: "*", name: "全部指標", by: who(), text: "還原預設" }); save(); kriTick(); render(); } }
      return;
    }
    if ((a = t.getAttribute("data-kact"))) { doKact(a); return; }
    if ((a = t.getAttribute("data-ver"))) { restoreVersion(a); return; }
    if ((a = t.getAttribute("data-cfgrest"))) { restoreCfg(+a); return; }
    if ((a = t.getAttribute("data-rep")) != null && V.tab === "report") { reportDialog(+a); return; }
    if ((a = t.getAttribute("data-wi"))) { whatIf(a); return; }
    if ((a = t.getAttribute("data-oact"))) { whatIf(a, t.getAttribute("data-id")); return; }
    if ((a = t.getAttribute("data-ord"))) {
      var k = t.getAttribute("data-k");
      if (a === "add") editOrder(null);
      else if (a === "edit") editOrder(+k);
      else if (a === "del") { if (confirm("刪除訂單 " + S.orders[+k].id + "？")) { S.orders.splice(+k, 1); save(); rebuild(); render(); } }
      else if (a === "erp") importErp();
      else if (a === "demo") { if (confirm("載入範例訂單會取代目前的訂單清單，確定？")) { var cfg = planCfg(today()); S.orders = D.demoOrders(E.calendar(cfg.calendar)); S.plan = null; S.down = []; S.demo = true; pending = null; save(); rebuild(); render(); } }
      else if (a === "clear") { if (confirm("清空全部訂單（排程也會清掉）？")) { S.orders = []; S.plan = null; S.down = []; pending = null; save(); rebuild(); render(); } }
      return;
    }
    if ((a = t.getAttribute("data-sta"))) {
      var tr = t.closest("tr"), i = tr ? +tr.getAttribute("data-k") : -1, st = S.cfg.stages;
      if (a === "add") st.push({ id: uid("S"), name: "新站別", mode: "parallel", setup: 0, out: { allowed: false, leadDays: 2, cost: 0 } });
      else if (a === "up" && i > 0) st.splice(i - 1, 0, st.splice(i, 1)[0]);
      else if (a === "down" && i < st.length - 1) st.splice(i + 1, 0, st.splice(i, 1)[0]);
      else if (a === "del") {
        if (st.length <= 1) { toast("至少要有一個站別。", true); return; }
        if (!confirm("刪除站別「" + st[i].name + "」？這站的機型和產品途程也會一起刪掉。")) return;
        var sid = st[i].id; st.splice(i, 1);
        S.cfg.types = S.cfg.types.filter(function (x) { return x.stage !== sid; });
        S.cfg.products.forEach(function (p) { if (p.route) delete p.route[sid]; });
      }
      cfgChanged(); render(); return;
    }
    if ((a = t.getAttribute("data-tya"))) {
      var tr2 = t.closest("tr"), j = tr2 ? +tr2.getAttribute("data-k") : -1;
      if (a === "add") S.cfg.types.push({ id: uid("T"), stage: S.cfg.stages[0].id, name: "新機型", count: 1, fixed: 0 });
      else if (a === "del") {
        if (!confirm("刪除機型「" + S.cfg.types[j].name + "」？產品途程裡用到它的也會拿掉。")) return;
        var tid = S.cfg.types[j].id; S.cfg.types.splice(j, 1);
        S.cfg.products.forEach(function (p) { Object.keys(p.route || {}).forEach(function (s) { delete p.route[s][tid]; }); });
      }
      cfgChanged(); render(); return;
    }
    if ((a = t.getAttribute("data-pra"))) {
      var pk = t.getAttribute("data-k");
      if (a === "add") editProduct(null);
      else if (a === "edit") editProduct(+pk);
      else if (a === "del") {
        var pid = S.cfg.products[+pk].id, used = S.orders.filter(function (o) { return o.product === pid; }).length;
        if (used) { toast("還有 " + used + " 張訂單用這個產品，先刪掉或改掉那些訂單。", true); return; }
        if (!confirm("刪除產品 " + pid + "？")) return;
        S.cfg.products.splice(+pk, 1); cfgChanged(); render();
      }
      return;
    }
    if ((a = t.getAttribute("data-cfg"))) {
      if (a === "default") { if (!confirm("還原九上預設工廠設定（站別、機型、產品）？訂單不會刪。")) return; S.cfg = D.defaultConfig(); S.cfg.calendar.start = today(); }
      else if (a === "thesis") { if (!confirm("載入論文範例會取代工廠設定與訂單，確定？")) return; S.cfg = D.thesisConfig(1 / 60); S.orders = D.thesisOrders().map(function (o) { return Object.assign({}, o, { release: "" }); }); S.plan = null; S.down = []; }
      pending = null; cfgChanged(); render(); return;
    }
    var row = t.closest("tr[data-o]");
    if (row && V.tab === "board") { var oi = +row.getAttribute("data-o"); V.hl = V.hl === oi ? null : oi; drawGantt(); paintHl(pending && V.show === "new" ? pending : cur); var g = document.getElementById("gantt"); if (g && g.scrollIntoView) g.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });
  mount.addEventListener("change", function (e) {
    var t = e.target, a;
    if (t.hasAttribute("data-ntf") || t.hasAttribute("data-ntf-owner")) { setNotify(t); return; }
    if (t.hasAttribute("data-kri")) { setTol(t.getAttribute("data-kri"), t.getAttribute("data-f"), t.value); return; }
    if (t.hasAttribute("data-grace")) { S.grace = Math.max(0, num(t.value, 120)); save(); kriTick(); render(); return; }
    if (t.getAttribute("data-act") === "noise") { V.noise = t.checked; save(false); return; }
    if ((a = t.getAttribute("data-cal"))) {
      var cl = S.cfg.calendar = S.cfg.calendar || {};
      if (a === "day") cl.days = Array.prototype.map.call(mount.querySelectorAll('[data-cal="day"]:checked'), function (x) { return +x.value; });
      else if (a === "holidays") {
        var seen = {}; cl.holidays = (String(t.value).match(/\d{4}-\d{1,2}-\d{1,2}/g) || []).map(function (h) { var q = h.split("-"); return q[0] + "-" + ("0" + q[1]).slice(-2) + "-" + ("0" + q[2]).slice(-2); })
          .filter(function (h) { if (seen[h]) return false; seen[h] = 1; return true; }).sort();
        t.value = cl.holidays.join(", ");
      } else cl[a] = num(t.value, a === "hours" ? 16 : 8);
      if (!cl.days || !cl.days.length) { cl.days = [1, 2, 3, 4, 5]; toast("至少要有一個上班日。", true); }
      cfgChanged(); return;
    }
    if ((a = t.getAttribute("data-st"))) {
      var s = S.cfg.stages[+t.closest("tr").getAttribute("data-k")]; s.out = s.out || {};
      if (a === "name") s.name = t.value.trim() || s.name; else if (a === "mode") s.mode = t.value; else if (a === "setup") s.setup = Math.max(0, num(t.value, 0));
      else if (a === "out") s.out.allowed = t.checked; else if (a === "lead") s.out.leadDays = Math.max(0, num(t.value, 0)); else if (a === "cost") s.out.cost = Math.max(0, num(t.value, 0));
      cfgChanged(); return;
    }
    if ((a = t.getAttribute("data-ty"))) {
      var ty = S.cfg.types[+t.closest("tr").getAttribute("data-k")];
      if (a === "stage") {
        var old = ty.stage; ty.stage = t.value;
        S.cfg.products.forEach(function (p) { if (p.route && p.route[old]) delete p.route[old][ty.id]; });
      } else if (a === "name") ty.name = t.value.trim() || ty.name; else if (a === "count") ty.count = Math.max(0, Math.round(num(t.value, 1))); else if (a === "fixed") ty.fixed = Math.max(0, num(t.value, 0));
      cfgChanged(); if (a === "stage") render(); return;
    }
  });
  window.addEventListener("hashchange", function () { var t = tabFromHash(); if (t && t !== V.tab) { V.tab = t; render(); } });
  var rz = null;
  window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(function () { if (V.tab === "board") afterBoard(); }, 200); });
  new MutationObserver(function () { if (V.tab === "board") afterBoard(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  rebuild(); render(); syncErp(true);
  setInterval(function () {                          // 頁面開著時，每 5 分鐘重算一次燈號（逾時沒回報會隨時間變化）
    if (document.hidden || !cur || !cur.M || pending || V.busy) return;
    var ev = kriTick(); paintAlert();
    if (ev.length && V.tab === "risk") render();
  }, 300000);
})();
