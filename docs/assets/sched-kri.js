/*
 * sched-kri.js — 生產排程的「風險 → 監控指標(KRI) → 容忍度門檻 → 觸發 → 處理」
 *   做法對應 COSO《Achieving Effective Internal Control Over GenAI》(2026)的內控觀念（會演進的風險登錄表、
 *   連結 KRI 的觸發點、多指標容忍度、預測漂移＝連續超標才升級、監控本身也要被監控），
 *   但這裡監控的是「排程引擎的預測」，不是生成式 AI。純計算、不碰畫面：瀏覽器與 Node 測試共用。
 *
 *   evaluate(ctx, tol) → 每個指標一筆 {id, risk, name, value, display, level: green|yellow|red|na, y, r, msg, action…}
 *   gate(items)        → 採用新排程前的檢查：有紅燈要填原因＋二次確認，有黃燈要勾選確認
 *   transitions(prev, items) → 燈號變化（觸發紀錄）
 *   snapshot(items, extra)   → 存進試算表給首頁、選單紅點、每日早報讀
 *
 *   ctx = { nowMin, grace(分鐘，預設 120), stageName(sid),
 *           orders:[{id, planned, predEnd, actEnd, actInferred, stages:[{sid, pred:[s,e]|null, act:{s,e,inferred}|null}]}],
 *           plan:{ageDays|null, fresh, cfgChanged}, stats:{hasDue, late, onTimeRate, maxLate, outCost, shaky}, util }
 *   時間都是「工作分鐘」。
 */
