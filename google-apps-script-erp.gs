/**
 * 九上科技儀表板 — ERP 後端（Google Apps Script 第二個檔案）
 *
 * ⚠️ 自動產生，請勿手改：來源是 docs/assets/erp-engine.js + erp-admin.js + erp-roles.js + sched-kri.js + biz-kri.js + governance.js + gas/erp-adapter.gs，
 *    修改後執行 python scripts/build_erp_gas.py 重新產生。
 *
 * 安裝：在同一個 Apps Script 專案按「＋ → 指令碼」新增檔案（名稱例：erp），把本檔全部貼進去；
 *       再把 google-apps-script.gs 的 default 分支改成轉給 erpDispatch_（見 README「ERP 設定」）。
 *       本檔不含任何帳號、金鑰或白名單；登入驗證沿用主檔的 verify_。
 */

/*
 * erp-engine.js — 九上 ERP 核心規則（純計算：不碰畫面、不碰儲存）
 *
 * 同一份程式在三個地方執行：
 *   1. 瀏覽器（erp.html 未登入時的「本機試用」）
 *   2. Google Apps Script（登入後的正式資料；由 scripts/build_erp_gas.py 併入 google-apps-script-erp.gs）
 *   3. Node（tests/erp-engine.test.mjs 驗算）
 *
 * 規則移植自 mars-tw/freedom-erp-crm（MIT, Copyright (c) 2026 mars-tw）的
 * FIFO 成本層、訂單出貨/退貨、報價發出/取代/接受、BOM 版本與防循環、工單預留/開工/完工成本轉移，
 * 並改為新台幣實帳與接單生產（允許先接單後備料，以「缺料」提示取代直接擋單）。
 *
 * 金額四捨五入到小數 2 位、數量到 3 位（金屬料可用 kg）。
 */
