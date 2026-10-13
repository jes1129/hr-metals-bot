/**
 * 九上科技儀表板 — 排程風險「自動通知」（Google Apps Script）
 *
 * 用途：每 30 分鐘（平日 08:00–18:59）自己檢查一次排程風險燈號，越線就通知負責人，不必有人打開網頁。
 *   - 黃燈 → 通知該指標的負責人；紅燈 → 負責人＋老闆（目前負責人都先對應到老闆，之後可在排程頁分開設定）
 *   - 同一件事 24 小時內不重複寄（除非變得更糟）；紅燈 30 分鐘沒人按「已知悉」→ 再通知老闆一次（升級）
 *   - 趨勢預警（預計 3 天內轉黃／紅）只顯示在網頁的通知中心，不寄信
 *   - 每一則通知也寫進「通知中心」（網頁右上角的鈴鐺），按「已知悉」就不再提醒
 *
 * 安裝（貼進「同一個」Apps Script 專案，當新的指令碼檔案；不用重新部署網頁）：
 *   1. 左側「＋ → 指令碼」新增檔案，貼上本檔 → 儲存。
 *   2. 上方函式選 checkSchedAlerts → 執行一次 → 授權（會要求寄信、讀寫試算表）。
 *   3. 函式選 installSchedAlertTrigger → 執行一次 → 之後每 30 分鐘自動檢查。
 *   4. 到網頁「生產排程 → 門檻設定」填老闆 Email（沒填就寄給 NOTIFY_EMAILS 或試算表擁有者）。
 *
 * 需要同專案內的主檔 google-apps-script.gs（用到它的 tList_／tUpsert_／tRemove_）。ERP 檔有的話，
 * 會順便用 ERP 工單完工時間判斷「逾時沒回報」與完工誤差。
 */

var SA_URL = "https://jes1129.github.io/hr-metals-bot/schedule.html#tab=dash";
var SA_ALERT_HDR = ["id", "level", "active", "first", "lastN", "nlevel", "ack", "ackBy", "ackAt", "esc", "name", "display", "msg", "owner", "t"];
var SA_NOTICE_HDR = ["id", "t", "kind", "key", "level", "name", "display", "msg", "owner", "to", "read"];
var SA_MAX_MAIL = 15;                       // 每次檢查最多寄幾封（免費 Gmail 一天約 100 封，避免爆量）

function sa_rank_(lv) { return lv === "red" ? 2 : lv === "yellow" ? 1 : 0; }
function sa_tw_(ms) { var d = new Date(ms + 8 * 3600000); return { dow: d.getUTCDay() === 0 ? 7 : d.getUTCDay(), hour: d.getUTCHours() }; }
function sa_read_(table) { try { return tList_(table).rows || []; } catch (e) { return []; } }
function sa_blob_(rows, name) {
  var parts = rows.filter(function (r) { return new RegExp("^" + name + "\\.\\d+$").test(String(r.id)); })
    .sort(function (a, b) { return Number(String(a.id).split(".")[1]) - Number(String(b.id).split(".")[1]); });
  if (!parts.length) return null;
  try { return JSON.parse(parts.map(function (r) { return String(r.data).replace(/^~/, ""); }).join("")); } catch (e) { return null; }
}
function sa_cfg_() {
  var cfg = { enabled: true, escalateMin: 30, repeatHours: 24, boss: "", owners: {} };
  try {
    var r = sa_read_("sched_cfg").filter(function (x) { return x.id === "notify"; })[0];
    if (r) { var o = JSON.parse(String(r.data).replace(/^~/, "")); Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null) cfg[k] = o[k]; }); }
  } catch (e) {}
  if (!cfg.boss) { var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS"); cfg.boss = (v && v.trim()) ? v.trim() : Session.getActiveUser().getEmail(); }
  return cfg;
}
function sa_emails_(cfg, owner) {          // 負責人對應的信箱；沒設就用老闆的
  var s = (cfg.owners && cfg.owners[owner]) || cfg.boss, seen = {}, out = [];
  String(s).split(/[,;\s]+/).forEach(function (m) { if (m && /@/.test(m) && !seen[m]) { seen[m] = 1; out.push(m); } });
  return out;
}
function sa_erp_() {                       // ERP 已完工的工單 → 完工時間
  var m = {};
  try {
    if (typeof erpLoad_ === "function") {
      var w = erpLoad_(), mv = {};
      (w.moves || []).forEach(function (x) { if (x.type === "完工入庫" && x.ref) mv[x.ref] = x; });
      (w.workorders || []).forEach(function (o) { if (o.status === "完工") { var ts = mv[o.no] ? Date.parse(mv[o.no].ts) : NaN; m[o.no] = { ts: isFinite(ts) ? ts : null }; } });
    }
  } catch (e) {}
  return m;
}
function sa_fmtH_(ms) { var h = Math.abs(ms) / 3600000; return (h >= 10 ? h.toFixed(0) : h.toFixed(1)).replace(/\.0$/, ""); }

