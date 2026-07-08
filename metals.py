# -*- coding: utf-8 -*-
"""
metals.py — 功能 B：銅鋁監控（對應指南第 9、11、14 頁）。

流程：Yahoo Finance 取銅/鋁現價 → append 到 prices.json 時間序列
      → 判斷是否突破 config 的關注區間 → 突破即回傳告警（由呼叫端推送）。
"""
import datetime
import json
import os

import config

# 資料目錄：Modal 用 Volume 掛在 /data；GitHub Actions 設 METALS_DATA_DIR=data 存進 repo
DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
PRICES_FILE = os.path.join(DATA_DIR, "prices.json")

YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}


# ---------------------------------------------------------------------------
# 取價（Yahoo Finance 公開報價 API，不需瀏覽器）
# ---------------------------------------------------------------------------
async def scrape_prices() -> dict:
    """回傳 {metal_key: {price, change, change_pct}}，皆已換算成 config 單位（USD/公噸）。"""
    import httpx  # 延遲匯入

    result = {}
    for key, cfg in config.METALS.items():
        try:
            resp = httpx.get(YAHOO_URL.format(sym=cfg["yahoo"]), headers=_UA, timeout=30)
            resp.raise_for_status()
            meta = resp.json()["chart"]["result"][0]["meta"]
            mult = cfg.get("to_tonne", 1.0)
            price = round(meta["regularMarketPrice"] * mult, 1)
            prev = (meta.get("previousClose") or meta.get("chartPreviousClose")) * mult
            change = round(price - prev, 1)
            change_pct = round((price - prev) / prev * 100, 2) if prev else None
            result[key] = {"price": price, "change": change, "change_pct": change_pct}
        except Exception as e:  # noqa: BLE001
            print(f"[metals] 取 {cfg['name']} 報價失敗：{e}")
            result[key] = {"price": None, "change": None, "change_pct": None}
    return result


# ---------------------------------------------------------------------------
# Volume 歷史時間序列
# ---------------------------------------------------------------------------
def load_history() -> dict:
    """讀 prices.json → {metal_key: [ {ts, price, change, change_pct}, ... ]}。"""
    if not os.path.exists(PRICES_FILE):
        return {k: [] for k in config.METALS}
    try:
        with open(PRICES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        for k in config.METALS:
            data.setdefault(k, [])
        return data
    except Exception:  # noqa: BLE001
        return {k: [] for k in config.METALS}


def append_history(history: dict, prices: dict) -> dict:
    """把本次抓到的價格追加到時間序列（就地更新 history）。"""
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for key, p in prices.items():
        history.setdefault(key, []).append({"ts": ts, **p})
    return history


def save_history(history: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(PRICES_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 突破區間判斷（對應指南第 11、14 頁狀態燈）
# ---------------------------------------------------------------------------
def check_status(key: str, price) -> str:
    """回傳 'break_high' / 'break_low' / 'in_range' / 'unknown'。"""
    if price is None:
        return "unknown"
    cfg = config.METALS[key]
    if price > cfg["watch_high"]:
        return "break_high"
    if price < cfg["watch_low"]:
        return "break_low"
    return "in_range"


STATUS_LABEL = {
    "break_high": "突破上線",
    "break_low": "跌破下線",
    "in_range": "區間內",
    "unknown": "無資料",
}


def build_alerts(prices: dict) -> list:
    """回傳需要 Discord 告警的 embed 卡片（僅突破/跌破時，漲紅跌綠）。"""
    alerts = []
    for key, p in prices.items():
        status = check_status(key, p.get("price"))
        if status in ("break_high", "break_low"):
            cfg = config.METALS[key]
            if status == "break_high":
                line, color = cfg["watch_high"], 0xC0392B   # 突破上線 → 紅
            else:
                line, color = cfg["watch_low"], 0x1E8449    # 跌破下線 → 綠
            alerts.append(
                {
                    "title": f"⚠️ {cfg['name']}（{cfg['en']}）{STATUS_LABEL[status]}",
                    "color": color,
                    "description": (
                        f"現價 **{p['price']} {cfg['unit']}**"
                        f"（關注線 {line}）"
                    ),
                }
            )
    return alerts


# ---------------------------------------------------------------------------
# 主流程（供 main 呼叫）
# ---------------------------------------------------------------------------
async def run() -> dict:
    """爬價 → 存歷史 → 回傳 {'prices':..., 'alerts':[...]}（存檔/推送由 main 處理）。"""
    prices = await scrape_prices()
    history = load_history()
    append_history(history, prices)
    save_history(history)
    alerts = build_alerts(prices)
    print(f"[metals] 抓到：{prices}；告警 {len(alerts)} 則")
    return {"prices": prices, "alerts": alerts, "history": history}