(function (root) {
  "use strict";

  // ---------- 資料表定義（GAS 依此建分頁與欄位；num/bool/json 欄位讀回時轉型） ----------
  var TABLES = {
    items: {
      sheet: "ERP_料號",
      cols: ["id", "sku", "name", "kind", "unit", "metal", "std_cost", "price", "safety", "active", "on_hand", "reserved", "note"],
      num: ["std_cost", "price", "safety", "on_hand", "reserved"], bool: ["active"]
    },
    lots: {
      sheet: "ERP_庫存批次",
      cols: ["id", "item_id", "seq", "qty", "unit_cost", "src", "ref", "date"],
      num: ["seq", "qty", "unit_cost"]
    },
    moves: {
      sheet: "ERP_庫存異動",
      cols: ["id", "ts", "date", "item_id", "type", "qty", "value", "ref", "note", "by"],
      num: ["qty", "value"]
    },
    customers: {
      sheet: "ERP_客戶",
      cols: ["id", "name", "tax_id", "contact", "phone", "email", "address", "source", "note", "created"]
    },
    deals: {
      sheet: "ERP_商機",
      cols: ["id", "customer_id", "name", "amount", "stage", "lost_reason", "next_date", "note", "followups", "created"],
      num: ["amount"], json: ["followups"]
    },
    quotes: {
      sheet: "ERP_報價單",
      cols: ["id", "no", "customer_id", "deal_id", "date", "valid_until", "lines", "total", "status", "so_id", "note"],
      num: ["total"], json: ["lines"]
    },
    orders: {
      sheet: "ERP_銷售訂單",
      cols: ["id", "no", "customer_id", "quote_id", "date", "due", "lines", "total", "paid", "refunded", "payments", "cancelled", "note"],
      num: ["total", "paid", "refunded"], bool: ["cancelled"], json: ["lines", "payments"]
    },
    receipts: {
      sheet: "ERP_進貨單",
      cols: ["id", "no", "supplier", "date", "lines", "total", "note"],
      num: ["total"], json: ["lines"]
    },
    boms: {
      sheet: "ERP_BOM",
      cols: ["id", "item_id", "revision", "components", "active", "note", "created"],
      num: ["revision"], bool: ["active"], json: ["components"]
    },
    workorders: {
      sheet: "ERP_工單",
      cols: ["id", "no", "bom_id", "bom", "qty", "status", "due", "extra_cost", "actual_cost", "consumed", "note", "created"],
      num: ["qty", "extra_cost", "actual_cost"], json: ["bom", "consumed"]
    },
    contacts: {
      sheet: "ERP_聯絡人",
      cols: ["id", "customer_id", "name", "title", "phone", "email", "primary", "note", "created"],
      bool: ["primary"]
    },
    cases: {
      sheet: "ERP_客服案件",
      cols: ["id", "no", "customer_id", "contact_id", "title", "kind", "priority", "status", "owner", "due", "resolution", "log", "note", "created", "updated"],
      json: ["log"]
    },
    services: {
      sheet: "ERP_服務委託",
      cols: ["id", "no", "customer_id", "case_id", "title", "amount", "status", "deliveries", "paid", "payments", "note", "created"],
      num: ["amount", "paid"], json: ["deliveries", "payments"]
    },
    tasks: {
      sheet: "ERP_專案任務",
      cols: ["id", "title", "project", "customer_id", "owner", "due", "status", "note", "created", "done_at"]
    },
    milestones: {
      sheet: "ERP_里程碑",
      cols: ["id", "title", "project", "customer_id", "due", "status", "note", "created", "done_at"]
    }
  };
  var META_SHEET = "ERP_設定";

  var KINDS = ["原料", "半成品", "成品", "商品", "耗材"];
  var STAGES = ["新開發", "已聯繫", "已報價", "成交", "失單"];
  var CASE_KINDS = ["詢價", "客訴", "技術支援", "維修", "其他"];
  var CASE_STATUS = ["開啟", "處理中", "待客戶回覆", "已解決", "已關閉"];
  var PRIORITIES = ["低", "中", "高"];
  var TASK_STATUS = ["待辦", "進行中", "完成"];
  var MS_STATUS = ["規劃中", "已達成", "延後"];

  // ---------- 小工具 ----------
  function ErpError(msg) { this.name = "ErpError"; this.message = msg; }
  ErpError.prototype = Object.create(Error.prototype);
  function need(cond, msg) { if (!cond) throw new ErpError(msg); }
  function m2(x) { return Math.round((Number(x) || 0) * 100) / 100; }        // 金額
  function q3(x) { return Math.round((Number(x) || 0) * 1000) / 1000; }      // 數量
  function c4(x) { return Math.round((Number(x) || 0) * 10000) / 10000; }    // 單位成本
  function str(v, max) { v = v == null ? "" : String(v).trim(); return max ? v.slice(0, max) : v; }
  function posQty(v, label) { var n = q3(v); need(isFinite(n) && n > 0, (label || "數量") + "須大於 0"); return n; }
  function money(v, label) { var n = m2(v); need(isFinite(n) && n >= 0, (label || "金額") + "不可為負數"); return n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function today(ctx) { return ctx.today || new Date().toISOString().slice(0, 10); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }

  function empty() {
    var w = { meta: { seq: {}, lotseq: 0 } };
    for (var t in TABLES) w[t] = [];
    return w;
  }

  // 每次操作的環境：id 產生器、變動追蹤（GAS 只回寫有變的列）
  function makeCtx(ctx) {
    ctx = ctx || {};
    var n = 0;
    return {
      by: ctx.by || "",
      now: ctx.now || new Date().toISOString(),
      today: ctx.today || (ctx.now || new Date().toISOString()).slice(0, 10),
      newId: ctx.newId || function (p) { n++; return p + Date.now().toString(36) + n.toString(36) + Math.floor(Math.random() * 1e6).toString(36); },
      dirty: {}
    };
  }
  function touch(ctx, table, rec) { (ctx.dirty[table] = ctx.dirty[table] || {})[rec.id] = true; ctx.dirty.meta = ctx.dirty.meta || false; }
  function find(w, table, id, label) {
    for (var i = 0; i < w[table].length; i++) if (String(w[table][i].id) === String(id)) return w[table][i];
    throw new ErpError("找不到" + (label || "紀錄") + "：" + id);
  }
  function findOpt(w, table, id) {
    for (var i = 0; i < w[table].length; i++) if (String(w[table][i].id) === String(id)) return w[table][i];
    return null;
  }
  // 單據編號：前綴-年月-流水（每月重編），例 SO-202610-003
  function nextNo(w, ctx, prefix) {
    var ym = today(ctx).slice(0, 7).replace("-", "");
    var k = prefix + ym;
    w.meta.seq[k] = (w.meta.seq[k] || 0) + 1;
    ctx.dirty.meta = true;
    var s = String(w.meta.seq[k]); while (s.length < 3) s = "0" + s;
    return prefix + "-" + ym + "-" + s;
  }

  // ---------- FIFO 庫存 ----------
  function itemLots(w, itemId) {
    return w.lots.filter(function (l) { return String(l.item_id) === String(itemId) && l.qty > 0; })
      .sort(function (a, b) { return a.seq - b.seq; });
  }
  function addLot(w, ctx, item, qty, unitCost, src, ref) {
    w.meta.lotseq = (w.meta.lotseq || 0) + 1; ctx.dirty.meta = true;
    var lot = { id: ctx.newId("L"), item_id: item.id, seq: w.meta.lotseq, qty: q3(qty), unit_cost: c4(unitCost), src: src, ref: ref || "", date: today(ctx) };
    w.lots.push(lot); touch(ctx, "lots", lot);
    item.on_hand = q3(item.on_hand + qty); touch(ctx, "items", item);
    return lot;
  }
  // 依先進先出扣庫存，回傳用掉的成本層與總成本
  function consume(w, ctx, item, qty) {
    need(item.on_hand + 1e-9 >= qty, "「" + item.name + "」庫存不足：現有 " + item.on_hand + "，需要 " + qty);
    var left = qty, layers = [], value = 0, lots = itemLots(w, item.id);
    for (var i = 0; i < lots.length && left > 1e-9; i++) {
      var lot = lots[i], take = q3(Math.min(left, lot.qty));
      lot.qty = q3(lot.qty - take); touch(ctx, "lots", lot);
      layers.push({ qty: take, unit_cost: lot.unit_cost, returned: 0 });
      value = m2(value + take * lot.unit_cost);
      left = q3(left - take);
    }
    need(left <= 1e-9, "「" + item.name + "」成本批次不足（資料可能被手動改過）");
    item.on_hand = q3(item.on_hand - qty); touch(ctx, "items", item);
    return { layers: layers, value: value };
  }
  function logMove(w, ctx, item, type, qty, value, ref, note) {
    var mv = { id: ctx.newId("M"), ts: ctx.now, date: today(ctx), item_id: item.id, type: type, qty: q3(qty), value: m2(value), ref: ref || "", note: str(note, 200), by: ctx.by };
    w.moves.push(mv); touch(ctx, "moves", mv);
  }
  function stockValue(w, itemId) {
    return itemLots(w, itemId).reduce(function (s, l) { return m2(s + l.qty * l.unit_cost); }, 0);
  }

  // ---------- 訂單狀態（由明細推導，不另存避免不一致） ----------
  function orderState(o) {
    if (o.cancelled) return "已取消";
    var q = 0, sh = 0, rt = 0;
    o.lines.forEach(function (l) { q += l.qty; sh += l.shipped; rt += l.returned; });
    if (rt > 0) return rt + 1e-9 >= sh ? "已退貨" : "部分退貨";
    if (sh <= 0) return "未出貨";
    return sh + 1e-9 >= q ? "已出貨" : "部分出貨";
  }
  function orderNet(o) {   // 應收淨額 = 已出貨 − 已退貨 的售價
    return o.lines.reduce(function (s, l) { return m2(s + (l.shipped - l.returned) * l.price); }, 0);
  }
  function payState(o) {
    var got = m2(o.paid - o.refunded);
    if (got <= 0) return "未收款";
    return got + 0.005 >= o.total ? "已收清" : "部分收款";
  }

  // ---------- 檢查輸入的明細 ----------
  function saleLines(w, lines, needItem) {
    need(lines && lines.length, "請至少填一個品項");
    need(lines.length <= 50, "品項最多 50 個");
    var seen = {};
    return lines.map(function (x, i) {
      var item = x.item_id ? find(w, "items", x.item_id, "料號") : null;
      if (needItem) need(item, "第 " + (i + 1) + " 列請選擇料號");
      if (item) { need(!seen[item.id], "「" + item.name + "」重複，請合併成一列"); seen[item.id] = 1; }
      return {
        line: i + 1, item_id: item ? item.id : "", sku: item ? item.sku : "", name: item ? item.name : str(x.name, 100),
        qty: posQty(x.qty, "第 " + (i + 1) + " 列數量"), price: money(x.price, "第 " + (i + 1) + " 列單價")
      };
    });
  }
  function sumLines(lines) { return lines.reduce(function (s, l) { return m2(s + l.qty * l.price); }, 0); }
  function pickLines(o, sel) {
    need(sel && sel.length, "請指定品項與數量");
    var seen = {};
    return sel.map(function (x) {
      var l = null;
      for (var i = 0; i < o.lines.length; i++) if (o.lines[i].line === Number(x.line)) l = o.lines[i];
      need(l, "找不到第 " + x.line + " 列");
      need(!seen[l.line], "同一列不能重複指定"); seen[l.line] = 1;
      return { l: l, qty: posQty(x.qty) };
    });
  }

  // ---------- BOM 防循環 ----------
  function bomCycle(w, productId, components) {
    var edges = {};
    w.boms.forEach(function (b) { if (b.active) edges[b.item_id] = b.components.map(function (c) { return c.item_id; }); });
    edges[productId] = components.map(function (c) { return c.item_id; });
    function visit(id, path) {
      need(!path[id], "BOM 形成循環（成品用到了自己）");
      path[id] = 1;
      (edges[id] || []).forEach(function (n) { visit(n, path); });
      delete path[id];
    }
    visit(productId, {});
  }
  function activeBom(w, itemId) {
    var b = w.boms.filter(function (x) { return x.item_id === itemId && x.active; });
    return b.length ? b[0] : null;
  }

  // ===========================================================================
  // 所有操作入口：apply(w, action, p, ctx) → { result, dirty }；失敗丟 ErpError，呼叫端整批放棄
  // ===========================================================================
  var A = {};

  // ---- 料號 ----
  A["item.save"] = function (w, p, ctx) {
    var sku = str(p.sku, 40), name = str(p.name, 100);
    need(sku, "請填料號"); need(name, "請填品名");
    w.items.forEach(function (x) { need(x.sku !== sku || x.id === p.id, "料號「" + sku + "」已存在"); });
    var it = p.id ? find(w, "items", p.id, "料號") : null;
    var kind = str(p.kind) || "成品"; need(KINDS.indexOf(kind) >= 0, "類別不符");
    var rec = it || { id: ctx.newId("I"), on_hand: 0, reserved: 0, active: true };
    rec.sku = sku; rec.name = name; rec.kind = kind;
    rec.unit = str(p.unit, 10) || "件";
    rec.metal = ["", "copper", "aluminum"].indexOf(str(p.metal)) >= 0 ? str(p.metal) : "";
    rec.std_cost = money(p.std_cost || 0, "標準成本");
    rec.price = money(p.price || 0, "售價");
    rec.safety = q3(p.safety || 0); need(rec.safety >= 0, "安全庫存不可為負");
    rec.note = str(p.note, 300);
    if (p.active !== undefined) rec.active = !!p.active;
    if (!it) w.items.push(rec);
    touch(ctx, "items", rec);
    return rec.id;
  };
  A["item.delete"] = function (w, p, ctx) {
    var it = find(w, "items", p.id, "料號");
    var used = w.moves.some(function (m) { return m.item_id === it.id; }) || it.reserved > 0
      || w.boms.some(function (b) { return b.item_id === it.id || b.components.some(function (c) { return c.item_id === it.id; }); })
      || w.orders.some(function (o) { return o.lines.some(function (l) { return l.item_id === it.id; }); })
      || w.quotes.some(function (q) { return q.lines.some(function (l) { return l.item_id === it.id; }); });
    need(!used, "此料號已有異動或被單據使用，不能刪除；請改為「停用」");
    w.items.splice(w.items.indexOf(it), 1);
    (ctx.dirty.items = ctx.dirty.items || {})[it.id] = "delete";
    return it.id;
  };

  // ---- 進貨（多品項，實際進價形成 FIFO 成本層） ----
  A["stock.receive"] = function (w, p, ctx) {
    var supplier = str(p.supplier, 100); need(supplier, "請填供應商");
    need(p.lines && p.lines.length, "請至少填一個品項");
    var rc = { id: ctx.newId("R"), no: nextNo(w, ctx, "PO"), supplier: supplier, date: isDate(p.date) ? p.date : today(ctx), lines: [], total: 0, note: str(p.note, 300) };
    p.lines.forEach(function (x, i) {
      var it = find(w, "items", x.item_id, "料號");
      var qty = posQty(x.qty, "第 " + (i + 1) + " 列數量");
      var cost = x.unit_cost === "" || x.unit_cost == null ? it.std_cost : money(x.unit_cost, "第 " + (i + 1) + " 列進價");
      addLot(w, ctx, it, qty, cost, "進貨", rc.no);
      logMove(w, ctx, it, "進貨", qty, qty * cost, rc.no, supplier);
      rc.lines.push({ item_id: it.id, sku: it.sku, name: it.name, qty: qty, unit_cost: c4(cost) });
      rc.total = m2(rc.total + qty * cost);
    });
    w.receipts.push(rc); touch(ctx, "receipts", rc);
    return rc.id;
  };

  // ---- 盤點調整（正數：補進一批；負數：依 FIFO 扣） ----
  A["stock.adjust"] = function (w, p, ctx) {
    var it = find(w, "items", p.item_id, "料號");
    var d = q3(p.qty); need(d !== 0 && isFinite(d), "調整數量不可為 0");
    var note = str(p.note, 200); need(note, "請填調整原因（例：月底盤點）");
    if (d > 0) {
      var cost = p.unit_cost === "" || p.unit_cost == null ? it.std_cost : money(p.unit_cost, "單位成本");
      addLot(w, ctx, it, d, cost, "盤盈", "ADJ");
      logMove(w, ctx, it, "盤點調整", d, d * cost, "ADJ", note);
    } else {
      var r = consume(w, ctx, it, -d);
      logMove(w, ctx, it, "盤點調整", d, -r.value, "ADJ", note);
    }
    return it.id;
  };

  // ---- 客戶 ----
  A["customer.save"] = function (w, p, ctx) {
    var name = str(p.name, 100); need(name, "請填客戶名稱");
    w.customers.forEach(function (c) { need(c.name !== name || c.id === p.id, "客戶「" + name + "」已存在"); });
    var c = p.id ? find(w, "customers", p.id, "客戶") : { id: ctx.newId("C"), created: today(ctx) };
    ["tax_id", "contact", "phone", "email", "address", "source", "note"].forEach(function (k) { c[k] = str(p[k], k === "note" || k === "address" ? 300 : 100); });
    c.name = name;
    if (!p.id) w.customers.push(c);
    touch(ctx, "customers", c);
    return c.id;
  };
  A["customer.delete"] = function (w, p, ctx) {
    var c = find(w, "customers", p.id, "客戶");
    var used = ["deals", "quotes", "orders", "cases", "services", "tasks", "milestones"].some(function (t) { return w[t].some(function (x) { return x.customer_id === c.id; }); });
    need(!used, "此客戶已有商機、報價、訂單、案件、服務或專案，不能刪除");
    w.contacts.filter(function (x) { return x.customer_id === c.id; }).forEach(function (x) {
      w.contacts.splice(w.contacts.indexOf(x), 1); (ctx.dirty.contacts = ctx.dirty.contacts || {})[x.id] = "delete";
    });
    w.customers.splice(w.customers.indexOf(c), 1);
    (ctx.dirty.customers = ctx.dirty.customers || {})[c.id] = "delete";
    return c.id;
  };

  // ---- 商機（銷售漏斗） ----
  A["deal.save"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    var name = str(p.name, 100); need(name, "請填商機名稱");
    var stage = str(p.stage) || "新開發"; need(STAGES.indexOf(stage) >= 0, "階段不符");
    var lost = str(p.lost_reason, 200);
    need(stage !== "失單" || lost, "失單請填原因（之後可分析）");
    var d = p.id ? find(w, "deals", p.id, "商機") : { id: ctx.newId("D"), followups: [], created: today(ctx) };
    d.customer_id = p.customer_id; d.name = name; d.stage = stage; d.lost_reason = stage === "失單" ? lost : "";
    d.amount = money(p.amount || 0, "預估金額");
    d.next_date = isDate(p.next_date) ? p.next_date : "";
    d.note = str(p.note, 300);
    if (!p.id) w.deals.push(d);
    touch(ctx, "deals", d);
    return d.id;
  };
  A["deal.followup"] = function (w, p, ctx) {
    var d = find(w, "deals", p.id, "商機");
    var note = str(p.note, 300); need(note, "請填跟進內容");
    d.followups.push({ date: today(ctx), note: note, by: ctx.by });
    if (isDate(p.next_date)) d.next_date = p.next_date;
    if (d.stage === "新開發") d.stage = "已聯繫";
    touch(ctx, "deals", d);
    return d.id;
  };
  A["deal.delete"] = function (w, p, ctx) {
    var d = find(w, "deals", p.id, "商機");
    need(!w.quotes.some(function (q) { return q.deal_id === d.id; }), "此商機已有報價單，不能刪除");
    w.deals.splice(w.deals.indexOf(d), 1);
    (ctx.dirty.deals = ctx.dirty.deals || {})[d.id] = "delete";
    return d.id;
  };

  // ---- 報價單：草稿可改 → 發出後鎖定（同商機舊報價自動作廢）→ 客戶接受轉訂單 ----
  A["quote.save"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    if (p.deal_id) { var dl = find(w, "deals", p.deal_id, "商機"); need(dl.customer_id === p.customer_id, "商機不屬於這位客戶"); }
    var q = p.id ? find(w, "quotes", p.id, "報價單") : null;
    if (q) need(q.status === "草稿", "已發出的報價不可修改；請另開新報價");
    var lines = saleLines(w, p.lines, true);
    var rec = q || { id: ctx.newId("Q"), no: nextNo(w, ctx, "QT"), status: "草稿", so_id: "" };
    rec.customer_id = p.customer_id; rec.deal_id = p.deal_id || "";
    rec.date = isDate(p.date) ? p.date : today(ctx);
    rec.valid_until = isDate(p.valid_until) ? p.valid_until : "";
    need(!rec.valid_until || rec.valid_until >= rec.date, "有效期限不可早於報價日");
    rec.lines = lines; rec.total = sumLines(lines); rec.note = str(p.note, 300);
    if (!q) w.quotes.push(rec);
    touch(ctx, "quotes", rec);
    return rec.id;
  };
  A["quote.issue"] = function (w, p, ctx) {
    var q = find(w, "quotes", p.id, "報價單");
    need(q.status === "草稿", "只有草稿可以發出");
    q.status = "已發出"; touch(ctx, "quotes", q);
    if (q.deal_id) {
      w.quotes.forEach(function (o) {
        if (o.id !== q.id && o.deal_id === q.deal_id && o.status === "已發出") { o.status = "已取代"; touch(ctx, "quotes", o); }
      });
      var d = find(w, "deals", q.deal_id, "商機");
      if (STAGES.indexOf(d.stage) < 2) { d.stage = "已報價"; touch(ctx, "deals", d); }
    }
    return q.id;
  };
  A["quote.accept"] = function (w, p, ctx) {
    var q = find(w, "quotes", p.id, "報價單");
    need(q.status === "已發出", "只有「已發出」且是最新版的報價可以接受");
    need(!q.valid_until || q.valid_until >= today(ctx), "報價已過有效期限（" + q.valid_until + "），請重新報價");
    var soId = A["order.create"](w, { customer_id: q.customer_id, quote_id: q.id, date: today(ctx), due: p.due, lines: q.lines, note: "由報價 " + q.no + " 轉入" }, ctx);
    q.status = "已成交"; q.so_id = soId; touch(ctx, "quotes", q);
    if (q.deal_id) { var d = find(w, "deals", q.deal_id, "商機"); d.stage = "成交"; d.lost_reason = ""; touch(ctx, "deals", d); }
    return soId;
  };
  A["quote.delete"] = function (w, p, ctx) {
    var q = find(w, "quotes", p.id, "報價單");
    need(q.status === "草稿", "已發出的報價要保留紀錄，不能刪除");
    w.quotes.splice(w.quotes.indexOf(q), 1);
    (ctx.dirty.quotes = ctx.dirty.quotes || {})[q.id] = "delete";
    return q.id;
  };

  // ---- 銷售訂單：建單即預留（可先接單後備料）→ 分批出貨扣 FIFO → 退貨還原原成本 ----
  A["order.create"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    var lines = saleLines(w, p.lines, true).map(function (l) {
      var it = find(w, "items", l.item_id, "料號");
      need(it.active !== false, "「" + it.name + "」已停用");
      it.reserved = q3(it.reserved + l.qty); touch(ctx, "items", it);
      l.shipped = 0; l.returned = 0; l.cost_layers = [];
      return l;
    });
    var o = {
      id: ctx.newId("S"), no: nextNo(w, ctx, "SO"), customer_id: p.customer_id, quote_id: p.quote_id || "",
      date: isDate(p.date) ? p.date : today(ctx), due: isDate(p.due) ? p.due : "",
      lines: lines, total: sumLines(lines), paid: 0, refunded: 0, payments: [], cancelled: false, note: str(p.note, 300)
    };
    w.orders.push(o); touch(ctx, "orders", o);
    return o.id;
  };
  A["order.update"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    need(!o.cancelled, "訂單已取消");
    if (p.due !== undefined) o.due = isDate(p.due) ? p.due : "";
    if (p.note !== undefined) o.note = str(p.note, 300);
    touch(ctx, "orders", o);
    return o.id;
  };
  A["order.pay"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    need(!o.cancelled, "訂單已取消");
    var amt = money(p.amount, "收款金額"); need(amt > 0, "收款金額須大於 0");
    need(m2(o.paid - o.refunded + amt) <= o.total + 0.005, "收款超過訂單金額（尚可收 " + m2(o.total - o.paid + o.refunded) + "）");
    o.paid = m2(o.paid + amt);
    o.payments.push({ date: isDate(p.date) ? p.date : today(ctx), amount: amt, note: str(p.note, 100), by: ctx.by });
    touch(ctx, "orders", o);
    return o.id;
  };
  A["order.refund"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    var amt = money(p.amount, "退款金額"); need(amt > 0, "退款金額須大於 0");
    need(amt <= m2(o.paid - o.refunded) + 0.005, "退款超過已收金額");
    o.refunded = m2(o.refunded + amt);
    o.payments.push({ date: isDate(p.date) ? p.date : today(ctx), amount: -amt, note: str(p.note, 100) || "退款", by: ctx.by });
    touch(ctx, "orders", o);
    return o.id;
  };
  A["order.ship"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    need(!o.cancelled, "訂單已取消");
    pickLines(o, p.lines).forEach(function (x) {
      var l = x.l, n = x.qty;
      need(q3(l.shipped + n) <= l.qty + 1e-9, "「" + l.name + "」不能超量出貨（尚未出 " + q3(l.qty - l.shipped) + "）");
      var it = find(w, "items", l.item_id, "料號");
      var r = consume(w, ctx, it, n);
      it.reserved = q3(Math.max(0, it.reserved - n));
      r.layers.forEach(function (ly) { l.cost_layers.push(ly); });
      l.shipped = q3(l.shipped + n);
      logMove(w, ctx, it, "銷貨出庫", -n, -r.value, o.no, "");
    });
    touch(ctx, "orders", o);
    return o.id;
  };
  A["order.return"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    var note = str(p.note, 200);
    pickLines(o, p.lines).forEach(function (x) {
      var l = x.l, n = x.qty;
      need(q3(l.returned + n) <= l.shipped + 1e-9, "「" + l.name + "」退貨不能超過已出貨（可退 " + q3(l.shipped - l.returned) + "）");
      var it = find(w, "items", l.item_id, "料號"), left = n, value = 0;
      // 依出貨時用掉的成本層原價還原（毛利與庫存價值才對得起來）
      for (var i = 0; i < l.cost_layers.length && left > 1e-9; i++) {
        var ly = l.cost_layers[i], take = q3(Math.min(left, ly.qty - ly.returned));
        if (take <= 0) continue;
        addLot(w, ctx, it, take, ly.unit_cost, "退貨", o.no);
        ly.returned = q3(ly.returned + take); value = m2(value + take * ly.unit_cost); left = q3(left - take);
      }
      need(left <= 1e-9, "退貨成本層不足（資料可能被手動改過）");
      l.returned = q3(l.returned + n);
      logMove(w, ctx, it, "銷貨退回", n, value, o.no, note);
    });
    touch(ctx, "orders", o);
    return o.id;
  };
  A["order.cancel"] = function (w, p, ctx) {
    var o = find(w, "orders", p.id, "訂單");
    need(!o.cancelled, "訂單已取消");
    need(!o.lines.some(function (l) { return l.shipped > 0; }), "已出貨的訂單不能取消；請用退貨");
    need(m2(o.paid - o.refunded) <= 0, "請先退還已收款項再取消");
    o.lines.forEach(function (l) {
      var it = find(w, "items", l.item_id, "料號");
      it.reserved = q3(Math.max(0, it.reserved - l.qty)); touch(ctx, "items", it);
    });
    o.cancelled = true; touch(ctx, "orders", o);
    return o.id;
  };

  // ---- BOM（每次儲存 = 新版本，舊版停用但保留，工單用的是當時快照） ----
  A["bom.save"] = function (w, p, ctx) {
    var it = find(w, "items", p.item_id, "成品料號");
    need(p.components && p.components.length, "請至少填一項用料");
    need(p.components.length <= 30, "用料最多 30 項");
    var seen = {};
    var comps = p.components.map(function (c, i) {
      var ci = find(w, "items", c.item_id, "用料");
      need(ci.id !== it.id, "用料不能是成品自己");
      need(!seen[ci.id], "「" + ci.name + "」重複"); seen[ci.id] = 1;
      return { item_id: ci.id, sku: ci.sku, name: ci.name, qty: posQty(c.qty, "第 " + (i + 1) + " 項用量") };
    });
    bomCycle(w, it.id, comps);
    var rev = 0;
    w.boms.forEach(function (b) {
      if (b.item_id === it.id) { rev = Math.max(rev, b.revision); if (b.active) { b.active = false; touch(ctx, "boms", b); } }
    });
    var b = { id: ctx.newId("B"), item_id: it.id, revision: rev + 1, components: comps, active: true, note: str(p.note, 300), created: today(ctx) };
    w.boms.push(b); touch(ctx, "boms", b);
    return b.id;
  };

  // ---- 工單：計畫 → 預留用料 → 開工 → 完工（用料依 FIFO 扣，成本轉入成品批次） ----
  A["wo.create"] = function (w, p, ctx) {
    var b = p.bom_id ? find(w, "boms", p.bom_id, "BOM") : activeBom(w, p.item_id);
    need(b, "這個成品還沒有 BOM，請先建立用料表");
    var it = find(w, "items", b.item_id, "成品");
    var o = { id: ctx.newId("W"), no: nextNo(w, ctx, "WO"), bom_id: b.id, bom: { item_id: it.id, sku: it.sku, name: it.name, revision: b.revision, components: clone(b.components) },
      qty: posQty(p.qty, "生產數量"), status: "計畫", due: isDate(p.due) ? p.due : "", extra_cost: 0, actual_cost: 0, consumed: [], note: str(p.note, 300), created: today(ctx) };
    w.workorders.push(o); touch(ctx, "workorders", o);
    return o.id;
  };
  function woNeed(o, c) { return q3(c.qty * o.qty); }
  A["wo.reserve"] = function (w, p, ctx) {
    var o = find(w, "workorders", p.id, "工單");
    need(o.status === "計畫", "只有「計畫」狀態可以預留用料");
    o.bom.components.forEach(function (c) { var ci = find(w, "items", c.item_id, "用料"); ci.reserved = q3(ci.reserved + woNeed(o, c)); touch(ctx, "items", ci); });
    o.status = "已備料"; touch(ctx, "workorders", o);
    return o.id;
  };
  A["wo.start"] = function (w, p, ctx) {
    var o = find(w, "workorders", p.id, "工單");
    need(o.status === "已備料", "請先預留用料");
    o.status = "生產中"; touch(ctx, "workorders", o);
    return o.id;
  };
  A["wo.complete"] = function (w, p, ctx) {
    var o = find(w, "workorders", p.id, "工單");
    need(o.status === "生產中", "請先開工");
    var extra = money(p.extra_cost || 0, "加工/人工費用");
    // 先全部檢查夠不夠，避免扣到一半才失敗
    o.bom.components.forEach(function (c) {
      var ci = find(w, "items", c.item_id, "用料");
      need(ci.on_hand + 1e-9 >= woNeed(o, c), "用料「" + ci.name + "」不足：現有 " + ci.on_hand + "，需要 " + woNeed(o, c));
    });
    var cost = 0; o.consumed = [];
    o.bom.components.forEach(function (c) {
      var ci = find(w, "items", c.item_id, "用料"), n = woNeed(o, c);
      var r = consume(w, ctx, ci, n);
      ci.reserved = q3(Math.max(0, ci.reserved - n));
      o.consumed.push({ item_id: ci.id, name: ci.name, qty: n, value: r.value });
      cost = m2(cost + r.value);
      logMove(w, ctx, ci, "工單領料", -n, -r.value, o.no, "");
    });
    var fg = find(w, "items", o.bom.item_id, "成品");
    var total = m2(cost + extra);
    addLot(w, ctx, fg, o.qty, total / o.qty, "完工", o.no);
    logMove(w, ctx, fg, "完工入庫", o.qty, total, o.no, extra ? "含加工費 " + extra : "");
    o.extra_cost = extra; o.actual_cost = total; o.status = "完工";
    touch(ctx, "workorders", o);
    return o.id;
  };
  A["wo.cancel"] = function (w, p, ctx) {
    var o = find(w, "workorders", p.id, "工單");
    need(["計畫", "已備料", "生產中"].indexOf(o.status) >= 0, "此工單不能取消");
    if (o.status !== "計畫") o.bom.components.forEach(function (c) {
      var ci = find(w, "items", c.item_id, "用料"); ci.reserved = q3(Math.max(0, ci.reserved - woNeed(o, c))); touch(ctx, "items", ci);
    });
    o.status = "已取消"; touch(ctx, "workorders", o);
    return o.id;
  };

  function del(w, ctx, table, rec) {
    w[table].splice(w[table].indexOf(rec), 1);
    (ctx.dirty[table] = ctx.dirty[table] || {})[rec.id] = "delete";
  }
  function oneOf(v, list, def, label) { v = str(v) || def; need(list.indexOf(v) >= 0, (label || "選項") + "不符"); return v; }

  // ---- 客戶聯絡人（一個客戶可多位，其中一位為主要聯絡人） ----
  A["contact.save"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    var name = str(p.name, 60); need(name, "請填聯絡人姓名");
    var c = p.id ? find(w, "contacts", p.id, "聯絡人") : { id: ctx.newId("P"), created: today(ctx) };
    need(!p.id || c.customer_id === p.customer_id, "聯絡人不能改到別的客戶");
    c.customer_id = p.customer_id; c.name = name;
    ["title", "phone", "email", "note"].forEach(function (k) { c[k] = str(p[k], k === "note" ? 300 : 100); });
    c.primary = !!p.primary || !w.contacts.some(function (x) { return x.customer_id === p.customer_id && x.id !== c.id; });
    if (c.primary) w.contacts.forEach(function (x) {
      if (x.customer_id === c.customer_id && x.id !== c.id && x.primary) { x.primary = false; touch(ctx, "contacts", x); }
    });
    if (!p.id) w.contacts.push(c);
    touch(ctx, "contacts", c);
    return c.id;
  };
  A["contact.delete"] = function (w, p, ctx) {
    var c = find(w, "contacts", p.id, "聯絡人");
    need(!w.cases.some(function (x) { return x.contact_id === c.id; }), "此聯絡人已有客服案件，不能刪除");
    del(w, ctx, "contacts", c);
    var rest = w.contacts.filter(function (x) { return x.customer_id === c.customer_id; });
    if (c.primary && rest.length) { rest[0].primary = true; touch(ctx, "contacts", rest[0]); }
    return c.id;
  };

  // ---- 客服案件：開啟 → 處理中 → 待客戶回覆 → 已解決／已關閉（結案要寫處理結果，每次變更留紀錄） ----
  A["case.save"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    if (p.contact_id) need(find(w, "contacts", p.contact_id, "聯絡人").customer_id === p.customer_id, "聯絡人不屬於這位客戶");
    var title = str(p.title, 120); need(title, "請填案件主旨");
    var c = p.id ? find(w, "cases", p.id, "案件") : { id: ctx.newId("K"), no: nextNo(w, ctx, "CS"), status: "開啟", resolution: "", log: [], created: today(ctx) };
    c.customer_id = p.customer_id; c.contact_id = p.contact_id || ""; c.title = title;
    c.kind = oneOf(p.kind, CASE_KINDS, "詢價", "案件類別");
    c.priority = oneOf(p.priority, PRIORITIES, "中", "優先度");
    c.owner = str(p.owner, 60); c.due = isDate(p.due) ? p.due : ""; c.note = str(p.note, 500); c.updated = today(ctx);
    if (!p.id) { c.log.push({ date: today(ctx), by: ctx.by, status: "開啟", note: "建立案件" }); w.cases.push(c); }
    touch(ctx, "cases", c);
    return c.id;
  };
  A["case.status"] = function (w, p, ctx) {
    var c = find(w, "cases", p.id, "案件");
    var st = oneOf(p.status, CASE_STATUS, "", "案件狀態");
    var note = str(p.note, 500);
    need(st !== c.status, "狀態沒有改變");
    if (st === "已解決" || st === "已關閉") { need(note || c.resolution, "結案請寫處理結果"); if (note) c.resolution = note; }
    c.status = st; c.updated = today(ctx);
    c.log.push({ date: today(ctx), by: ctx.by, status: st, note: note });
    touch(ctx, "cases", c);
    return c.id;
  };
  A["case.log"] = function (w, p, ctx) {
    var c = find(w, "cases", p.id, "案件");
    var note = str(p.note, 500); need(note, "請填處理紀錄");
    c.log.push({ date: today(ctx), by: ctx.by, status: c.status, note: note }); c.updated = today(ctx);
    touch(ctx, "cases", c);
    return c.id;
  };
  A["case.delete"] = function (w, p, ctx) {
    var c = find(w, "cases", p.id, "案件");
    need(!w.services.some(function (x) { return x.case_id === c.id; }), "此案件已有服務委託，不能刪除");
    need(c.log.length <= 1, "已有處理紀錄的案件請改為「已關閉」保留紀錄");
    del(w, ctx, "cases", c);
    return c.id;
  };

  // ---- 服務交付（代工打樣、外包加工等）：草稿 → 確認 → 交付（每次一版）→ 客戶驗收或要求修改 → 收款 ----
  A["service.save"] = function (w, p, ctx) {
    find(w, "customers", p.customer_id, "客戶");
    if (p.case_id) need(find(w, "cases", p.case_id, "案件").customer_id === p.customer_id, "案件不屬於這位客戶");
    var s = p.id ? find(w, "services", p.id, "服務委託") : null;
    if (s) need(s.status === "草稿", "已確認的服務不能修改內容");
    var title = str(p.title, 120); need(title, "請填服務項目");
    var rec = s || { id: ctx.newId("V"), no: nextNo(w, ctx, "SV"), status: "草稿", deliveries: [], paid: 0, payments: [], created: today(ctx) };
    rec.customer_id = p.customer_id; rec.case_id = p.case_id || ""; rec.title = title;
    rec.amount = money(p.amount, "服務金額"); need(rec.amount > 0, "服務金額須大於 0");
    rec.note = str(p.note, 500);
    if (!s) w.services.push(rec);
    touch(ctx, "services", rec);
    return rec.id;
  };
  A["service.confirm"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(s.status === "草稿", "只有草稿可以確認");
    s.status = "已確認"; touch(ctx, "services", s);
    return s.id;
  };
  A["service.deliver"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(["已確認", "已交付", "要求修改"].indexOf(s.status) >= 0, "請先確認服務；已驗收的服務不能再交付");
    need(s.paid <= 0, "已收款的服務不能改交付");
    var ref = str(p.ref, 300); need(ref, "請填交付內容（例：樣品編號、圖檔連結）");
    s.deliveries.push({ rev: s.deliveries.length + 1, date: today(ctx), ref: ref, note: str(p.note, 300), by: ctx.by });
    s.status = "已交付"; touch(ctx, "services", s);
    return s.id;
  };
  function latestRev(s) { return s.deliveries.length ? s.deliveries[s.deliveries.length - 1].rev : 0; }
  A["service.accept"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(s.status === "已交付" && Number(p.rev) === latestRev(s), "只能驗收最新一版交付");
    s.status = "已驗收"; s.deliveries[s.deliveries.length - 1].result = "驗收通過";
    touch(ctx, "services", s);
    return s.id;
  };
  A["service.request_changes"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(s.status === "已交付" && Number(p.rev) === latestRev(s), "只能對最新一版交付要求修改");
    var note = str(p.note, 300); need(note, "請寫要修改的地方");
    s.status = "要求修改"; s.deliveries[s.deliveries.length - 1].result = "要求修改：" + note;
    touch(ctx, "services", s);
    return s.id;
  };
  A["service.pay"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(s.status === "已驗收" || s.status === "部分收款", "客戶驗收後才能收款");
    var amt = money(p.amount, "收款金額"); need(amt > 0, "收款金額須大於 0");
    need(m2(s.paid + amt) <= s.amount + 0.005, "收款超過服務金額（尚可收 " + m2(s.amount - s.paid) + "）");
    s.paid = m2(s.paid + amt);
    s.payments.push({ date: isDate(p.date) ? p.date : today(ctx), amount: amt, note: str(p.note, 100), by: ctx.by });
    s.status = s.paid + 0.005 >= s.amount ? "已收款" : "部分收款";
    touch(ctx, "services", s);
    return s.id;
  };
  A["service.delete"] = function (w, p, ctx) {
    var s = find(w, "services", p.id, "服務委託");
    need(s.status === "草稿", "已確認的服務要保留紀錄，不能刪除");
    del(w, ctx, "services", s);
    return s.id;
  };

  // ---- 專案任務與里程碑 ----
  function projectRec(w, p, ctx, table, prefix, statuses, def) {
    var title = str(p.title, 120); need(title, "請填標題");
    if (p.customer_id) find(w, "customers", p.customer_id, "客戶");
    var r = p.id ? find(w, table, p.id) : { id: ctx.newId(prefix), status: def, created: today(ctx), done_at: "" };
    r.title = title; r.project = str(p.project, 60); r.customer_id = p.customer_id || "";
    r.due = isDate(p.due) ? p.due : ""; r.note = str(p.note, 500);
    if (table === "tasks") r.owner = str(p.owner, 60);
    if (p.status) setStatus(r, p.status, statuses, ctx);
    if (!p.id) w[table].push(r);
    touch(ctx, table, r);
    return r.id;
  }
  function setStatus(r, st, statuses, ctx) {
    r.status = oneOf(st, statuses, "", "狀態");
    r.done_at = (r.status === "完成" || r.status === "已達成") ? (r.done_at || today(ctx)) : "";
  }
  A["task.save"] = function (w, p, ctx) { return projectRec(w, p, ctx, "tasks", "T", TASK_STATUS, "待辦"); };
  A["task.status"] = function (w, p, ctx) { var t = find(w, "tasks", p.id, "任務"); setStatus(t, p.status, TASK_STATUS, ctx); touch(ctx, "tasks", t); return t.id; };
  A["task.delete"] = function (w, p, ctx) { var t = find(w, "tasks", p.id, "任務"); del(w, ctx, "tasks", t); return t.id; };
  A["milestone.save"] = function (w, p, ctx) { return projectRec(w, p, ctx, "milestones", "N", MS_STATUS, "規劃中"); };
  A["milestone.status"] = function (w, p, ctx) { var m = find(w, "milestones", p.id, "里程碑"); setStatus(m, p.status, MS_STATUS, ctx); touch(ctx, "milestones", m); return m.id; };
  A["milestone.delete"] = function (w, p, ctx) { var m = find(w, "milestones", p.id, "里程碑"); del(w, ctx, "milestones", m); return m.id; };

  function apply(w, action, p, ctxIn) {
    var fn = A[action];
    need(fn, "不支援的操作：" + action);
    for (var t in TABLES) if (!w[t]) w[t] = [];      // 舊資料沒有新功能的表 → 補空表
    var ctx = makeCtx(ctxIn);
    ctx.allowSelfApprove = !!(ctxIn && ctxIn.allowSelfApprove);
    var result = fn(w, p || {}, ctx);
    return { result: result, dirty: ctx.dirty };
  }

  // ===========================================================================
  // 報表（總覽頁、AI 助手都用這裡的數字）
  // ===========================================================================
  function report(w, todayStr) {
    var t = todayStr || new Date().toISOString().slice(0, 10), ym = t.slice(0, 7);
    var r = { inventory_value: 0, low_stock: [], shortage: [], sales_month: 0, cogs_month: 0, sales_all: 0, cogs_all: 0,
      receivable: 0, open_orders: 0, overdue_orders: [], quotes_open: 0, quotes_expiring: [], pipeline: {}, wo_active: 0 };
    w.items.forEach(function (it) {
      var v = stockValue(w, it.id);
      r.inventory_value = m2(r.inventory_value + v);
      if (it.active !== false && it.safety > 0 && it.on_hand < it.safety) r.low_stock.push({ id: it.id, sku: it.sku, name: it.name, on_hand: it.on_hand, safety: it.safety });
      var short = q3(it.reserved - it.on_hand);
      if (short > 0) r.shortage.push({ id: it.id, sku: it.sku, name: it.name, kind: it.kind, short: short, has_bom: !!activeBom(w, it.id) });
    });
    // 營收與成本依「出貨／退貨的異動日」認列
    var orderById = {};
    w.orders.forEach(function (o) { orderById[o.no] = o; });
    w.moves.forEach(function (m) {
      if (m.type !== "銷貨出庫" && m.type !== "銷貨退回") return;
      var o = orderById[m.ref]; if (!o) return;
      var l = o.lines.filter(function (x) { return x.item_id === m.item_id; })[0]; if (!l) return;
      var rev = m2(-m.qty * l.price), cost = m2(-m.value);
      r.sales_all = m2(r.sales_all + rev); r.cogs_all = m2(r.cogs_all + cost);
      if (String(m.date).slice(0, 7) === ym) { r.sales_month = m2(r.sales_month + rev); r.cogs_month = m2(r.cogs_month + cost); }
    });
    r.gp_month = m2(r.sales_month - r.cogs_month);
    r.gp_all = m2(r.sales_all - r.cogs_all);
    r.gm_month = r.sales_month ? Math.round(r.gp_month / r.sales_month * 1000) / 10 : null;
    w.orders.forEach(function (o) {
      if (o.cancelled) return;
      r.receivable = m2(r.receivable + Math.max(0, orderNet(o) - (o.paid - o.refunded)));
      var st = orderState(o);
      if (st === "未出貨" || st === "部分出貨") {
        r.open_orders++;
        if (o.due && o.due < t) r.overdue_orders.push({ id: o.id, no: o.no, due: o.due });
      }
    });
    w.quotes.forEach(function (q) {
      if (q.status !== "已發出") return;
      r.quotes_open++;
      if (q.valid_until && q.valid_until >= t && q.valid_until <= addDays(t, 7)) r.quotes_expiring.push({ id: q.id, no: q.no, valid_until: q.valid_until });
    });
    STAGES.forEach(function (s) { r.pipeline[s] = { n: 0, amount: 0 }; });
    w.deals.forEach(function (d) { var x = r.pipeline[d.stage]; if (x) { x.n++; x.amount = m2(x.amount + d.amount); } });
    w.workorders.forEach(function (o) { if (["計畫", "已備料", "生產中"].indexOf(o.status) >= 0) r.wo_active++; });
    r.cases_open = []; r.services_waiting = []; r.services_unpaid = 0; r.tasks_due = []; r.milestones_soon = [];
    (w.cases || []).forEach(function (c) {
      if (c.status !== "已解決" && c.status !== "已關閉") r.cases_open.push({ id: c.id, no: c.no, title: c.title, priority: c.priority, due: c.due, late: !!(c.due && c.due < t) });
    });
    (w.services || []).forEach(function (s) {
      if (s.status === "已交付") r.services_waiting.push({ id: s.id, no: s.no, title: s.title });
      if (s.status === "已驗收" || s.status === "部分收款") r.services_unpaid = m2(r.services_unpaid + s.amount - s.paid);
    });
    (w.tasks || []).forEach(function (x) {
      if (x.status !== "完成" && x.due && x.due <= addDays(t, 7)) r.tasks_due.push({ id: x.id, title: x.title, due: x.due, late: x.due < t });
    });
    (w.milestones || []).forEach(function (x) {
      if (x.status !== "已達成" && x.due && x.due <= addDays(t, 14)) r.milestones_soon.push({ id: x.id, title: x.title, due: x.due, late: x.due < t });
    });
    REPORTERS.forEach(function (fn) { fn(w, t, r); });
    return r;
  }
  function addDays(d, n) { var x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

  // 一致性檢查（測試與「資料健檢」按鈕用）：庫存數 = 批次加總、預留不為負
  function check(w) {
    var errs = [];
    w.items.forEach(function (it) {
      var s = itemLots(w, it.id).reduce(function (a, l) { return q3(a + l.qty); }, 0);
      if (Math.abs(s - it.on_hand) > 1e-6) errs.push("「" + it.name + "」帳面 " + it.on_hand + " ≠ 批次加總 " + s);
      if (it.reserved < -1e-9) errs.push("「" + it.name + "」預留量為負");
    });
    return errs;
  }

  // 匯入備份前的完整檢查：每張表是陣列、id 不重複、參照存在、庫存一致
  var REFS = {
    lots: { item_id: "items" }, moves: { item_id: "items" }, deals: { customer_id: "customers" },
    quotes: { customer_id: "customers" }, orders: { customer_id: "customers" }, boms: { item_id: "items" },
    workorders: { bom_id: "boms" }, contacts: { customer_id: "customers" }, cases: { customer_id: "customers" },
    services: { customer_id: "customers" }
  };
  function validate(w) {
    var errs = [];
    if (!w || typeof w !== "object") return ["不是有效的備份檔"];
    for (var t in TABLES) {
      if (w[t] === undefined) continue;
      if (!Array.isArray(w[t])) { errs.push(t + " 不是清單"); continue; }
      var seen = {};
      w[t].forEach(function (r, i) {
        if (!r || typeof r !== "object" || !r.id) { errs.push(TABLES[t].sheet + " 第 " + (i + 1) + " 筆缺少 id"); return; }
        if (seen[r.id]) errs.push(TABLES[t].sheet + " 的 id 重複：" + r.id);
        seen[r.id] = 1;
      });
    }
    if (errs.length) return errs;
    for (var tb in REFS) (w[tb] || []).forEach(function (r) {
      for (var k in REFS[tb]) if (r[k] && !(w[REFS[tb][k]] || []).some(function (x) { return x.id === r[k]; }))
        errs.push(TABLES[tb].sheet + " " + (r.no || r.id) + " 參照不存在的 " + k + "：" + r[k]);
    });
    VALIDATORS.forEach(function (fn) { fn(w, errs); });
    if (w.items && w.lots) errs = errs.concat(check(w));
    return errs.slice(0, 50);
  }

  // 擴充模組（例：erp-admin.js 行政工作台）用：加資料表、操作、報表、檢查
  var REPORTERS = [], VALIDATORS = [];
  function extend(def) {
    for (var t in def.tables || {}) TABLES[t] = def.tables[t];
    for (var a in def.actions || {}) A[a] = def.actions[a];
    for (var r in def.refs || {}) REFS[r] = def.refs[r];
    if (def.report) REPORTERS.push(def.report);
    if (def.validate) VALIDATORS.push(def.validate);
    api.actions = Object.keys(A);
  }
  var helpers = { need: need, str: str, find: find, findOpt: findOpt, touch: touch, del: del, oneOf: oneOf, nextNo: nextNo,
    isDate: isDate, today: today, money: money, m2: m2, q3: q3, addDays: addDays, ErpError: ErpError };

  var api = {
    TABLES: TABLES, META_SHEET: META_SHEET, KINDS: KINDS, STAGES: STAGES,
    CASE_KINDS: CASE_KINDS, CASE_STATUS: CASE_STATUS, PRIORITIES: PRIORITIES, TASK_STATUS: TASK_STATUS, MS_STATUS: MS_STATUS,
    empty: empty, apply: apply, report: report, check: check, validate: validate, extend: extend, h: helpers,
    orderState: orderState, payState: payState, orderNet: orderNet, stockValue: stockValue, itemLots: itemLots, activeBom: activeBom,
    ErpError: ErpError, actions: Object.keys(A)
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ErpEngine = api;
})(typeof window !== "undefined" ? window : this);

/*
 * erp-admin.js — 行政工作台規則（掛在 ErpEngine 上的擴充模組；同樣在瀏覽器、Apps Script、Node 測試三處執行）
 *
 * 組織／部門、員工、週班表（可整週複製）、手動出勤（作廢要寫原因）、
 * 申請（請假／加班／出差／採購…：草稿 → 送出 → 核准或退回 → 退回可修改再送；送出後可撤回）、
 * 設備與預約（同設備時段不可重疊）、公告（置頂、封存）。
 * 移植自 mars-tw/freedom-erp-crm（MIT）行政工作台的流程規則，改為真實帳號簽核（不能核准自己送出的申請）。
 */
(function (root) {
  "use strict";
  var E = root.ErpEngine || (typeof require === "function" ? require("./erp-engine.js") : null);
  var H = E.h, need = H.need, str = H.str, find = H.find, touch = H.touch, isDate = H.isDate, today = H.today;

  var UNIT_KINDS = ["公司", "工廠", "辦公室", "門市", "部門"];
  var REQ_KINDS = ["請假", "加班", "出差", "採購", "其他"];
  var LEAVE_TYPES = ["特休", "事假", "病假", "公假", "婚假", "喪假", "產假", "其他"];
  var REQ_STATUS = ["草稿", "已送出", "已核准", "已退回", "已撤回"];

  var TABLES = {
    units: { sheet: "ERP_組織", cols: ["id", "name", "kind", "parent_id", "active", "note", "created"], bool: ["active"] },
    staff: { sheet: "ERP_員工", cols: ["id", "code", "name", "unit_id", "title", "phone", "email", "hire_date", "active", "note", "created"], bool: ["active"] },
    shifts: { sheet: "ERP_班表", cols: ["id", "staff_id", "date", "start", "end", "break_min", "status", "note", "created"], num: ["break_min"] },
    attendance: { sheet: "ERP_出勤", cols: ["id", "staff_id", "date", "clock_in", "clock_out", "break_min", "status", "void_reason", "note", "by", "created"], num: ["break_min"] },
    requests: { sheet: "ERP_申請", cols: ["id", "no", "staff_id", "kind", "leave_type", "start_date", "start_time", "end_date", "end_time", "hours", "reason", "status", "created_by", "reviewer", "review_note", "history", "created"], num: ["hours"], json: ["history"] },
    equipment: { sheet: "ERP_設備", cols: ["id", "code", "name", "location", "active", "note", "created", "maint_days", "last_maint"], bool: ["active"], num: ["maint_days"] },
    reservations: { sheet: "ERP_設備預約", cols: ["id", "equipment_id", "staff_id", "date", "start", "end", "purpose", "status", "by", "created"] },
    notices: { sheet: "ERP_公告", cols: ["id", "title", "body", "pinned", "status", "by", "created", "updated"], bool: ["pinned"] }
  };

  // ---------- 時間工具（HH:MM；結束早於開始＝跨夜） ----------
  function hm(v, label) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
    need(m && +m[1] < 24 && +m[2] < 60, (label || "時間") + "請用 HH:MM（例 08:30）");
    return (m[1].length === 1 ? "0" : "") + m[1] + ":" + m[2];
  }
  function mins(t) { var a = t.split(":"); return +a[0] * 60 + +a[1]; }
  function dayIndex(d) { return Math.round(Date.parse(d + "T00:00:00Z") / 86400000); }
  function span(date, start, end) {      // 以「天數×1440＋分鐘」表示絕對區間，跨夜自動 +1 天
    var a = dayIndex(date) * 1440 + mins(start), b = dayIndex(date) * 1440 + mins(end);
    if (b <= a) b += 1440;
    return [a, b];
  }
  function overlap(x, y) { return x[0] < y[1] && y[0] < x[1]; }
  function weekday(d) { return new Date(d + "T00:00:00Z").getUTCDay(); }   // 0=日 1=一
  function needDate(v, label) { need(isDate(v), (label || "日期") + "格式不符"); return v; }
  function oneOf(v, list, def, label) { v = str(v) || def; need(list.indexOf(v) >= 0, (label || "選項") + "不符"); return v; }
  function activeStaff(w, id) { var s = find(w, "staff", id, "員工"); need(s.active !== false, "「" + s.name + "」已停用"); return s; }

  var A = {};

  // ---- 組織／部門（可有上層，不能形成循環） ----
  A["unit.save"] = function (w, p, ctx) {
    var name = str(p.name, 60); need(name, "請填單位名稱");
    w.units.forEach(function (u) { need(u.name !== name || u.id === p.id, "單位「" + name + "」已存在"); });
    var u = p.id ? find(w, "units", p.id, "單位") : { id: ctx.newId("U"), active: true, created: today(ctx) };
    var parent = p.parent_id ? find(w, "units", p.parent_id, "上層單位") : null;
    for (var cur = parent; cur; cur = cur.parent_id ? H.findOpt(w, "units", cur.parent_id) : null) need(cur.id !== u.id, "上層單位不能是自己或下層");
    u.name = name; u.kind = oneOf(p.kind, UNIT_KINDS, "部門", "單位類型"); u.parent_id = parent ? parent.id : ""; u.note = str(p.note, 300);
    if (p.active !== undefined) u.active = !!p.active;
    if (!p.id) w.units.push(u);
    touch(ctx, "units", u);
    return u.id;
  };
  A["unit.delete"] = function (w, p, ctx) {
    var u = find(w, "units", p.id, "單位");
    need(!w.staff.some(function (s) { return s.unit_id === u.id; }) && !w.units.some(function (x) { return x.parent_id === u.id; }), "此單位還有員工或下層單位，不能刪除；請改為停用");
    H.del(w, ctx, "units", u);
    return u.id;
  };

  // ---- 員工（員工編號建立後固定；離職請停用，保留歷史） ----
  A["staff.save"] = function (w, p, ctx) {
    var code = str(p.code, 20), name = str(p.name, 40);
    need(code, "請填員工編號"); need(name, "請填姓名");
    var s = p.id ? find(w, "staff", p.id, "員工") : null;
    if (s) need(s.code === code, "員工編號建立後不能修改");
    else w.staff.forEach(function (x) { need(x.code !== code, "員工編號「" + code + "」已存在"); });
    var unit = find(w, "units", p.unit_id, "所屬單位");
    var rec = s || { id: ctx.newId("E"), code: code, active: true, created: today(ctx) };
    rec.name = name; rec.unit_id = unit.id;
    ["title", "phone", "email", "note"].forEach(function (k) { rec[k] = str(p[k], k === "note" ? 300 : 80); });
    rec.hire_date = isDate(p.hire_date) ? p.hire_date : "";
    if (p.active !== undefined) rec.active = !!p.active;
    if (!s) w.staff.push(rec);
    touch(ctx, "staff", rec);
    return rec.id;
  };

  // ---- 班表（同一人時段不能重疊；可整週複製） ----
  function shiftClash(w, staffId, sp, exceptId) {
    return w.shifts.filter(function (x) {
      return x.staff_id === staffId && x.status !== "已取消" && x.id !== exceptId && overlap(sp, span(x.date, x.start, x.end));
    })[0];
  }
  A["shift.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id), date = needDate(p.date, "日期");
    var start = hm(p.start, "上班時間"), end = hm(p.end, "下班時間");
    var brk = Math.round(Number(p.break_min) || 0); need(brk >= 0 && brk < 600, "休息分鐘不符");
    var sp = span(date, start, end); need(sp[1] - sp[0] > brk, "休息時間不能比班長");
    var x = p.id ? find(w, "shifts", p.id, "班次") : null;
    if (x) need(x.status === "排定", "只有「排定」的班次可以修改");
    var c = shiftClash(w, st.id, sp, x && x.id);
    need(!c, "「" + st.name + "」在 " + (c && c.date) + " " + (c && c.start) + "–" + (c && c.end) + " 已有班次，時段重疊");
    var r = x || { id: ctx.newId("H"), status: "排定", created: today(ctx) };
    r.staff_id = st.id; r.date = date; r.start = start; r.end = end; r.break_min = brk; r.note = str(p.note, 200);
    if (!x) w.shifts.push(r);
    touch(ctx, "shifts", r);
    return r.id;
  };
  A["shift.cancel"] = function (w, p, ctx) {
    var x = find(w, "shifts", p.id, "班次"); need(x.status === "排定", "只有「排定」的班次可以取消");
    x.status = "已取消"; touch(ctx, "shifts", x); return x.id;
  };
  A["shift.complete"] = function (w, p, ctx) {
    var x = find(w, "shifts", p.id, "班次"); need(x.status === "排定", "只有「排定」的班次可以標記完成");
    x.status = "已完成"; touch(ctx, "shifts", x); return x.id;
  };
  A["shift.copy_week"] = function (w, p, ctx) {
    var from = needDate(p.from, "來源週"), to = needDate(p.to, "目標週");
    need(weekday(from) === 1 && weekday(to) === 1, "請選兩個星期一（整週複製）");
    need(from !== to, "來源週與目標週相同");
    var diff = dayIndex(to) - dayIndex(from), copied = 0, skipped = 0;
    w.shifts.filter(function (x) { var d = dayIndex(x.date) - dayIndex(from); return d >= 0 && d < 7 && x.status !== "已取消"; })
      .forEach(function (x) {
        var nd = new Date((dayIndex(x.date) + diff) * 86400000).toISOString().slice(0, 10);
        var st = H.findOpt(w, "staff", x.staff_id);
        if (!st || st.active === false || shiftClash(w, x.staff_id, span(nd, x.start, x.end))) { skipped++; return; }
        var r = { id: ctx.newId("H"), staff_id: x.staff_id, date: nd, start: x.start, end: x.end, break_min: x.break_min, status: "排定", note: x.note, created: today(ctx) };
        w.shifts.push(r); touch(ctx, "shifts", r); copied++;
      });
    need(copied + skipped > 0, "來源週沒有班次可以複製");
    return "複製 " + copied + " 班" + (skipped ? "，略過 " + skipped + " 班（時段衝突或員工已停用）" : "");
  };

  // ---- 出勤（手動輸入；作廢要寫原因並保留紀錄） ----
  A["attendance.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id), date = needDate(p.date, "日期");
    var cin = hm(p.clock_in, "上班打卡"), cout = p.clock_out ? hm(p.clock_out, "下班打卡") : "";
    var brk = Math.round(Number(p.break_min) || 0); need(brk >= 0 && brk < 600, "休息分鐘不符");
    var x = p.id ? find(w, "attendance", p.id, "出勤") : null;
    if (x) need(x.status === "有效", "已作廢的出勤不能修改");
    var dup = w.attendance.filter(function (a) { return a.staff_id === st.id && a.date === date && a.status === "有效" && (!x || a.id !== x.id); })[0];
    need(!dup, "「" + st.name + "」" + date + " 已有出勤紀錄，請直接修改那筆");
    var r = x || { id: ctx.newId("A"), status: "有效", void_reason: "", created: today(ctx) };
    r.staff_id = st.id; r.date = date; r.clock_in = cin; r.clock_out = cout; r.break_min = brk; r.note = str(p.note, 200); r.by = ctx.by;
    if (!x) w.attendance.push(r);
    touch(ctx, "attendance", r);
    return r.id;
  };
  A["attendance.void"] = function (w, p, ctx) {
    var x = find(w, "attendance", p.id, "出勤"); need(x.status === "有效", "這筆已作廢");
    var reason = str(p.reason, 200); need(reason, "作廢請寫原因");
    x.status = "已作廢"; x.void_reason = reason; x.by = ctx.by; touch(ctx, "attendance", x); return x.id;
  };

  // ---- 申請與簽核 ----
  function hist(r, ctx, action, note) { r.history.push({ date: today(ctx), by: ctx.by, action: action, note: note || "" }); }
  A["request.save"] = function (w, p, ctx) {
    var st = activeStaff(w, p.staff_id);
    var x = p.id ? find(w, "requests", p.id, "申請") : null;
    if (x) need(x.status === "草稿" || x.status === "已退回", "送出後不能修改；請先撤回");
    var kind = oneOf(p.kind, REQ_KINDS, "請假", "申請類別");
    var sd = needDate(p.start_date, "開始日期"), ed = needDate(p.end_date || p.start_date, "結束日期");
    need(ed >= sd, "結束日期不能早於開始日期");
    var stt = p.start_time ? hm(p.start_time, "開始時間") : "", ett = p.end_time ? hm(p.end_time, "結束時間") : "";
    if (sd === ed && stt && ett) need(mins(ett) > mins(stt), "結束時間要晚於開始時間");
    var hours = Math.round((Number(p.hours) || 0) * 10) / 10; need(hours >= 0 && hours <= 2000, "時數不符");
    var reason = str(p.reason, 500); need(reason, "請寫申請事由");
    var r = x || { id: ctx.newId("Q"), no: H.nextNo(w, ctx, "AP"), status: "草稿", created_by: ctx.by, reviewer: "", review_note: "", history: [], created: today(ctx) };
    r.staff_id = st.id; r.kind = kind; r.leave_type = kind === "請假" ? oneOf(p.leave_type, LEAVE_TYPES, "特休", "假別") : "";
    r.start_date = sd; r.end_date = ed; r.start_time = stt; r.end_time = ett; r.hours = hours; r.reason = reason;
    if (!x) { hist(r, ctx, "建立草稿"); w.requests.push(r); } else hist(r, ctx, "修改");
    touch(ctx, "requests", r);
    return r.id;
  };
  function reqStep(from, to, label, needNote) {
    return function (w, p, ctx) {
      var r = find(w, "requests", p.id, "申請");
      need(from.indexOf(r.status) >= 0, "目前狀態「" + r.status + "」不能" + label);
      var note = str(p.note, 300);
      if (needNote) need(note, label + "請寫原因");
      if (to === "已核准") need(ctx.allowSelfApprove || !r.created_by || r.created_by !== ctx.by, "不能核准自己送出的申請，請由另一位主管核准");
      if (to === "已核准" || to === "已退回") { r.reviewer = ctx.by; r.review_note = note; }
      r.status = to; hist(r, ctx, label, note);
      touch(ctx, "requests", r);
      return r.id;
    };
  }
  A["request.submit"] = reqStep(["草稿", "已退回"], "已送出", "送出");
  A["request.approve"] = reqStep(["已送出"], "已核准", "核准");
  A["request.return"] = reqStep(["已送出"], "已退回", "退回", true);
  A["request.withdraw"] = reqStep(["已送出"], "已撤回", "撤回");
  A["request.delete"] = function (w, p, ctx) {
    var r = find(w, "requests", p.id, "申請"); need(r.status === "草稿", "只有草稿可以刪除"); H.del(w, ctx, "requests", r); return r.id;
  };

  // ---- 設備與預約 ----
  A["equipment.save"] = function (w, p, ctx) {
    var name = str(p.name, 60); need(name, "請填設備名稱");
    var code = str(p.code, 30);
    if (code) w.equipment.forEach(function (x) { need(x.code !== code || x.id === p.id, "設備編號「" + code + "」已存在"); });
    var e = p.id ? find(w, "equipment", p.id, "設備") : { id: ctx.newId("G"), active: true, created: today(ctx) };
    e.name = name; e.code = code; e.location = str(p.location, 60); e.note = str(p.note, 300);
    if (p.active !== undefined) e.active = !!p.active;
    // 保養週期（天；0 或空＝不追蹤）與上次保養日：風險儀表板「設備保養逾期」用
    if (p.maint_days !== undefined && p.maint_days !== "") { var md = Number(p.maint_days); need(isFinite(md) && md >= 0 && md <= 3650, "保養週期要是 0–3650 天"); e.maint_days = Math.round(md); }
    else if (e.maint_days === undefined || p.maint_days === "") e.maint_days = 0;
    if (p.last_maint !== undefined) { need(p.last_maint === "" || isDate(p.last_maint), "上次保養日格式要是 YYYY-MM-DD"); e.last_maint = p.last_maint; }
    else if (e.last_maint === undefined) e.last_maint = "";
    if (!p.id) w.equipment.push(e);
    touch(ctx, "equipment", e);
    return e.id;
  };
  A["equipment.maintained"] = function (w, p, ctx) {                       // 按一下＝今天（或指定日）已完成保養
    var e = find(w, "equipment", p.id, "設備");
    var d = p.date ? needDate(p.date, "保養日期") : today(ctx);
    e.last_maint = d; touch(ctx, "equipment", e);
    return e.id;
  };
  A["reservation.save"] = function (w, p, ctx) {
    var e = find(w, "equipment", p.equipment_id, "設備"); need(e.active !== false, "「" + e.name + "」已停用");
    if (p.staff_id) activeStaff(w, p.staff_id);
    var date = needDate(p.date, "日期"), start = hm(p.start, "開始時間"), end = hm(p.end, "結束時間");
    var sp = span(date, start, end);
    var x = p.id ? find(w, "reservations", p.id, "預約") : null;
    if (x) need(x.status === "預約中", "只有「預約中」可以修改");
    var c = w.reservations.filter(function (r) { return r.equipment_id === e.id && r.status === "預約中" && (!x || r.id !== x.id) && overlap(sp, span(r.date, r.start, r.end)); })[0];
    need(!c, "「" + e.name + "」" + (c && c.date) + " " + (c && c.start) + "–" + (c && c.end) + " 已被預約");
    var r = x || { id: ctx.newId("B"), status: "預約中", created: today(ctx) };
    r.equipment_id = e.id; r.staff_id = p.staff_id || ""; r.date = date; r.start = start; r.end = end;
    r.purpose = str(p.purpose, 200); need(r.purpose, "請寫用途"); r.by = ctx.by;
    if (!x) w.reservations.push(r);
    touch(ctx, "reservations", r);
    return r.id;
  };
  A["reservation.cancel"] = function (w, p, ctx) {
    var r = find(w, "reservations", p.id, "預約"); need(r.status === "預約中", "這筆預約已結束"); r.status = "已取消"; touch(ctx, "reservations", r); return r.id;
  };
  A["reservation.return"] = function (w, p, ctx) {
    var r = find(w, "reservations", p.id, "預約"); need(r.status === "預約中", "這筆預約已結束"); r.status = "已歸還"; touch(ctx, "reservations", r); return r.id;
  };

  // ---- 公告 ----
  A["notice.save"] = function (w, p, ctx) {
    var title = str(p.title, 100); need(title, "請填公告標題");
    var n = p.id ? find(w, "notices", p.id, "公告") : { id: ctx.newId("O"), status: "公告中", created: today(ctx) };
    n.title = title; n.body = str(p.body, 2000); n.pinned = !!p.pinned; n.by = ctx.by; n.updated = today(ctx);
    if (!p.id) w.notices.push(n);
    touch(ctx, "notices", n);
    return n.id;
  };
  A["notice.archive"] = function (w, p, ctx) { var n = find(w, "notices", p.id, "公告"); need(n.status === "公告中", "已封存"); n.status = "已封存"; n.pinned = false; touch(ctx, "notices", n); return n.id; };
  A["notice.restore"] = function (w, p, ctx) { var n = find(w, "notices", p.id, "公告"); need(n.status === "已封存", "公告中"); n.status = "公告中"; touch(ctx, "notices", n); return n.id; };

  // ---------- 報表：今天的班、出勤差異、待簽核、今日預約、公告 ----------
  function report(w, t, r) {
    w.staff = w.staff || []; w.shifts = w.shifts || []; w.attendance = w.attendance || [];
    w.requests = w.requests || []; w.reservations = w.reservations || []; w.notices = w.notices || [];
    r.staff_active = w.staff.filter(function (s) { return s.active !== false; }).length;
    r.shifts_today = w.shifts.filter(function (x) { return x.date === t && x.status !== "已取消"; });
    r.requests_pending = w.requests.filter(function (x) { return x.status === "已送出"; });
    r.reservations_today = w.reservations.filter(function (x) { return x.date === t && x.status === "預約中"; });
    r.notices_active = w.notices.filter(function (x) { return x.status === "公告中"; })
      .sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updated).localeCompare(String(a.updated)); });
    r.attendance_diff = diff(w, t);
  }
  // 班表 vs 出勤：遲到（>5 分）、早退（>5 分）、有班沒出勤
  function diff(w, date) {
    var out = [];
    w.shifts.filter(function (x) { return x.date === date && x.status !== "已取消"; }).forEach(function (x) {
      var a = w.attendance.filter(function (y) { return y.staff_id === x.staff_id && y.date === date && y.status === "有效"; })[0];
      var st = H.findOpt(w, "staff", x.staff_id) || { name: "?" };
      if (!a) { out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "沒有出勤紀錄" }); return; }
      var late = mins(a.clock_in) - mins(x.start);
      if (late > 5) out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "遲到 " + late + " 分" });
      if (a.clock_out) {
        var early = mins(x.end) - mins(a.clock_out);
        if (mins(x.end) > mins(x.start) && early > 5) out.push({ staff: st.name, shift: x.start + "–" + x.end, issue: "早退 " + early + " 分" });
      }
    });
    return out;
  }
  function workHours(a) {      // 出勤時數（扣休息）
    if (!a.clock_out) return 0;
    var sp = span(a.date, a.clock_in, a.clock_out);
    return Math.max(0, Math.round((sp[1] - sp[0] - (a.break_min || 0)) / 6) / 10);
  }

  E.extend({
    tables: TABLES, actions: A, report: report,
    refs: { staff: { unit_id: "units" }, shifts: { staff_id: "staff" }, attendance: { staff_id: "staff" },
      requests: { staff_id: "staff" }, reservations: { equipment_id: "equipment" } }
  });
  function nextMaint(e) {                                  // 下次該保養的日期；沒追蹤或從未保養回傳 ""（從未保養＝現在就該做）
    if (!(e.maint_days > 0) || !isDate(e.last_maint)) return "";
    var d = new Date(e.last_maint + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + e.maint_days); return d.toISOString().slice(0, 10);
  }
  E.admin = { nextMaint: nextMaint, UNIT_KINDS: UNIT_KINDS, REQ_KINDS: REQ_KINDS, LEAVE_TYPES: LEAVE_TYPES, REQ_STATUS: REQ_STATUS,
    diff: diff, workHours: workHours, weekday: weekday, span: span };
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof window !== "undefined" ? window : this);

