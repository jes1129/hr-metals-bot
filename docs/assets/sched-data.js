/*
 * sched-data.js — 生產排程的預設工廠設定與範例訂單（可在「工廠設定」頁全部改掉）
 *   defaultConfig()：九上的預設站別（下料 → CNC 加工 → 表面處理 → 品檢包裝）
 *   demoOrders(cal)：一組兩週的範例訂單（日期依今天往後排）
 *   thesisConfig() / thesisOrders()：陳建銘（2015）論文第五章的封裝廠範例，用來驗證引擎算得跟論文一樣
 */
(function (root) {
  "use strict";

  function defaultConfig() {
    return {
      name: "九上科技 · 預設工廠",
      calendar: { days: [1, 2, 3, 4, 5, 6], dayStart: 8, hours: 16 },
      stages: [
        { id: "CUT", name: "下料", mode: "whole", setup: 20, out: { allowed: false, leadDays: 2, cost: 3 } },
        { id: "CNC", name: "CNC 加工", mode: "parallel", setup: 45, out: { allowed: true, leadDays: 4, cost: 25 } },
        { id: "SURF", name: "表面處理", mode: "batch", setup: 30, out: { allowed: true, leadDays: 3, cost: 6 } },
        { id: "QC", name: "品檢包裝", mode: "parallel", setup: 0, out: { allowed: false, leadDays: 1, cost: 2 } }
      ],
      types: [
        { id: "BS", stage: "CUT", name: "帶鋸機", count: 2, fixed: 10 },
        { id: "LS", stage: "CUT", name: "雷射切割", count: 1, fixed: 10 },
        { id: "CL", stage: "CNC", name: "CNC 車床", count: 4, fixed: 15 },
        { id: "TM", stage: "CNC", name: "車銑複合機", count: 2, fixed: 15 },
        { id: "MC", stage: "CNC", name: "綜合加工機", count: 3, fixed: 20 },
        { id: "AN", stage: "SURF", name: "陽極處理槽", count: 1, fixed: 90 },
        { id: "EP", stage: "SURF", name: "電鍍線", count: 1, fixed: 60 },
        { id: "QCS", stage: "QC", name: "品檢站", count: 2, fixed: 5 }
      ],
      products: [
        { id: "FG-JNT-001", name: "銅接頭（客製）", split: [50, 100], batch: 400,
          route: { CUT: { BS: 0.5 }, CNC: { CL: 3.0, TM: 2.2 }, SURF: { EP: 0.15 }, QC: { QCS: 0.3 } } },
        { id: "FG-BRK-002", name: "鋁合金支架", split: [40, 80], batch: 320,
          route: { CUT: { BS: 1.0, LS: 0.6 }, CNC: { MC: 5.0, TM: 4.2 }, SURF: { AN: 0.2 }, QC: { QCS: 0.4 } } },
        { id: "FG-SFT-003", name: "不鏽鋼軸心", split: [50, 100], batch: 400,
          route: { CUT: { BS: 0.6 }, CNC: { CL: 3.6, TM: 2.8 }, SURF: { EP: 0.12 }, QC: { QCS: 0.25 } } },
        { id: "FG-FLG-004", name: "鋁法蘭", split: [30, 60], batch: 240,
          route: { CUT: { LS: 0.8, BS: 1.2 }, CNC: { MC: 6.5, TM: 5.5 }, SURF: { AN: 0.25 }, QC: { QCS: 0.5 } } },
        { id: "FG-HSG-005", name: "鋁外殼", split: [20, 40], batch: 160,
          route: { CUT: { LS: 1.5 }, CNC: { MC: 9.0 }, SURF: { AN: 0.3, EP: 0.35 }, QC: { QCS: 0.6 } } }
      ]
    };
  }

  // [單號, 客戶, 產品, 數量, 投料(第幾個工作日), 交期(第幾個工作日), 重要度 1 一般／2 重要／3 急]
  var DEMO = [
    ["WO-101", "大雅精密", "FG-JNT-001", 2200, 0, 2, 1],
    ["WO-102", "神岡工業", "FG-BRK-002", 1100, 0, 3, 2],
    ["WO-103", "台中機械", "FG-SFT-003", 1800, 0, 2, 1],
    ["WO-104", "大雅精密", "FG-FLG-004", 720, 0, 4, 1],
    ["WO-105", "豐原電機", "FG-HSG-005", 420, 1, 5, 2],
    ["WO-106", "神岡工業", "FG-JNT-001", 1400, 1, 3, 1],
    ["WO-107", "潭子自動化", "FG-BRK-002", 900, 1, 5, 1],
    ["WO-108", "台中機械", "FG-SFT-003", 1250, 2, 4, 1],
    ["WO-109", "豐原電機", "FG-FLG-004", 540, 2, 6, 1],
    ["WO-110", "潭子自動化", "FG-HSG-005", 300, 2, 6, 1],
    ["WO-111", "大雅精密", "FG-JNT-001", 1600, 3, 5, 2],
    ["WO-112", "神岡工業", "FG-BRK-002", 720, 3, 7, 1],
    ["WO-113", "台中機械", "FG-SFT-003", 1080, 4, 6, 1],
    ["WO-114", "豐原電機", "FG-FLG-004", 650, 4, 8, 1],
    ["WO-115", "潭子自動化", "FG-JNT-001", 1800, 5, 8, 1],
    ["WO-116", "大雅精密", "FG-HSG-005", 360, 5, 9, 2],
    ["WO-117", "神岡工業", "FG-SFT-003", 1440, 6, 9, 1],
    ["WO-118", "台中機械", "FG-BRK-002", 800, 6, 10, 1]
  ];
  function demoOrders(cal) {
    return DEMO.map(function (d) {
      return { id: d[0], customer: d[1], product: d[2], qty: d[3], release: cal.dayDate(d[4]), due: cal.dayDate(d[5]), weight: d[6] };
    });
  }

  // 論文第五章範例（Lin & Chen 2015；陳建銘 2015）：黏晶 DB → 銲線 WB → 封膠 MD
  //   unit＝每件秒數；scale＝換算倍率（UI 用 1/60 把秒變成分鐘）
  function thesisConfig(scale) {
    var k = scale == null ? 1 : scale;
    return {
      name: "論文驗證範例（半導體封裝廠）",
      calendar: { days: [0, 1, 2, 3, 4, 5, 6], dayStart: 0, hours: 24 },
      stages: [
        { id: "DB", name: "黏晶 DB", mode: "whole", setup: 0 },
        { id: "WB", name: "銲線 WB", mode: "parallel", setup: 0 },
        { id: "MD", name: "封膠 MD", mode: "batch", setup: 0 }
      ],
      types: [
        { id: "DB1", stage: "DB", name: "DB1", count: 1 }, { id: "DB2", stage: "DB", name: "DB2", count: 1 },
        { id: "WB1", stage: "WB", name: "WB1", count: 3 }, { id: "WB2", stage: "WB", name: "WB2", count: 2 },
        { id: "MD1", stage: "MD", name: "MD1", count: 1 }, { id: "MD2", stage: "MD", name: "MD2", count: 1 }
      ],
      products: [
        { id: "A", name: "產品 A", split: [250, 500], batch: 1000,
          route: { DB: { DB1: 4 * k, DB2: 8 * k }, WB: { WB1: 24 * k, WB2: 16 * k }, MD: { MD2: 2 * k } } },
        { id: "B", name: "產品 B", split: [500, 1000], batch: 2000,
          route: { DB: { DB1: 2 * k, DB2: 4 * k }, WB: { WB1: 30 * k, WB2: 20 * k }, MD: { MD1: 6 * k } } }
      ]
    };
  }
  function thesisOrders() {
    return [{ id: "A", product: "A", qty: 2000, release: 0 }, { id: "B", product: "B", qty: 4000, release: 0 }];
  }

  var api = { defaultConfig: defaultConfig, demoOrders: demoOrders, thesisConfig: thesisConfig, thesisOrders: thesisOrders };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SchedData = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
