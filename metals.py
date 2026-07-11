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
def _yh_mult(cfg: dict) -> float:
    """Yahoo 原始單位 → USD/公噸 的乘數。"""
    u = cfg.get("yh_unit")
    if u == "lb":
        return config.LB_PER_TONNE
    if u == "short_ton":
        return config.SHORT_TON_PER_TONNE
    return 1.0


async def scrape_prices() -> dict:
    """回傳 {metal_key: {price(USD/t), price_twd, rate}}。
    有 field 者用 Westmetall（LME 官方）；只有 yh 者（鋼）現價取自 Yahoo 最新收盤。"""
    import httpx  # 延遲匯入

    result = {}
    try:
        html = httpx.get(config.LME_URL, headers=_UA, timeout=30).text
    except Exception as e:  # noqa: BLE001
        print(f"[metals] 取 LME 頁面失敗：{e}")
        html = ""

    rate = _usdtwd()
    for key, cfg in config.METALS.items():
        if cfg.get("field"):
            price = _parse_lme(html, cfg["field"]) if html else None
        elif cfg.get("yh"):
            d = _yahoo_daily(cfg["yh"])           # 只有 Yahoo 來源（鋼）
            price = round(list(d.values())[-1] * _yh_mult(cfg), 2) if d else None
        else:
            price = None
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
# 日線回補（Yahoo Finance 每日收盤，供走勢圖看趨勢；現價/告警仍用 Westmetall）
# ---------------------------------------------------------------------------
DAILY_FILE_PATH = os.path.join(DATA_DIR, config.DAILY_FILE)


def _yahoo_daily(sym: str) -> dict:
    """抓 Yahoo 某 symbol 過去一年日收盤，回傳 {date_iso: close}。失敗回 {}。"""
    import httpx  # 延遲匯入

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
    try:
        r = httpx.get(url, params={"range": "1y", "interval": "1d"},
                      headers=_UA, timeout=30)
        j = r.json()["chart"]["result"][0]
        ts = j["timestamp"]
        close = j["indicators"]["quote"][0]["close"]
    except Exception as e:  # noqa: BLE001
        print(f"[metals] Yahoo 日線 {sym} 失敗：{e}")
        return {}
    out = {}
    for t, c in zip(ts, close):
        if c is None:
            continue
        d = datetime.datetime.utcfromtimestamp(t).date().isoformat()
        out[d] = c
    return out


def backfill_daily() -> dict:
    """回補一年日線並寫入 data/daily.json。回傳 {copper:[{ts,usd,rate}], aluminum:[...], fx:[{ts,rate}]}。"""
    fxd = _yahoo_daily(config.YH_FX)
    fx_dates = sorted(fxd)

    def rate_on(d: str):
        if d in fxd:
            return fxd[d]
        prior = [x for x in fx_dates if x <= d]
        if prior:
            return fxd[prior[-1]]
        return fxd[fx_dates[0]] if fx_dates else None

    daily = {"fx": [{"ts": d, "rate": round(fxd[d], 4)} for d in fx_dates]}
    for key, cfg in config.METALS.items():
        if not cfg.get("yh"):          # 無 Yahoo 日線來源者 → 走勢圖靠 prices.json 快照
            continue
        raw = _yahoo_daily(cfg["yh"])
        mult = _yh_mult(cfg)
        series = []
        for d in sorted(raw):
            rate = rate_on(d)
            series.append({
                "ts": d,
                "usd": round(raw[d] * mult, 2),
                "rate": round(rate, 4) if rate else None,
            })
        daily[key] = series

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(DAILY_FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(daily, f, ensure_ascii=False, indent=2)
    cu = len(daily.get("copper", []))
    al = len(daily.get("aluminum", []))
    print(f"[metals] 日線回補完成：銅 {cu} 筆、鋁 {al} 筆")
    return daily


def load_daily() -> dict:
    """讀 daily.json；不存在回 {}。"""
    if not os.path.exists(DAILY_FILE_PATH):
        return {}
    try:
        with open(DAILY_FILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


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
# 只取價/算漲跌，不做上下線告警（由使用者自行判斷）
# ---------------------------------------------------------------------------
async def run() -> dict:
    """取價 → 算漲跌 → 存歷史 → 回傳 {'prices':..., 'history':...}。"""
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
    print(f"[metals] 抓到：{prices}")
    return {"prices": prices, "history": history}
