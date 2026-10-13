// 變更控制：Apps Script 檔案語法、ERP 後端檔是否與來源同步、版本號前後端對得上
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const GS = ["google-apps-script.gs", "google-apps-script-erp.gs", "sched-alerts.gs", "email-notify.gs", "notebooklm-export.gs", "gas/erp-adapter.gs"];

test("每個 Apps Script 檔案語法正確（貼上去才不會整個壞掉）", () => {
  for (const f of GS) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
});

test("google-apps-script-erp.gs 與來源同步（改了引擎／adapter 要重跑 scripts/build_erp_gas.py）", () => {
  const before = read("google-apps-script-erp.gs");
  execFileSync(process.platform === "win32" ? "python" : "python3", ["scripts/build_erp_gas.py"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PYTHONUTF8: "1" }, stdio: "pipe" });
  const after = read("google-apps-script-erp.gs");
  assert.equal(after.replace(/\r\n/g, "\n"), before.replace(/\r\n/g, "\n"));
});

function load(files) {
  const ctx = { console, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, LockService: {}, SpreadsheetApp: {}, Utilities: {}, Session: {}, GmailApp: {}, UrlFetchApp: {}, ContentService: {} };
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

test("appVersion：回報 ERP 版本；沒貼的檔案回 null", () => {
  const only = load(["google-apps-script-erp.gs"]);
  const r = only.erpDispatch_("appVersion", {}, "a@b.c");
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.api }, { erp: 1, alerts: null, digest: null });
  const all = load(["google-apps-script-erp.gs", "sched-alerts.gs", "email-notify.gs"]);
  assert.deepEqual({ ...all.erpDispatch_("appVersion", {}, "a@b.c").api }, { erp: 1, alerts: 1, digest: 1 });
});

test("網頁需要的後端版本（app.js 的 NEED）不能高於程式碼裡的實際版本", () => {
  const app = read("docs/assets/app.js");
  const need = JSON.parse(/NEED = (\{[^}]*\})/.exec(app)[1].replace(/(\w+):/g, '"$1":'));
  const all = load(["google-apps-script-erp.gs", "sched-alerts.gs", "email-notify.gs"]);
  const have = all.erpDispatch_("appVersion", {}, "x").api;
  for (const k of Object.keys(need)) assert.ok(have[k] >= need[k], `${k}: 網頁需要 ${need[k]}，後端檔只有 ${have[k]}`);
});

test("沒有 ERP_EMAILS 權限的人也能看版本（版本不含資料），其他 ERP 動作仍受限", () => {
  const ctx = load(["google-apps-script-erp.gs"]);
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k === "ERP_EMAILS" ? "boss@x.com" : null) }) };
  assert.equal(ctx.erpDispatch_("appVersion", {}, "staff@x.com").ok, true);
  assert.match(ctx.erpDispatch_("erpLoad", {}, "staff@x.com").error, /沒有 ERP 權限/);
});

test("CI 流程：部署前先跑測試，失敗就不部署", () => {
  const y = read(".github/workflows/metals.yml");
  assert.match(y, /\n  test:\n/);
  assert.match(y, /needs: test/);
  assert.match(y, /node --test tests\/\*\.test\.mjs/);
  assert.match(y, /unittest discover/);
  assert.match(read(".github/workflows/tests.yml"), /pull_request/);
});
