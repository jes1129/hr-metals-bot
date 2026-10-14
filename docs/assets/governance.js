/*
 * governance.js — 內控治理登錄：功能清單、風險評分、控制對照、外部相依、情境演練、定期紀錄、內控月報
 *   依 COSO 2026《GenAI 內部控制指引》第七節的 6 步驟（建立治理架構 → 盤點 → 評估風險 → 設計控制 → 執行溝通 → 監督調整）整理。
 *   純資料與規則，沒有任何 AI。瀏覽器（內控治理頁）、Apps Script（每月內控月報）、Node 測試共用同一份。
 *
 *   新增功能、新增外部服務、新增風險時：改這個檔，再跑 node --test tests/governance.test.mjs，
 *   測試會檢查「每個風險至少有一個控制」「每個功能都有負責人」「控制指到的風險都存在」，缺了就不讓上線。
 *   改完要重產 ERP 後端檔：python scripts/build_erp_gas.py
 */
(function (root) {
  "use strict";

  // ---- 步驟 1：治理分工（小公司沒有委員會，用「誰負責什麼」取代） -------------------------------------------
  var ROLES = [
    { who: "老闆", duty: "核准重大變更（工廠設定、門檻、權限、新增外部服務）；簽核每季治理檢視；收高風險操作與內控月報", cadence: "每季檢視、事件時核准" },
    { who: "主管", duty: "同老闆的檢視與核准權限（能讀寫治理紀錄）；覆核排程與營運風險的紅燈處理", cadence: "每季檢視" },
    { who: "生管", duty: "排程引擎與排程風險指標的負責人；工廠設定變更前先提出、變更後確認排程重排", cadence: "每週看風險儀表板" },
    { who: "會計", duty: "ERP 成本、毛利、應收帳款計算的負責人；盤點調整原因的覆核", cadence: "每月結帳前" },
    { who: "行政", duty: "帳號異動（到職、離職、調動）通知老闆；每季帳號盤點的對照", cadence: "異動當天" },
    { who: "所有人", duty: "不把客戶、成本、員工資料貼到外部 AI 或未核准的服務；發現異常回報負責人", cadence: "隨時" }
  ];

  // ---- 步驟 2：自動化／AI 功能清單 -------------------------------------------------------------------------------
  // kind：演算法（固定規則，同樣輸入同樣輸出）／生成式 AI／第三方 AI 服務／基礎設施
  // reliance：依賴（結果直接當決策或帳務依據）／不依賴（只供參考，人會再確認）
  var INVENTORY = [
    { id: "F1", name: "生產排程引擎", kind: "演算法", cap: "判斷與預測", owner: "生管", source: "ERP 訂單、工廠設定", engine: "sched-engine.js（論文融合的規則演算法，無 AI）", deploy: "瀏覽器端計算", importance: "高", reliance: "依賴", risks: ["R1", "R2"] },
    { id: "F2", name: "排程風險監控與通知", kind: "演算法", cap: "監控", owner: "生管", source: "排程採用紀錄、現場回報", engine: "sched-kri.js、sched-alerts.gs（17 個指標）", deploy: "瀏覽器＋Apps Script", importance: "高", reliance: "依賴", risks: ["R1", "R13"] },
    { id: "F3", name: "營運風險儀表板", kind: "演算法", cap: "監控", owner: "老闆", source: "ERP 全部資料", engine: "biz-kri.js（14 個指標）", deploy: "瀏覽器＋Apps Script", importance: "高", reliance: "依賴", risks: ["R9", "R11"] },
    { id: "F4", name: "ERP 規則引擎（庫存 FIFO、成本、毛利、應收）", kind: "演算法", cap: "自動交易處理", owner: "會計", source: "ERP 各資料表", engine: "erp-engine.js", deploy: "瀏覽器＋Apps Script（同一份規則）", importance: "高", reliance: "依賴", risks: ["R11", "R8"] },
    { id: "F5", name: "原料價格抓取與資料來源監控", kind: "演算法", cap: "資料擷取", owner: "老闆", source: "公開的原料價格來源、匯率", engine: "metals.py、datahealth.py", deploy: "GitHub Actions 排程", importance: "中", reliance: "依賴", risks: ["R3", "R5"] },
    { id: "F6", name: "行情與供應商 AI 摘要", kind: "生成式 AI", cap: "判斷與預測", owner: "老闆", source: "原料行情、供應商名單", engine: "ai.py：Groq → Claude → 規則式後備", deploy: "GitHub Actions 排程", importance: "中", reliance: "不依賴", risks: ["R4", "R5", "R10"] },
    { id: "F7", name: "客戶與供應商名單雷達", kind: "演算法", cap: "資料擷取", owner: "老闆", source: "公開名單來源", engine: "run_radar.py、crossmatch.py", deploy: "GitHub Actions 排程", importance: "低", reliance: "不依賴", risks: ["R3", "R5"] },
    { id: "F8", name: "每日備份與還原演練", kind: "基礎設施", cap: "備份", owner: "老闆", source: "整份 Google 試算表", engine: "backup.gs", deploy: "Apps Script 觸發器", importance: "高", reliance: "依賴", risks: ["R7"] },
    { id: "F9", name: "職務權限與高風險操作通知", kind: "基礎設施", cap: "權限", owner: "老闆", source: "acl 分頁", engine: "erp-roles.js、accessGate_", deploy: "Apps Script", importance: "高", reliance: "依賴", risks: ["R6", "R10"] },
    { id: "F10", name: "每日早報信", kind: "演算法", cap: "通知", owner: "老闆", source: "原料價格、ERP 摘要", engine: "email-notify.gs", deploy: "Apps Script 觸發器", importance: "低", reliance: "不依賴", risks: ["R9"] },
    { id: "F11", name: "NotebookLM 每日簡報匯出", kind: "第三方 AI 服務", cap: "資料轉換", owner: "老闆", source: "ERP 現況彙總", engine: "notebooklm-export.gs → Google NotebookLM", deploy: "Apps Script 觸發器（選用）", importance: "低", reliance: "不依賴", risks: ["R5", "R10", "R12"] }
  ];

  // ---- 步驟 3：風險（可能性 L、影響 I 都是 1–5；score = L × I） ----------------------------------------------------
  // scenario 是「如果……會怎樣」的極端情境，給季度演練用
  var RISKS = [
    { id: "R1", name: "排程預測和現場脫節（漂移）", L: 3, I: 4, scenario: "某一站實際工時比設定多 30%，連續三張單都延遲" },
    { id: "R2", name: "工廠設定被誤改，排程悄悄失準", L: 3, I: 4, scenario: "有人把某站每小時產能多打了一個零，之後沒人重排" },
    { id: "R3", name: "原料價格資料過期、錯誤或凍結", L: 3, I: 3, scenario: "價格來源網站改版，連續三天抓到同一個價格" },
    { id: "R4", name: "AI 摘要出錯（幻覺）被當成事實", L: 3, I: 3, scenario: "AI 摘要把供應商的價格寫成上漲 20%，原始資料其實持平" },
    { id: "R5", name: "外部服務改版、停用或換模型", L: 3, I: 3, scenario: "Groq 免費額度取消、或 Apps Script 平台改了授權方式" },
    { id: "R6", name: "越權看到成本、人事資料", L: 2, I: 5, scenario: "離職員工的帳號還是啟用，帶著成本表離開" },
    { id: "R7", name: "資料被誤刪或損毀，無法復原", L: 2, I: 5, scenario: "有人整份匯入舊備份，把今天的訂單全部蓋掉" },
    { id: "R8", name: "程式更新造成錯誤上線", L: 2, I: 4, scenario: "改了成本計算，卻忘了重貼 Apps Script，網頁與後端版本不一致" },
    { id: "R9", name: "警示沒人處理（警示疲勞、信件被忽略）", L: 3, I: 3, scenario: "紅燈寄出去三天，沒有任何人按「已知悉」" },
    { id: "R10", name: "影子 AI：把公司資料貼到未核准的外部 AI", L: 3, I: 4, scenario: "業務把客戶報價單整份貼到個人帳號的 ChatGPT 請它潤稿" },
    { id: "R11", name: "成本、毛利、應收的計算規則錯誤", L: 2, I: 5, scenario: "FIFO 扣庫存順序錯，毛利被高估而接了虧損單" },
    { id: "R12", name: "敏感資料被送到第三方服務", L: 2, I: 3, scenario: "NotebookLM 的來源文件被分享給不該看的人" },
    { id: "R13", name: "監控本身失靈（現場沒回報、觸發器停了）", L: 3, I: 3, scenario: "每 30 分鐘的觸發器因授權過期停止，沒人發現" }
  ];

  // ---- 步驟 4：控制（type：預防／偵測／改正；evidence：要查的時候去哪裡找憑據；status：done 已有／new 這次新增） -----------------
  var CONTROLS = [
    { id: "C1", name: "採用新排程前依燈號檢查（黃燈勾選、紅燈填原因並二次確認）", type: "預防", risks: ["R1", "R2"], where: "排程頁「採用」", evidence: "sched_ver 採用紀錄（誰、何時、為什麼、前後差異、當下燈號）", status: "done" },
    { id: "C2", name: "預測漂移監控（誤差連續超標才升級、完工回報率）", type: "偵測", risks: ["R1", "R13"], where: "排程頁「風險儀表板」D1–D5", evidence: "sched_hist 歷史、通知中心", status: "done" },
    { id: "C3", name: "工廠設定每次修改留紀錄，可預覽並回復", type: "改正", risks: ["R2"], where: "排程頁「採用紀錄」", evidence: "sched_ver 工廠設定變更紀錄", status: "done" },
    { id: "C4", name: "原料資料來源監控（新鮮度、凍結、價差、匯率）", type: "偵測", risks: ["R3"], where: "datahealth.py、首頁燈號、早報", evidence: "GitHub Actions 紅色註解、早報警示", status: "done" },
    { id: "C5", name: "AI 摘要有規則式後備；每月抽查 5 筆對照原始資料", type: "偵測", risks: ["R4"], where: "ai.py 後備；內控治理頁「紀錄」", evidence: "gov_log 的「AI 摘要抽查」紀錄", status: "new" },
    { id: "C6", name: "外部相依清單：改版或換模型後依檢查表驗證", type: "預防", risks: ["R5", "R12"], where: "內控治理頁「外部相依」", evidence: "gov_log 的「相依驗證」紀錄", status: "new" },
    { id: "C7", name: "七種職務、伺服器端把關並遮掉成本與人事", type: "預防", risks: ["R6", "R11"], where: "帳號權限、accessGate_", evidence: "acl 分頁、ERP_操作紀錄", status: "done" },
    { id: "C8", name: "高風險操作即時通知老闆；每季帳號盤點", type: "偵測", risks: ["R6", "R10"], where: "accessReview、aclRisk_", evidence: "「高風險操作」分頁、盤點信", status: "done" },
    { id: "C9", name: "每日備份、每月還原演練、單張救回", type: "改正", risks: ["R7"], where: "backup.gs", evidence: "backup_log 分頁", status: "done" },
    { id: "C10", name: "程式更新先跑全部測試，失敗不部署；頁尾版本比對", type: "預防", risks: ["R8"], where: "GitHub Actions、頁尾版本", evidence: "Actions 執行紀錄", status: "done" },
    { id: "C11", name: "營運風險 14 指標、門檻、通知、紅燈 30 分鐘沒人回應升級老闆", type: "偵測", risks: ["R9", "R11"], where: "ERP「風險儀表板」、sched-alerts.gs", evidence: "sched_notice、sched_alert、biz_hist", status: "done" },
    { id: "C12", name: "影子 AI 規定：公司資料不得貼到未核准的外部 AI；每季確認一次", type: "預防", risks: ["R10"], where: "內控治理頁「速查」與「紀錄」", evidence: "gov_log 的「影子 AI 確認」紀錄", status: "new" },
    { id: "C13", name: "重大設定變更核准紀錄（工廠設定、門檻、權限、外部服務）", type: "預防", risks: ["R2", "R8", "R12"], where: "內控治理頁「紀錄」", evidence: "gov_log 的「變更核准」紀錄（含核准人）", status: "new" },
    { id: "C14", name: "ERP 規則單元測試（FIFO、毛利、應收）", type: "預防", risks: ["R11", "R8"], where: "tests/erp-engine.test.mjs", evidence: "Actions 測試結果", status: "done" },
    { id: "C15", name: "每季治理檢視：老闆逐項確認清單、風險、控制並簽核", type: "偵測", risks: ["R9", "R13", "R5"], where: "內控治理頁「紀錄」", evidence: "gov_log 的「治理檢視」紀錄", status: "new" },
    { id: "C16", name: "每月內控月報信（燈號、備份、高風險操作、待辦紀錄）", type: "偵測", risks: ["R9", "R13", "R7"], where: "govMonthlyReport（Apps Script）", evidence: "寄給老闆的月報信", status: "new" }
  ];

  // ---- 步驟 6：外部相依（改版或換模型就要重新驗證） ------------------------------------------------------------------
  var DEPS = [
    { id: "D1", name: "Google Apps Script 與試算表", owner: "老闆", used: "ERP 後端、通知、備份", change: "授權範圍改變、觸發器停用、配額調整", check: ["執行 appVersion（頁尾版本沒有警告）", "觸發器清單裡 checkSchedAlerts、backupNow 都還在", "手動執行一次 backupNow 確認有新備份"] },
    { id: "D2", name: "GitHub Pages 與 Actions", owner: "老闆", used: "網頁發布、排程抓價格、跑測試", change: "Actions 執行環境升級、排程延遲、額度限制", check: ["最近一次 metals 工作流程是綠燈", "首頁更新時間是今天", "測試 job 通過"] },
    { id: "D3", name: "原料價格與匯率來源網站", owner: "老闆", used: "metals.py、datahealth.py", change: "網站改版、欄位改名、停止提供", check: ["首頁資料來源燈號沒有紅燈", "最新價格與來源網站肉眼比對一致", "沒有連續多天價格相同"] },
    { id: "D4", name: "Groq（第一層 AI）", owner: "老闆", used: "ai.py 行情與供應商摘要", change: "免費額度改變、模型下架或改名、回覆格式改變", check: ["執行 probe-ai 工作流程確認能回應", "抽查 5 筆摘要對照原始資料（記「AI 摘要抽查」）", "模型名稱仍在官方模型清單"] },
    { id: "D5", name: "Claude／Anthropic API（第二層 AI，選用）", owner: "老闆", used: "ai.py 後備", change: "模型更換、價格調整、API 版本改變", check: ["確認 ANTHROPIC_API_KEY 是否仍有設定、額度未用完", "模型名稱仍可用", "抽查 5 筆輸出"] },
    { id: "D6", name: "Google 登入（Sign-In）", owner: "老闆", used: "所有需要登入的功能", change: "OAuth 設定、網域白名單改變", check: ["用一個非老闆帳號登入確認可進入", "未授權帳號確實被擋下"] },
    { id: "D7", name: "Google NotebookLM（選用）", owner: "老闆", used: "每日簡報來源", change: "分享設定改變、功能調整", check: ["來源文件的分享對象仍只有公司人員", "簡報內容沒有成本或人事明細"] }
  ];

  // ---- 定期紀錄：kind 對應 gov_log 的 kind 欄位；every 是應該幾天做一次（0 = 事件發生時才記） ----------------------------
  var KINDS = {
    "gov-review": { label: "治理檢視", every: 92, hint: "每季一次：老闆逐項確認清單、風險評分、控制是否還適用" },
    "ai-sample": { label: "AI 摘要抽查", every: 31, hint: "每月一次：抽 5 筆 AI 摘要對照原始資料，記下有幾筆不一致" },
    "dep-verify": { label: "相依驗證", every: 92, hint: "每季或外部服務改版後：依外部相依的檢查表逐項確認" },
    "shadow-ai": { label: "影子 AI 確認", every: 92, hint: "每季一次：問每位同事有沒有把公司資料貼到未核准的外部 AI" },
    "change-approval": { label: "變更核准", every: 0, hint: "重大設定變更時：誰提出、改什麼、誰核准" }
  };
  var LOG_HDR = ["id", "ts", "by", "kind", "ref", "note", "approver"];
  var DAY = 86400000;

  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function ms(t) { var n = typeof t === "number" ? t : Date.parse(t); return isFinite(n) ? n : null; }

  function score(r) { return r.L * r.I; }
  function scoreLevel(s) { return s >= 12 ? "高" : s >= 8 ? "中" : "低"; }
  function ranked() { return RISKS.map(function (r) { return { id: r.id, name: r.name, L: r.L, I: r.I, score: score(r), level: scoreLevel(score(r)), scenario: r.scenario }; }).sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); }); }
  function controlsFor(riskId) { return CONTROLS.filter(function (c) { return c.risks.indexOf(riskId) >= 0; }); }

  /** 結構檢查：回傳問題清單（空 = 沒問題）。測試與「治理」頁都用它。 */
  function problems() {
    var out = [], ids = {};
    RISKS.forEach(function (r) { if (ids[r.id]) out.push("風險編號重複：" + r.id); ids[r.id] = 1; if (!(r.L >= 1 && r.L <= 5 && r.I >= 1 && r.I <= 5)) out.push(r.id + " 的可能性或影響不在 1–5"); });
    RISKS.forEach(function (r) {
      var cs = controlsFor(r.id);
      if (!cs.length) out.push(r.id + "「" + r.name + "」沒有任何控制");
      else if (score(r) >= 12 && !cs.some(function (c) { return c.type === "預防"; }) && !cs.some(function (c) { return c.type === "改正"; })) out.push(r.id + " 是高風險，卻只有偵測、沒有預防或改正控制");
    });
    CONTROLS.forEach(function (c) {
      if (["預防", "偵測", "改正"].indexOf(c.type) < 0) out.push(c.id + " 的類型不是預防／偵測／改正");
      if (!c.evidence) out.push(c.id + " 沒有寫憑據在哪裡");
      c.risks.forEach(function (rid) { if (!byId(RISKS, rid)) out.push(c.id + " 指到不存在的風險 " + rid); });
    });
    INVENTORY.forEach(function (f) {
      if (!f.owner) out.push(f.id + " 沒有負責人");
      if (["依賴", "不依賴"].indexOf(f.reliance) < 0) out.push(f.id + " 沒有標依賴程度");
      if (["高", "中", "低"].indexOf(f.importance) < 0) out.push(f.id + " 沒有標重要性");
      f.risks.forEach(function (rid) { if (!byId(RISKS, rid)) out.push(f.id + " 指到不存在的風險 " + rid); });
      // 越依賴自動化的輸出，控制就要越嚴：依賴 + 高重要性的功能，其高分風險（≥12）至少要有一個預防或改正控制
      if (f.reliance === "依賴" && f.importance === "高") f.risks.forEach(function (rid) { if (score(byId(RISKS, rid) || { L: 0, I: 0 }) >= 12 && !controlsFor(rid).some(function (c) { return c.type === "預防" || c.type === "改正"; })) out.push(f.id + "「" + f.name + "」依賴度高，但風險 " + rid + " 沒有預防或改正控制"); });
    });
    var used = {}; INVENTORY.forEach(function (f) { f.risks.forEach(function (rid) { used[rid] = 1; }); });
    RISKS.forEach(function (r) { if (!used[r.id]) out.push(r.id + "「" + r.name + "」沒有對應到任何功能"); });
    return out;
  }

  /** 定期紀錄的到期狀態。records：[{ts, kind, ref}]；回傳每個待辦一筆 {key, kind, ref, label, last(ms|null), days, every, state: ok|due|never} */
  function dueList(records, now) {
    var last = {};
    (records || []).forEach(function (r) { var t = ms(r.ts); if (t == null) return; var k = r.kind + "|" + (r.ref || ""); if (!last[k] || t > last[k]) last[k] = t; });
    var out = [];
    function add(kind, ref, label) {
      var def = KINDS[kind], k = kind + "|" + (ref || ""), t = last[k] != null ? last[k] : null;
      var days = t == null ? null : Math.floor((now - t) / DAY);
      out.push({ key: k, kind: kind, ref: ref || "", label: label, last: t, days: days, every: def.every, state: t == null ? "never" : days > def.every ? "due" : "ok" });
    }
    add("gov-review", "", KINDS["gov-review"].label);
    add("ai-sample", "", KINDS["ai-sample"].label);
    add("shadow-ai", "", KINDS["shadow-ai"].label);
    DEPS.forEach(function (d) { add("dep-verify", d.id, KINDS["dep-verify"].label + "：" + d.name); });
    return out;
  }

  function dayStr(now) { var d = new Date(now + 8 * 3600000); return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2); }

  /**
   * 內控月報。input：
   *   now（ms）、kri {red, yellow, green, na, red_names[], yellow_names[]}、backup {installed, backupDays, drillDays, failStreak}|null、
   *   riskOps（近 30 天高風險操作筆數）、records（gov_log 的列）
   */
  function monthlyReport(input) {
    var now = input.now, k = input.kri || {}, b = input.backup, due = dueList(input.records, now), lines = [], todo = [];
    lines.push("【內控月報】" + dayStr(now));
    lines.push("");
    lines.push("一、風險燈號（排程＋營運）");
    lines.push("　目前紅燈 " + (k.red || 0) + " 項、黃燈 " + (k.yellow || 0) + " 項" + (k.green != null ? "、正常 " + k.green + " 項" : "") + (k.na ? "、資料不足 " + k.na + " 項" : ""));
    (k.red_names || []).slice(0, 8).forEach(function (n) { lines.push("　【紅】" + n); });
    (k.yellow_names || []).slice(0, 8).forEach(function (n) { lines.push("　【黃】" + n); });
    if ((k.red || 0) > 0) todo.push("有紅燈未解除，請負責人處理並在通知中心按「已知悉」");
    lines.push("");
    lines.push("二、備份與還原");
    if (!b || !b.installed) { lines.push("　尚未安裝備份（backup.gs）"); todo.push("安裝每日備份：貼 backup.gs 並執行 installBackupTrigger"); }
    else {
      lines.push("　最近備份：" + (b.backupDays == null ? "沒有成功紀錄" : b.backupDays + " 天前") + "；最近還原演練：" + (b.drillDays == null ? "沒有成功紀錄" : b.drillDays + " 天前") + (b.failStreak ? "；連續失敗 " + b.failStreak + " 次" : ""));
      if (b.backupDays == null || b.backupDays > 2 || b.failStreak) todo.push("備份異常：檢查 backup_log 分頁與觸發器");
      if (b.drillDays == null || b.drillDays > 40) todo.push("還原演練逾期：手動執行 restoreDrill");
    }
    lines.push("");
    lines.push("三、高風險操作");
    lines.push("　近 30 天 " + (input.riskOps || 0) + " 筆（大量匯入、大量刪除、帳號權限變更、匯入備份）");
    if ((input.riskOps || 0) > 0) todo.push("打開「高風險操作」分頁，確認每一筆都是預期的操作");
    lines.push("");
    lines.push("四、定期治理紀錄");
    due.forEach(function (d) {
      var tag = d.state === "ok" ? "【正常】" : d.state === "due" ? "【逾期】" : "【從未記錄】";
      lines.push("　" + tag + " " + d.label + (d.days != null ? "（" + d.days + " 天前，應每 " + d.every + " 天一次）" : ""));
      if (d.state !== "ok") todo.push(d.label + (d.state === "never" ? "：還沒有任何紀錄" : "：已逾期 " + (d.days - d.every) + " 天"));
    });
    lines.push("");
    lines.push("五、待辦（共 " + todo.length + " 項）");
    if (!todo.length) lines.push("　本月沒有待辦。");
    todo.forEach(function (t, i) { lines.push("　" + (i + 1) + ". " + t); });
    lines.push("");
    lines.push("治理紀錄請到：行政工作台 →「內控治理」。");
    return { subject: "【內控月報】" + (todo.length ? todo.length + " 項待辦" : "無待辦") + "（" + dayStr(now) + "）", body: lines.join("\n"), todo: todo };
  }

  var api = { ROLES: ROLES, INVENTORY: INVENTORY, RISKS: RISKS, CONTROLS: CONTROLS, DEPS: DEPS, KINDS: KINDS, LOG_HDR: LOG_HDR,
    score: score, scoreLevel: scoreLevel, ranked: ranked, controlsFor: controlsFor, problems: problems, dueList: dueList, monthlyReport: monthlyReport };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ErpGov = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
