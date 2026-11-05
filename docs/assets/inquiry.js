/* 客戶詢價解析：把一段詢價文字（LINE／Email）讀成「材質、形狀、尺寸、數量」，再由程式算重量。
 *
 * 分工（和行情解讀同一個原則）：
 *   - AI（Apps Script 的 parseInquiry）或下面的規則解析，只負責「把文字讀成結構化欄位」；
 *   - 重量一律由 compute() 用公式算，AI 不算數字、不給價格；
 *   - 兩條路的輸出都要經過 sanitize()，型別、範圍不對的欄位一律丟掉，不會直接進報價表。
 * 同一支檔案在瀏覽器（window.Inquiry）與 Node 測試（module.exports）共用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Inquiry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SHAPES = ["round_bar", "tube", "plate", "block", "unknown"];
  var DIM_KEYS = ["diameter", "outer_diameter", "inner_diameter", "length", "width", "thickness", "height"];

  // 材質表：live 有值＝儀表板有即時行情可帶入料價；其餘只有密度，料價要人工填。
  var MATERIALS = [
    { name: "黃銅", density: 8.5, live: null, keys: ["黃銅", "C3604", "C2680", "C2801", "brass"] },
    { name: "青銅", density: 8.8, live: null, keys: ["磷青銅", "青銅", "bronze", "C5191"] },
    { name: "不鏽鋼", density: 7.93, live: null, keys: ["不鏽鋼", "不銹鋼", "stainless", "SUS"] },
    { name: "碳鋼", density: 7.85, live: null, keys: ["S45C", "S50C", "SS400", "碳鋼", "鋼材"] },
    { name: "鈦", density: 4.51, live: null, keys: ["鈦", "Ti6Al4V", "titanium"] },
    { name: "鋁", density: 2.7, live: "鋁", keys: ["鋁", "6061", "6063", "5052", "7075", "aluminum", "aluminium"] },
    { name: "銅", density: 8.96, live: "銅", keys: ["紫銅", "純銅", "電解銅", "無氧銅", "C1100", "銅"] }
  ];

  // ---------- 小工具 ----------
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  // 全形→半形，各種直徑符號統一成 Φ，乘號統一成 x
  function normalize(text) {
    var s = String(text == null ? "" : text).replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/　/g, " ").replace(/[Φφ∅Ø⌀ø]/g, "Φ");
    s = s.replace(/(\d(?:\.\d+)?)\s*(?:[×✕*xX])\s*(?=[\dΦ])/g, "$1x");
    return s;
  }

  function matchMaterial(text) {
    var t = String(text || "").toLowerCase(), best = null, bestIdx = Infinity;
    MATERIALS.forEach(function (m) {
      m.keys.forEach(function (k) {
        var i = t.indexOf(k.toLowerCase());
        if (i >= 0 && i < bestIdx) { bestIdx = i; best = m; }          // 取文字中最先出現的；同位置時「黃銅」會比「銅」早一個字
      });
    });
    return best ? { name: best.name, density: best.density, live: best.live } : null;
  }

  // ---------- 規則解析 ----------
  function ruleParse(text) {
    var t = normalize(text), dims = {}, shape = "unknown", m;
    var out = { customer: null, material: null, shape: "unknown", dims_mm: {}, quantity: null, weight_kg_each: null, weight_kg_total: null, note: null, source: "rule" };

    var mat = matchMaterial(t);
    out.material = mat ? mat.name : null;

    // 數量：「20 支」「30件」「數量 20」
    var q2 = t.match(/(\d+)\s*(?:支|根|片|個|件|只|條|pcs|pc|組|塊)/i) || t.match(/數量\s*[:：]?\s*(\d+)/);
    if (q2) out.quantity = num(q2[1]);

    // 直接寫了重量
    m = t.match(/(單重|每支|每件|每片|每個)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:kg|KG|公斤)/);
    if (m) out.weight_kg_each = num(m[2]);
    else {
      m = t.match(/(\d+(?:\.\d+)?)\s*(?:kg|KG|公斤)/);
      if (m) out.weight_kg_total = num(m[1]);
    }

    var hasTube = /管/.test(t), hasPlate = /板/.test(t);

    // 管：外徑／內徑／長度
    if (hasTube) {
      m = t.match(/(?:外徑|OD)\s*[:：=]?\s*Φ?\s*(\d+(?:\.\d+)?)/i); if (m) dims.outer_diameter = num(m[1]);
      m = t.match(/(?:內徑|ID)\s*[:：=]?\s*Φ?\s*(\d+(?:\.\d+)?)/i); if (m) dims.inner_diameter = num(m[1]);
      m = t.match(/(?:長度?|L)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i); if (m) dims.length = num(m[1]);
      if (dims.outer_diameter && dims.inner_diameter && dims.length) shape = "tube";
    }

    // 圓棒：Φ30x200／直徑 30 長 200
    if (shape === "unknown") {
      m = t.match(/Φ\s*(\d+(?:\.\d+)?)\s*(?:mm|MM)?\s*(?:x|長度?|L)?\s*[:：=]?\s*(\d+(?:\.\d+)?)?/);
      if (m) { dims.diameter = num(m[1]); if (m[2]) dims.length = num(m[2]); }
      if (!dims.diameter) { m = t.match(/(?:直徑|dia\.?)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i); if (m) dims.diameter = num(m[1]); }
      if (dims.diameter && !dims.length) { m = t.match(/(?:長度?|L)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i); if (m) dims.length = num(m[1]); }
      if (dims.diameter && dims.length) shape = "round_bar";
    }

    // 三個尺寸：長x寬x高（板材：最小的視為厚度）
    if (shape === "unknown") {
      m = t.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/);
      if (m) {
        var a = num(m[1]), b = num(m[2]), c = num(m[3]);
        if (hasPlate) { shape = "plate"; var s3 = [a, b, c].sort(function (x, y) { return y - x; }); dims = { length: s3[0], width: s3[1], thickness: s3[2] }; }
        else { shape = "block"; dims = { length: a, width: b, height: c }; }
      }
    }
    // 板材：兩個尺寸 ＋ 厚度
    if (shape === "unknown" && hasPlate) {
      m = t.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/);
      var th = t.match(/(?:厚度?|t)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i);
      if (m && th) { shape = "plate"; dims = { length: num(m[1]), width: num(m[2]), thickness: num(th[1]) }; }
    }

    out.shape = shape;
    out.dims_mm = dims;
    return sanitize(out);
  }

  // ---------- 驗收：AI 與規則解析的輸出都要過這關 ----------
  function sanitize(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var out = { customer: null, material: null, shape: "unknown", dims_mm: {}, quantity: null, weight_kg_each: null, weight_kg_total: null, note: null, source: r.source === "ai" ? "ai" : "rule", warnings: [] };
    function str(v, n) { return typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null; }
    out.customer = str(r.customer, 40);
    out.material = str(r.material, 20);
    out.note = str(r.note, 80);
    out.shape = SHAPES.indexOf(r.shape) >= 0 ? r.shape : "unknown";
    var d = r.dims_mm && typeof r.dims_mm === "object" ? r.dims_mm : {};
    DIM_KEYS.forEach(function (k) {
      var v = num(d[k]);
      if (v == null || d[k] === null || d[k] === "") return;
      if (v > 0 && v <= 20000) out.dims_mm[k] = v;                        // 單位 mm；超過 20 公尺或小於等於 0 視為讀錯
      else out.warnings.push("尺寸「" + k + "」的數值不合理，已略過");
    });
    var q = num(r.quantity);
    if (q != null && r.quantity !== null && q >= 1 && q <= 100000 && Math.floor(q) === q) out.quantity = q;
    else if (r.quantity != null && r.quantity !== "") out.warnings.push("數量不合理，已略過");
    ["weight_kg_each", "weight_kg_total"].forEach(function (k) {
      var v = num(r[k]);
      if (v != null && r[k] !== null && v > 0 && v <= 100000) out[k] = v;
      else if (r[k] != null && r[k] !== "") out.warnings.push("重量欄位不合理，已略過");
    });
    return out;
  }

  // ---------- 計算重量（全部由程式算） ----------
  function volumeMm3(shape, d) {
    var pi4 = Math.PI / 4;
    if (shape === "round_bar" && d.diameter && d.length) return pi4 * d.diameter * d.diameter * d.length;
    if (shape === "tube" && d.outer_diameter && d.inner_diameter && d.length) {
      if (d.inner_diameter >= d.outer_diameter) return null;
      return pi4 * (d.outer_diameter * d.outer_diameter - d.inner_diameter * d.inner_diameter) * d.length;
    }
    if (shape === "plate" && d.length && d.width && (d.thickness || d.height)) return d.length * d.width * (d.thickness || d.height);
    if (shape === "block" && d.length && d.width && (d.height || d.thickness)) return d.length * d.width * (d.height || d.thickness);
    return null;
  }

  function compute(parsed) {
    var p = sanitize(parsed), warnings = (p.warnings || []).slice();
    var mat = matchMaterial(p.material || "");
    if (p.material && !mat) warnings.push("看不出「" + p.material + "」是哪種材質，請在材質欄選擇或輸入。");
    if (!p.material) warnings.push("詢價裡沒有看到材質，請自行選擇。");
    var qty = p.quantity, unitKg = null, source = null;
    if (p.weight_kg_each) { unitKg = p.weight_kg_each; source = "詢價寫的單重"; }
    else {
      var vol = volumeMm3(p.shape, p.dims_mm);
      if (vol != null && mat) { unitKg = vol * mat.density / 1e6; source = "依尺寸與密度 " + mat.density + " 計算"; }
      else if (vol != null && !mat) warnings.push("有尺寸但不知道材質密度，算不出重量。");
    }
    var totalKg = null;
    if (p.weight_kg_total && !unitKg) { totalKg = p.weight_kg_total; source = "詢價寫的總重"; }
    else if (unitKg) {
      if (!qty) warnings.push("詢價沒有寫數量，先以 1 件計算。");
      totalKg = unitKg * (qty || 1);
    }
    if (totalKg == null) warnings.push("尺寸或重量不足，算不出重量，請手動輸入。");
    if (mat && mat.live === "鋁") warnings.push("鋁合金（如 6061、7075）實際料價通常比 LME 鋁貴，請確認每公斤料價。");
    if (mat && !mat.live) warnings.push("「" + mat.name + "」沒有即時行情，請自行填每公斤料價。");
    return {
      ok: totalKg != null, material: mat, shape: p.shape, dims: p.dims_mm, qty: qty || (unitKg ? 1 : null),
      unitKg: unitKg == null ? null : round(unitKg, 3), totalKg: totalKg == null ? null : round(totalKg, 2),
      weightSource: source, customer: p.customer, note: p.note, warnings: warnings, source: p.source
    };
  }

  function round(v, n) { var k = Math.pow(10, n); return Math.round(v * k) / k; }

  // 一行白話：讓使用者核對「我讀到的是什麼」
  var SHAPE_ZH = { round_bar: "圓棒", tube: "管", plate: "板", block: "方塊", unknown: "形狀不明" };
  function describe(parsed) {
    var p = sanitize(parsed), d = p.dims_mm, parts = [];
    if (p.material) parts.push(p.material);
    parts.push(SHAPE_ZH[p.shape]);
    if (p.shape === "round_bar" && d.diameter) parts.push("Φ" + d.diameter + (d.length ? " × " + d.length : "") + " mm");
    else if (p.shape === "tube") parts.push("外徑 " + (d.outer_diameter || "?") + "／內徑 " + (d.inner_diameter || "?") + "／長 " + (d.length || "?") + " mm");
    else if (p.shape === "plate" || p.shape === "block") parts.push([d.length, d.width, d.thickness || d.height].filter(Boolean).join(" × ") + " mm");
    if (p.quantity) parts.push("× " + p.quantity);
    return parts.join(" ");
  }

  return { MATERIALS: MATERIALS, normalize: normalize, matchMaterial: matchMaterial, ruleParse: ruleParse, sanitize: sanitize, compute: compute, describe: describe, volumeMm3: volumeMm3 };
});