/*
 * erp-roles.js — 職能分工規則（純計算，沒有畫面也沒有儲存）
 *
 * 同一份程式在三個地方執行：瀏覽器（隱藏看不到的欄位）、Apps Script（真正擋下不該做的操作、
 * 把看不到的欄位在伺服器端就拿掉）、Node（tests/roles.test.mjs 驗算）。
 * 真正的把關在伺服器端；瀏覽器只是不顯示。
 *
 * 職務：老闆／主管／業務／生管倉管／會計／行政／唯讀。
 * 原則：業務看不到成本與毛利；人事資料只有老闆、主管、行政、會計看得到；會計只管收付款；
 *       匯入備份、帳號設定只有老闆與主管能做；還沒設定任何帳號時維持原狀（所有登入者權限相同），避免把自己鎖在門外。
 */
(function (root) {
  "use strict";

  var ROLES = {
    boss:    { name: "老闆",     all: true,  seeCost: true,  seePersonnel: true,  manage: true,  rank: 7 },
    manager: { name: "主管",     all: true,  seeCost: true,  seePersonnel: true,  manage: false, rank: 6 },
    sales:   { name: "業務",     seeCost: false, seePersonnel: false, rank: 3,
      can: ["customer.", "deal.", "quote.", "contact.", "case.", "task.", "milestone.", "reservation.", "request.save", "request.submit", "request.withdraw", "request.delete",
            "order.create", "order.update", "order.ship", "order.cancel",
            "service.save", "service.confirm", "service.deliver", "service.accept", "service.request_changes"] },
    ops:     { name: "生管／倉管", seeCost: false, seePersonnel: false, rank: 3,
      can: ["item.", "stock.", "bom.", "wo.", "task.", "milestone.", "reservation.", "equipment.save", "request.save", "request.submit", "request.withdraw", "request.delete",
            "order.ship", "order.return"] },
    finance: { name: "會計",     seeCost: true,  seePersonnel: true,  rank: 4,
      can: ["order.pay", "order.refund", "service.pay", "reservation.", "request.save", "request.submit", "request.withdraw", "request.delete"] },
    admin:   { name: "行政",     seeCost: false, seePersonnel: true,  rank: 4,
      can: ["unit.", "staff.", "shift.", "attendance.", "request.", "equipment.", "reservation.", "notice.", "task.", "milestone."] },
    viewer:  { name: "唯讀",     seeCost: false, seePersonnel: false, rank: 1, can: [] }
  };
  var ORDER = ["boss", "manager", "sales", "ops", "finance", "admin", "viewer"];

  // 看得到成本才算得出來的欄位／整張表
  var COST_FIELDS = { items: ["std_cost"], lots: ["unit_cost"], moves: ["value"], workorders: ["extra_cost", "actual_cost"] };
  var COST_TABLES = ["receipts"];                                   // 進貨單全是進價
  var PERSONNEL_TABLES = ["staff", "shifts", "attendance", "requests"];

  function role(r) { return ROLES[r] || null; }
  function name(r) { return ROLES[r] ? ROLES[r].name : String(r || ""); }

  /** 這個職務能不能執行這個 ERP 動作（action 例：order.pay） */
  function can(r, action) {
    var d = ROLES[r]; if (!d) return false;
    if (d.all) return true;
    var list = d.can || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.charAt(p.length - 1) === "." ? String(action).indexOf(p) === 0 : action === p) return true;
    }
    return false;
  }

  /** 只有老闆、主管能匯入備份（整份取代）；只有老闆能管帳號 */
  function canImport(r) { return !!(ROLES[r] && ROLES[r].all); }
  function canManage(r) { return !!(ROLES[r] && ROLES[r].manage); }

  /** 一般資料表（非 ERP_ 分頁）的存取：write=是否為寫入 */
  function canTable(r, table, write) {
    var d = ROLES[r]; if (!d) return false;
    var t = String(table || "");
    if (t === "acl") return d.manage === true;                                 // 帳號表只有老闆能讀寫
    if (t === "高風險操作") return !write && d.all === true;                     // 高風險紀錄由伺服器寫入，老闆、主管可讀
    if (/^ERP_/.test(t) || t === "backup_log") return d.all === true;          // ERP 分頁只透過 ERP 動作存取；直接讀寫限老闆／主管
    if (!write) return true;
    if (r === "viewer") return false;
    if (/^gov_/.test(t)) return d.all === true;                                  // 內控治理紀錄：只有老闆、主管能寫
    if (/^sched_(notice|alert)$/.test(t)) return true;                        // 通知中心「已知悉」
    if (/^sched/.test(t)) return d.all === true || r === "ops";                // 排程設定與資料：老闆、主管、生管
    return true;
  }

  /** 伺服器端把這個職務看不到的欄位拿掉（回傳新物件，不改原本的）。world.meta.access 讓畫面知道要顯示「—」 */
  function redact(world, r) {
    var d = ROLES[r] || ROLES.viewer, w = JSON.parse(JSON.stringify(world));
    w.meta = w.meta || {};
    w.meta.access = { role: r, name: d.name, seeCost: !!d.seeCost, seePersonnel: !!d.seePersonnel };
    if (!d.seeCost) {
      Object.keys(COST_FIELDS).forEach(function (t) {
        (w[t] || []).forEach(function (row) { COST_FIELDS[t].forEach(function (f) { if (f in row) row[f] = null; }); });
      });
      COST_TABLES.forEach(function (t) { if (w[t]) w[t] = []; });
      (w.items || []).forEach(function (it) { it.cost_hidden = true; });
      (w.workorders || []).forEach(function (row) { (row.consumed || []).forEach(function (c) { delete c.value; }); });
      (w.orders || []).forEach(function (o) { (o.lines || []).forEach(function (l) { delete l.cost_layers; delete l.cost; delete l.unit_cost; }); });
    }
    if (!d.seePersonnel) PERSONNEL_TABLES.forEach(function (t) { if (w[t]) w[t] = []; });
    return w;
  }

  var api = { ROLES: ROLES, ORDER: ORDER, role: role, name: name, can: can, canImport: canImport, canManage: canManage, canTable: canTable, redact: redact,
    COST_FIELDS: COST_FIELDS, PERSONNEL_TABLES: PERSONNEL_TABLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ErpRoles = api;
})(typeof window !== "undefined" ? window : this);

