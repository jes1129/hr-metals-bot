# -*- coding: utf-8 -*-
# 註：docs-only 的 commit 不會觸發部署；本檔任何改動可強制重新部署整站。（說明頁白痴級重寫＋更新頻率表）
"""
run_metals.py — 功能 B 入口（每日 2 次，最頻繁）→ 同時產生首頁與原料頁。

流程：Westmetall 取銅／鋁現價 + Yahoo 日線回補 → 存 prices/daily.json
      → 產生 docs/metals.html（原料頁）與 docs/index.html（首頁總覽，讀各 data 檔數字）。
"""
import asyncio
import datetime
import json
import os

import config
import dashboard
import metals

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")


def _build_signals(history):
    """原料現況（現價＋漲跌%）→ 給 email 早報讀取（docs/signals.json，Pages 會 serve）。"""
    metals_list = []
    for key, cfg in config.METALS.items():
        series = history.get(key, []) or []
        latest = series[-1] if series else {}
        metals_list.append({
            "key": key, "name": cfg.get("name", key),
            "price_twd": latest.get("price_twd"), "pct": latest.get("change_pct"),
            "note": cfg.get("note", ""),
        })
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return {"updated": now, "metals": metals_list}


def _fetch_news(max_n=6):
    """抓 Google 新聞（銅鋁／金屬原料）最新標題，讓使用者了解漲跌原因。免金鑰。"""
    import email.utils
    import urllib.parse
    import xml.etree.ElementTree as ET

    import httpx
    q = "銅價 OR 鋁價 OR 金屬 原料 價格 when:30d"   # 近 30 天
    url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(q)
           + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant")
    try:
        r = httpx.get(url, timeout=15, follow_redirects=True,
                      headers={"User-Agent": "Mozilla/5.0"})
        root = ET.fromstring(r.text)
        rows = []
        for it in root.findall(".//item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            src = it.find("source")
            source = (src.text.strip() if src is not None and src.text else "")
            if source and title.endswith(" - " + source):   # 拿掉標題尾端重複的「 - 來源」
                title = title[: -(len(source) + 3)].strip()
            dt = None
            pub = it.findtext("pubDate")
            if pub:
                try:
                    dt = email.utils.parsedate_to_datetime(pub).astimezone(
                        datetime.timezone(datetime.timedelta(hours=8)))
                except Exception:  # noqa: BLE001
                    pass
            if title and link:
                rows.append((dt, {"title": title, "link": link, "source": source,
                                  "date": dt.strftime("%m/%d") if dt else ""}))
        _old = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        rows.sort(key=lambda x: x[0] or _old, reverse=True)   # 最新在前（無日期者最後）
        out = [r for _, r in rows[:max_n]]
        print(f"[news] 取得 {len(out)} 則原料新聞")
        return out
    except Exception as e:  # noqa: BLE001
        print("[news] 取新聞失敗：", e)
        return []


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
    # 原料頁（含相關新聞）
    with open(os.path.join("docs", "metals.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_html(history, daily, news=_fetch_news()))
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
    # AI 助手（純靜態外殼，快速問答本地算、自由提問走 Gemini）
    with open(os.path.join("docs", "assistant.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_assistant_html())
    # 原料現況/突破訊號（供 email 早報讀取）
    with open(os.path.join("docs", "signals.json"), "w", encoding="utf-8") as f:
        json.dump(_build_signals(history), f, ensure_ascii=False)

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


if __name__ == "__main__":
    main()
