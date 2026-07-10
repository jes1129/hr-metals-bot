# -*- coding: utf-8 -*-
"""
run_metals.py — 功能 B 入口（每日 2 次，最頻繁）→ 同時產生首頁與原料頁。

流程：Westmetall 取銅鋁鎳現價 + Yahoo 日線回補 → 存 prices/daily.json
      → 產生 docs/metals.html（原料頁）與 docs/index.html（首頁總覽，讀各 data 檔數字）
      → 突破區間時發告警（若有設 webhook）。
"""
import asyncio
import json
import os

import dashboard
import metals

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")


def _read(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def main():
    result = asyncio.run(metals.run())   # 寫 prices.json、算告警
    daily = metals.backfill_daily()       # 回補日線 → daily.json
    history = result["history"]

    os.makedirs("docs", exist_ok=True)
    # 原料頁
    with open(os.path.join("docs", "metals.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_html(history, daily))
    # 報價試算頁（用最新原料現價）
    with open(os.path.join("docs", "quote.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_quote_html(history))
    # 說明頁（純靜態教學，隨每次部署更新）
    with open(os.path.join("docs", "help.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_help_html())
    # 資料庫操作中心（純靜態外殼，資料登入後由前端載入）
    with open(os.path.join("docs", "db.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_db_html())
    # 訂單 + 老闆儀表板（純靜態外殼，訂單登入後由前端載入）
    with open(os.path.join("docs", "orders.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_orders_html())
    # 庫存 · MRP 缺料建議（純靜態外殼，資料登入後由前端載入）
    with open(os.path.join("docs", "mrp.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_mrp_html())
    # AI 助手（純靜態外殼，快速問答本地算、自由提問走 Gemini）
    with open(os.path.join("docs", "assistant.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_assistant_html())

    # 首頁總覽數字（跨 data 檔，可能落後數小時，可接受）
    jobs = _read(os.path.join(DATA_DIR, "jobs.json"), [])
    jobs_total = jobs[-1]["total"] if jobs else 0
    sup = _read(os.path.join(DATA_DIR, "suppliers.json"), [])
    sup_total, sup_near = len(sup), sum(1 for s in sup if s.get("is_near"))
    cust = _read(os.path.join(DATA_DIR, "customers.json"), None)
    cust_total = len(cust) if isinstance(cust, list) else None

    with open(os.path.join("docs", "index.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_home(history, jobs_total, sup_total, sup_near, cust_total))
    print("[run_metals] 已更新 docs/metals.html 與 docs/index.html（首頁）")

    if result["alerts"]:
        import notify
        notify.send_embeds(result["alerts"], content="**⚠️ 銅鋁突破告警**")


if __name__ == "__main__":
    main()