/*
 * sched-kri.js — 生產排程的「風險 → 監控指標(KRI) → 容忍度門檻 → 觸發 → 處理」
 *   做法對應 COSO《Achieving Effective Internal Control Over GenAI》(2026)的內控觀念（會演進的風險登錄表、
 *   連結 KRI 的觸發點、多指標容忍度、預測漂移＝連續超標才升級、監控本身也要被監控），
 *   但這裡監控的是「排程引擎的預測」，不是生成式 AI。純計算、不碰畫面：瀏覽器與 Node 測試共用。
 *
 *   evaluate(ctx, tol) → 每個指標一筆 {id, risk, name, value, display, level: green|yellow|red|na, y, r, msg, action…}
 *   gate(items)        → 採用新排程前的檢查：有紅燈要填原因＋二次確認，有黃燈要勾選確認
 *   transitions(prev, items) → 燈號變化（觸發紀錄）
 *   snapshot(items, extra)   → 存進試算表給首頁、選單紅點、每日早報讀
 *
 *   ctx = { nowMin, grace(分鐘，預設 120), stageName(sid),
 *           orders:[{id, planned, predEnd, actEnd, actInferred, stages:[{sid, pred:[s,e]|null, act:{s,e,inferred}|null}]}],
 *           plan:{ageDays|null, fresh, cfgChanged}, stats:{hasDue, late, onTimeRate, maxLate, outCost, shaky}, util }
 *   時間都是「工作分鐘」。
 */