// 目前亮燈的清單：排程頁最後一次存下的燈號＋「現在」重新算的（逾時沒回報、ERP 完工誤差、資料過期）
function sa_current_(snap, now) {
  var out = {}, tol = snap.tol || {}, grace = (snap.grace != null ? snap.grace : 120) * 60000, orders = snap.orders || [], erp = sa_erp_();
  (snap.items || []).forEach(function (x) { out[x.id] = { key: x.id, level: x.level, name: x.name, display: x.display, msg: x.msg || "", owner: x.owner || "老闆", action: x.actionLabel || "" }; });
  // 逾時沒回報（D4）：預計完工超過寬限時間，排程頁沒有回報、ERP 也沒完工
  var overdue = orders.filter(function (o) { return o.ae == null && !erp[o.erp || o.id] && o.pe != null && o.pe + grace < now; }).map(function (o) { return o.id; });
  var t4 = tol.D4 || { y: 1, r: 3, owner: "班長", name: "預計完工已過、卻還沒回報的單" };
  var lv4 = t4.r != null && overdue.length >= t4.r ? "red" : overdue.length >= t4.y ? "yellow" : "green";
  if (lv4 !== "green") out.D4 = { key: "D4", level: lv4, name: t4.name, display: overdue.length + " 張", owner: t4.owner || "班長", action: "去回報進度",
    msg: "預計完工已超過 " + Math.round(grace / 60000) + " 分鐘仍沒回報：" + overdue.slice(0, 5).join("、") + (overdue.length > 5 ? "…" : "") + "（ERP 工單按完工會自動帶入）。" };
  else delete out.D4;
  // ERP 完工誤差（D1）：ERP 完工的時間比預計早或晚多少（排程頁還沒回報的）
  var comp = orders.filter(function (o) { var e = erp[o.erp || o.id]; return o.ae == null && e && e.ts != null && o.pe != null; })
    .map(function (o) { return { id: o.id, ts: erp[o.erp || o.id].ts, e: erp[o.erp || o.id].ts - o.pe }; }).sort(function (a, b) { return a.ts - b.ts; });
  var last = comp.length ? comp[comp.length - 1] : null;
  if (last && last.ts > (snap.ts || 0)) {
    var t1 = tol.D1 || { y: 2, r: 4, owner: "生管", name: "最近一張完工的預測誤差" }, h = Math.abs(last.e) / 3600000;
    var lv1 = t1.r != null && h >= t1.r ? "red" : h >= t1.y ? "yellow" : "green";
    if (lv1 !== "green") out.D1 = { key: "D1", level: lv1, name: t1.name, display: sa_fmtH_(last.e) + " 小時", owner: t1.owner || "生管", action: "重新最佳化",
      msg: "ERP 工單 " + last.id + " 比預計" + (last.e > 0 ? "晚" : "早") + " " + sa_fmtH_(last.e) + " 小時完工。" };
  }
  // 監控本身失靈：排程風險資料太久沒更新
  var ageH = (now - (snap.ts || 0)) / 3600000;
  if (ageH > 24) out.STALE = { key: "STALE", level: ageH > 72 ? "red" : "yellow", name: "排程風險資料太久沒更新", display: Math.floor(ageH) + " 小時", owner: "生管", action: "打開排程頁",
    msg: "已經 " + Math.floor(ageH) + " 小時沒有人打開排程頁，燈號可能過時；監控本身失靈也是風險。" };
  return out;
}

