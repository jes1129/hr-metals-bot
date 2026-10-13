/*
 * biz-kri.js — 全公司營運風險：風險 → 監控指標(KRI) → 黃／紅門檻 → 儀表板 → 通知
 *   和排程風險（sched-kri.js）同一套框架：燈號、門檻、負責人、趨勢、通知中心與自動通知都共用；
 *   差別只在資料來源是 ERP 的資料（world），不是排程預測。純規則與統計，沒有任何 AI。
 *   瀏覽器（風險儀表板）、Apps Script（每 30 分鐘自動檢查）、Node 測試共用同一份。
 *
 *   evaluate(world, today, tol, opts) → 每個指標一筆
 *       {id, grp, risk, name, value, display, level: green|yellow|red|na, y, r, owner, msg, action…, cat:"營運"}
 *   opts: { seeCost: 這個職務看不看得到成本（false → 需要成本才能算的指標回 na）, terms: 帳款天數（預設 30）, minSales: 集中度最少要有的銷售額 }
 *
 *   id 的第一個字母：B＝營運（業務／財務／庫存／生產）、A＝行政與人事。和排程指標（D/P/L/S/C）不會撞號。
 *   加班上限預設依勞動基準法第 32 條（延長工時每月 46 小時）設定；公司另有約定（工會同意、變形工時…）請在門檻設定自行調整。
 */
