# -*- coding: utf-8 -*-
"""
datahealth.py — 原料行情「資料來源」監控（純規則與統計，沒有任何 AI）。

為什麼要有：本專案的 metals.yml 記著一次事故——資料三週沒更新，排程卻一直回報成功。
「程式跑成功」不等於「資料是對的、是新的」，所以這裡直接檢查資料本身：

  F1 新鮮度   最近一筆有效報價離現在多久（小時）
  F2 抓取失敗 最近連續幾次抓到的價格是空的
  J1 單日異常 最新一筆相對前一筆的漲跌幅（%），超過就可能是抓錯欄位／單位
  G1 雙來源價差 LME 官方價（Westmetall）與 Yahoo 期貨日收盤的差距（%）
  X1 匯率     即時匯率與 Yahoo 日線匯率的差距（%）
  S1 價格凍結 價格連續多天一模一樣（來源頁面沒更新卻仍抓得到舊值）

門檻（黃, 紅）可在 THRESHOLDS 改。輸出格式與排程風險一致：level = green|yellow|red。
"""
import datetime

# id: (名稱, 黃, 紅, 單位)
THRESHOLDS = {
    "F1": ("報價新鮮度", 30, 54, "小時"),     # 一天跑 2 次；超過 30 小時 = 漏跑一次；54 = 連漏兩次
    "F2": ("連續抓不到價", 1, 3, "次"),
    "J1": ("單日漲跌異常", 5.0, 8.0, "%"),   # 銅鋁單日 5% 已罕見；8% 多半是抓錯
    "G1": ("兩來源價差", 4.0, 8.0, "%"),     # LME 官方價 vs Yahoo 期貨（不同市場，容許一點差距）
    "X1": ("匯率差距", 1.5, 3.0, "%"),
    "S1": ("價格凍結天數", 4, 7, "天"),       # 週末加連假最多約 4 天不動
}

LIVE_METALS = ("copper", "aluminum")
YH_MULT = {"copper": 2204.62, "aluminum": 1.0}   # 與 config.LB_PER_TONNE 一致：Yahoo 原始單位 → USD/公噸


def _parse(ts):
    try:
        return datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def _level(v, y, r):
    if v is None:
        return "yellow"          # 算不出來本身就是警訊（沒資料可驗）
    return "red" if v >= r else "yellow" if v >= y else "green"


def assess(history, daily, now=None, thresholds=None, metals=LIVE_METALS):
    """回傳 {updated, level, red, yellow, items:[{id,metal,name,level,value,display,msg}]}。"""
    th = dict(THRESHOLDS)
    th.update(thresholds or {})
    now = now or datetime.datetime.now(datetime.timezone.utc)
    items = []

    def add(fid, metal, value, display, msg, level=None):
        name, y, r, unit = th[fid]
        lv = level or _level(value, y, r)
        items.append({"id": fid, "metal": metal, "name": name + ("（" + metal_name(metal) + "）" if metal else ""),
                      "level": lv, "value": value, "display": display, "msg": msg if lv != "green" else ""})

    for m in metals:
        series = history.get(m) or []
        good = [e for e in series if e.get("price")]
        # F1 新鮮度
        last = _parse(good[-1]["ts"]) if good else None
        age = round((now - last).total_seconds() / 3600, 1) if last else None
        add("F1", m, age, "—" if age is None else f"{age:g} 小時前",
            "沒有任何有效報價" if age is None else "資料超過 %g 小時沒更新，來源或排程可能壞了" % age)
        # F2 連續抓不到
        fails = 0
        for e in reversed(series):
            if e.get("price"):
                break
            fails += 1
        add("F2", m, fails, f"{fails} 次", f"最近連續 {fails} 次抓不到價格（來源頁面改版或被擋？）")
        # J1 單日異常（只看最新一筆有效價相對前一筆有效價）
        if len(good) >= 2 and good[-2]["price"]:
            pct = round(abs(good[-1]["price"] - good[-2]["price"]) / good[-2]["price"] * 100, 2)
            add("J1", m, pct, f"{pct:g}%", f"最新價相對前一筆變動 {pct:g}%，請確認不是抓錯欄位或單位")
        # S1 價格凍結：往回數，價格完全不變的天數
        if good:
            p0 = good[-1]["price"]
            t0 = _parse(good[-1]["ts"])
            first = t0
            for e in reversed(good):
                if e["price"] != p0:
                    break
                first = _parse(e["ts"]) or first
            days = round(((t0 - first).total_seconds() / 86400) if (t0 and first) else 0, 1)
            add("S1", m, days, f"{days:g} 天", f"價格已 {days:g} 天完全沒變，來源頁面可能停更")
        # G1 雙來源價差
        dd = (daily or {}).get(m) or []
        if good and dd and dd[-1].get("usd"):
            other = dd[-1]["usd"]
            gap = round(abs(good[-1]["price"] - other) / other * 100, 2)
            add("G1", m, gap, f"{gap:g}%", f"LME 官方價與 Yahoo 日收盤差 {gap:g}%，兩邊至少有一邊可能抓錯")
        elif good:
            add("G1", m, None, "—", "沒有第二個來源可對照（日線沒資料）")
    # X1 匯率
    fx = (daily or {}).get("fx") or []
    rate = None
    for m in metals:
        for e in reversed(history.get(m) or []):
            if e.get("rate"):
                rate = e["rate"]
                break
        if rate:
            break
    if rate and fx and fx[-1].get("rate"):
        gap = round(abs(rate - fx[-1]["rate"]) / fx[-1]["rate"] * 100, 2)
        add("X1", "", gap, f"{gap:g}%", f"即時匯率與日線匯率差 {gap:g}%")
    else:
        add("X1", "", None, "—", "匯率抓不到或沒有對照資料")

    red = sum(1 for i in items if i["level"] == "red")
    yel = sum(1 for i in items if i["level"] == "yellow")
    return {"updated": now.astimezone(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
            "level": "red" if red else "yellow" if yel else "green", "red": red, "yellow": yel, "items": items}


def metal_name(m):
    return {"copper": "銅", "aluminum": "鋁"}.get(m, m)


def summary(h):
    """一行文字（用在日誌、早報）。"""
    bad = [i for i in h["items"] if i["level"] != "green"]
    if not bad:
        return "原料資料來源正常（%d 項檢查）" % len(h["items"])
    return "原料資料來源：%d 紅 %d 黃 — " % (h["red"], h["yellow"]) + "；".join(
        "%s%s %s" % ("🔴" if i["level"] == "red" else "🟡", i["name"], i["display"]) for i in bad)