(function (root) {
  "use strict";

  // dir: "hi"＝數字越大越糟（≥ 黃／紅門檻就亮燈）；"lo"＝數字越小越糟（< 黃／紅門檻就亮燈）
  var DEFS = [
    { id: "D1", grp: "預測漂移", risk: "排程預測和現場脫節", name: "最近一張完工的預測誤差", unit: "小時", dir: "hi", y: 2, r: 4, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "預測誤差＝實際完工 − 排程預計完工（早或晚都算）。超過門檻代表工時設定可能不準。" },
    { id: "D2", grp: "預測漂移", risk: "排程預測和現場脫節", name: "連續幾張完工誤差超標", unit: "張", dir: "hi", y: 1, r: 2, owner: "生管", action: "fresh", actionLabel: "從頭排程",
      hint: "從最近一張往前數，連續幾張的誤差都超過第一項的黃燈門檻。連續超標就是「漂移」，要修正而不是繼續用。" },
    { id: "D3", grp: "預測漂移", risk: "工時設定失準", name: "某一站實際工時和設定的偏差", unit: "%", dir: "hi", y: 10, r: 20, owner: "生管", action: "factory", actionLabel: "檢查工廠設定",
      hint: "各站已回報的「實際耗時 ÷ 排程耗時」平均，取偏差最大的站。偏差大就該回「工廠設定」改每件分鐘。" },
    { id: "D4", grp: "預測漂移", risk: "現場沒有回報進度", name: "預計完工已過、卻還沒回報的單", unit: "張", dir: "hi", y: 1, r: 3, owner: "班長", action: "report", actionLabel: "去回報進度",
      hint: "預計完工已超過寬限時間（預設 2 小時）仍沒有完工回報；ERP 工單完工會自動帶入。" },
    { id: "D5", grp: "預測漂移", risk: "監控本身失靈（沒人回報）", name: "各站完工回報率", unit: "%", dir: "lo", y: 90, r: 70, owner: "班長", action: "report", actionLabel: "去回報進度",
      hint: "預計完工已過寬限時間的「站」裡，有幾成已回報（ERP 推定的不算）。回報率低，漂移監控就看不準。" },
    { id: "P1", grp: "計畫新舊", risk: "排程過期", name: "距離上次採用排程", unit: "天", dir: "hi", y: 2, r: 4, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "排程是某個時間點的計畫，太久沒更新就跟現場越差越遠。" },
    { id: "P2", grp: "計畫新舊", risk: "新單沒有排進去", name: "還沒最佳化的新訂單", unit: "張", dir: "hi", y: 1, r: 3, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "訂單清單有、但排程裡沒有的單，目前只是用現場做法暫排。" },
    { id: "P3", grp: "計畫新舊", risk: "設定被改動", name: "工廠設定改過、排程還沒重排", unit: "項", dir: "hi", y: 1, r: null, owner: "生管", action: "fresh", actionLabel: "從頭排程",
      hint: "站別、機台數、工時改過之後，原本的排程是依舊設定算的。" },
    { id: "L1", grp: "領先指標（早期預警）", risk: "產能不夠接單（需求超過產能）", name: "未來 5 個工作日要交的單：工時需求 ÷ 產能", unit: "%", dir: "hi", y: 85, r: 100, owner: "生管", action: "board", actionLabel: "看各站忙碌、考慮外包",
      hint: "最早的警訊：還沒延遲，但需求已經逼近產能。取各站裡最緊的一站；超過 100% 代表來不及。" },
    { id: "L2", grp: "領先指標（早期預警）", risk: "交期緩衝被吃光", name: "未完工訂單的平均交期寬裕", unit: "小時", dir: "lo", y: 12, r: 4, owner: "業務", action: "board", actionLabel: "看延遲風險的單",
      hint: "每張未完工的單，預計完工離交期還剩多少緩衝，取平均。緩衝一路縮小，就是延遲的前兆。" },
    { id: "L3", grp: "領先指標（早期預警）", risk: "交期不穩", name: "未完工訂單的平均準時機率", unit: "%", dir: "lo", y: 90, r: 75, owner: "業務", action: "board", actionLabel: "看準時機率",
      hint: "考慮加工時間誤差後，未完工的單平均有多大機會準時。比「準時率」更早反應。" },
    { id: "L4", grp: "領先指標（早期預警）", risk: "外包依賴升高", name: "外包佔比（未完工訂單）", unit: "%", dir: "hi", y: 5, r: 15, owner: "老闆", action: "board", actionLabel: "看外包的單",
      hint: "未完工的單裡，外包的件數佔幾成。越來越高，代表自家產能撐不住。" },
    { id: "S1", grp: "交期", risk: "交期落空", name: "準時率", unit: "%", dir: "lo", y: 95, r: 85, owner: "業務", action: "board", actionLabel: "看延遲的單",
      hint: "預計能準時完工的單 ÷ 有交期的單。" },
    { id: "S2", grp: "交期", risk: "交期落空", name: "預計最大延遲", unit: "小時", dir: "hi", y: 2, r: 8, owner: "業務", action: "board", actionLabel: "看延遲的單",
      hint: "預計延遲最久的那一張，晚了幾小時。" },
    { id: "S3", grp: "交期", risk: "交期不穩（排得進但很險）", name: "準時機率偏低的單（< 70%）", unit: "張", dir: "hi", y: 1, r: 3, owner: "業務", action: "board", actionLabel: "看準時機率",
      hint: "考慮加工時間誤差後，準時機率低於 70% 的單。" },
    { id: "C1", grp: "產能與成本", risk: "產能撞牆", name: "瓶頸站忙碌程度", unit: "%", dir: "hi", y: 90, r: 97, owner: "生管", action: "board", actionLabel: "看各站忙碌",
      hint: "最忙那一站的機台忙碌比例。逼近 100% 代表任何插單都會延遲。" },
    { id: "C2", grp: "產能與成本", risk: "外包成本失控", name: "外包費合計", unit: "NT$", dir: "hi", y: 5000, r: 20000, owner: "老闆", action: "board", actionLabel: "看外包的單",
      hint: "排程裡所有外包的費用合計。" }
  ];
  var LV = { na: -1, green: 0, yellow: 1, red: 2 };
  var LABEL = { na: "—", green: "正常", yellow: "黃燈", red: "紅燈" };

  function tolOf(def, tol) {
    var t = tol && tol[def.id] || {};
    return { y: t.y != null && isFinite(t.y) ? +t.y : def.y, r: t.r === null ? null : (t.r != null && isFinite(t.r) ? +t.r : def.r), owner: t.owner || def.owner };
  }
  function levelOf(v, def, t) {
    if (v == null || !isFinite(v)) return "na";
    if (def.dir === "hi") return t.r != null && v >= t.r ? "red" : v >= t.y ? "yellow" : "green";
    return t.r != null && v < t.r ? "red" : v < t.y ? "yellow" : "green";
  }
  function hrs(min) { var h = Math.abs(min) / 60; return (h >= 10 ? h.toFixed(0) : h.toFixed(1)).replace(/\.0$/, ""); }
  function pct0(x) { return Math.round(x) + "%"; }

  function ids(list, n) { return list.slice(0, n || 3).join("、") + (list.length > (n || 3) ? "…" : ""); }

  function evaluate(ctx, tol) {
    var grace = ctx.grace != null ? ctx.grace : 120, now = ctx.nowMin || 0, orders = ctx.orders || [], out = [];
    // ---- 預測誤差（完工的單；ERP 推定不算）
    var done = orders.filter(function (o) { return o.actEnd != null && o.predEnd != null && !o.actInferred; })
      .sort(function (a, b) { return a.actEnd - b.actEnd; });
    var errs = done.map(function (o) { return { id: o.id, e: o.actEnd - o.predEnd }; });
    var last = errs.length ? errs[errs.length - 1] : null;
    var d1 = last ? Math.abs(last.e) / 60 : null;
    var thr1 = tolOf(DEFS[0], tol).y * 60, run = 0;
    for (var k = errs.length - 1; k >= 0 && Math.abs(errs[k].e) >= thr1; k--) run++;
    // ---- 各站工時偏差
    var ratio = {};
    orders.forEach(function (o) {
      o.stages.forEach(function (st) {
        if (!st.act || st.act.inferred || st.act.s == null || st.act.e == null || !st.pred) return;
        var pd = st.pred[1] - st.pred[0], ad = st.act.e - st.act.s;
        if (pd > 1 && ad > 0) (ratio[st.sid] = ratio[st.sid] || []).push(ad / pd);
      });
    });
    var d3 = null, d3sid = null, d3dir = 0;
    Object.keys(ratio).forEach(function (sid) {
      var a = ratio[sid], m = a.reduce(function (x, y) { return x + y; }, 0) / a.length, dev = Math.abs(m - 1) * 100;
      if (d3 == null || dev > d3) { d3 = dev; d3sid = sid; d3dir = m - 1; }
    });
    // ---- 逾時沒回報
    var overdue = orders.filter(function (o) { return o.predEnd != null && o.actEnd == null && o.predEnd + grace < now; }).map(function (o) { return o.id; });
    var due = 0, rep = 0;
    orders.forEach(function (o) {
      o.stages.forEach(function (st) {
        if (!st.pred || st.pred[1] + grace >= now) return;
        due++; if (st.act && st.act.e != null && !st.act.inferred) rep++;
      });
    });
    var st = ctx.stats || {}, pl = ctx.plan || {}, ld = ctx.lead || {};
    var V = {
      D1: d1 == null ? null : d1,
      D2: errs.length ? run : null,
      D3: d3,
      D4: orders.some(function (o) { return o.predEnd != null; }) ? overdue.length : null,
      D5: due ? rep / due * 100 : null,
      P1: pl.ageDays == null ? null : pl.ageDays,
      P2: pl.fresh == null ? null : pl.fresh,
      P3: pl.cfgChanged == null ? null : (pl.cfgChanged ? 1 : 0),
      S1: st.hasDue ? st.onTimeRate * 100 : null,
      S2: st.hasDue ? Math.max(0, st.maxLate || 0) / 60 : null,
      S3: st.shaky == null ? null : st.shaky,
      L1: ld.load == null ? null : ld.load * 100,
      L2: ld.slack == null ? null : ld.slack / 60,
      L3: ld.prob == null ? null : ld.prob * 100,
      L4: ld.outPct == null ? null : ld.outPct * 100,
      C1: ctx.util == null ? null : ctx.util * 100,
      C2: st.outCost == null ? null : st.outCost
    };
    DEFS.forEach(function (def) {
      var t = tolOf(def, tol), v = V[def.id], lv = levelOf(v, def, t), disp = v == null ? "—" : def.id === "P1" ? v.toFixed(1).replace(/\.0$/, "") + " 天" : def.unit === "NT$" ? "NT$ " + Math.round(v).toLocaleString()
        : def.unit === "小時" ? (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "") + " 小時" : def.unit === "%" ? pct0(v) : def.unit === "項" ? (v ? "有" : "沒有") : Math.round(v) + " " + def.unit;
      var msg = "";
      if (lv === "yellow" || lv === "red") {
        if (def.id === "D1") msg = "最近完工的 " + last.id + " 比預計" + (last.e > 0 ? "晚" : "早") + " " + hrs(last.e) + " 小時。";
        else if (def.id === "D2") msg = "最近連續 " + run + " 張完工誤差都超過 " + hrs(thr1) + " 小時（" + ids(errs.slice(-run).reverse().map(function (x) { return x.id; })) + "）。";
        else if (def.id === "D3") msg = "「" + ctx.stageName(d3sid) + "」實際工時比排程" + (d3dir > 0 ? "多" : "少") + " " + Math.round(Math.abs(d3dir) * 100) + "%，建議改工廠設定的每件分鐘。";
        else if (def.id === "D4") msg = "超過預計完工 " + hrs(grace) + " 小時還沒回報：" + ids(overdue) + "。";
        else if (def.id === "D5") msg = "已到期的站只有 " + pct0(v) + " 有回報（" + rep + "／" + due + "）。";
        else if (def.id === "P1") msg = "已經 " + disp + "沒有更新排程。";
        else if (def.id === "P2") msg = "有 " + v + " 張新訂單還沒排進去。";
        else if (def.id === "P3") msg = "工廠設定在排程之後改過。";
        else if (def.id === "S1") msg = "預計只有 " + pct0(v) + " 準時（" + ((st.hasDue || 0) - (st.late || 0)) + "／" + st.hasDue + " 張）。";
        else if (def.id === "S2") msg = "最晚的一張預計晚 " + disp + "。";
        else if (def.id === "S3") msg = v + " 張的準時機率低於 70%，加工稍慢就會延遲。";
        else if (def.id === "L1") msg = "未來 5 個工作日要交的單，工時需求已達產能的 " + disp + (ld.loadName ? "（最緊的是「" + ld.loadName + "」）" : "") + "，再插單就會延遲。";
        else if (def.id === "L2") msg = v < 0 ? "未完工訂單預計平均已經比交期晚 " + (Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)).replace(/\.0$/, "") + " 小時。" : "未完工訂單平均只剩 " + disp + " 的交期緩衝。";
        else if (def.id === "L3") msg = "未完工訂單平均準時機率只剩 " + disp + "。";
        else if (def.id === "L4") msg = "未完工訂單有 " + disp + " 靠外包。";
        else if (def.id === "C1") msg = "瓶頸站忙碌 " + disp + "，幾乎沒有彈性。";
        else if (def.id === "C2") msg = "外包費合計 " + disp + "。";
      }
      out.push({ id: def.id, grp: def.grp, risk: def.risk, name: def.name, unit: def.unit, dir: def.dir, y: t.y, r: t.r, owner: t.owner, action: def.action, actionLabel: def.actionLabel,
        hint: def.hint, value: v, display: disp, level: lv, msg: msg });
    });
    return out;
  }

  function worst(items) { var w = "green", seen = false; items.forEach(function (x) { if (x.level !== "na") seen = true; if (LV[x.level] > LV[w]) w = x.level; }); return seen ? w : "na"; }
  function counts(items) { var c = { red: 0, yellow: 0, green: 0, na: 0 }; items.forEach(function (x) { c[x.level]++; }); return c; }

  // 採用新排程前的檢查：紅燈＝要填原因＋二次確認；黃燈＝要勾選「我已看過」
  function gate(items) {
    var red = items.filter(function (x) { return x.level === "red"; }), yellow = items.filter(function (x) { return x.level === "yellow"; });
    return { red: red, yellow: yellow, needReason: red.length > 0, needAck: red.length + yellow.length > 0, clear: !red.length && !yellow.length };
  }
  function thresholdText(x) {
    return x.dir === "hi" ? "黃 ≥ " + fmtN(x.y, x) + (x.r != null ? "、紅 ≥ " + fmtN(x.r, x) : "") : "黃 < " + fmtN(x.y, x) + (x.r != null ? "、紅 < " + fmtN(x.r, x) : "");
  }
  function fmtN(v, x) { return (x.unit === "NT$" ? "NT$ " + Math.round(v).toLocaleString() : v + (x.unit === "%" ? "%" : x.unit === "項" ? "" : " " + x.unit)).trim(); }

  // 燈號變化＝觸發紀錄（prev：{id: level}）
  function transitions(prev, items) {
    var ev = [];
    items.forEach(function (x) {
      var p = prev && prev[x.id]; if (p == null) p = "green";
      if (x.level === "na" || p === x.level) return;
      if (p === "na" && x.level === "green") return;
      ev.push({ id: x.id, name: x.name, from: p, to: x.level, display: x.display, msg: x.msg, up: LV[x.level] > LV[p] });
    });
    return ev;
  }
  function levels(items) { var m = {}; items.forEach(function (x) { m[x.id] = x.level; }); return m; }

  // 給首頁、選單紅點、每日早報用的精簡快照（orders：單號＋預計完工與實際完工的絕對時間 ms，早報在 Apps Script 端再算「逾時沒回報」）
  function snapshot(items, extra) {
    var c = counts(items), tol = {};
    items.forEach(function (x) { tol[x.id] = { y: x.y, r: x.r, owner: x.owner, name: x.name, dir: x.dir, unit: x.unit }; });
    return Object.assign({ v: 1, ts: Date.now(), worst: worst(items), red: c.red, yellow: c.yellow, green: c.green, tol: tol,
      items: items.filter(function (x) { return x.level === "red" || x.level === "yellow"; }).map(function (x) { return { id: x.id, name: x.name, level: x.level, display: x.display, msg: x.msg, owner: x.owner, actionLabel: x.actionLabel }; }) }, extra || {});
  }

  // 趨勢（領先）：用歷史值判斷「正在惡化／改善」，並預估多久會碰到下一道門檻
  //   hist：[{t(ms), v:{id: 數字}}]（舊→新）；items：evaluate 的結果；回傳 {id: {n, dir: none|flat|worse|better, eta:{to,days}|null, slopeDay}}
  var DAY = 86400000;
  function trends(hist, items) {
    var out = {};
    items.forEach(function (x) {
      var pts = (hist || []).filter(function (p) { return p.v && p.v[x.id] != null; }).slice(-8).map(function (p) { return [p.t, p.v[x.id]]; });
      var r = { n: pts.length, dir: "none", eta: null, slopeDay: 0 };
      out[x.id] = r;
      if (pts.length < 3 || x.value == null) return;
      var span = pts[pts.length - 1][0] - pts[0][0];
      if (span < 2 * 3600000) return;
      var n = pts.length, t0 = pts[0][0], sx = 0, sy = 0, sxx = 0, sxy = 0;
      pts.forEach(function (q) { var tx = (q[0] - t0) / DAY; sx += tx; sy += q[1]; sxx += tx * tx; sxy += tx * q[1]; });
      var den = n * sxx - sx * sx, slope = den > 1e-12 ? (n * sxy - sx * sy) / den : 0;
      r.slopeDay = slope;
      var hi = x.dir === "hi", scale = Math.max(Math.abs(x.y), 1e-9), l3 = pts.slice(-3);
      var worse = hi ? (l3[0][1] < l3[1][1] && l3[1][1] < l3[2][1]) : (l3[0][1] > l3[1][1] && l3[1][1] > l3[2][1]);
      var better = hi ? (l3[0][1] > l3[1][1] && l3[1][1] > l3[2][1]) : (l3[0][1] < l3[1][1] && l3[1][1] < l3[2][1]);
      var chg = Math.abs(l3[2][1] - l3[0][1]) / scale;
      r.dir = worse && chg >= 0.03 ? "worse" : better && chg >= 0.03 ? "better" : "flat";
      if (r.dir === "worse" && span >= 6 * 3600000 && Math.abs(slope) > 1e-9 && (hi ? slope > 0 : slope < 0)) {
        var target = x.level === "green" ? x.y : (x.level === "yellow" && x.r != null ? x.r : null);
        if (target != null) {
          var dist = hi ? target - x.value : x.value - target, d = dist / Math.abs(slope);
          if (dist > 0 && d <= 3) r.eta = { to: x.level === "green" ? "yellow" : "red", days: d };
        }
      }
    });
    return out;
  }

  var api = { trends: trends, DEFS: DEFS, LABEL: LABEL, LV: LV, evaluate: evaluate, worst: worst, counts: counts, gate: gate, transitions: transitions, levels: levels, snapshot: snapshot, tolOf: tolOf, thresholdText: thresholdText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SchedKri = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