function sa_mail_(to, subject, body) { GmailApp.sendEmail(to.join(","), subject, body); }
// 同一次檢查有好幾個指標亮燈時，每個收件人只收「一封」，把全部列在裡面（避免信太多）
function sa_lv_(c) { return c.level === "red" ? "紅燈" : "黃燈"; }
function sa_subject_(list) {
  if (list.length === 1) return "【排程風險・" + sa_lv_(list[0].c) + "】" + list[0].c.name + "（" + list[0].c.display + "）";
  var r = list.filter(function (p) { return p.c.level === "red"; }).length, y = list.length - r;
  return "【排程風險】" + (r ? r + " 項紅燈" : "") + (r && y ? "、" : "") + (y ? y + " 項黃燈" : "");
}
function sa_digest_(list, cfg) {
  var lines = ["【排程風險通知】共 " + list.length + " 項：", ""];
  list.forEach(function (p, i) {
    var c = p.c;
    lines.push((i + 1) + ". 【" + sa_lv_(c) + "】" + c.name + "（" + c.display + "）— " + p.why);
    if (c.msg) lines.push("   說明：" + c.msg);
    lines.push("   負責人：" + c.owner + (c.action ? "　建議：" + c.action : ""));
  });
  lines.push("", "到儀表板查看並按「已知悉」：" + SA_URL, "",
    "（按「已知悉」之後，同一件事不會再重複通知；除非變得更糟。紅燈 " + cfg.escalateMin + " 分鐘沒人處理會再通知老闆一次。）");
  return lines.join("\n");
}

