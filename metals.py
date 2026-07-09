# -*- coding: utf-8 -*-
"""
metals.py — 功能 B：銅鋁監控（對應指南第 9、11、14 頁）。

流程：Westmetall 取 LME 官方銅/鋁結算價（USD/公噸）+ Yahoo 匯率換台幣
      → append 到 prices.json 時間序列 → 判斷是否突破關注區間 → 回傳告警。
"""
import datetime
import json
import os
import re

import config

# 資料目錄：Modal 用 Volume 掛在 /data；GitHub Actions 設 METALS_DATA_DIR=data 存進 repo
DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
PRICES_FILE = os.path.join(DATA_DIR, "prices.json")

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}


def _parse_lme(html: str, field: str):
    """從 Westmetall 頁面抓某金屬的 LME 現金結算價（USD/公噸）。抓不到回 None。"""
    m = re.search(field + r'" class="block">\s*([0-9][0-9,]*\.\d{2})', html)
    return float(m.group(1).replace(",", "")) if m else None


def _usdtwd() -> float:
    """取 USD→TWD 即時匯率。失敗回 None。"""
    import httpx

    try:
        r = httpx.get(config.FX_URL, headers=_UA, timeout=20)
        return r.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
    except Exception as e:  # noqa: BLE001
        print(f"[metals] 取匯率失敗：{e}")
        return None


# ---------------------------------------------------------------------------
# 取價（Westmetall LME 官方價 + Yahoo 匯率，皆不需瀏覽器）
# ---------------------------------------------------------------------------
async def scrape_prices() -> dict:
    """回傳 {metal_key: {price(USD/t), price_twd, rate}}。漲跌在 run() 依歷史計算。"""
    import httpx  # 延遲匯入

    result = {}
    try:
        html = httpx.get(config.LME_URL, headers=_UA, timeout=30).text
    except Exception as e:  # noqa: BLE001
        print(f"[metals] 取 LME 頁面失敗：{e}")
        html = ""

    rate = _usdtwd()
    for key, cfg in config.METALS.items():
        price = _parse_lme(html, cfg["field"]) if html else None
        price_twd = round(price * rate) if (price and rate) else None
        result[key] = {"price": price, "price_twd": price_twd, "rate": rate}
    return result


def _last_price(series: list):
    """歷史中最後一筆有效 USD 價（供計算漲跌）。"""
    for entry in reversed(series):
        if entry.get("price") is not None:
            return entry["price"]
    return None


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
            twd = f"（約 NT${p['price_twd']:,}/t）" if p.get("price_twd") else ""
            alerts.append(
                {
                    "title": f"⚠️ {cfg['name']}（{cfg['en']}）{STATUS_LABEL[status]}",
                    "color": color,
                    "description": (
                        f"現價 **US${p['price']:,.0f}/t**{twd}"
                        f"（關注線 US${line:,}）"
                    ),
                }
            )
    return alerts


# ---------------------------------------------------------------------------
# 主流程（供 main 呼叫）
# ---------------------------------------------------------------------------
async def run() -> dict:
    """取價 → 算漲跌 → 存歷史 → 回傳 {'prices':..., 'alerts':[...]}。"""
    prices = await scrape_prices()
    history = load_history()
    # 依歷史最後一筆計算漲跌（USD）
    for key, p in prices.items():
        prev = _last_price(history.get(key, []))
        if p.get("price") is not None and prev:
            p["change"] = round(p["price"] - prev, 1)
            p["change_pct"] = round((p["price"] - prev) / prev * 100, 2)
        else:
            p["change"] = None
            p["change_pct"] = None
    append_history(history, prices)
    save_history(history)
    alerts = build_alerts(prices)
    print(f"[metals] 抓到：{prices}；告警 {len(alerts)} 則")
    return {"prices": prices, "alerts": alerts, "history": history}
