# -*- coding: utf-8 -*-
"""
advice.py — 把行情資料變成「今天該做什麼」的白話建議（純規則，不用 AI、不連網）。

輸入：prices.json 的 history（有現價與單日漲跌）、daily.json 的日線（算 7/30 天、區間位置）、資料健康燈號。
輸出：dict，給首頁、原料頁的「我的提醒」、signals.json（供 Apps Script 的提醒信使用）共用。

門檻放在 config.ADVICE_*，要調整只改那裡。所有文字只是「參考」，不是投資建議。
"""
import config

# 預設門檻（config 沒設定時使用）
DAY_PCT = getattr(config, "ADVICE_DAY_PCT", 1.5)      # 單日漲跌幅超過這個 % 就提醒
WEEK_PCT = getattr(config, "ADVICE_WEEK_PCT", 3.0)    # 7 天累計漲跌超過這個 % 就提醒
HIGH_POS = getattr(config, "ADVICE_HIGH_POS", 90)     # 近一年區間位置 ≥ 這個 % 算「接近高點」
LOW_POS = getattr(config, "ADVICE_LOW_POS", 10)       # ≤ 這個 % 算「接近低點」

NAMES = {"copper": "銅", "aluminum": "鋁"}


def _twd_series(rows):
    """日線 → [(日期, 元/噸)]"""
    out = []
    for r in rows or []:
        usd, rate = r.get("usd"), r.get("rate")
        if usd is not None and rate is not None:
            out.append((r.get("ts"), usd * rate))
    return out


def _ago(series, days):
    """距最後一天 days 天前的價格（取不晚於該日的最近一筆）。"""
    import datetime
    if not series:
        return None
    last = datetime.date.fromisoformat(series[-1][0][:10])
    cut = last - datetime.timedelta(days=days)
    hit = None
    for ts, v in series:
        if datetime.date.fromisoformat(ts[:10]) <= cut:
            hit = v
        else:
            break
    return hit


def _pct(new, old):
    return None if not old else round((new / old - 1) * 100, 2)


def _attr(rows, days):
    """把台幣價格變動拆成「國際價（美元）」與「匯率」兩塊。
    days=1 → 最後一天 vs 前一個交易日；days>1 → 最後一天 vs days 天前。
    台幣價 = 美元價 × 匯率，所以 總變動 ≈ 國際價變動 + 匯率變動（相乘的小交叉項另外歸在 total 裡）。"""
    import datetime
    good = [r for r in (rows or []) if r.get("usd") and r.get("rate") and r.get("ts")]
    if len(good) < 2:
        return None
    last = good[-1]
    if days <= 1:
        base = good[-2]
    else:
        cut = datetime.date.fromisoformat(last["ts"][:10]) - datetime.timedelta(days=days)
        base = None
        for r in good:
            if datetime.date.fromisoformat(r["ts"][:10]) <= cut:
                base = r
            else:
                break
        if base is None:
            return None
    total = _pct(last["usd"] * last["rate"], base["usd"] * base["rate"])
    return {"total": total, "usd": _pct(last["usd"], base["usd"]), "fx": _pct(last["rate"], base["rate"]),
            "from": base["ts"][:10], "to": last["ts"][:10]}


def metal_stats(history, daily):
    """每種金屬的現況數字。"""
    stats = {}
    for key, name in NAMES.items():
        hist = (history or {}).get(key) or []
        latest = hist[-1] if hist else {}
        s = _twd_series((daily or {}).get(key))
        price = latest.get("price_twd") or (round(s[-1][1]) if s else None)
        st = {"key": key, "name": name, "price_twd": price, "day_pct": latest.get("change_pct"),
              "d7": None, "d30": None, "pos": None, "ma_gap": None,
              "hi7": None, "lo7": None, "spark": [], "attr": {"day": None, "week": None}}
        rows = (daily or {}).get(key) or []
        st["attr"] = {"day": _attr(rows, 1), "week": _attr(rows, 7)}
        if len(s) >= 2:
            vals = [v for _, v in s]
            last = vals[-1]
            st["d7"] = _pct(last, _ago(s, 7))
            st["d30"] = _pct(last, _ago(s, 30))
            lo, hi = min(vals), max(vals)
            st["pos"] = round((last - lo) / ((hi - lo) or 1) * 100)
            ma = sum(vals[-20:]) / min(20, len(vals))
            st["ma_gap"] = _pct(last, ma)
            wk = vals[-5:]                       # 最近 5 個交易日
            st["hi7"], st["lo7"] = round(max(wk)), round(min(wk))
            st["spark"] = [round(v) for v in vals[-30:]]
        stats[key] = st
    return stats


def build(history, daily, health=None):
    """回傳 {headline, items[{level,text}], metals[...], week[...]}。"""
    stats = metal_stats(history, daily)
    items = []

    # 1) 資料健康最優先：資料不可信，其他建議都要打折
    if health and health.get("level") in ("red", "yellow"):
        bad = [i for i in health.get("items", []) if i.get("level") != "green"]
        names = "、".join(i["name"] for i in bad[:3])
        items.append({"level": health["level"],
                      "text": f"原料資料來源有{'紅' if health['level'] == 'red' else '黃'}燈（{names}），報價先別直接照用。"})

    for st in stats.values():
        n = st["name"]
        d, w, pos = st["day_pct"], st["d7"], st["pos"]
        if d is not None and abs(d) >= DAY_PCT:
            if d > 0:
                items.append({"level": "attention", "text": f"{n}今天漲 {d:.2f}%，今天要報價的話，確認一下是否需要加價。"})
            else:
                items.append({"level": "attention", "text": f"{n}今天跌 {abs(d):.2f}%，有要下單的原料，可以留意進貨時機。"})
        if w is not None and abs(w) >= WEEK_PCT:
            if w > 0:
                items.append({"level": "attention", "text": f"{n}近 7 天累計漲 {w:.1f}%，近期報價建議加價或縮短報價有效期。"})
            else:
                items.append({"level": "attention", "text": f"{n}近 7 天累計跌 {abs(w):.1f}%，可以考慮分批備料。"})
        if pos is not None and pos >= HIGH_POS:
            items.append({"level": "info", "text": f"{n}目前在近一年區間的 {pos}% 位置，接近高點，備料宜保守。"})
        elif pos is not None and pos <= LOW_POS:
            items.append({"level": "info", "text": f"{n}目前在近一年區間的 {pos}% 位置，接近低點，是備料的參考時機。"})

    order = {"red": 0, "yellow": 1, "attention": 2, "info": 3}
    items.sort(key=lambda i: order.get(i["level"], 9))   # 要處理的排前面，位置提醒排後面

    n_act = sum(1 for i in items if i["level"] in ("red", "yellow", "attention"))
    if n_act:
        headline = f"今天有 {n_act} 件事要注意"
    elif items:
        headline = "今天沒有需要處理的事（有行情位置的提醒，見下方）"
    else:
        headline = "今天沒有需要處理的事，行情平穩"

    week = []
    for st in stats.values():
        if st["d7"] is None:
            continue
        week.append({"name": st["name"], "d7": st["d7"], "d30": st["d30"],
                     "hi": st["hi7"], "lo": st["lo7"], "ma_gap": st["ma_gap"]})
    return {"headline": headline, "items": items, "metals": list(stats.values()), "week": week}
