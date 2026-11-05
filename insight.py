# -*- coding: utf-8 -*-
"""
insight.py — 新聞分類與每日行情白話解讀。

原則：先規則、AI 只負責「寫得像人話」與「讀標題判斷偏多偏空」，而且 AI 的輸出要過關才採用：
  - 沒有金鑰、呼叫失敗、輸出格式不對、解讀裡出現我們沒給它的數字 → 一律退回規則式版本，頁面照常產出。
  - 頁面會標示來源：「AI 解讀」或「自動整理」，不讓人誤以為規則式的句子是 AI 想的。
  - 只有說明行情，不給買賣建議；AI 提示詞也明確禁止。

資料來源：advice.metal_stats()（價格、漲跌、拆解）＋ run_metals 抓到的新聞標題。
"""
import re

TAGS = ("偏多", "偏空", "中性")

# 規則式關鍵字（AI 不可用時的後備；寧可判中性也不亂判）
_UP = ("上漲", "漲", "攀升", "走高", "創高", "創新高", "短缺", "吃緊", "減產", "罷工", "供應中斷", "供應緊", "需求增", "需求回溫", "庫存下降", "去庫存", "降息", "貶值")
_DOWN = ("下跌", "跌", "下挫", "走低", "重挫", "崩", "疲弱", "需求減", "需求不振", "需求放緩", "庫存增", "累庫", "過剩", "增產", "升息", "升值", "關稅")


def _rule_tag(title: str) -> str:
    up = sum(1 for k in _UP if k in title)
    dn = sum(1 for k in _DOWN if k in title)
    if up > dn:
        return "偏多"
    if dn > up:
        return "偏空"
    return "中性"


def classify_news(news, use_ai=True):
    """替每則新聞加上 tag（偏多／偏空／中性）與 tag_by（ai／rule）。回傳新的 list，不改原資料。"""
    out = [dict(n) for n in (news or [])]
    if not out:
        return out
    for n in out:
        n["tag"], n["tag_by"] = _rule_tag(n.get("title", "")), "rule"
    if not use_ai:
        return out
    try:
        import ai_json
        if not ai_json.available():
            return out
        system = ("你是原料行情分析助理。判斷每則新聞標題對「銅與鋁的價格」是偏多（可能推升價格）、偏空（可能壓低價格）或中性（無明確方向或無關）。"
                  "只根據標題字面判斷，不要臆測；不確定就判中性。"
                  "只輸出 JSON：{\"items\":[{\"i\":編號,\"tag\":\"偏多\"或\"偏空\"或\"中性\"}]}")
        payload = {"news": [{"i": i, "title": n.get("title", "")} for i, n in enumerate(out)]}
        res, _layer = ai_json.call(system, payload, temperature=0.0, max_tokens=1800)
        items = (res or {}).get("items") if isinstance(res, dict) else None
        if not isinstance(items, list):
            return out
        for it in items:
            try:
                i, tag = int(it.get("i")), str(it.get("tag"))
            except Exception:  # noqa: BLE001
                continue
            if 0 <= i < len(out) and tag in TAGS:
                out[i]["tag"], out[i]["tag_by"] = tag, "ai"
    except Exception as e:  # noqa: BLE001
        print("[insight] 新聞 AI 分類失敗，使用規則式：", e)
    return out


def _sg(v, nd=2):
    return "—" if v is None else f"{v:+.{nd}f}%"


_RELEVANT = ("銅", "鋁", "金屬", "LME", "原料", "鎳", "鋅", "鋼", "大宗", "基本金屬")


def filter_relevant(news):
    """去掉重複標題與明顯無關的新聞（至少留 3 則，否則保持原樣，不讓區塊變空）。"""
    seen, uniq = set(), []
    for n in news or []:
        t = (n.get("title") or "").strip()
        if t and t not in seen:
            seen.add(t)
            uniq.append(n)
    keep = [n for n in uniq if any(k in n["title"] for k in _RELEVANT)]
    return keep if len(keep) >= 3 else uniq


def _mmdd(d):
    return f"{d[5:7]}/{d[8:10]}" if d and len(d) >= 10 else ""


def _driver(attr):
    """一句話講出這個變動主要是國際價還是匯率。"""
    if not attr:
        return ""
    u, f = attr.get("usd"), attr.get("fx")
    if u is None or f is None:
        return ""
    if abs(u) < 0.05 and abs(f) < 0.05:
        return "國際價與匯率都幾乎沒動"
    if abs(f) < abs(u) / 3:
        return f"主要來自國際價（{_sg(u)}），匯率影響很小"
    if abs(u) < abs(f) / 3:
        return f"主要來自匯率（{_sg(f)}），國際價變動很小"
    return f"國際價 {_sg(u)}、匯率 {_sg(f)} 各占一部分"


