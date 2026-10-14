# -*- coding: utf-8 -*-
"""
build_erp_gas.py — 產生 google-apps-script-erp.gs（貼進 Apps Script 的第二個檔案）。

ERP 規則只有一份：docs/assets/erp-engine.js 與 erp-admin.js（瀏覽器與測試共用）。
這支把它和 gas/erp-adapter.gs（試算表讀寫）接成一個檔，避免手動複製造成兩邊規則不同步。
改了引擎或 adapter 之後執行：python scripts/build_erp_gas.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "docs", "assets", "erp-engine.js")
ADMIN = os.path.join(ROOT, "docs", "assets", "erp-admin.js")
ROLES = os.path.join(ROOT, "docs", "assets", "erp-roles.js")
KRI = os.path.join(ROOT, "docs", "assets", "sched-kri.js")
BIZ = os.path.join(ROOT, "docs", "assets", "biz-kri.js")
GOV = os.path.join(ROOT, "docs", "assets", "governance.js")
ADAPTER = os.path.join(ROOT, "gas", "erp-adapter.gs")
OUT = os.environ.get("ERP_GAS_OUT") or os.path.join(ROOT, "google-apps-script-erp.gs")   # 測試會指到暫存檔，避免和其他測試搶同一個檔

HEADER = """/**
 * 九上科技儀表板 — ERP 後端（Google Apps Script 第二個檔案）
 *
 * ⚠️ 自動產生，請勿手改：來源是 docs/assets/erp-engine.js + erp-admin.js + erp-roles.js + sched-kri.js + biz-kri.js + governance.js + gas/erp-adapter.gs，
 *    修改後執行 python scripts/build_erp_gas.py 重新產生。
 *
 * 安裝：在同一個 Apps Script 專案按「＋ → 指令碼」新增檔案（名稱例：erp），把本檔全部貼進去；
 *       再把 google-apps-script.gs 的 default 分支改成轉給 erpDispatch_（見 README「ERP 設定」）。
 *       本檔不含任何帳號、金鑰或白名單；登入驗證沿用主檔的 verify_。
 */

"""


def main():
    with open(ENGINE, encoding="utf-8") as f:
        engine = f.read()
    with open(ADMIN, encoding="utf-8") as f:
        admin = f.read()
    with open(ROLES, encoding="utf-8") as f:
        roles = f.read()
    with open(KRI, encoding="utf-8") as f:
        kri = f.read()
    with open(BIZ, encoding="utf-8") as f:
        biz = f.read()
    with open(GOV, encoding="utf-8") as f:
        gov = f.read()
    with open(ADAPTER, encoding="utf-8") as f:
        adapter = f.read()
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER + engine.rstrip() + "\n\n" + admin.rstrip() + "\n\n" + roles.rstrip() + "\n\n" + kri.rstrip() + "\n\n" + biz.rstrip() + "\n\n" + gov.rstrip() + "\n\n" + adapter)
    print("[build_erp_gas] 已產生", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    main()