(function (root) {
  "use strict";
  var K = root.SchedKri || (typeof require === "function" ? require("./sched-kri.js") : null);

  var DEFS = [
    { id: "B1", grp: "業務與財務", risk: "接單虧損（賣得比成本低）", name: "負毛利訂單", unit: "張", dir: "hi", y: 1, r: 3, owner: "業務", needCost: true, action: "orders", actionLabel: "看這些訂單",
      hint: "已出貨的訂單實際毛利為負，或還沒出貨的訂單售價低於標準成本。需要成本權限才看得到。" },
    { id: "B2", grp: "業務與財務", risk: "應收帳款收不回來", name: "逾期應收金額", unit: "NT$", dir: "hi", y: 100000, r: 300000, owner: "會計", action: "orders", actionLabel: "催收",
      hint: "已出貨、超過帳款天數（預設 30 天）還沒收齊的金額。" },
    { id: "B3", grp: "業務與財務", risk: "應收帳款收不回來", name: "最久逾期天數", unit: "天", dir: "hi", y: 15, r: 45, owner: "會計", action: "orders", actionLabel: "催收",
      hint: "逾期最久的那一筆已經超過帳款天數幾天。拖越久越難收。" },
    { id: "B4", grp: "業務與財務", risk: "客戶過度集中", name: "最大客戶佔近 90 天銷售", unit: "%", dir: "hi", y: 40, r: 60, owner: "老闆", action: "customers", actionLabel: "看客戶",
      hint: "最大客戶若佔太高，一旦流失或延遲付款，公司現金流會直接受影響。銷售額太少（資料不足）時不判斷。" },
    { id: "B10", grp: "業務與財務", risk: "交期落空", name: "已逾期未出貨的訂單", unit: "張", dir: "hi", y: 1, r: 3, owner: "業務", action: "orders", actionLabel: "看逾期訂單",
      hint: "交期已過、還沒出完的訂單。" },
    { id: "B5", grp: "庫存與生產", risk: "缺料停工", name: "缺料品項", unit: "項", dir: "hi", y: 1, r: 5, owner: "倉管", action: "stock", actionLabel: "看缺料",
      hint: "預留（接單與工單需要）超過現有庫存的品項數。" },
    { id: "B6", grp: "庫存與生產", risk: "安全庫存不足", name: "低於安全庫存的品項", unit: "項", dir: "hi", y: 3, r: 8, owner: "倉管", action: "stock", actionLabel: "看庫存",
      hint: "現有庫存低於所設安全庫存的品項數。" },
    { id: "B7", grp: "庫存與生產", risk: "帳實不符／舞弊", name: "30 天內盤點調整金額佔庫存價值", unit: "%", dir: "hi", y: 1, r: 3, owner: "老闆", needCost: true, action: "stock", actionLabel: "看盤點調整",
      hint: "盤點調整（盤盈盤虧）金額的絕對值合計 ÷ 庫存價值。常常大幅調整，代表帳實不符或有管理漏洞。需要成本權限。" },
    { id: "B8", grp: "庫存與生產", risk: "工單成本失控", name: "工單用料成本超出標準的最大幅度", unit: "%", dir: "hi", y: 10, r: 20, owner: "生管", needCost: true, action: "wo", actionLabel: "看工單",
      hint: "近 60 天完工的工單，實際用料成本比「BOM 用量 × 標準成本」多幾成，取最大的一張。需要成本權限。" },
    { id: "B9", grp: "庫存與生產", risk: "工單拖延", name: "已逾期未完工的工單", unit: "張", dir: "hi", y: 1, r: 3, owner: "生管", action: "wo", actionLabel: "看工單",
      hint: "交期已過、狀態還是計畫／已備料／生產中的工單。" },
    { id: "A1", grp: "行政與人事", risk: "申請卡關", name: "送出後最久沒人簽核的申請", unit: "天", dir: "hi", y: 3, r: 7, owner: "行政", action: "requests", actionLabel: "去簽核",
      hint: "狀態是「已送出」、還沒核准或退回的申請，等了幾天。" },
    { id: "A2", grp: "行政與人事", risk: "設備故障／停機", name: "保養逾期的設備", unit: "台", dir: "hi", y: 1, r: 2, owner: "生管", action: "equip", actionLabel: "看設備",
      hint: "設了保養週期的設備，超過「上次保養日＋週期」還沒保養（沒填上次保養日就從建立日起算）。" },
    { id: "A3", grp: "行政與人事", risk: "加班超過法定上限", name: "本月核准加班最多的員工", unit: "小時", dir: "hi", y: 36, r: 46, owner: "行政", action: "requests", actionLabel: "看加班申請",
      hint: "本月已核准的加班申請時數，取最多的員工。預設依勞基法第 32 條（延長工時每月 46 小時）；公司另有約定請在門檻設定調整。" }
  ];

  function sortedEq(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function addDays(d, n) { var x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function diffDays(a, b) { return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000); }
  function m0(n) { return Math.round(n); }
  function ids(list, n) { return list.slice(0, n || 3).join("、") + (list.length > (n || 3) ? "…" : ""); }
  function nt(n) { return "NT$ " + Math.round(n).toLocaleString("en-US"); }
  function by(list, k) { var m = {}; (list || []).forEach(function (x) { m[x[k]] = x; }); return m; }

  function evaluate(w, today, tol, opts) {
    opts = opts || {};
    var seeCost = opts.seeCost !== false, terms = opts.terms != null ? opts.terms : 30, minSales = opts.minSales != null ? opts.minSales : 50000;
    var items = w.items || [], itemById = by(items, "id"), orders = (w.orders || []).filter(function (o) { return !o.cancelled; }), moves = w.moves || [];
    var V = {}, M = {}, extra = {};                                  // V：數值；M：說明所需資料

    // ---- 出貨日（以出貨異動日為準）、每張單的實際營收與成本
    var ship = {}, act = {};
    moves.forEach(function (m) {
      if (m.type !== "銷貨出庫" && m.type !== "銷貨退回") return;
      var a = act[m.ref] = act[m.ref] || { rev: 0, cost: 0 };
      var o = orders.filter(function (x) { return x.no === m.ref; })[0];
      var l = o && o.lines.filter(function (x) { return x.item_id === m.item_id; })[0];
      if (l) { a.rev += -m.qty * l.price; a.cost += -m.value; }
      if (m.type === "銷貨出庫" && (!ship[m.ref] || m.date < ship[m.ref])) ship[m.ref] = m.date;
    });
    // B1 負毛利
    if (seeCost) {
      var neg = [];
      orders.forEach(function (o) {
        var a = act[o.no], bad = false;
        if (a && a.rev > 0 && a.cost > a.rev + 0.005) bad = true;
        o.lines.forEach(function (l) { var rest = l.qty - l.shipped; var it = itemById[l.item_id]; if (rest > 0 && it && it.std_cost != null && l.price < it.std_cost) bad = true; });
        if (bad) neg.push(o.no);
      });
      V.B1 = orders.length ? neg.length : null; M.B1 = neg;
    }
    // B2 / B3 逾期應收
    var overdueAmt = 0, oldest = 0, oldestNo = "", od = [];
    orders.forEach(function (o) {
      var net = o.lines.reduce(function (s, l) { return s + (l.shipped - l.returned) * l.price; }, 0), owe = net - (o.paid - o.refunded), sd = ship[o.no];
      if (owe > 0.5 && sd) { var late = diffDays(today, addDays(sd, terms)); if (late > 0) { overdueAmt += owe; od.push(o.no); if (late > oldest) { oldest = late; oldestNo = o.no; } } }
    });
    V.B2 = orders.length ? overdueAmt : null; M.B2 = od;
    V.B3 = orders.length ? oldest : null; M.B3 = oldestNo;
    // B4 客戶集中度（近 90 天出貨銷售）
    var since = addDays(today, -90), byCust = {}, total = 0, oByNo = by(orders, "no");
    moves.forEach(function (m) {
      if ((m.type !== "銷貨出庫" && m.type !== "銷貨退回") || m.date < since) return;
      var o = oByNo[m.ref], l = o && o.lines.filter(function (x) { return x.item_id === m.item_id; })[0]; if (!l) return;
      var rev = -m.qty * l.price; byCust[o.customer_id] = (byCust[o.customer_id] || 0) + rev; total += rev;
    });
    var top = null; Object.keys(byCust).forEach(function (c) { if (!top || byCust[c] > byCust[top]) top = c; });
    V.B4 = total >= minSales && top ? byCust[top] / total * 100 : null; M.B4 = top ? { cust: top, total: total } : null;
    // B10 逾期未出貨
    var late10 = orders.filter(function (o) {
      var q = 0, sh = 0; o.lines.forEach(function (l) { q += l.qty; sh += l.shipped; });
      return o.due && o.due < today && sh + 1e-9 < q;
    }).map(function (o) { return o.no; });
    V.B10 = orders.length ? late10.length : null; M.B10 = late10;
    // B5 / B6 庫存
    var short = items.filter(function (it) { return it.active !== false && it.reserved - it.on_hand > 1e-9; });
    var low = items.filter(function (it) { return it.active !== false && it.safety > 0 && it.on_hand < it.safety; });
    V.B5 = items.length ? short.length : null; M.B5 = short.map(function (x) { return x.name; });
    V.B6 = items.length ? low.length : null; M.B6 = low.map(function (x) { return x.name; });
    // B7 盤點調整 / 庫存價值
    if (seeCost) {
      var invVal = (w.lots || []).reduce(function (s, l) { return s + l.qty * l.unit_cost; }, 0), since30 = addDays(today, -30);
      var adj = moves.filter(function (m) { return m.type === "盤點調整" && m.date >= since30; }).reduce(function (s, m) { return s + Math.abs(m.value); }, 0);
      V.B7 = invVal > 0 ? adj / invVal * 100 : null; M.B7 = { adj: adj, inv: invVal };
    }
    // B8 工單成本超標
    var wos = w.workorders || [];
    if (seeCost) {
      var since60 = addDays(today, -60), done = {}; moves.forEach(function (m) { if (m.type === "完工入庫") done[m.ref] = m.date; });
      var worst = null;
      wos.forEach(function (o) {
        if (o.status !== "完工" || (done[o.no] || "") < since60) return;
        var std = 0, ok = true;
        ((o.bom && o.bom.components) || []).forEach(function (c) { var it = itemById[c.item_id]; if (!it || it.std_cost == null) ok = false; else std += c.qty * o.qty * it.std_cost; });
        if (!ok || std <= 0) return;
        var pct = (o.actual_cost - o.extra_cost - std) / std * 100;
        if (!worst || pct > worst.pct) worst = { no: o.no, pct: pct };
      });
      V.B8 = worst ? Math.max(0, worst.pct) : null; M.B8 = worst;
    }
    // B9 工單逾期
    var late9 = wos.filter(function (o) { return ["計畫", "已備料", "生產中"].indexOf(o.status) >= 0 && o.due && o.due < today; }).map(function (o) { return o.no; });
    V.B9 = wos.length ? late9.length : null; M.B9 = late9;
    // A1 申請卡關
    var reqs = (w.requests || []).filter(function (r) { return r.status === "已送出"; }), maxAge = 0, maxReq = null;
    reqs.forEach(function (r) {
      var sub = r.created; (r.history || []).forEach(function (h) { if (/送出/.test(h.action) && h.date) sub = h.date; });
      var age = sub ? diffDays(today, sub) : 0; if (age > maxAge) { maxAge = age; maxReq = r; }
    });
    V.A1 = (w.requests || []).length ? maxAge : null; M.A1 = { req: maxReq, n: reqs.length };
    // A2 設備保養
    var eq = (w.equipment || []).filter(function (e) { return e.active !== false && e.maint_days > 0; }), overEq = [];
    eq.forEach(function (e) { var base = e.last_maint || e.created; if (base && addDays(base, e.maint_days) < today) overEq.push(e.name); });
    V.A2 = eq.length ? overEq.length : null; M.A2 = overEq;
    // A3 本月核准加班
    var ym = today.slice(0, 7), hrs = {};
    (w.requests || []).forEach(function (r) { if (r.kind === "加班" && r.status === "已核准" && String(r.start_date).slice(0, 7) === ym) hrs[r.staff_id] = (hrs[r.staff_id] || 0) + (Number(r.hours) || 0); });
    var topS = null; Object.keys(hrs).forEach(function (s) { if (!topS || hrs[s] > hrs[topS]) topS = s; });
    V.A3 = (w.requests || []).length ? (topS ? hrs[topS] : 0) : null; M.A3 = topS ? { id: topS, h: hrs[topS], name: ((by(w.staff, "id")[topS]) || {}).name || "" } : null;

    var out = [];
    DEFS.forEach(function (def) {
      var t = K.tolOf(def, tol), v = V[def.id] === undefined ? null : V[def.id], lv = K.levelOf ? K.levelOf(v, def, t) : "na";
      if (def.needCost && !seeCost) lv = "na";
      var disp = v == null ? "—" : def.unit === "NT$" ? nt(v) : def.unit === "%" ? (Math.round(v * 10) / 10) + "%" : def.unit === "小時" ? (Math.round(v * 10) / 10) + " 小時" : Math.round(v) + " " + def.unit;
      if (def.needCost && !seeCost) disp = "需成本權限";
      var msg = "";
      if (lv === "yellow" || lv === "red") {
        if (def.id === "B1") msg = M.B1.length + " 張訂單虧損或定價低於成本：" + ids(M.B1) + "。";
        else if (def.id === "B2") msg = "逾期未收 " + disp + "（" + M.B2.length + " 張：" + ids(M.B2) + "）。";
        else if (def.id === "B3") msg = "訂單 " + M.B3 + " 已逾期 " + v + " 天。";
        else if (def.id === "B4") msg = "最大客戶佔近 90 天銷售的 " + disp + "（約 " + nt(M.B4.total * v / 100) + "）。";
        else if (def.id === "B10") msg = "交期已過還沒出完：" + ids(M.B10) + "。";
        else if (def.id === "B5") msg = "缺料：" + ids(M.B5, 4) + "。";
        else if (def.id === "B6") msg = "低於安全庫存：" + ids(M.B6, 4) + "。";
        else if (def.id === "B7") msg = "近 30 天盤點調整 " + nt(M.B7.adj) + "，佔庫存價值 " + disp + "。";
        else if (def.id === "B8") msg = "工單 " + M.B8.no + " 用料成本比標準多 " + disp + "。";
        else if (def.id === "B9") msg = "交期已過還沒完工：" + ids(M.B9) + "。";
        else if (def.id === "A1") msg = "有申請已等 " + v + " 天沒人簽核（共 " + M.A1.n + " 件待簽核）。";
        else if (def.id === "A2") msg = "超過保養週期：" + ids(M.A2) + "。";
        else if (def.id === "A3") msg = (M.A3.name || "有員工") + "本月已核准加班 " + disp + "，法定上限（預設）每月 46 小時。";
      }
      out.push({ id: def.id, grp: def.grp, risk: def.risk, name: def.name, unit: def.unit, dir: def.dir, y: t.y, r: t.r, owner: t.owner, action: def.action, actionLabel: def.actionLabel,
        hint: def.hint, value: v, display: disp, level: lv, msg: msg, cat: "營運", needCost: !!def.needCost });
    });
    return out;
  }

  // 排序用：id 的自然順序（B1, B2, B3, B4, B5…, B10, A1…）
  var ORDER = DEFS.map(function (d) { return d.id; });

  var api = { DEFS: DEFS, ORDER: ORDER, evaluate: evaluate, tolOf: K.tolOf, levelOf: K.levelOf, worst: K.worst, counts: K.counts, transitions: K.transitions,
    levels: K.levels, trends: K.trends, thresholdText: K.thresholdText, LABEL: K.LABEL, LV: K.LV };
  void sortedEq; void m0;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BizKri = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
