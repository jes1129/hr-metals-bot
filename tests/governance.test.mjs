// 內控治理：登錄資料的完整性、定期紀錄到期判斷、內控月報、權限、後端月報函式
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../docs/assets/governance.js");
const R = require("../docs/assets/erp-roles.js");
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const DAY = 86400000;
const NOW = Date.parse("2026-11-01T00:00:00Z");

test("登錄資料沒有缺漏：每個風險有控制、每個功能有負責人、編號都對得上", () => {
  assert.deepEqual(G.problems(), []);
});

test("高分風險（≥12）一定有預防或改正控制，不能只靠事後偵測", () => {
  for (const r of G.ranked().filter((x) => x.score >= 12)) {
    const cs = G.controlsFor(r.id);
    assert.ok(cs.some((c) => c.type === "預防" || c.type === "改正"), `${r.id} ${r.name}`);
  }
});

test("problems() 真的抓得到缺漏（刻意弄壞再還原）", () => {
  const saved = G.CONTROLS.slice();
  G.CONTROLS.splice(0, G.CONTROLS.length, ...saved.filter((c) => c.id !== "C9" && c.id !== "C16"));       // 拿掉唯一對應 R7 的備份控制
  assert.ok(G.problems().some((p) => /R7/.test(p)));
  G.CONTROLS.splice(0, G.CONTROLS.length, ...saved);
  assert.deepEqual(G.problems(), []);
});

test("風險排序：分數由高到低；等級門檻 12／8", () => {
  const r = G.ranked();
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score);
  assert.equal(G.scoreLevel(12), "高"); assert.equal(G.scoreLevel(11), "中"); assert.equal(G.scoreLevel(8), "中"); assert.equal(G.scoreLevel(7), "低");
});

test("生成式 AI 與第三方 AI 功能都標為「不依賴」或有明確控制（AI 輸出不能直接當帳務依據）", () => {
  for (const f of G.INVENTORY.filter((x) => x.kind === "生成式 AI" || x.kind === "第三方 AI 服務")) assert.equal(f.reliance, "不依賴", f.name);
});

test("定期紀錄：從未記錄 → never；超過期限 → due；期限內 → ok；相依驗證每個外部服務各算一筆", () => {
  const none = G.dueList([], NOW);
  assert.ok(none.every((d) => d.state === "never"));
  assert.equal(none.filter((d) => d.kind === "dep-verify").length, G.DEPS.length);
  const logs = [
    { ts: new Date(NOW - 10 * DAY).toISOString(), kind: "ai-sample", ref: "" },
    { ts: new Date(NOW - 40 * DAY).toISOString(), kind: "ai-sample", ref: "" },           // 較舊的不影響
    { ts: new Date(NOW - 100 * DAY).toISOString(), kind: "gov-review", ref: "" },
    { ts: new Date(NOW - 5 * DAY).toISOString(), kind: "dep-verify", ref: "D4" }
  ];
  const d = Object.fromEntries(G.dueList(logs, NOW).map((x) => [x.key, x]));
  assert.equal(d["ai-sample|"].state, "ok");
  assert.equal(d["gov-review|"].state, "due");
  assert.equal(d["dep-verify|D4"].state, "ok");
  assert.equal(d["dep-verify|D3"].state, "never");
  assert.equal(d["shadow-ai|"].state, "never");
});

test("變更核准是事件型紀錄：不出現在定期待辦裡", () => {
  assert.ok(!G.dueList([], NOW).some((d) => d.kind === "change-approval"));
  assert.equal(G.KINDS["change-approval"].every, 0);
});

test("內控月報：有紅燈、備份太久、逾期紀錄時列進待辦；全部正常時待辦為 0", () => {
  const okLogs = [{ ts: new Date(NOW - DAY).toISOString(), kind: "gov-review" }, { ts: new Date(NOW - DAY).toISOString(), kind: "ai-sample" }, { ts: new Date(NOW - DAY).toISOString(), kind: "shadow-ai" }]
    .concat(G.DEPS.map((d) => ({ ts: new Date(NOW - DAY).toISOString(), kind: "dep-verify", ref: d.id })));
  const good = G.monthlyReport({ now: NOW, kri: { red: 0, yellow: 0, red_names: [], yellow_names: [] }, backup: { installed: true, backupDays: 0, drillDays: 3, failStreak: 0 }, riskOps: 0, records: okLogs });
  assert.equal(good.todo.length, 0);
  assert.match(good.subject, /無待辦/);

  const bad = G.monthlyReport({ now: NOW, kri: { red: 2, yellow: 1, red_names: ["準時率（80%）", "負毛利訂單（2 張）"], yellow_names: [] }, backup: { installed: true, backupDays: 5, drillDays: 60, failStreak: 2 }, riskOps: 3, records: [] });
  assert.ok(bad.todo.some((t) => /紅燈/.test(t)));
  assert.ok(bad.todo.some((t) => /備份異常/.test(t)));
  assert.ok(bad.todo.some((t) => /還原演練逾期/.test(t)));
  assert.ok(bad.todo.some((t) => /高風險操作/.test(t)));
  assert.ok(bad.todo.some((t) => /治理檢視/.test(t)));
  assert.match(bad.body, /準時率（80%）/);
  assert.match(bad.subject, new RegExp(bad.todo.length + " 項待辦"));

  const none = G.monthlyReport({ now: NOW, kri: {}, backup: null, riskOps: 0, records: okLogs });
  assert.ok(none.todo.some((t) => /安裝每日備份/.test(t)));
});

