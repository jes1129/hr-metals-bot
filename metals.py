# -*- coding: utf-8 -*-
"""
metals.py — 功能 B：銅鋁監控（對應指南第 9、11、14 頁）。

流程：Playwright 爬鉅亨網銅/鋁現價 → append 到 Volume 的 prices.json 時間序列
      → 判斷是否突破 config 的關注區間 → 突破即回傳告警文字（由 main 推送）。
"""
import datetime
import json
import os

import browser
import config

# 資料目錄：Modal 用 Volume 掛在 /data；GitHub Actions 設 METALS_DATA_DIR=data 存進 repo
DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
PRICES_FILE = os.path.join(DATA_DIR, "prices.json")


# ---------------------------------------------------------------------------
# 爬價
# ---------------------------------------------------------------------------
async def scrape_prices() -> dict:
    """
    回傳 {metal_key: {"price": float, "change": float, "change_pct": float}}。

    TODO(verify): 鉅亨網銅/鋁報價的實際頁面 DOM 或後端 API 結構。
    以下用「頁面上抓數字」的合理假設；實際部署時對照鉅亨網頁面調整 selector，
    或改用 browser.fetch_json() 打鉅亨網的報價 API（更穩定）。
    """
    result = {}
    async with browser.real_chrome(headless=True) as (page, _ctx):
        for key, cfg in config.METALS.items():
            try:
                await page.goto(cfg["url"], wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(1500)
                # TODO(verify): 以下選擇器需對照鉅亨網實際頁面
                price = await _read_number(page, '[data-field="price"], .price')
                change = await _read_number(page, '[data-field="change"], .change')
                pct = await _read_number(page, '[data-field="changePct"], .change-pct')
                result[key] = {"price": price, "change": change, "change_pct": pct}
            except Exception as e:  # noqa: BLE001
                print(f"[metals] 爬 {cfg['name']} 失敗：{e}")
                result[key] = {"price": None, "change": None, "change_pct": None}
    return result


async def _read_number(page, selector: str):
    """讀取元素文字並轉成 float（去除逗號/百分號）。抓不到回 None。"""
    try:
        el = await page.query_selector(selector)
        if not el:
            return None
        txt = (await el.inner_text()).strip()
        txt = txt.replace(",", "").replace("%", "").replace("+", "")
        return float(txt)
    except Exception:  # noqa: BLE001
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