(function (root) {
  "use strict";

  // dir: "hi"＝數字越大越糟（≥ 黃／紅門檻就亮燈）；"lo"＝數字越小越糟（< 黃／紅門檻就亮燈）
  var DEFS = [
    { id: "D1", grp: "預測漂移", risk: "排程預測和現場脫節", name: "最近一張完工的預測誤差", unit: "小時", dir: "hi", y: 2, r: 4, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "預測誤差＝實際完工 − 排程預計完工（早或晚都算）。超過門檻代表工時設定可能不準。" },
    { id: "D2", grp: "預測漂移", risk: "排程預測和現場脫節", name: "連續幾張完工誤差超標", unit: "張", dir: "hi", y: 1, r: 2, owner: "生管", action: "fresh", actionLabel: "從頭排程",
      hint: "從最近一張往前數，連續幾張的誤差都超過第一項的黃燈門檻。連續超標就是「漂移」，要修正而不是繼續用。" },
    { id: "D3", grp: "預測漂移", risk: "工時設定失準", name: "某一站實際工時和設定的偏差", unit: "%", dir: "hi", y: 10, r: 20, owner: "生管", action: "factory", actionLabel: "檢查工廠設定",
      hint: "各站已回報的「實際耗時 ÷ 排程耗時」平均，取偏差最大的站。偏差大就該回「工廠設定」改每件分鐘。" },
    { id: "D4", grp: "預測漂移", risk: "現場沒有回報進度", name: "預計完工已過、卻還沒回報的單", unit: "張", dir: "hi", y: 1, r: 3, owner: "班長", action: "report", actionLabel: "去回報進度",
      hint: "預計完工已超過寬限時間（預設 2 小時）仍沒有完工回報；ERP 工單完工會自動帶入。" },
    { id: "D5", grp: "預測漂移", risk: "監控本身失靈（沒人回報）", name: "各站完工回報率", unit: "%", dir: "lo", y: 90, r: 70, owner: "班長", action: "report", actionLabel: "去回報進度",
      hint: "預計完工已過寬限時間的「站」裡，有幾成已回報（ERP 推定的不算）。回報率低，漂移監控就看不準。" },
    { id: "P1", grp: "計畫新舊", risk: "排程過期", name: "距離上次採用排程", unit: "天", dir: "hi", y: 2, r: 4, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "排程是某個時間點的計畫，太久沒更新就跟現場越差越遠。" },
    { id: "P2", grp: "計畫新舊", risk: "新單沒有排進去", name: "還沒最佳化的新訂單", unit: "張", dir: "hi", y: 1, r: 3, owner: "生管", action: "reopt", actionLabel: "重新最佳化",
      hint: "訂單清單有、但排程裡沒有的單，目前只是用現場做法暫排。" },
    { id: "P3", grp: "計畫新舊", risk: "設定被改動", name: "工廠設定改過、排程還沒重排", unit: "項", dir: "hi", y: 1, r: null, owner: "生管", action: "fresh", actionLabel: "從頭排程",
      hint: "站別、機台數、工時改過之後，原本的排程是依舊設定算的。" },
    { id: "L1", grp: "領先指標（早期預警）", risk: "產能不夠接單（需求超過產能）", name: "未來 5 個工作日要交的單：工時需求 ÷ 產能", unit: "%", dir: "hi", y: 85, r: 100, owner: "生管", action: "board", actionLabel: "看各站忙碌、考慮外包",
      hint: "最早的警訊：還沒延遲，但需求已經逼近產能。取各站裡最緊的一站；超過 100% 代表來不及。" },
    { id: "L2", grp: "領先指標（早期預警）", risk: "交期緩衝被吃光", name: "未完工訂單的平均交期寬裕", unit: "小時", dir: "lo", y: 12, r: 4, owner: "業務", action: "board", actionLabel: "看延遲風險的單",
      hint: "每張未完工的單，預計完工離交期還剩多少緩衝，取平均。緩衝一路縮小，就是延遲的前兆。" },
    { id: "L3", grp: "領先指標（早期預警）", risk: "交期不穩", name: "未完工訂單的平均準時機率", unit: "%", dir: "lo", y: 90, r: 75, owner: "業務", action: "board", actionLabel: "看準時機率",
      hint: "考慮加工時間誤差後，未完工的單平均有多大機會準時。比「準時率」更早反應。" },
    { id: "L4", grp: "領先指標（早期預警）", risk: "外包依賴升高", name: "外包佔比（未完工訂單）", unit: "%", dir: "hi", y: 5, r: 15, owner: "老闆", action: "board", actionLabel: "看外包的單",
      hint: "未完工的單裡，外包的件數佔幾成。越來越高，代表自家產能撐不住。" },
    { id: "S1", grp: "交期", risk: "交期落空", name: "準時率", unit: "%", dir: "lo", y: 95, r: 85, owner: "業務", action: "board", actionLabel: "看延遲的單",
      hint: "預計能準時完工的單 ÷ 有交期的單。" },
    { id: "S2", grp: "交期", risk: "交期落空", name: "預計最大延遲", unit: "小時", dir: "hi", y: 2, r: 8, owner: "業務", action: "board", actionLabel: "看延遲的單",
      hint: "預計延遲最久的那一張，晚了幾小時。" },
    { id: "S3", grp: "交期", risk: "交期不穩（排得進但很險）", name: "準時機率偏低的單（< 70%）", unit: "張", dir: "hi", y: 1, r: 3, owner: "業務", action: "board", actionLabel: "看準時機率",
      hint: "考慮加工時間誤差後，準時機率低於 70% 的單。" },
    { id: "C1", grp: "產能與成本", risk: "產能撞牆", name: "瓶頸站忙碌程度", unit: "%", dir: "hi", y: 90, r: 97, owner: "生管", action: "board", actionLabel: "看各站忙碌",
      hint: "最忙那一站的機台忙碌比例。逼近 100% 代表任何插單都會延遲。" },
    { id: "C2", grp: "產能與成本", risk: "外包成本失控", name: "外包費合計", unit: "NT$", dir: "hi", y: 5000, r: 20000, owner: "老闆", action: "board", actionLabel: "看外包的單",
      hint: "排程裡所有外包的費用合計。" }
  ];
  var LV = { na: -1, green: 0, yellow: 1, red: 2 };
  var LABEL = { na: "—", green: "正常", yellow: "黃燈", red: "紅燈" };

  function tolOf(def, tol) {
    var t = tol && tol[def.id] || {};
    return { y: t.y != null && isFinite(t.y) ? +t.y : def.y, r: t.r === null ? null : (t.r != null && isFinite(t.r) ? +t.r : def.r), owner: t.owner || def.owner };
  }
  function levelOf(v, def, t) {
    if (v == null || !isFinite(v)) return "na";
    if (def.dir === "hi") return t.r != null && v >= t.r ? "red" : v >= t.y ? "yellow" : "green";
    return t.r != null && v < t.r ? "red" : v < t.y ? "yellow" : "green";
  }
  function hrs(min) { var h = Math.abs(min) / 60; return (h >= 10 ? h.toFixed(0) : h.toFixed(1)).replace(/\.0$/, ""); }
  function pct0(x) { return Math.round(x) + "%"; }

  function ids(list, n) { return list.slice(0, n || 3).join("、") + (list.length > (n || 3) ? "…" : ""); }

  function evaluate(ctx, tol) {
    var grace = ctx.grace != null ? ctx.grace : 120, now = ctx.nowMin || 0, orders = ctx.orders || [], out = [];
    // ---- 預測誤差（完工的單；ERP 推定不算）
    var done = orders.filter(function (o) { return o.actEnd != null && o.predEnd != null && !o.actInferred; })
      .sort(function (a, b) { return a.actEnd - b.actEnd; });
    var errs = done.map(function (o) { return { id: o.id, e: o.actEnd - o.predEnd }; });
    var last = errs.length ? errs[errs.length - 1] : null;
    var d1 = last ? Math.abs(last.e) / 60 : null;
    var thr1 = tolOf(DEFS[0], tol).y * 60, run = 0;
    for (var k = errs.length - 1; k >= 0 && Math.abs(errs[k].e) >= thr1; k--) run++;
    // ---- 各站工時偏差
    var ratio = {};
    orders.forEach(function (o) {
      o.stages.forEach(function (st) {
        if (!st.act || st.act.inferred || st.act.s == null || st.act.e == null || !st.pred) return;
        var pd = st.pred[1] - st.pred[0], ad = st.act.e - st.act.s;
        if (pd > 1 && ad > 0) (ratio[st.sid] = ratio[st.sid] || []).push(ad / pd);
      });
    });
    var d3 = null, d3sid = null, d3dir = 0;
    Object.keys(ratio).forEach(function (sid) {
      var a = ratio[sid], m = a.reduce(function (x, y) { return x + y; }, 0) / a.length, dev = Math.abs(m - 1) * 100;
      if (d3 == null || dev > d3) { d3 = dev; d3sid = sid; d3dir = m - 1; }
    });
    // ---- 逾時沒回報
    var overdue = orders.filter(function (o) { return o.predEnd != null && o.actEnd == null && o.predEnd + grace < now; }).map(function (o) { return o.id; });
    var due = 0, rep = 0;
    orders.forEach(function (o) {
      o.stages.forEach(function (st) {
        if (!st.pred || st.pred[1] + grace >= now) return;
        due++; if (st.act && st.act.e != null && !st.act.inferred) rep++;
      });
    });
    var st = ctx.stats || {}, pl = ctx.plan || {}, ld = ctx.lead || {};
    var V = {
      D1: d1 == null ? null : d1,
      D2: errs.length ? run : null,
      D3: d3,
      D4: orders.some(function (o) { return o.predEnd != null; }) ? overdue.length : null,
      D5: due ? rep / due * 100 : null,
      P1: pl.ageDays == null ? null : pl.ageDays,
      P2: pl.fresh == null ? null : pl.fresh,
      P3: pl.cfgChanged == null ? null : (pl.cfgChanged ? 1 : 0),
      S1: st.hasDue ? st.onTimeRate * 100 : null,
      S2: st.hasDue ? Math.max(0, st.maxLate || 0) / 60 : null,
      S3: st.shaky == null ? null : st.shaky,
      L1: ld.load == null ? null : ld.load * 100,
      L2: ld.slack == null ? null : ld.slack / 60,
      L3: ld.prob == null ? null : ld.prob * 100,
      L4: ld.outPct == null ? null : ld.outPct * 100,
      C1: ctx.util == null ? null : ctx.util * 100,
      C2: st.outCost == null ? null : st.outCost
    };
    DEFS.forEach(function (def) {
      var t = tolOf(def, tol), v = V[def.id], lv = levelOf(v, def, t), disp = v == null ? "—" : def.id === "P1" ? v.toFixed(1).replace(/\.0$/, "") + " 天" : def.unit === "NT$" ? "NT$ " + Math.round(v).toLocaleString()
        : def.unit === "小時" ? (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "") + " 小時" : def.unit === "%" ? pct0(v) : def.unit === "項" ? (v ? "有" : "沒有") : Math.round(v) + " " + def.unit;
      var msg = "";
      if (lv === "yellow" || lv === "red") {
        if (def.id === "D1") msg = "最近完工的 " + last.id + " 比預計" + (last.e > 0 ? "晚" : "早") + " " + hrs(last.e) + " 小時。";
        else if (def.id === "D2") msg = "最近連續 " + run + " 張完工誤差都超過 " + hrs(thr1) + " 小時（" + ids(errs.slice(-run).reverse().map(function (x) { return x.id; })) + "）。";
        else if (def.id === "D3") msg = "「" + ctx.stageName(d3sid) + "」實際工時比排程" + (d3dir > 0 ? "多" : "少") + " " + Math.round(Math.abs(d3dir) * 100) + "%，建議改工廠設定的每件分鐘。";
        else if (def.id === "D4") msg = "超過預計完工 " + hrs(grace) + " 小時還沒回報：" + ids(overdue) + "。";
        else if (def.id === "D5") msg = "已到期的站只有 " + pct0(v) + " 有回報（" + rep + "／" + due + "）。";
        else if (def.id === "P1") msg = "已經 " + disp + "沒有更新排程。";
        else if (def.id === "P2") msg = "有 " + v + " 張新訂單還沒排進去。";
        else if (def.id === "P3") msg = "工廠設定在排程之後改過。";
        else if (def.id === "S1") msg = "預計只有 " + pct0(v) + " 準時（" + ((st.hasDue || 0) - (st.late || 0)) + "／" + st.hasDue + " 張）。";
        else if (def.id === "S2") msg = "最晚的一張預計晚 " + disp + "。";
        else if (def.id === "S3") msg = v + " 張的準時機率低於 70%，加工稍慢就會延遲。";
        else if (def.id === "L1") msg = "未來 5 個工作日要交的單，工時需求已達產能的 " + disp + (ld.loadName ? "（最緊的是「" + ld.loadName + "」）" : "") + "，再插單就會延遲。";
        else if (def.id === "L2") msg = v < 0 ? "未完工訂單預計平均已經比交期晚 " + (Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)).replace(/\.0$/, "") + " 小時。" : "未完工訂單平均只剩 " + disp + " 的交期緩衝。";
        else if (def.id === "L3") msg = "未完工訂單平均準時機率只剩 " + disp + "。";
        else if (def.id === "L4") msg = "未完工訂單有 " + disp + " 靠外包。";
        else if (def.id === "C1") msg = "瓶頸站忙碌 " + disp + "，幾乎沒有彈性。";
        else if (def.id === "C2") msg = "外包費合計 " + disp + "。";
      }
      out.push({ id: def.id, grp: def.grp, risk: def.risk, name: def.name, unit: def.unit, dir: def.dir, y: t.y, r: t.r, owner: t.owner, action: def.action, actionLabel: def.actionLabel,
        hint: def.hint, value: v, display: disp, level: lv, msg: msg });
    });
    return out;
  }

  function worst(items) { var w = "green", seen = false; items.forEach(function (x) { if (x.level !== "na") seen = true; if (LV[x.level] > LV[w]) w = x.level; }); return seen ? w : "na"; }
  function counts(items) { var c = { red: 0, yellow: 0, green: 0, na: 0 }; items.forEach(function (x) { c[x.level]++; }); return c; }

  // 採用新排程前的檢查：紅燈＝要填原因＋二次確認；黃燈＝要勾選「我已看過」
  function gate(items) {
    var red = items.filter(function (x) { return x.level === "red"; }), yellow = items.filter(function (x) { return x.level === "yellow"; });
    return { red: red, yellow: yellow, needReason: red.length > 0, needAck: red.length + yellow.length > 0, clear: !red.length && !yellow.length };
  }
  function thresholdText(x) {
    return x.dir === "hi" ? "黃 ≥ " + fmtN(x.y, x) + (x.r != null ? "、紅 ≥ " + fmtN(x.r, x) : "") : "黃 < " + fmtN(x.y, x) + (x.r != null ? "、紅 < " + fmtN(x.r, x) : "");
  }
  function fmtN(v, x) { return (x.unit === "NT$" ? "NT$ " + Math.round(v).toLocaleString() : v + (x.unit === "%" ? "%" : x.unit === "項" ? "" : " " + x.unit)).trim(); }

  // 燈號變化＝觸發紀錄（prev：{id: level}）
  function transitions(prev, items) {
    var ev = [];
    items.forEach(function (x) {
      var p = prev && prev[x.id]; if (p == null) p = "green";
      if (x.level === "na" || p === x.level) return;
      if (p === "na" && x.level === "green") return;
      ev.push({ id: x.id, name: x.name, from: p, to: x.level, display: x.display, msg: x.msg, up: LV[x.level] > LV[p] });
    });
    return ev;
  }
  function levels(items) { var m = {}; items.forEach(function (x) { m[x.id] = x.level; }); return m; }

  // 給首頁、選單紅點、每日早報用的精簡快照（orders：單號＋預計完工與實際完工的絕對時間 ms，早報在 Apps Script 端再算「逾時沒回報」）
  function snapshot(items, extra) {
    var c = counts(items), tol = {};
    items.forEach(function (x) { tol[x.id] = { y: x.y, r: x.r, owner: x.owner, name: x.name, dir: x.dir, unit: x.unit }; });
    return Object.assign({ v: 1, ts: Date.now(), worst: worst(items), red: c.red, yellow: c.yellow, green: c.green, tol: tol,
      items: items.filter(function (x) { return x.level === "red" || x.level === "yellow"; }).map(function (x) { return { id: x.id, name: x.name, level: x.level, display: x.display, msg: x.msg, owner: x.owner, actionLabel: x.actionLabel }; }) }, extra || {});
  }

  // 趨勢（領先）：用歷史值判斷「正在惡化／改善」，並預估多久會碰到下一道門檻
  //   hist：[{t(ms), v:{id: 數字}}]（舊→新）；items：evaluate 的結果；回傳 {id: {n, dir: none|flat|worse|better, eta:{to,days}|null, slopeDay}}
  var DAY = 86400000;
  function trends(hist, items) {
    var out = {};
    items.forEach(function (x) {
      var pts = (hist || []).filter(function (p) { return p.v && p.v[x.id] != null; }).slice(-8).map(function (p) { return [p.t, p.v[x.id]]; });
      var r = { n: pts.length, dir: "none", eta: null, slopeDay: 0 };
      out[x.id] = r;
      if (pts.length < 3 || x.value == null) return;
      var span = pts[pts.length - 1][0] - pts[0][0];
      if (span < 2 * 3600000) return;
      var n = pts.length, t0 = pts[0][0], sx = 0, sy = 0, sxx = 0, sxy = 0;
      pts.forEach(function (q) { var tx = (q[0] - t0) / DAY; sx += tx; sy += q[1]; sxx += tx * tx; sxy += tx * q[1]; });
      var den = n * sxx - sx * sx, slope = den > 1e-12 ? (n * sxy - sx * sy) / den : 0;
      r.slopeDay = slope;
      var hi = x.dir === "hi", scale = Math.max(Math.abs(x.y), 1e-9), l3 = pts.slice(-3);
      var worse = hi ? (l3[0][1] < l3[1][1] && l3[1][1] < l3[2][1]) : (l3[0][1] > l3[1][1] && l3[1][1] > l3[2][1]);
      var better = hi ? (l3[0][1] > l3[1][1] && l3[1][1] > l3[2][1]) : (l3[0][1] < l3[1][1] && l3[1][1] < l3[2][1]);
      var chg = Math.abs(l3[2][1] - l3[0][1]) / scale;
      r.dir = worse && chg >= 0.03 ? "worse" : better && chg >= 0.03 ? "better" : "flat";
      if (r.dir === "worse" && span >= 6 * 3600000 && Math.abs(slope) > 1e-9 && (hi ? slope > 0 : slope < 0)) {
        var target = x.level === "green" ? x.y : (x.level === "yellow" && x.r != null ? x.r : null);
        if (target != null) {
          var dist = hi ? target - x.value : x.value - target, d = dist / Math.abs(slope);
          if (dist > 0 && d <= 3) r.eta = { to: x.level === "green" ? "yellow" : "red", days: d };
        }
      }
    });
    return out;
  }

  var api = { trends: trends, DEFS: DEFS, LABEL: LABEL, LV: LV, evaluate: evaluate, worst: worst, counts: counts, gate: gate, transitions: transitions, levels: levels, snapshot: snapshot, tolOf: tolOf, thresholdText: thresholdText, levelOf: levelOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SchedKri = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);

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

// ===========================================================================
// ERP 後端（Apps Script 端）：把 ErpEngine 的資料放進試算表的 ERP_* 分頁
//
// 與原系統的關係：
//   - 只由 google-apps-script.gs 的 doPost「default」分支轉進來（先已通過登入與白名單驗證）。
//   - 只讀寫「ERP_」開頭的分頁，不碰 訂單/我的名單/收藏標記/報價紀錄 等既有分頁。
//   - 沒加入本檔時，原系統行為完全不變。
//
// 一致性：每次操作都在 LockService 鎖內「讀全部 → 引擎計算 → 只回寫有變的列」；
//         引擎檢查失敗就整筆放棄、不寫任何東西。前端每次操作帶唯一 key，重送不會重複執行。
// ===========================================================================
var ERP_LOG_SHEET = "ERP_操作紀錄";
var ERP_LOG_COLS = ["ts", "by", "action", "key", "result", "payload"];

// 版本：網頁（docs/assets/app.js 的 NEED）會用 appVersion 問後端「你是第幾版」，對不上就警告。
// 改了後端的對外行為、而網頁需要新行為時，把 GAS_API 加 1，並同步改 app.js 的 NEED.erp。
var GAS_BUILD = "2026.10.14";
var GAS_API = 2;                                // 2：內控治理（gov_ 資料表只有老闆、主管能寫；每月內控月報）

function erpBackup_() {                                // 備份狀態讀不到也不能讓版本查詢失敗
  try { return typeof backupStatus_ === "function" ? backupStatus_() : null; } catch (e) { return null; }
}

function erpAccess_(email) {                            // 網頁用：我是誰、什麼職務、權限控管有沒有啟用
  try { var a = aclRole_(email); return { configured: a.configured, role: a.role, name: a.role ? ErpRoles.name(a.role) : "", why: a.why }; } catch (e) { return null; }
}

function erpVersion_(email) {
  return { ok: true, build: GAS_BUILD, api: {
    erp: GAS_API,
    alerts: typeof SA_API !== "undefined" ? SA_API : null,       // 沒貼 sched-alerts.gs → null（網頁會提示尚未安裝）
    digest: typeof EMAIL_API !== "undefined" ? EMAIL_API : null,
    backup: typeof BK_API !== "undefined" ? BK_API : null
  }, backup: erpBackup_(), access: erpAccess_(email) };
}

function erpDispatch_(action, p, email) {
  if (action === "appVersion") return erpVersion_(email);                  // 任何通過登入的人都能看版本（不含資料）
  if (action !== "erpLoad" && action !== "erpAct" && action !== "erpImport") return null;   // 不是 ERP 的 action → 交回原本的 unknown action
  // ERP 含售價、成本、毛利：可在「專案設定 → 指令碼屬性」加 ERP_EMAILS（逗號分隔）限定誰能用；
  // 沒設 = 所有通過主檔白名單的人都能用。其他功能（訂單看板、資料庫…）不受影響。
  var only = String(PropertiesService.getScriptProperties().getProperty("ERP_EMAILS") || "").trim();
  if (only && only.split(/\s*,\s*/).map(function (x) { return x.toLowerCase(); }).indexOf(String(email).toLowerCase()) < 0) {
    return { error: "此帳號沒有 ERP 權限（請管理者把你加入 ERP_EMAILS）：" + email };
  }
  // 職能分工：沒設定任何帳號（acl 空）= 維持原狀；設定後依職務把關，看不到的欄位在這裡就拿掉
  var acc = aclRole_(email), role = acc.role;
  if (acc.configured && !role) return { error: acc.why };
  var cut = function (out) { if (acc.configured && out && out.world) out.world = ErpRoles.redact(out.world, role); return out; };
  if (action === "erpLoad") return cut({ ok: true, world: erpLoad_() });
  if (action === "erpImport") {
    if (acc.configured && !ErpRoles.canImport(role)) return { error: "你的職務（" + ErpRoles.name(role) + "）不能匯入備份" };
    var imp = erpImport_(p || {}, email);
    if (imp && !imp.error) aclRisk_("匯入備份（整份取代 ERP 資料）", email, role, "匯入 " + Object.keys((p && p.world) || {}).length + " 個資料表");
    return imp;
  }
  if (acc.configured && !ErpRoles.can(role, String((p && p.action) || ""))) return { error: "你的職務（" + ErpRoles.name(role) + "）不能執行：" + String((p && p.action) || "") };
  var out = erpAct_(p || {}, email);
  if (out && out.ok && /\.delete$/.test(String((p && p.action) || "")) && aclCount_(email, 1) >= ACL_DEL_LIMIT) aclRisk_("短時間大量刪除", email, role, "10 分鐘內已刪 " + ACL_DEL_LIMIT + " 筆以上（最近：" + p.action + "）");
  return cut(out);
}

// 匯入備份（整份取代 ERP_ 分頁）：先完整檢查，不通過就什麼都不寫；寫入前在操作紀錄留一筆
function erpImport_(p, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var src = p.world || {}, w = ErpEngine.empty();
    Object.keys(ErpEngine.TABLES).forEach(function (t) { if (Array.isArray(src[t])) w[t] = src[t]; });
    if (src.meta && typeof src.meta === "object") w.meta = { seq: src.meta.seq || {}, lotseq: Number(src.meta.lotseq) || 0 };
    var errs = ErpEngine.validate(w);
    if (errs.length) return { error: "備份檔檢查沒通過，未匯入：\n" + errs.slice(0, 8).join("\n") };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = erpSheet_(ss, ERP_LOG_SHEET, ERP_LOG_COLS);
    erpAppend_(log, [[new Date().toISOString(), email, "erpImport", "", "", "匯入備份：" + Object.keys(ErpEngine.TABLES).map(function (t) { return t + "=" + w[t].length; }).join(" ")]]);
    Object.keys(ErpEngine.TABLES).forEach(function (t) {
      var def = ErpEngine.TABLES[t], sh = ss.getSheetByName(def.sheet);
      if (!sh && !w[t].length) return;
      sh = sh || erpSheet_(ss, def.sheet, def.cols);
      var hdr = erpHeader_(sh, def.cols);
      if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), hdr.length)).clearContent();
      if (w[t].length) erpAppend_(sh, w[t].map(function (r) { return hdr.map(function (h) { return erpEncode_(r[h]); }); }), hdr.length);
    });
    var m = erpSheet_(ss, ErpEngine.META_SHEET, ["key", "value"]);
    m.getRange(2, 1, 1, 2).setNumberFormat("@").setValues([["meta", JSON.stringify(w.meta)]]);
    return { ok: true, world: erpLoad_() };
  } finally {
    lock.releaseLock();
  }
}

