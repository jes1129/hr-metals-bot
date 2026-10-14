/*
 * gov-ui.js — 行政工作台「內控治理」分頁：依 COSO 2026《GenAI 內部控制指引》的 6 步驟，把治理做成看得到、記得下來的東西
 *   速查（一頁看完）／分工／功能清單／風險評分／控制對照／外部相依／情境演練／紀錄
 * 資料與規則在 governance.js；定期紀錄（治理檢視、AI 摘要抽查、相依驗證、影子 AI 確認、變更核准）存在試算表「gov_log」分頁，
 * 只有老闆、主管能寫（erp-roles.js）。未登入的本機試用存在這台電腦。
 */
(function () {
  "use strict";
  var U = window.__erpUI, G = window.ErpGov;
  if (!U || !G) return;
  var esc = U.esc, ic = U.ic, chip = U.chip, section = U.section;
  var LS = "gov_log_local_v1";
  var ST = { sub: "quick", loaded: false, loading: false, logs: [], canWrite: true };
  var SUBS = [["quick", "速查"], ["roles", "分工"], ["inv", "功能清單"], ["risk", "風險評分"], ["ctl", "控制對照"], ["dep", "外部相依"], ["scn", "情境演練"], ["log", "紀錄"]];

  U.addTab("admin", "gov", ic("shield") + "內控治理");

  function bridge() { return window.__erpBridge; }
  function authed() { var b = bridge(); return !!(b && b.authed()); }
  function tone(lv) { return lv === "高" ? "bad" : lv === "中" ? "warn" : "ok"; }

  function load() {
    if (ST.loading) return;
    ST.loading = true;
    if (!authed()) {
      try { ST.logs = JSON.parse(localStorage.getItem(LS)) || []; } catch (e) { ST.logs = []; }
      ST.canWrite = true; ST.loaded = true; ST.loading = false; return;
    }
    Promise.all([bridge().call("tList", { table: "gov_log" }), bridge().call("appVersion", {})]).then(function (r) {
      ST.logs = ((r[0] && r[0].rows) || []).slice().sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); });
      var a = r[1] && r[1].ok ? r[1].access : null;
      ST.canWrite = !a || !a.configured || a.role === "boss" || a.role === "manager";
      ST.loaded = true; ST.loading = false; U.render();
    }).catch(function () { ST.loaded = true; ST.loading = false; U.render(); });
  }
  function who() { try { var u = bridge() && bridge().user(); return (u && u.email) || ""; } catch (e) { return ""; } }
  function addLog(kind, ref, note, approver) {
    var row = { id: "g" + Date.now().toString(36), ts: new Date().toISOString(), by: who() || "本機", kind: kind, ref: ref || "", note: note || "", approver: approver || "" };
    if (!authed()) {
      ST.logs.unshift(row);
      try { localStorage.setItem(LS, JSON.stringify(ST.logs)); } catch (e) {}
      U.render(); return Promise.resolve(true);
    }
    return bridge().call("tUpsert", { table: "gov_log", row: row, header: G.LOG_HDR }).then(function (d) {
      if (!d || d.error) { alert((d && d.error) || "儲存失敗，請稍後再試。"); return false; }
      ST.logs.unshift(row); U.render(); return true;
    });
  }

  // ---- 各子頁 ----------------------------------------------------------------------------------------------------
  function quick() {
    var pr = G.problems(), due = G.dueList(ST.logs, Date.now()), late = due.filter(function (d) { return d.state !== "ok"; });
    var steps = [
      ["1 建立治理架構", "「分工」頁寫明誰負責什麼；每季由老闆在「紀錄」簽一次治理檢視。"],
      ["2 盤點功能", "「功能清單」列出所有自動化與 AI，含負責人、資料來源、依賴程度。新增功能先登記再上線。"],
      ["3 評估風險", "「風險評分」用可能性 × 影響排出優先順序，每項附一個「如果……會怎樣」的情境。"],
      ["4 設計控制", "「控制對照」每個風險至少一個控制，標明預防、偵測、改正，以及憑據在哪裡。"],
      ["5 執行與溝通", "重大設定變更先在「紀錄」記核准；每月收內控月報信；本頁就是給同事的速查。"],
      ["6 監督與調整", "「外部相依」改版後驗證、每月抽查 AI 摘要；到期未做會在月報信與下方提醒。"]
    ];
    var rules = [
      "改工廠設定、門檻、權限、外部服務前，先在「紀錄」記下<b>提出人、內容、核准人</b>。",
      "<b>不要把客戶、成本、員工資料貼到未核准的外部 AI</b>（個人 ChatGPT、翻譯網站…）；要用 AI 先問老闆。",
      "AI 摘要只當參考，<b>金額與交期一律回原始資料確認</b>。",
      "收到紅燈信，負責人當天處理並在通知中心按「已知悉」；30 分鐘沒人處理會升級老闆。",
      "發現資料怪怪的（價格不動、數字突然變很多）先回報負責人，不要自己改。"
    ];
    var head = '<div class="okpis erp-kpis">' + U.kpi(ic("shield") + "功能", G.INVENTORY.length + " 項", "", "已登記的自動化與 AI")
      + U.kpi(ic("alert") + "風險", G.RISKS.length + " 項", "", "高分 " + G.ranked().filter(function (r) { return r.level === "高"; }).length + " 項")
      + U.kpi(ic("check") + "控制", G.CONTROLS.length + " 項", "", "每個風險至少 1 項")
      + U.kpi(ic("clock") + "待辦紀錄", late.length + " 項", late.length ? "warn" : "", late.length ? "逾期或從未記錄" : "都在期限內") + "</div>";
    var warn = pr.length ? '<div class="dbnote"><b>登錄資料有缺漏：</b><br>' + pr.map(esc).join("<br>") + "</div>" : "";
    var lateHtml = late.length ? '<div class="dbnote"><b>需要補的紀錄：</b><br>' + late.map(function (d) { return esc(d.label) + "：" + (d.state === "never" ? "還沒有紀錄" : "已 " + d.days + " 天（應每 " + d.every + " 天）"); }).join("<br>") + "</div>" : "";
    return head + warn + lateHtml
      + section(ic("book") + "6 步驟怎麼落實", U.table([{ l: "步驟", v: function (r) { return "<b>" + esc(r[0]) + "</b>"; } }, { l: "在這個儀表板怎麼做", v: 1 }], steps))
      + section(ic("shield") + "同事守則（一頁版）", "<ol>" + rules.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ol>");
  }
  function roles() {
    return '<div class="dbnote">公司規模小，不另設委員會；用「誰負責什麼」明文化。更細的畫面權限見「帳號權限」分頁。</div>'
      + section(ic("shield") + "治理分工", U.table([{ l: "角色", v: function (r) { return "<b>" + esc(r.who) + "</b>"; } }, { l: "責任", v: "duty" }, { l: "頻率", v: "cadence" }], G.ROLES));
  }
  function inv() {
    var cols = [{ l: "#", v: "id" }, { l: "功能", v: function (r) { return "<b>" + esc(r.name) + "</b><div class=\"erp-muted\">" + esc(r.engine) + "</div>"; } },
      { l: "類型", v: function (r) { return chip(r.kind, r.kind === "演算法" || r.kind === "基礎設施" ? "muted" : "warn"); } }, { l: "能力", v: "cap" }, { l: "負責人", v: "owner" },
      { l: "資料來源", v: "source" }, { l: "部署", v: "deploy" }, { l: "重要性", v: function (r) { return chip(r.importance, tone(r.importance)); } },
      { l: "依賴程度", v: function (r) { return chip(r.reliance, r.reliance === "依賴" ? "warn" : "muted"); } }, { l: "風險", v: function (r) { return esc(r.risks.join("、")); } }];
    return '<div class="dbnote">新增任何自動化、AI 或外部服務，<b>先登記在這裡（governance.js 的 INVENTORY）再上線</b>。「依賴」＝結果直接當決策或帳務依據，控制就要比較嚴；「不依賴」＝只供參考、人會再確認。生成式 AI 與第三方 AI 用黃色標示。</div>'
      + section(ic("book") + "自動化與 AI 功能清單（" + G.INVENTORY.length + "）", U.table(cols, G.INVENTORY));
  }
  function risk() {
    var rows = G.ranked();
    var cols = [{ l: "#", v: "id" }, { l: "風險", v: function (r) { return "<b>" + esc(r.name) + "</b>"; } }, { l: "可能性", v: "L", r: true }, { l: "影響", v: "I", r: true },
      { l: "分數", v: function (r) { return chip(r.score + "（" + r.level + "）", tone(r.level)); }, r: true }, { l: "控制數", v: function (r) { return String(G.controlsFor(r.id).length); }, r: true }];
    return '<div class="dbnote">分數＝可能性（1–5）× 影響（1–5）；≥12 高、≥8 中。分數由負責人每季檢視時調整（改 governance.js 的 RISKS）。高分風險必須有預防或改正控制，否則測試會擋下。</div>'
      + section(ic("alert") + "風險排序", U.table(cols, rows));
  }
  function ctl() {
    var cols = [{ l: "#", v: "id" }, { l: "控制", v: function (r) { return "<b>" + esc(r.name) + "</b>"; } }, { l: "類型", v: function (r) { return chip(r.type, r.type === "預防" ? "ok" : r.type === "偵測" ? "warn" : "muted"); } },
      { l: "對應風險", v: function (r) { return esc(r.risks.join("、")); } }, { l: "在哪裡", v: "where" }, { l: "憑據（要查時去哪找）", v: "evidence" },
      { l: "狀態", v: function (r) { return r.status === "new" ? chip("本次新增", "warn") : chip("已有", "ok"); } }];
    var cov = G.RISKS.map(function (r) { var cs = G.controlsFor(r.id), t = {}; cs.forEach(function (c) { t[c.type] = 1; });
      return { id: r.id, name: r.name, p: t["預防"] ? "●" : "", d: t["偵測"] ? "●" : "", c: t["改正"] ? "●" : "" }; });
    return section(ic("check") + "控制清單（" + G.CONTROLS.length + "）", U.table(cols, G.CONTROLS))
      + section(ic("chart") + "風險 × 控制類型", U.table([{ l: "#", v: "id" }, { l: "風險", v: "name" }, { l: "預防", v: "p" }, { l: "偵測", v: "d" }, { l: "改正", v: "c" }], cov));
  }
  function dep() {
    var due = G.dueList(ST.logs, Date.now()), by = {}; due.forEach(function (d) { if (d.kind === "dep-verify") by[d.ref] = d; });
    var cols = [{ l: "#", v: "id" }, { l: "外部服務", v: function (r) { return "<b>" + esc(r.name) + "</b><div class=\"erp-muted\">" + esc(r.used) + "</div>"; } }, { l: "可能的變動", v: "change" },
      { l: "改版後檢查", v: function (r) { return "<ol>" + r.check.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ol>"; } },
      { l: "最近驗證", v: function (r) { var d = by[r.id]; return !d || d.last == null ? chip("從未", "warn") : chip(d.days + " 天前", d.state === "ok" ? "ok" : "warn"); } },
      { l: "", v: function (r) { return ST.canWrite ? U.btn("gov-dep", "記一次驗證", r.id) : ""; } }];
    return '<div class="dbnote">你的功能依賴這些外部服務，它們改版、換模型或改額度時，<b>我們看不到通知</b>，所以要定期驗證。每季一次，或聽說對方有改動時立刻做；做完按「記一次驗證」。</div>'
      + section(ic("link") + "外部相依清單（" + G.DEPS.length + "）", U.table(cols, G.DEPS));
  }
  function scn() {
    var cols = [{ l: "#", v: "id" }, { l: "風險", v: "name" }, { l: "如果……會怎樣", v: "scenario" }, { l: "現有控制", v: function (r) { return G.controlsFor(r.id).map(function (c) { return esc(c.id + " " + c.name); }).join("<br>"); } }];
    return '<div class="dbnote">季度檢視時挑 2–3 個情境，問：「真的發生了，我們多久會發現？誰處理？怎麼還原？」答不出來就是控制要補強的地方。</div>'
      + section(ic("alert") + "情境演練題庫", U.table(cols, G.ranked()));
  }
  function log() {
    var due = G.dueList(ST.logs, Date.now());
    var dueHtml = U.table([{ l: "項目", v: "label" }, { l: "頻率", v: function (r) { return "每 " + r.every + " 天"; } },
      { l: "最近一次", v: function (r) { return r.last == null ? chip("從未", "warn") : esc(new Date(r.last).toISOString().slice(0, 10)) + "（" + r.days + " 天前）"; } },
      { l: "狀態", v: function (r) { return r.state === "ok" ? chip("正常", "ok") : chip(r.state === "never" ? "尚無紀錄" : "逾期", "warn"); } }], due);
    var acts = ST.canWrite ? '<div class="erp-row">' + U.btn("gov-add", ic("check") + "治理檢視（簽核）", "gov-review") + U.btn("gov-add", ic("search") + "AI 摘要抽查", "ai-sample")
      + U.btn("gov-add", ic("shield") + "影子 AI 確認", "shadow-ai") + U.btn("gov-add", ic("edit") + "重大變更核准", "change-approval") + "</div>"
      : '<div class="dbnote erp-muted">只有老闆、主管能新增治理紀錄；你可以查看。</div>';
    var hist = U.table([{ l: "時間", v: function (r) { return esc(String(r.ts).slice(0, 16).replace("T", " ")); } }, { l: "類型", v: function (r) { return esc((G.KINDS[r.kind] || { label: r.kind }).label); } },
      { l: "對象", v: "ref" }, { l: "內容", v: "note" }, { l: "核准人", v: "approver" }, { l: "記錄人", v: "by" }], ST.logs, { empty: "還沒有任何紀錄" });
    return '<div class="dbnote">這些紀錄就是「內控有在運作」的憑據：稽核或客戶問起時，拿這張表給他看。' + (authed() ? "" : "（目前是本機試用，紀錄只存在這台電腦。）") + "</div>"
      + section(ic("clock") + "定期事項", dueHtml) + section(ic("edit") + "新增紀錄", acts) + section(ic("book") + "紀錄（" + ST.logs.length + "）", hist);
  }
  var PAGES = { quick: quick, roles: roles, inv: inv, risk: risk, ctl: ctl, dep: dep, scn: scn, log: log };

  U.VIEW.gov = function () {
    if (!ST.loaded) { load(); if (!ST.loaded) return section(ic("shield") + "內控治理", '<div class="dbempty">讀取中…</div>'); }
    var nav = '<div class="erp-row">' + SUBS.map(function (s) { return U.btn("gov-sub", s[1], s[0], s[0] === ST.sub ? "on" : ""); }).join("") + "</div>";
    return '<div class="dbnote">依 COSO 2026《GenAI 內部控制指引》的 6 步驟整理。本頁的原則：<b>越依賴自動化的結果，控制就要越嚴格，而且要留得下憑據。</b></div>' + nav + PAGES[ST.sub]();
  };
  U.H["gov-sub"] = function (id) { ST.sub = PAGES[id] ? id : "quick"; U.render(); };
  U.H["gov-dep"] = function (id) {
    var d = G.DEPS.filter(function (x) { return x.id === id; })[0]; if (!d) return;
    var n = window.prompt("驗證「" + d.name + "」\n\n檢查項目：\n- " + d.check.join("\n- ") + "\n\n結果與備註（例：全部正常／模型名稱已改，已更新）：", "全部正常");
    if (n == null) return; addLog("dep-verify", id, n.trim() || "全部正常", "");
  };
  U.H["gov-add"] = function (kind) {
    var def = G.KINDS[kind], note, appr = "", ref = "";
    if (kind === "change-approval") {
      ref = window.prompt("變更什麼？（例：工廠設定－切割站產能、門檻－B2、新增外部服務）"); if (ref == null) return;
      note = window.prompt("提出人與原因："); if (note == null) return;
      appr = window.prompt("核准人（必填）："); if (!appr || !appr.trim()) { alert("沒有核准人，這筆不會記錄。重大變更需要有人核准。"); return; }
    } else if (kind === "ai-sample") {
      note = window.prompt("本月抽查 5 筆 AI 摘要，幾筆和原始資料不一致？有問題的是哪一類？\n（例：5 筆都一致／1 筆價格寫錯）"); if (note == null) return;
    } else if (kind === "shadow-ai") {
      note = window.prompt("已詢問哪些同事？有沒有人把公司資料貼到未核准的外部 AI？\n（例：已問全部同事，無）"); if (note == null) return;
    } else {
      note = window.prompt("本次檢視結論（例：功能清單與風險評分已確認，新增 F12、調整 R3 分數）："); if (note == null) return;
      appr = window.prompt("簽核人："); if (appr == null) return;
    }
    addLog(kind, ref, (note || "").trim() || def.label, (appr || "").trim());
  };
})();
