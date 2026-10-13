/**
 * 九上科技儀表板 — ERP 後端（Google Apps Script 第二個檔案）
 *
 * ⚠️ 自動產生，請勿手改：來源是 docs/assets/erp-engine.js + erp-admin.js + gas/erp-adapter.gs，
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
    equipment: { sheet: "ERP_設備", cols: ["id", "code", "name", "location", "active", "note", "created"], bool: ["active"] },
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
    if (!p.id) w.equipment.push(e);
    touch(ctx, "equipment", e);
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
  E.admin = { UNIT_KINDS: UNIT_KINDS, REQ_KINDS: REQ_KINDS, LEAVE_TYPES: LEAVE_TYPES, REQ_STATUS: REQ_STATUS,
    diff: diff, workHours: workHours, weekday: weekday, span: span };
  if (typeof module !== "undefined" && module.exports) module.exports = E;
})(typeof window !== "undefined" ? window : this);

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
var GAS_API = 1;

function erpVersion_() {
  return { ok: true, build: GAS_BUILD, api: {
    erp: GAS_API,
    alerts: typeof SA_API !== "undefined" ? SA_API : null,       // 沒貼 sched-alerts.gs → null（網頁會提示尚未安裝）
    digest: typeof EMAIL_API !== "undefined" ? EMAIL_API : null
  } };
}

function erpDispatch_(action, p, email) {
  if (action === "appVersion") return erpVersion_();                  // 任何通過登入的人都能看版本（不含資料）
  if (action !== "erpLoad" && action !== "erpAct" && action !== "erpImport") return null;   // 不是 ERP 的 action → 交回原本的 unknown action
  // ERP 含售價、成本、毛利：可在「專案設定 → 指令碼屬性」加 ERP_EMAILS（逗號分隔）限定誰能用；
  // 沒設 = 所有通過主檔白名單的人都能用。其他功能（訂單看板、資料庫…）不受影響。
  var only = String(PropertiesService.getScriptProperties().getProperty("ERP_EMAILS") || "").trim();
  if (only && only.split(/\s*,\s*/).map(function (x) { return x.toLowerCase(); }).indexOf(String(email).toLowerCase()) < 0) {
    return { error: "此帳號沒有 ERP 權限（請管理者把你加入 ERP_EMAILS）：" + email };
  }
  if (action === "erpLoad") return { ok: true, world: erpLoad_() };
  if (action === "erpImport") return erpImport_(p || {}, email);
  return erpAct_(p || {}, email);
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
function erpLoad_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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
