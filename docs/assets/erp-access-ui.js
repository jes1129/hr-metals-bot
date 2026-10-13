/*
 * erp-access-ui.js — 行政工作台「帳號權限」分頁：誰是什麼職務、新增／停用帳號、各職務能做什麼
 * 規則在 erp-roles.js；真正的把關在 Apps Script（google-apps-script-erp.gs 的 accessGate_ / erpDispatch_）。
 * 帳號資料存在公司試算表的「acl」分頁；只有老闆能讀寫。
 */
(function () {
  "use strict";
  var U = window.__erpUI, R = window.ErpRoles;
  if (!U || !R) return;
  var esc = U.esc, ic = U.ic, chip = U.chip, btn = U.btn, section = U.section;
  var HDR = ["id", "role", "active", "name", "ts", "by"];
  var ST = { loaded: false, loading: false, rows: [], err: "", me: null };

  U.addTab("admin", "access", ic("shield") + "帳號權限");

  function bridge() { return window.__erpBridge; }
  function authed() { var b = bridge(); return !!(b && b.authed()); }
  function active(v) { return v === true || v === 1 || /^(1|true|yes|是|y)$/i.test(String(v).trim()); }
  function load() {
    if (ST.loading || !authed()) return;
    ST.loading = true;
    bridge().call("appVersion", {}).then(function (v) {
      ST.me = v && v.ok ? v.access : null;
      if (ST.me && ST.me.configured && ST.me.role === "boss") return bridge().call("tList", { table: "acl" });
      return null;
    }).then(function (d) {
      ST.rows = d && d.rows ? d.rows.map(function (r) { return { id: String(r.id).toLowerCase(), role: r.role, active: active(r.active), name: r.name || "", ts: r.ts }; }) : [];
      ST.err = d && d.error ? d.error : ""; ST.loaded = true; ST.loading = false; U.render();
    }).catch(function () { ST.loading = false; ST.loaded = true; U.render(); });
  }
  function roleOpts() { return R.ORDER.map(function (k) { return [k, R.name(k)]; }); }
  function save(row) {
    return bridge().call("tUpsert", { table: "acl", row: row, header: HDR }).then(function (d) {
      if (!d || d.error) { alert((d && d.error) || "儲存失敗，請稍後再試。"); return false; }
      ST.loaded = false; load(); return true;
    });
  }

  var MATRIX = [
    ["老闆", "全部功能；唯一能管理帳號權限的人；匯入備份、大量操作時會收到通知"],
    ["主管", "全部功能（含成本與毛利）；不能管理帳號"],
    ["業務", "客戶、商機、報價、接單、出貨、案件；看不到成本與毛利、進貨單、人事資料；不能收款、不能調庫存"],
    ["生管／倉管", "料號、庫存、BOM、工單、出貨；看不到成本與毛利、人事資料；不能收款"],
    ["會計", "收款、退款、服務收款；看得到成本與毛利；不能改庫存、不能接單"],
    ["行政", "單位、員工、班表、出勤、申請簽核、設備、公告；看不到成本與毛利"],
    ["唯讀", "只能看（看不到成本與人事），不能新增或修改"]
  ];

  U.VIEW.access = function () {
    if (!authed()) return section(ic("shield") + "帳號權限", '<div class="dbempty">登入公司 Google 帳號後才能設定。未登入的「本機試用」沒有帳號可管。</div>');
    if (!ST.loaded) { load(); return section(ic("shield") + "帳號權限", '<div class="dbempty">讀取中…</div>'); }
    var me = ST.me, body = "";
    if (!me) body = '<div class="dbempty">讀不到權限資料：Apps Script 的 ERP 檔案太舊，請重貼最新的 google-apps-script-erp.gs。</div>';
    else if (!me.configured) {
      body = '<div class="dbnote"><b>權限控管尚未啟用</b>：目前所有登入的人權限相同（看得到成本、可以匯入備份）。<br>'
        + "啟用方式（只做一次）：到 Apps Script，上方函式選單選 <b>accessSetup</b> → 按「執行」。它會把你自己設為老闆；之後回到這頁新增其他人。<br>"
        + "<b>啟用後，沒有被加進來的人將無法使用</b>，請先想好每個人的職務。</div>";
    } else if (me.role !== "boss") {
      body = '<div class="dbnote">你的職務是 <b>' + esc(me.name) + "</b>。帳號權限只有老闆能管理。</div>";
    } else {
      var rows = ST.rows.slice().sort(function (a, b) { return R.ORDER.indexOf(a.role) - R.ORDER.indexOf(b.role) || a.id.localeCompare(b.id); });
      body = '<div class="dbtoolbar">' + btn("access-add", ic("plus") + "新增帳號", "", "primary") + "</div>"
        + '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>帳號（Email）</th><th>姓名</th><th>職務</th><th>狀態</th><th></th></tr></thead><tbody>'
        + (rows.length ? rows.map(function (r) {
          return "<tr><td>" + esc(r.id) + "</td><td>" + esc(r.name) + "</td><td>" + chip(R.name(r.role), r.role === "boss" ? "ok" : "muted") + "</td><td>"
            + (r.active ? chip("啟用", "ok") : chip("已停用", "warn")) + '</td><td class="erp-act">' + btn("access-edit", "修改", r.id) + "</td></tr>";
        }).join("") : '<tr><td colspan="5"><div class="dbempty">還沒有帳號</div></td></tr>') + "</tbody></table></div>"
        + '<div class="dbnote erp-muted">離職的人：在這裡停用，或在「組織與員工」把他標為停用（Email 要相同）——兩種都會立刻生效，不必等人去改 Apps Script 的白名單。白名單也請順手移除。每季 1、4、7、10 月 1 號會寄帳號盤點信給老闆（先執行一次 installAccessTrigger）。</div>';
    }
    var matrix = '<div class="dbtablewrap"><table class="dbtable erp-table"><thead><tr><th>職務</th><th>能做什麼</th></tr></thead><tbody>'
      + MATRIX.map(function (m) { return "<tr><td><b>" + esc(m[0]) + "</b></td><td>" + esc(m[1]) + "</td></tr>"; }).join("") + "</tbody></table></div>";
    return section(ic("shield") + "帳號權限" + (me && me.configured ? "　你是：" + esc(me.name) : ""), body) + section(ic("clipboard") + "各職務能做什麼", matrix);
  };

  function accountForm(r) {
    var editing = !!r; r = r || {};
    U.form({ title: editing ? "修改帳號" : "新增帳號", fields: [
      editing ? { type: "html", html: '<div class="dbnote">帳號 <b>' + esc(r.id) + "</b></div>" } : { k: "id", l: "Google 帳號 Email", req: 1, ph: "例：user@example.com" },
      { k: "name", l: "姓名", value: r.name },
      { k: "role", l: "職務", type: "select", opts: roleOpts(), value: r.role || "sales", req: 1 },
      { k: "active", l: "狀態", type: "check", text: "啟用（取消勾選＝停用，這個人立刻無法使用）", value: editing ? r.active : true }],
      submit: function (v) {
        var id = editing ? r.id : String(v.id || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) { alert("Email 格式不正確。"); return false; }
        return save({ id: id, name: v.name || "", role: v.role, active: v.active ? 1 : 0 });
      } });
  }
  U.H["access-add"] = function () { accountForm(null); };
  U.H["access-edit"] = function (id) { accountForm(ST.rows.filter(function (x) { return x.id === id; })[0]); };
})();