function checkSchedAlerts(e) {
  var now = Date.now(), tw = sa_tw_(now);
  if (e && (tw.dow >= 6 || tw.hour < 8 || tw.hour >= 19)) return "非上班時段（平日 08:00–18:59）不檢查";
  var cfg = sa_cfg_(), st = {}, sent = 0, log = [], pend = [], escs = [];
  sa_read_("sched_alert").forEach(function (r) { st[r.id] = r; });
  function put(row) { tUpsert_("sched_alert", row, SA_ALERT_HDR, "排程警示"); }
  function notice(kind, c, to) {
    tUpsert_("sched_notice", { id: "n" + now.toString(36) + "_" + c.key, t: now, kind: kind, key: c.key, level: c.level, name: c.name, display: c.display, msg: c.msg || "", owner: c.owner || "", to: (to || []).join(","), read: 0 }, SA_NOTICE_HDR, "排程警示");
  }
  put({ id: "_hb", active: 0, name: "heartbeat", t: now });                       // 心跳：讓網頁知道自動通知有在跑
  if (!cfg.enabled) return "自動通知已關閉";
  var snap = sa_blob_(sa_read_("sched_kri"), "kri");
  if (!snap) return "排程頁還沒有存過燈號（先打開排程頁並排一次程）";
  var cur = sa_current_(snap, now);

  Object.keys(cur).forEach(function (k) {
    var c = cur[k], s = st[k], active = s && Number(s.active) === 1, rNew = sa_rank_(c.level), rPrev = active ? sa_rank_(s.nlevel) : 0;
    var row = { id: k, level: c.level, active: 1, name: c.name, display: c.display, msg: c.msg, owner: c.owner, t: now };
    var first = active ? Number(s.first) || now : now, ack = active ? Number(s.ack) === 1 : false, esc = active ? Number(s.esc) === 1 : false, lastN = active ? Number(s.lastN) || 0 : 0;
    var up = !active || rNew > rPrev, repeat = !up && !ack && rNew >= rPrev && lastN && now - lastN >= cfg.repeatHours * 3600000;
    if (up) { first = now; ack = false; esc = false; }
    row.first = first; row.lastN = lastN; row.ack = ack ? 1 : 0; row.esc = esc ? 1 : 0; row.nlevel = active ? s.nlevel : "";
    if (active) { row.ackBy = s.ackBy || ""; row.ackAt = s.ackAt || ""; }
    if (rNew < rPrev) row.nlevel = c.level;                                       // 變輕：不通知，但之後再變重要再通知
    if (up || repeat) {
      var to = sa_emails_(cfg, c.owner);
      if (c.level === "red") sa_emails_(cfg, "老闆").forEach(function (m) { if (to.indexOf(m) < 0) to.push(m); });
      if (to.length) { pend.push({ c: c, to: to, why: up ? (rPrev ? "風險升級了" : "新的風險亮燈") : "風險還在（尚未按已知悉）" }); log.push((up ? "新" : "重複") + " " + k); }
      notice("lv", c, to); row.nlevel = c.level; row.lastN = now;
    }
    if (c.level === "red" && !ack && !esc && !up && lastN && now - first >= (cfg.escalateMin - 2) * 60000) {
      escs.push(c); log.push("升級 " + k);
      notice("esc", c, sa_emails_(cfg, "老闆")); row.esc = 1;
    }
    put(row);
  });
  var byAddr = {};                                                                // 每個收件人一封：把他要收的全列進去
  pend.forEach(function (p) { p.to.forEach(function (m) { (byAddr[m] = byAddr[m] || []).push(p); }); });
  Object.keys(byAddr).forEach(function (m) {
    if (sent >= SA_MAX_MAIL) return;
    sa_mail_([m], sa_subject_(byAddr[m]), sa_digest_(byAddr[m], cfg)); sent++;
  });
  if (escs.length) {                                                              // 升級：紅燈沒人處理，再通知老闆（也合併成一封）
    sa_emails_(cfg, "老闆").forEach(function (m) {
      if (sent >= SA_MAX_MAIL) return;
      sa_mail_([m], "【排程風險・升級】" + (escs.length === 1 ? escs[0].name : escs.length + " 項紅燈") + " " + cfg.escalateMin + " 分鐘沒人處理",
        sa_digest_(escs.map(function (c) { return { c: c, why: "紅燈已經 " + cfg.escalateMin + " 分鐘沒有人按「已知悉」" }; }), cfg)); sent++;
    });
  }
  Object.keys(st).forEach(function (k) {                                          // 恢復正常的：關掉並留一則系統通知（不寄信）
    var s = st[k];
    if (k === "_hb" || Number(s.active) !== 1 || cur[k]) return;
    put({ id: k, level: "green", active: 0, t: now, first: s.first, nlevel: "", ack: s.ack, ackBy: s.ackBy, ackAt: s.ackAt, esc: s.esc, name: s.name, display: s.display, msg: s.msg, owner: s.owner });
    notice("ok", { key: k, level: "green", name: s.name, display: "已恢復正常", msg: "", owner: s.owner }, []);
    log.push("恢復 " + k);
  });
  try {                                                                           // 通知只留最近 80 則
    var ns = sa_read_("sched_notice").sort(function (a, b) { return Number(b.t) - Number(a.t); });
    ns.slice(80).forEach(function (n) { tRemove_("sched_notice", n.id); });
  } catch (err) {}
  return "檢查完成：亮燈 " + Object.keys(cur).length + " 項，寄出 " + sent + " 封" + (log.length ? "｜" + log.join("；") : "");
}

function installSchedAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "checkSchedAlerts") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("checkSchedAlerts").timeBased().everyMinutes(30).create();
  try { SpreadsheetApp.getUi().alert("已開啟排程風險自動通知：每 30 分鐘檢查一次（平日 08:00–18:59）✅"); } catch (e) {}
}