function erpAct_(p, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var key = String(p.key || "").slice(0, 80);
    var log = erpSheet_(ss, ERP_LOG_SHEET, ERP_LOG_COLS);
    if (key) {
      var prev = erpFindKey_(log, key);
      if (prev !== null) return { ok: true, result: prev, world: erpLoad_(), replay: true };
    }
    var w = erpLoad_();
    var now = new Date();
    var r;
    try {
      r = ErpEngine.apply(w, String(p.action || ""), p.payload || {}, {
        by: email, now: now.toISOString(), today: Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd")
      });
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
    erpSave_(ss, w, r.dirty);
    erpAppend_(log, [[now.toISOString(), email, String(p.action), key, String(r.result || ""), JSON.stringify(p.payload || {}).slice(0, 2000)]]);
    return { ok: true, result: r.result, world: w };
  } finally {
    lock.releaseLock();
  }
}

// ---------- 讀 ----------
function erpLoad_(src) {                     // src 不填 = 現在這份試算表；備份還原演練會傳入備份檔
  var ss = src || SpreadsheetApp.getActiveSpreadsheet();
  var w = ErpEngine.empty();
  Object.keys(ErpEngine.TABLES).forEach(function (t) {
    var def = ErpEngine.TABLES[t];
    var sh = ss.getSheetByName(def.sheet);
    if (!sh || sh.getLastRow() < 2) return;
    var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    var hdr = vals[0];
    for (var i = 1; i < vals.length; i++) {
      if (!vals[i][0]) continue;
      var rec = {};
      for (var c = 0; c < hdr.length; c++) if (hdr[c]) rec[hdr[c]] = vals[i][c];
      w[t].push(erpDecode_(def, rec));
    }
  });
  var meta = ss.getSheetByName(ErpEngine.META_SHEET);
  if (meta && meta.getLastRow() >= 2) {
    try { w.meta = JSON.parse(meta.getRange(2, 2).getDisplayValue()) || w.meta; } catch (e) {}
  }
  w.meta.seq = w.meta.seq || {};
  w.meta.lotseq = Number(w.meta.lotseq) || 0;
  return w;
}
function erpDecode_(def, rec) {
  (def.num || []).forEach(function (k) { var n = Number(String(rec[k] || "").replace(/,/g, "")); rec[k] = isFinite(n) ? n : 0; });
  (def.bool || []).forEach(function (k) { rec[k] = String(rec[k]).toLowerCase() === "true"; });
  (def.json || []).forEach(function (k) {
    try { rec[k] = rec[k] ? JSON.parse(rec[k]) : (k === "bom" ? {} : []); } catch (e) { rec[k] = k === "bom" ? {} : []; }
  });
  return rec;
}

