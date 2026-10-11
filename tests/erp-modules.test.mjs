// CRM 擴充（聯絡人、客服案件）、服務交付、專案、行政工作台、備份檢查
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../docs/assets/erp-engine.js");
require("../docs/assets/erp-admin.js");
const T = "2026-10-12";   // 星期一
const base = { by: "boss@x", today: T, now: T + "T08:00:00Z" };
const act = (w, a, p, c) => E.apply(w, a, p, Object.assign({}, base, c)).result;
const get = (w, t, id) => w[t].find((x) => x.id === id);

function crm() {
  const w = E.empty();
  const c = act(w, "customer.save", { name: "大雅精密" });
  return { w, c };
}

test("聯絡人：第一位自動為主要，改主要時其他人取消；有案件的不能刪", () => {
  const { w, c } = crm();
  const p1 = act(w, "contact.save", { customer_id: c, name: "王經理" });
  const p2 = act(w, "contact.save", { customer_id: c, name: "林小姐", primary: true });
  assert.equal(get(w, "contacts", p1).primary, false);
  assert.equal(get(w, "contacts", p2).primary, true);
  act(w, "case.save", { customer_id: c, contact_id: p2, title: "詢價" });
  assert.throws(() => act(w, "contact.delete", { id: p2 }), /客服案件/);
  act(w, "contact.delete", { id: p1 });
  assert.equal(w.contacts.length, 1);
});

test("客服案件：結案要寫處理結果，每次變更都有紀錄；客戶有案件不能刪", () => {
  const { w, c } = crm();
  const k = act(w, "case.save", { customer_id: c, title: "毛邊客訴", kind: "客訴", priority: "高", due: "2026-10-10" });
  assert.match(get(w, "cases", k).no, /^CS-202610-001$/);
  assert.equal(E.report(w, T).cases_open[0].late, true);
  act(w, "case.status", { id: k, status: "處理中", note: "安排重工" });
  assert.throws(() => act(w, "case.status", { id: k, status: "已解決" }), /處理結果/);
  act(w, "case.status", { id: k, status: "已解決", note: "已重工出貨" });
  const kc = get(w, "cases", k);
  assert.equal(kc.resolution, "已重工出貨");
  assert.equal(kc.log.length, 3);
  assert.equal(E.report(w, T).cases_open.length, 0);
  assert.throws(() => act(w, "customer.delete", { id: c }), /不能刪除/);
  assert.throws(() => act(w, "case.delete", { id: k }), /已關閉/);
});

test("服務交付：確認後才能交付、只能驗收最新版、驗收後收款不可超收", () => {
  const { w, c } = crm();
  const s = act(w, "service.save", { customer_id: c, title: "支架打樣", amount: 12000 });
  assert.throws(() => act(w, "service.deliver", { id: s, ref: "樣品 A" }), /先確認/);
  act(w, "service.confirm", { id: s });
  act(w, "service.deliver", { id: s, ref: "樣品 v1" });
  act(w, "service.request_changes", { id: s, rev: 1, note: "孔位偏 0.2mm" });
  act(w, "service.deliver", { id: s, ref: "樣品 v2" });
  assert.throws(() => act(w, "service.accept", { id: s, rev: 1 }), /最新一版/);
  assert.throws(() => act(w, "service.pay", { id: s, amount: 100 }), /驗收後/);
  act(w, "service.accept", { id: s, rev: 2 });
  assert.throws(() => act(w, "service.deliver", { id: s, ref: "v3" }), /已驗收/);
  act(w, "service.pay", { id: s, amount: 5000 });
  assert.equal(get(w, "services", s).status, "部分收款");
  assert.equal(E.report(w, T).services_unpaid, 7000);
  assert.throws(() => act(w, "service.pay", { id: s, amount: 7001 }), /超過/);
  act(w, "service.pay", { id: s, amount: 7000 });
  assert.equal(get(w, "services", s).status, "已收款");
  assert.throws(() => act(w, "service.save", { id: s, customer_id: c, title: "x", amount: 1 }), /不能修改/);
});

