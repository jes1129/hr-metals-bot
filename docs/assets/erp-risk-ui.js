/*
 * erp-risk-ui.js — 「風險儀表板」分頁：全公司營運風險（業務、財務、庫存、生產、行政人事）
 * 規則在 biz-kri.js；Apps Script 每 30 分鐘用同一份規則檢查（sched-alerts.gs 的 checkSchedAlerts），越線寄信並寫進通知中心（鈴鐺）。
 * 和排程頁的風險儀表板同一套燈號、門檻、趨勢、通知；只是資料來源是 ERP。
 */
(function () {
  "use strict";
  var U = window.__erpUI, B = window.BizKri;
  if (!U || !B) return;
  var esc = U.esc, ic = U.ic, chip = U.chip, section = U.section;
  var ST = { loaded: false, loading: false, tol: {}, hist: [], canEdit: false, edit: false };
  var LS = "biz_tol_local_v1";

  var ON_ADMIN = !!document.getElementById("adminView");
  U.addTab(ON_ADMIN ? "admin" : "erp", "risk", ic("alert") + "風險儀表板", ON_ADMIN ? null : "home");

  function bridge() { return window.__erpBridge; }
  function authed() { var b = bridge(); return !!(b && b.authed()); }
  function opts() { var o = (ST.tol && ST.tol._opts) || {}; return { seeCost: U.seeCost(), terms: o.terms != null ? +o.terms : 30, minSales: o.minSales != null ? +o.minSales : 50000 }; }
  function items() { return B.evaluate(U.W(), U.today(), ST.tol, opts()); }

  function load() {
    if (ST.loading) return;
    ST.loading = true;
    if (!authed()) {
      try { ST.tol = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { ST.tol = {}; }
      ST.canEdit = true; ST.loaded = true; ST.loading = false; return;
    }
    Promise.all([bridge().call("tList", { table: "sched_cfg" }), bridge().call("tList", { table: "biz_hist" }), bridge().call("appVersion", {})]).then(function (r) {
      var cfg = r[0] && r[0].rows ? r[0].rows.filter(function (x) { return x.id === "biz_tol"; })[0] : null;
      try { ST.tol = cfg ? JSON.parse(String(cfg.data).replace(/^~/, "")) : {}; } catch (e) { ST.tol = {}; }
      ST.hist = ((r[1] && r[1].rows) || []).map(function (x) { var v = {}; try { v = JSON.parse(x.v); } catch (e) {} return { t: Number(x.t), v: v }; }).sort(function (a, b) { return a.t - b.t; });
      var a = r[2] && r[2].ok ? r[2].access : null;
      ST.canEdit = !a || !a.configured || a.role === "boss" || a.role === "manager";
      ST.loaded = true; ST.loading = false; U.render();
    }).catch(function () { ST.loaded = true; ST.loading = false; U.render(); });
  }
  function saveTol() {
    if (!authed()) { try { localStorage.setItem(LS, JSON.stringify(ST.tol)); } catch (e) {} return Promise.resolve(true); }
    return bridge().call("tUpsert", { table: "sched_cfg", row: { id: "biz_tol", data: JSON.stringify(ST.tol) }, header: ["id", "data"] }).then(function (d) {
      if (!d || d.error) { alert((d && d.error) || "儲存失敗"); return false; } return true;
    });
  }

  var LEVEL_CLS = { green: "ok", yellow: "warn", red: "bad", na: "muted" };
  function trendTxt(t) {
    if (!t || t.dir === "none") return "";
    if (t.dir === "worse") return '<span class="erp-bad">▲ 惡化中' + (t.eta ? "，預計 " + Math.max(0.1, Math.round(t.eta.days * 10) / 10) + " 天後轉" + (t.eta.to === "red" ? "紅" : "黃") : "") + "</span>";
    if (t.dir === "better") return '<span class="erp-ok">▼ 改善中</span>';
    return '<span class="erp-muted">持平</span>';
  }
  function tile(x, tr) {
    var cls = LEVEL_CLS[x.level];
    return '<div class="biz-tile ' + cls + '"><div class="biz-t1">' + chip(B.LABEL[x.level], cls) + ' <span class="biz-name">' + esc(x.name) + "</span></div>"
      + '<div class="biz-v">' + esc(x.display) + "</div>"
      + '<div class="biz-sub erp-muted">' + (x.level === "na" ? (x.needCost && !U.seeCost() ? "你的職務看不到成本" : "資料還不夠，無法判斷") : esc(B.thresholdText(x)) + "　負責：" + esc(x.owner)) + "</div>"
      + (x.msg ? '<div class="biz-msg">' + esc(x.msg) + "</div>" : "") + '<div class="biz-tr">' + trendTxt(tr) + "</div></div>";
  }
  function settings(its) {
    var rows = its.map(function (x) {
      var d = B.DEFS.filter(function (q) { return q.id === x.id; })[0], t = ST.tol[x.id] || {};
      return "<tr><td>" + esc(x.id) + "</td><td>" + esc(x.name) + '<div class="erp-muted">' + esc(d.hint) + "</div></td>"
        + '<td><input class="dbfilter biz-in" data-biz="' + x.id + '" data-f="y" type="number" step="any" value="' + esc(x.y) + '"> ' + esc(x.unit) + "</td>"
        + '<td><input class="dbfilter biz-in" data-biz="' + x.id + '" data-f="r" type="number" step="any" value="' + (x.r == null ? "" : esc(x.r)) + '" placeholder="不設紅燈"> ' + esc(x.unit) + "</td>"
        + '<td><input class="dbfilter biz-in" data-biz="' + x.id + '" data-f="owner" value="' + esc(t.owner || d.owner) + '" size="6"></td></tr>';
    }).join("");
    var o = opts();
    return '<div class="dbnote">黃燈、紅燈門檻與負責人都可以改，Apps Script 每 30 分鐘用同一組門檻檢查並寄信。<b>負責人</b>用名字對應 Email（在排程頁「門檻設定」的通知設定裡填：業務、會計、倉管、生管、行政、老闆…），沒填的寄給老闆。'
      + "<br><b>加班上限</b>預設依勞基法第 32 條（延長工時每月 46 小時）設定；公司另有約定（工會同意、變形工時…）請自行調整。</div>"
      + '<div class="erp-row"><label class="erp-inline">帳款天數 <input class="dbfilter biz-in" data-biz="_opts" data-f="terms" type="number" min="0" value="' + o.terms + '"> 天（出貨後超過幾天沒收齊算逾期）</label>'
      + '<label class="erp-inline">集中度最低銷售額 <input class="dbfilter biz-in" data-biz="_opts" data-f="minSales" type="number" min="0" value="' + o.minSales + '"> 元（太少不判斷）</label></div>'
      + '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>#</th><th>指標</th><th>黃燈門檻</th><th>紅燈門檻</th><th>負責人</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  U.VIEW.risk = function () {
    if (!ST.loaded) { load(); if (!ST.loaded) return section(ic("alert") + "風險儀表板", '<div class="dbempty">讀取中…</div>'); }
    var its = items(), tr = B.trends(ST.hist, its), c = B.counts(its), groups = [];
    its.forEach(function (x) { var g = groups.filter(function (q) { return q.name === x.grp; })[0]; if (!g) groups.push(g = { name: x.grp, list: [] }); g.list.push(x); });
    var worse = its.filter(function (x) { return tr[x.id] && tr[x.id].dir === "worse"; }).length;
    var head = '<div class="okpis erp-kpis">'
      + U.kpi(ic("alert") + "紅燈", c.red + " 項", c.red ? "warn" : "", "需要立刻處理") + U.kpi(ic("clock") + "黃燈", c.yellow + " 項", c.yellow ? "warn" : "", "留意")
      + U.kpi(ic("check") + "正常", c.green + " 項", "", c.na ? c.na + " 項資料不足／無權限" : "") + U.kpi(ic("chart") + "惡化中", worse + " 項", worse ? "warn" : "", ST.hist.length >= 3 ? "依近期歷史判斷" : "歷史還不夠（需要 Apps Script 自動檢查累積）") + "</div>";
    var body = groups.map(function (g) { return section(esc(g.name), '<div class="biz-grid">' + g.list.map(function (x) { return tile(x, tr[x.id]); }).join("") + "</div>"); }).join("");
    var tail = ST.canEdit ? section(ic("edit") + "門檻設定", ST.edit ? settings(its) : '<div class="dbnote erp-muted">調整黃燈／紅燈門檻與負責人。</div>',
      U.btn("risk-edit", ST.edit ? "收起" : "展開門檻設定")) : "";
    var note = authed() ? "" : '<div class="dbnote erp-muted">目前是本機試用：燈號依畫面上的資料即時計算，不會寄信。登入後 Apps Script 每 30 分鐘自動檢查並通知負責人。</div>';
    return note + head + body + tail;
  };
  U.H["risk-edit"] = function () { ST.edit = !ST.edit; U.render(); };

  document.addEventListener("change", function (e) {
    var t = e.target; if (!t.classList || !t.classList.contains("biz-in")) return;
    var id = t.getAttribute("data-biz"), f = t.getAttribute("data-f"), v = t.value.trim();
    var cur = ST.tol[id] = ST.tol[id] || {};
    if (f === "owner") { if (v) cur.owner = v; else delete cur.owner; }
    else if (f === "r" && v === "") cur.r = null;
    else if (v === "" || !isFinite(+v) || +v < 0) { alert("請輸入大於或等於 0 的數字。"); U.render(); return; }
    else cur[f] = +v;
    saveTol().then(function () { U.render(); });
  });
})();