// ---------- 寫（只回寫 dirty 的列；新增一次批次寫入；刪除由下往上） ----------
function erpSave_(ss, w, dirty) {
  Object.keys(dirty).forEach(function (t) {
    if (t === "meta" || !ErpEngine.TABLES[t]) return;
    var def = ErpEngine.TABLES[t];
    var sh = erpSheet_(ss, def.sheet, def.cols);
    var hdr = erpHeader_(sh, def.cols);
    var last = sh.getLastRow();
    var ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues() : [];
    var rowOf = {};
    for (var i = 0; i < ids.length; i++) if (ids[i][0]) rowOf[ids[i][0]] = i + 2;
    var byId = {};
    w[t].forEach(function (r) { byId[r.id] = r; });
    var adds = [], dels = [];
    Object.keys(dirty[t]).forEach(function (id) {
      if (dirty[t][id] === "delete") { if (rowOf[id]) dels.push(rowOf[id]); return; }
      var rec = byId[id]; if (!rec) return;
      var row = hdr.map(function (h) { return erpEncode_(rec[h]); });
      if (rowOf[id]) sh.getRange(rowOf[id], 1, 1, hdr.length).setNumberFormat("@").setValues([row]);
      else adds.push(row);
    });
    if (adds.length) erpAppend_(sh, adds, hdr.length);
    dels.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  });
  if (dirty.meta) {
    var m = erpSheet_(ss, ErpEngine.META_SHEET, ["key", "value"]);
    m.getRange(2, 1, 1, 2).setNumberFormat("@").setValues([["meta", JSON.stringify(w.meta)]]);
  }
}
function erpEncode_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------- 分頁工具（全部以純文字格式存，避免料號 001 被吃成 1、日期被轉格式） ----------
function erpSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setNumberFormat("@").setValues([cols]).setFontWeight("bold");
  sh.setFrozenRows(1);
  return sh;
}
function erpHeader_(sh, cols) {
  var lc = Math.max(sh.getLastColumn(), 1);
  var hdr = sh.getRange(1, 1, 1, lc).getDisplayValues()[0].filter(function (h) { return h; });
  var miss = cols.filter(function (c) { return hdr.indexOf(c) < 0; });
  if (miss.length) {   // 新版本多了欄位 → 補在最右邊，舊資料不動
    hdr = hdr.concat(miss);
    sh.getRange(1, 1, 1, hdr.length).setNumberFormat("@").setValues([hdr]);
  }
  return hdr;
}
function erpAppend_(sh, rows, width) {
  width = width || rows[0].length;
  var start = sh.getLastRow() + 1;
  var need = start + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  sh.getRange(start, 1, rows.length, width).setNumberFormat("@").setValues(rows);
}
function erpFindKey_(log, key) {
  var last = log.getLastRow();
  if (last < 2) return null;
  var from = Math.max(2, last - 299);   // 只需比對最近 300 筆（重送都發生在幾秒內）
  var vals = log.getRange(from, 4, last - from + 1, 2).getDisplayValues();
  for (var i = vals.length - 1; i >= 0; i--) if (vals[i][0] === key) return vals[i][1];
  return null;
}