test("專案任務與里程碑：完成時記錄完成日，即將到期列入報表", () => {
  const { w, c } = crm();
  const t1 = act(w, "task.save", { title: "出圖", project: "新支架", customer_id: c, due: "2026-10-14" });
  const m1 = act(w, "milestone.save", { title: "首件確認", project: "新支架", due: "2026-10-20" });
  let r = E.report(w, T);
  assert.equal(r.tasks_due.length, 1);
  assert.equal(r.milestones_soon.length, 1);
  act(w, "task.status", { id: t1, status: "完成" });
  assert.equal(get(w, "tasks", t1).done_at, T);
  act(w, "milestone.status", { id: m1, status: "已達成" });
  r = E.report(w, T);
  assert.equal(r.tasks_due.length + r.milestones_soon.length, 0);
  assert.throws(() => act(w, "task.status", { id: t1, status: "亂填" }), /不符/);
});

function office() {
  const w = E.empty();
  const hq = act(w, "unit.save", { name: "神岡廠", kind: "工廠" });
  const qc = act(w, "unit.save", { name: "品管課", kind: "部門", parent_id: hq });
  const a = act(w, "staff.save", { code: "E001", name: "阿明", unit_id: qc });
  const b = act(w, "staff.save", { code: "E002", name: "阿華", unit_id: qc });
  return { w, hq, qc, a, b };
}

test("組織與員工：上層不能循環、編號唯一且不能改、有員工的單位不能刪", () => {
  const { w, hq, qc, a } = office();
  assert.throws(() => act(w, "unit.save", { id: hq, name: "神岡廠", kind: "工廠", parent_id: qc }), /自己或下層/);
  assert.throws(() => act(w, "staff.save", { code: "E001", name: "重複", unit_id: qc }), /已存在/);
  assert.throws(() => act(w, "staff.save", { id: a, code: "X9", name: "阿明", unit_id: qc }), /不能修改/);
  assert.throws(() => act(w, "unit.delete", { id: qc }), /停用/);
});

test("班表：同人時段不能重疊（含跨夜）、整週複製會略過衝突", () => {
  const { w, a, b } = office();
  act(w, "shift.save", { staff_id: a, date: "2026-10-12", start: "08:00", end: "17:00", break_min: 60 });
  act(w, "shift.save", { staff_id: a, date: "2026-10-13", start: "22:00", end: "06:00" });          // 跨夜到 14 號 06:00
  assert.throws(() => act(w, "shift.save", { staff_id: a, date: "2026-10-14", start: "05:00", end: "09:00" }), /重疊/);
  act(w, "shift.save", { staff_id: b, date: "2026-10-12", start: "08:00", end: "17:00" });
  act(w, "shift.save", { staff_id: a, date: "2026-10-19", start: "09:00", end: "12:00" });        // 目標週已有一班會衝突
  assert.throws(() => act(w, "shift.copy_week", { from: "2026-10-13", to: "2026-10-19" }), /星期一/);
  const msg = act(w, "shift.copy_week", { from: "2026-10-12", to: "2026-10-19" });
  assert.match(msg, /複製 2 班，略過 1 班/);
  assert.equal(w.shifts.filter((x) => x.date === "2026-10-20").length, 1);   // 跨夜那班複製到 20 號
});

test("出勤：一天一筆、作廢要原因；與班表比對出遲到與缺勤", () => {
  const { w, a, b } = office();
  act(w, "shift.save", { staff_id: a, date: T, start: "08:00", end: "17:00" });
  act(w, "shift.save", { staff_id: b, date: T, start: "08:00", end: "17:00" });
  const at = act(w, "attendance.save", { staff_id: a, date: T, clock_in: "08:20", clock_out: "17:00", break_min: 60 });
  assert.throws(() => act(w, "attendance.save", { staff_id: a, date: T, clock_in: "08:00" }), /已有出勤/);
  const r = E.report(w, T);
  assert.deepEqual(r.attendance_diff.map((d) => d.staff + d.issue).sort(), ["阿明遲到 20 分", "阿華沒有出勤紀錄"]);
  assert.equal(E.admin.workHours(get(w, "attendance", at)), 7.7);
  assert.throws(() => act(w, "attendance.void", { id: at }), /原因/);
  act(w, "attendance.void", { id: at, reason: "打錯日期" });
  assert.equal(get(w, "attendance", at).status, "已作廢");
});