test("權限：gov_ 資料表只有老闆、主管能寫，其他人可讀；唯讀不能寫", () => {
  assert.equal(R.canTable("boss", "gov_log", true), true);
  assert.equal(R.canTable("manager", "gov_log", true), true);
  for (const r of ["sales", "ops", "finance", "admin", "viewer"]) {
    assert.equal(R.canTable(r, "gov_log", true), false, r);
    assert.equal(R.canTable(r, "gov_log", false), true, r + " 讀");
  }
});

// ---- 後端：月報函式（用假的試算表環境跑 govReport_） ----
function loadGas(rows) {
  const sent = [];
  const ctx = {
    console, ErpGov: undefined,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: {}, SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) }, Utilities: {}, Session: { getActiveUser: () => ({ getEmail: () => "boss@example.com" }) },
    GmailApp: { sendEmail: (to, subject, body) => sent.push({ to, subject, body }) }, UrlFetchApp: {}, ContentService: {}, CacheService: {}, ScriptApp: {}
  };
  vm.createContext(ctx);
  vm.runInContext(read("google-apps-script-erp.gs"), ctx, { filename: "erp.gs" });
  ctx.tList_ = (t) => ({ rows: rows[t] || [] });
  ctx.aclBosses_ = () => ["boss@example.com"];
  return { ctx, sent };
}

test("後端 govReport_：讀 sched_alert 的亮燈與 gov_log，組成月報；govMonthlyReport 寄給老闆", () => {
  const { ctx, sent } = loadGas({
    sched_alert: [{ id: "S1", level: "red", active: 1, name: "準時率", display: "80%" }, { id: "B2", level: "yellow", active: 1, name: "逾期應收", display: "NT$ 120,000" }, { id: "S2", level: "red", active: 0, name: "已解除" }],
    gov_log: [{ ts: new Date().toISOString(), kind: "gov-review", ref: "" }]
  });
  const r = ctx.govReport_(Date.now());
  assert.match(r.body, /目前紅燈 1 項、黃燈 1 項/);
  assert.match(r.body, /準時率（80%）/);
  assert.doesNotMatch(r.body, /已解除/);
  assert.ok(r.todo.some((t) => /AI 摘要抽查/.test(t)));
  assert.ok(!r.todo.some((t) => /治理檢視/.test(t)));
  ctx.govMonthlyReport();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "boss@example.com");
  assert.match(sent[0].subject, /內控月報/);
});

test("後端內嵌的治理規則與 docs/assets/governance.js 同一份（改了要重跑 build_erp_gas.py）", () => {
  assert.ok(read("google-apps-script-erp.gs").replace(/\r/g, "").includes(read("docs/assets/governance.js").replace(/\r/g, "").trimEnd()));
});

test("內控治理頁已掛進行政工作台，且 governance.js 先於 gov-ui.js 載入", () => {
  const h = read("docs/admin.html");
  assert.ok(h.indexOf("assets/governance.js") > 0 && h.indexOf("assets/governance.js") < h.indexOf("assets/gov-ui.js"));
  // admin.html 是 dashboard.py 每次更新報價時重新產生的：產生器裡也要有，否則手改的會被蓋掉
  const d = read("dashboard.py"), at = d.indexOf("erp-access-ui.js");
  assert.ok(at > 0 && d.indexOf("assets/governance.js", at) > 0 && d.indexOf("assets/gov-ui.js", at) > d.indexOf("assets/governance.js", at));
});

test("內控治理頁：每個子頁都能畫出來、紀錄寫入後待辦消失、沒有核准人就不記變更", () => {
  const store = {};
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const U = {
    esc, ic: () => "", chip: (t) => `[${t}]`, btn: (a, l, id) => `<b data-a="${a}" data-id="${id}">${l}</b>`, kpi: (l, v) => `${l}${v}`,
    section: (t, i) => `<s>${t}</s>${i}`, VIEW: {}, H: {}, TABS: {}, addTab() {}, render() {},
    table: (cols, rows) => rows.map((r) => cols.map((c) => (typeof c.v === "function" ? c.v(r) : esc(r[c.v]))).join("|")).join("\n")
  };
  const alerts = []; const prompts = [];
  const win = { __erpUI: U, ErpGov: G, __erpBridge: { authed: () => false, user: () => null, call: () => Promise.resolve({}) }, prompt: (m) => prompts.shift(), alert: (m) => alerts.push(m) };
  const ctx = { window: win, alert: win.alert, document: {}, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } }, console, Date, JSON, Promise };
  vm.createContext(ctx);
  vm.runInContext(read("docs/assets/gov-ui.js"), ctx, { filename: "gov-ui.js" });
  for (const s of ["quick", "roles", "inv", "risk", "ctl", "dep", "scn", "log"]) {
    U.H["gov-sub"](s);
    const html = U.VIEW.gov();
    assert.ok(html.length > 50, s);
  }
  // 沒核准人 → 不記錄
  prompts.push("工廠設定－切割站產能", "生管：實測偏低", "");
  U.H["gov-add"]("change-approval");
  assert.equal(JSON.parse(store.gov_log_local_v1 || "[]").length, 0);
  assert.match(alerts[0], /沒有核准人/);
  // 有核准人 → 記錄；治理檢視記錄後，待辦少一項
  const before = G.dueList([], Date.now()).filter((d) => d.state !== "ok").length;
  prompts.push("工廠設定－切割站產能", "生管：實測偏低", "老闆");
  U.H["gov-add"]("change-approval");
  prompts.push("已確認清單與風險", "老闆");
  U.H["gov-add"]("gov-review");
  const logs = JSON.parse(store.gov_log_local_v1);
  assert.equal(logs.length, 2);
  assert.equal(logs.find((l) => l.kind === "change-approval").approver, "老闆");
  U.H["gov-sub"]("log");
  assert.match(U.VIEW.gov(), /治理檢視/);
  assert.equal(G.dueList(logs, Date.now()).filter((d) => d.state !== "ok").length, before - 1);
});
