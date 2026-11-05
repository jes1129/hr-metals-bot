// 變更控制：Apps Script 檔案語法、CI 流程
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const GS = ["google-apps-script.gs", "backup.gs", "notebooklm-export.gs", "price-alerts.gs", "inquiry.gs"];

test("每個 Apps Script 檔案語法正確（貼上去才不會整個壞掉）", () => {
  for (const f of GS) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
});

test("CI 流程：部署前先跑測試，失敗就不部署", () => {
  const y = read(".github/workflows/metals.yml").split(String.fromCharCode(13)).join("");
  assert.match(y, /needs: test/);
  assert.match(y, /node --test tests\/\*\.test\.mjs/);
  assert.match(y, /unittest discover/);
  assert.match(read(".github/workflows/tests.yml"), /pull_request/);
});