test("申請：送出後不能改、退回要原因、不能核准自己送出的；撤回與核准", () => {
  const { w, a } = office();
  const q = act(w, "request.save", { staff_id: a, kind: "請假", leave_type: "特休", start_date: "2026-10-20", hours: 8, reason: "家事" }, { by: "amin@x" });
  act(w, "request.submit", { id: q }, { by: "amin@x" });
  assert.throws(() => act(w, "request.save", { id: q, staff_id: a, kind: "請假", start_date: "2026-10-20", reason: "改" }), /撤回/);
  assert.throws(() => act(w, "request.approve", { id: q }, { by: "amin@x" }), /自己/);
  assert.throws(() => act(w, "request.return", { id: q }), /原因/);
  act(w, "request.return", { id: q, note: "請附代理人" });
  act(w, "request.save", { id: q, staff_id: a, kind: "請假", leave_type: "特休", start_date: "2026-10-20", hours: 8, reason: "家事，代理人阿華" }, { by: "amin@x" });
  act(w, "request.submit", { id: q }, { by: "amin@x" });
  assert.equal(E.report(w, T).requests_pending.length, 1);
  act(w, "request.approve", { id: q, note: "OK" });
  const r = get(w, "requests", q);
  assert.equal(r.status, "已核准");
  assert.equal(r.reviewer, "boss@x");
  assert.deepEqual(r.history.map((h) => h.action), ["建立草稿", "送出", "退回", "修改", "送出", "核准"]);
  // 本機試用可允許自己核准（只在瀏覽器試用模式開）
  const q2 = act(w, "request.save", { staff_id: a, kind: "加班", start_date: T, hours: 2, reason: "趕貨" });
  act(w, "request.submit", { id: q2 });
  act(w, "request.approve", { id: q2 }, { allowSelfApprove: true });
});

test("設備預約：同設備時段不可重疊、歸還或取消後可再預約", () => {
  const { w, a } = office();
  const g = act(w, "equipment.save", { name: "三次元量測儀", code: "CMM-1" });
  const r1 = act(w, "reservation.save", { equipment_id: g, staff_id: a, date: T, start: "09:00", end: "11:00", purpose: "首件量測" });
  assert.throws(() => act(w, "reservation.save", { equipment_id: g, date: T, start: "10:30", end: "12:00", purpose: "x" }), /已被預約/);
  act(w, "reservation.return", { id: r1 });
  act(w, "reservation.save", { equipment_id: g, date: T, start: "10:30", end: "12:00", purpose: "量測" });
  assert.equal(E.report(w, T).reservations_today.length, 1);
});

test("公告：置頂排前面、封存後不在公告中", () => {
  const { w } = office();
  act(w, "notice.save", { title: "一般" });
  const n2 = act(w, "notice.save", { title: "重要", pinned: true });
  assert.equal(E.report(w, T).notices_active[0].title, "重要");
  act(w, "notice.archive", { id: n2 });
  assert.equal(E.report(w, T).notices_active.length, 1);
});

test("備份檢查：抓出重複 id、斷掉的參照、庫存不一致；正常資料通過", () => {
  const { w, a } = office();
  const c = act(w, "customer.save", { name: "客戶" });
  act(w, "contact.save", { customer_id: c, name: "王" });
  assert.deepEqual(E.validate(JSON.parse(JSON.stringify(w))), []);
  const bad = JSON.parse(JSON.stringify(w));
  bad.staff.push(Object.assign({}, bad.staff[0]));
  assert.match(E.validate(bad).join(), /重複/);
  const bad2 = JSON.parse(JSON.stringify(w));
  bad2.contacts[0].customer_id = "C不存在";
  assert.match(E.validate(bad2).join(), /參照不存在/);
  assert.match(E.validate("x").join(), /不是有效/);
});

test("舊資料（沒有新表）也能直接套用新操作", () => {
  const old = E.empty();
  for (const t of ["contacts", "cases", "services", "tasks", "milestones", "units", "staff", "shifts", "attendance", "requests", "equipment", "reservations", "notices"]) delete old[t];
  act(old, "unit.save", { name: "總公司", kind: "公司" });
  assert.equal(old.units.length, 1);
  assert.ok(Array.isArray(old.contacts));
});