// ===========================================================================
// 權限與職能分工（規則在 erp-roles.js；這裡負責讀「acl」分頁、把關、通知老闆）
//
//  - 「acl」分頁一列一個人：id（Email 小寫）、role（boss/manager/sales/ops/finance/admin/viewer）、active（1/0）、name。
//  - acl 完全沒有任何啟用的帳號 = 還沒啟用權限控管，維持原狀（所有登入者權限相同），避免把自己鎖在門外。
//    啟用方式：在 Apps Script 執行一次 accessSetup（把你自己設成老闆），之後在行政工作台「帳號權限」分頁加人。
//  - 停用帳號（active=0）、或「ERP_員工」裡同 Email 的員工被標為離職，立刻無法使用，不必等人去改白名單。
//  - 高風險操作（匯入備份、大量匯入、短時間大量刪除、帳號權限變更）會寫進「高風險操作」分頁並寄信給老闆。
// ===========================================================================
var ACL_SHEET = "acl";
var ACL_HDR = ["id", "role", "active", "name", "ts", "by"];
var RISK_SHEET = "高風險操作";
var RISK_HDR = ["ts", "who", "role", "kind", "detail"];
var ACL_BULK_ROWS = 20;                       // 一次匯入超過幾列算高風險
var ACL_DEL_LIMIT = 5;                        // 10 分鐘內刪幾筆算「大量刪除」

function aclTrue_(v) { return v === true || v === 1 || /^(1|true|yes|是|y)$/i.test(String(v).trim()); }
function aclRows_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getValues(), hdr = v[0], out = [];
  for (var i = 1; i < v.length; i++) {
    var o = {}; for (var c = 0; c < hdr.length; c++) o[hdr[c]] = v[i][c];
    if (!o.id) continue;
    o.id = String(o.id).trim().toLowerCase(); o.active = aclTrue_(o.active); out.push(o);
  }
  return out;
}
function aclStaffInactive_(email) {           // 員工資料裡同 Email 的人被標為離職 → 視同停用
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ERP_員工");
    if (!sh || sh.getLastRow() < 2) return false;
    var v = sh.getDataRange().getValues(), hdr = v[0], ei = hdr.indexOf("email"), ai = hdr.indexOf("active"), hit = false, anyActive = false;
    if (ei < 0 || ai < 0) return false;
    for (var i = 1; i < v.length; i++) if (String(v[i][ei]).trim().toLowerCase() === email) { hit = true; if (aclTrue_(v[i][ai])) anyActive = true; }
    return hit && !anyActive;
  } catch (e) { return false; }
}
/** → {configured, role, why}；role 為 null = 不准使用 */
function aclRole_(email) {
  var rows = aclRows_(), em = String(email || "").trim().toLowerCase();
  if (!rows.some(function (r) { return r.active; })) return { configured: false, role: "boss", why: "" };
  var me = rows.filter(function (r) { return r.id === em; })[0];
  if (!me) return { configured: true, role: null, why: "此帳號還沒有被指派職務：" + email + "（請老闆在「帳號權限」加入）" };
  if (!me.active) return { configured: true, role: null, why: "此帳號已停用：" + email };
  if (aclStaffInactive_(em)) return { configured: true, role: null, why: "此帳號對應的員工已離職：" + email };
  if (!ErpRoles.role(String(me.role))) return { configured: true, role: null, why: "職務設定不正確（" + me.role + "）：" + email };
  return { configured: true, role: String(me.role), why: "" };
}
function aclBosses_() {
  var l = aclRows_().filter(function (r) { return r.active && r.role === "boss"; }).map(function (r) { return r.id; });
  if (l.length) return l;
  var v = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  return [(v && v.trim()) ? v.trim() : Session.getActiveUser().getEmail()];
}
/** 高風險操作：寫紀錄＋寄信給老闆（同一人同一類 10 分鐘內只寄一次，避免洗版） */
function aclRisk_(kind, email, role, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    erpAppend_(erpSheet_(ss, RISK_SHEET, RISK_HDR), [[new Date().toISOString(), email, role || "", kind, String(detail || "").slice(0, 500)]]);
    var cache = CacheService.getScriptCache(), ck = "risk:" + kind + ":" + email;
    if (cache.get(ck)) return;
    cache.put(ck, "1", 600);
    GmailApp.sendEmail(aclBosses_().join(","), "【高風險操作】" + kind + "（" + email + "）",
      "操作人：" + email + "（" + (role ? ErpRoles.name(role) : "未設定") + "）\n操作：" + kind + "\n內容：" + detail +
      "\n時間：" + Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm") + "\n\n如果這不是你預期的操作，請立刻到「帳號權限」停用該帳號，並檢查「高風險操作」分頁。");
  } catch (e) { console.log("高風險通知失敗：" + e); }
}
function aclCount_(email, n) {                // 10 分鐘內累計刪除筆數
  var cache = CacheService.getScriptCache(), k = "del:" + email, v = (Number(cache.get(k)) || 0) + n;
  cache.put(k, String(v), 600); return v;
}
function aclDeny_(role, what) { return { error: "你的職務（" + ErpRoles.name(role) + "）不能" + what }; }

/**
 * 主檔 doPost 驗證完 email 之後呼叫（見 README「權限」的一行設定）。回傳 null = 放行；回傳物件 = 直接當回應擋下。
 * 沒貼這個檔、或沒設定任何帳號時完全不影響原本行為。
 */
function accessGate_(action, p, email) {
  var a = aclRole_(email);
  if (!a.configured) return null;
  if (!a.role) return { error: a.why };
  var role = a.role;
  p = p || {};
  switch (action) {
    case "tList":
      return ErpRoles.canTable(role, p.table, false) ? null : aclDeny_(role, "讀取資料表「" + p.table + "」");
    case "tUpsert": case "tRemove": case "tImport":
      if (!ErpRoles.canTable(role, p.table, true)) return aclDeny_(role, "修改資料表「" + p.table + "」");
      if (p.table === ACL_SHEET) {
        var chk = aclChange_(action, p); if (chk) return chk;
        aclRisk_("帳號權限變更", email, role, action + " " + (p.row ? JSON.stringify(p.row) : (p.id || "")));
      } else if (action === "tImport" && (p.rows || []).length > ACL_BULK_ROWS) aclRisk_("大量匯入", email, role, p.table + " 匯入 " + p.rows.length + " 列");
      else if (action === "tRemove" && aclCount_(email, 1) >= ACL_DEL_LIMIT) aclRisk_("短時間大量刪除", email, role, "10 分鐘內已刪 " + ACL_DEL_LIMIT + " 筆以上（最近：" + p.table + "）");
      return null;
    case "markSet": case "quoteAdd": case "quoteDel": case "driveSave":
      return role === "viewer" ? aclDeny_(role, "修改資料") : null;
    default:
      return null;                              // erpLoad / erpAct / erpImport 由 erpDispatch_ 依職務處理
  }
}
/** 改 acl 本身的防呆：不能把最後一位老闆停用或降級（會沒人能管帳號） */
function aclChange_(action, p) {
  var rows = aclRows_(), bosses = rows.filter(function (r) { return r.active && r.role === "boss"; });
  var target = String((p.row && p.row.id) || p.id || "").trim().toLowerCase();
  var isBoss = bosses.some(function (r) { return r.id === target; });
  if (!isBoss || bosses.length > 1) return null;
  var stays = action === "tUpsert" && p.row && (p.row.role === undefined || p.row.role === "boss") && (p.row.active === undefined || aclTrue_(p.row.active));
  return stays ? null : { error: "不能停用、刪除或降級最後一位老闆，否則沒有人能管理帳號。請先指定另一位老闆。" };
}

// 一次性設定：在 Apps Script 編輯器執行，把「你自己」設為第一位老闆，啟用權限控管
function accessSetup() {
  var me = String(Session.getActiveUser().getEmail()).toLowerCase();
  if (aclRows_().some(function (r) { return r.active; })) return "已經設定過了（acl 分頁已有啟用的帳號）。";
  var sh = erpSheet_(SpreadsheetApp.getActiveSpreadsheet(), ACL_SHEET, ACL_HDR);
  erpAppend_(sh, [[me, "boss", 1, "老闆", new Date().toISOString(), "accessSetup"]]);
  return "已啟用權限控管：" + me + " 是老闆。請到行政工作台「帳號權限」加入其他人；沒加入的人將無法使用。";
}

// 每季帳號盤點：列出所有帳號與最後使用時間、久未使用的、白名單與職務對不上的
// 手動執行 = 立刻寄；由每月 1 號的觸發器呼叫時，只在 1、4、7、10 月寄
function accessReview(e) {
  if (e && [0, 3, 6, 9].indexOf(new Date().getMonth()) < 0) return "非季初，略過";
  var ss = SpreadsheetApp.getActiveSpreadsheet(), rows = aclRows_(), last = {}, lines = [], flags = [];
  var log = ss.getSheetByName(ERP_LOG_SHEET);
  if (log && log.getLastRow() >= 2) {
    log.getRange(2, 1, log.getLastRow() - 1, 2).getValues().forEach(function (r) { var em = String(r[1]).toLowerCase(), t = new Date(r[0]).getTime(); if (t && (!last[em] || t > last[em])) last[em] = t; });
  }
  var now = Date.now(), allow = typeof ALLOWED_EMAILS !== "undefined" ? ALLOWED_EMAILS.map(function (x) { return String(x).toLowerCase(); }) : null;
  rows.forEach(function (r) {
    var idle = last[r.id] ? Math.floor((now - last[r.id]) / 86400000) : null;
    lines.push((r.active ? "● " : "○ ") + r.id + "　" + ErpRoles.name(r.role) + (r.active ? "" : "（已停用）") + "　最後操作：" + (idle === null ? "沒有紀錄" : idle + " 天前"));
    if (r.active && (idle === null || idle > 90)) flags.push("🟡 " + r.id + " 已 " + (idle === null ? "從未" : idle + " 天沒") + "使用，確認還需要這個帳號嗎？");
    if (r.active && allow && allow.indexOf(r.id) < 0) flags.push("🔴 " + r.id + " 在 acl 是啟用的，但不在 ALLOWED_EMAILS 白名單，實際上無法登入。");
    if (r.active && aclStaffInactive_(r.id)) flags.push("🔴 " + r.id + " 對應的員工已離職，但帳號還是啟用的（已被系統擋下，請在「帳號權限」停用）。");
  });
  if (allow) allow.forEach(function (em) { if (!rows.some(function (r) { return r.id === em; })) flags.push("🟡 " + em + " 在 ALLOWED_EMAILS 白名單，但 acl 沒有這個人（啟用權限控管後他無法使用）。若這個人已離職，請從白名單移除。"); });
  var body = "【每季帳號盤點】\n\n" + (lines.join("\n") || "（acl 還沒有帳號，權限控管尚未啟用）") + "\n\n" + (flags.length ? "需要處理：\n" + flags.join("\n") : "沒有發現需要處理的項目。") +
    "\n\n請老闆逐一確認：每個人的職務是否仍適合？離職或調動的人是否已停用？";
  GmailApp.sendEmail(aclBosses_().join(","), "【每季帳號盤點】" + (flags.length ? flags.length + " 項待處理" : "無異常"), body);
  erpAppend_(erpSheet_(ss, RISK_SHEET, RISK_HDR), [[new Date().toISOString(), "system", "", "每季帳號盤點", flags.length + " 項待處理"]]);
  return body;
}
function installAccessTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "accessReview") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("accessReview").timeBased().onMonthDay(1).atHour(9).inTimezone("Asia/Taipei").create();   // 每月 1 號觸發；實際只在 1、4、7、10 月寄出盤點信
  return "已安裝：每季（1、4、7、10 月 1 號 09:00）寄帳號盤點信。";
}


// ===========================================================================
// 全公司營運風險（規則在 biz-kri.js）：給 sched-alerts.gs 的 checkSchedAlerts 每 30 分鐘呼叫。
// 門檻與負責人存在 sched_cfg 的 biz_tol 列（網頁「風險儀表板 → 門檻設定」改）；歷史存在 biz_hist（趨勢與小曲線用）。
// ===========================================================================
var BIZ_HIST = "biz_hist";
var BIZ_HIST_HDR = ["id", "t", "v"];
var BIZ_HIST_KEEP = 400;                       // 約 18 個上班日（每 30 分鐘一筆）

function bizTol_() {
  try {
    var r = tList_("sched_cfg").rows.filter(function (x) { return x.id === "biz_tol"; })[0];
    return r ? JSON.parse(String(r.data).replace(/^~/, "")) : {};
  } catch (e) { return {}; }
}
function bizItems_(now) {
  var d = new Date(now), today = Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd");
  var tol = bizTol_(), o = tol._opts || {};                        // _opts：帳款天數、集中度最低銷售額（網頁「門檻設定」）
  return BizKri.evaluate(erpLoad_(), today, tol, { seeCost: true, terms: o.terms, minSales: o.minSales });
}
function bizCurrent_(now) {
  var items = bizItems_(now), out = {};
  try { bizHist_(items, now); } catch (e) {}
  items.forEach(function (x) {
    if (x.level !== "yellow" && x.level !== "red") return;
    out[x.id] = { key: x.id, level: x.level, name: x.name, display: x.display, msg: x.msg || "", owner: x.owner || "老闆", action: x.actionLabel || "", cat: "營運" };
  });
  return out;
}
function bizHist_(items, now) {                 // 距離上一筆至少 25 分鐘才記一筆
  var rows = tList_(BIZ_HIST).rows, last = 0;
  rows.forEach(function (r) { var t = Number(r.t); if (t > last) last = t; });
  if (now - last < 25 * 60000) return;
  var v = {}; items.forEach(function (x) { if (x.value != null) v[x.id] = Math.round(x.value * 100) / 100; });
  tUpsert_(BIZ_HIST, { id: "h" + now, t: now, v: JSON.stringify(v) }, BIZ_HIST_HDR, "營運風險");
  rows.sort(function (a, b) { return Number(b.t) - Number(a.t); }).slice(BIZ_HIST_KEEP - 1).forEach(function (r) { tRemove_(BIZ_HIST, r.id); });
}


// ===========================================================================
// 內控月報（規則在 governance.js）：每月 1 號 08:00 寄給老闆。
// 內容：目前紅黃燈（排程＋營運）、備份與還原演練、近 30 天高風險操作、定期治理紀錄（gov_log）有沒有逾期、待辦清單。
// 安裝：Apps Script 函式選單選 installGovTrigger → 執行（只做一次）；想先看看內容，執行 govMonthlyReport。
// ===========================================================================
var GOV_LOG = "gov_log";

function govActiveKri_() {                          // 目前還亮著的燈：sched_alert 分頁（排程與營運風險共用，checkSchedAlerts 每 30 分鐘維護）
  var rows = [];
  try { rows = tList_("sched_alert").rows || []; } catch (e) {}
  var out = { red: 0, yellow: 0, red_names: [], yellow_names: [] };
  rows.forEach(function (r) {
    if (!aclTrue_(r.active)) return;
    if (r.level === "red") { out.red++; out.red_names.push(String(r.name || r.id) + (r.display ? "（" + r.display + "）" : "")); }
    else if (r.level === "yellow") { out.yellow++; out.yellow_names.push(String(r.name || r.id) + (r.display ? "（" + r.display + "）" : "")); }
  });
  return out;
}
function govRiskOps_(now) {                         // 近 30 天高風險操作筆數（每季帳號盤點那一行不算）
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RISK_SHEET);
    if (!sh || sh.getLastRow() < 2) return 0;
    var since = now - 30 * 86400000;
    return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().filter(function (r) { var t = new Date(r[0]).getTime(); return t && t >= since && r[3] !== "每季帳號盤點"; }).length;
  } catch (e) { return 0; }
}
function govReport_(now) {
  var records = [];
  try { records = tList_(GOV_LOG).rows || []; } catch (e) {}
  return ErpGov.monthlyReport({ now: now, kri: govActiveKri_(), backup: erpBackup_(), riskOps: govRiskOps_(now), records: records });
}
function govMonthlyReport(e) {
  var r = govReport_(Date.now());
  GmailApp.sendEmail(aclBosses_().join(","), r.subject, r.body);
  return r.body;
}
function installGovTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "govMonthlyReport") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("govMonthlyReport").timeBased().onMonthDay(1).atHour(8).inTimezone("Asia/Taipei").create();
  return "已安裝：每月 1 號 08:00 寄內控月報給老闆。";
}