def rule_summary(stats, news_tagged=None):
    """規則式白話解讀（AI 不可用時使用）。"""
    parts = []
    for st in stats.values():
        if st.get("price_twd") is None:
            continue
        line = f"{st['name']}目前 NT${st['price_twd']:,}／噸，近 7 天 {_sg(st.get('d7'))}"
        a = (st.get("attr") or {}).get("day")
        d = _driver(a)
        if a and a.get("total") is not None and d:
            line += f"；依日線收盤（{_mmdd(a.get('from'))}→{_mmdd(a.get('to'))}）變動 {_sg(a['total'])}，{d}"
        parts.append(line + "。")
    tags = [n.get("tag") for n in (news_tagged or [])]
    if tags:
        up, dn = tags.count("偏多"), tags.count("偏空")
        parts.append(f"最近 {len(tags)} 則相關新聞：偏多 {up} 則、偏空 {dn} 則、中性 {len(tags) - up - dn} 則。")
    return "".join(parts) or "目前沒有足夠的行情資料可以整理。"


def _allowed_numbers(stats, news):
    nums = set()
    blob = repr(stats) + repr(news)
    for m in re.findall(r"\d[\d,]*\.?\d*", blob):
        nums.add(m.replace(",", ""))
    return nums


def _numbers_ok(text, allowed):
    """AI 解讀裡凡是帶小數或 ≥100 的數字，都必須出現在我們提供的資料裡；否則視為亂編。"""
    for m in re.findall(r"\d[\d,]*\.?\d*", text):
        raw = m.replace(",", "").rstrip(".")
        if not raw:
            continue
        is_big = ("." in raw) or (float(raw) >= 100)
        if not is_big:
            continue
        if raw in allowed:
            continue
        # 允許四捨五入的差異（AI 常把 0.64 寫成 0.6、1.32 寫成 1.3）
        if any(abs(float(raw) - float(a)) <= 0.051 for a in allowed if re.fullmatch(r"-?\d+\.?\d*", a) and float(a) < 100):
            continue
        return False
    return True


def daily_summary(stats, news_tagged=None, use_ai=True):
    """回傳 {text, source}，source 為 'ai' 或 'rule'。"""
    fallback = {"text": rule_summary(stats, news_tagged), "source": "rule"}
    if not use_ai:
        return fallback
    try:
        import ai_json
        if not ai_json.available():
            return fallback
        slim = {k: {"名稱": v["name"], "現價_台幣每噸": v.get("price_twd"), "最新價相對前次更新漲跌%": v.get("day_pct"), "近7天%": v.get("d7"),
                    "近30天%": v.get("d30"), "近一年區間位置%": v.get("pos"),
                    "最近一個交易日拆解_收盤對收盤": (v.get("attr") or {}).get("day"), "近7天拆解": (v.get("attr") or {}).get("week")}
                for k, v in stats.items()}
        news = [{"標題": n.get("title", ""), "判斷": n.get("tag")} for n in (news_tagged or [])[:6]]
        system = ("你是公司內部的原料行情助理，對象是不懂金融的製造業主管。請用繁體中文（台灣用語）、白話，寫 80 到 140 字的『今日行情解讀』。"
                  "只能使用我提供的資料與數字，不得編造任何數字或事件；不得提供買賣、投資或報價建議；不確定的原因要說『可能』。"
                  "要涵蓋：銅與鋁今天的變化、變動主要來自國際價還是匯率、新聞面的大致氣氛。"
                  "只輸出 JSON：{\"summary\":\"...\"}")
        res, _layer = ai_json.call(system, {"行情": slim, "新聞": news}, temperature=0.3, max_tokens=2000)
        text = str((res or {}).get("summary", "")).strip() if isinstance(res, dict) else ""
        if not (30 <= len(text) <= 400) or not re.search(r"[一-鿿]", text):
            return fallback
        if not _numbers_ok(text, _allowed_numbers(slim, news)):
            print("[insight] AI 解讀含有未提供的數字，退回規則式。")
            return fallback
        return {"text": text, "source": "ai"}
    except Exception as e:  # noqa: BLE001
        print("[insight] AI 解讀失敗，使用規則式：", e)
        return fallback
