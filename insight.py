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


def rule_facts(stats):
    """行情數字句：全部由程式計算（不經 AI），不會寫錯。"""
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
    return "".join(parts)


def news_sentence(news_tagged):
    tags = [n.get("tag") for n in (news_tagged or [])]
    if not tags:
        return ""
    up, dn = tags.count("偏多"), tags.count("偏空")
    return f"最近 {len(tags)} 則相關新聞：偏多 {up} 則、偏空 {dn} 則、中性 {len(tags) - up - dn} 則。"


def rule_summary(stats, news_tagged=None):
    """規則式白話解讀（AI 不可用時使用）。"""
    return (rule_facts(stats) + news_sentence(news_tagged)) or "目前沒有足夠的行情資料可以整理。"


def _qual(v, thr=0.3):
    """把數字轉成方向詞給 AI 看——AI 完全看不到任何行情數字，所以不可能把數字讀錯或寫錯。"""
    if v is None:
        return "不明"
    return "上漲" if v >= thr else "下跌" if v <= -thr else "持平"


def _ai_ok(text):
    """AI 說明文字的驗收：長度合理、有中文、**完全不能有數字**（數字只由程式負責）、不能是買賣建議。"""
    if not (20 <= len(text) <= 260):
        return False
    if not re.search(r"[\u4e00-\u9fff]", text):
        return False
    if re.search(r"\d", text):
        return False
    if re.search(r"建議(買|賣|進場|出場|加碼|減碼|做多|做空)|應該(買|賣)|值得(買|賣)|買進|賣出", text):
        return False
    return True


def daily_summary(stats, news_tagged=None, use_ai=True):
    """回傳 {text, source, facts, note}。

    text  = 行情數字句（程式算的）＋ 新聞面說明。source 為 'ai'（說明句由 AI 寫）或 'rule'（全規則）。
    設計理由（2026-11-05 雲端實測學到的）：讓 AI 寫含數字的解讀，它會把不同來源的數字混在一起、
    把「國際銅價下跌」誤讀成「美元走弱」，而且這些數字都在我們給它的資料裡，所以『數字有出現在資料裡』
    的檢查擋不住。所以數字一律不給 AI、也不准它寫，AI 只負責新聞面的氣氛說明。
    """
    facts = rule_facts(stats)
    fallback = {"text": rule_summary(stats, news_tagged), "source": "rule", "facts": facts, "note": ""}
    if not use_ai or not news_tagged:
        return fallback
    try:
        import ai_json
        if not ai_json.available():
            return fallback
        view = {}
        for k, v in stats.items():
            a = (v.get("attr") or {}).get("day") or {}
            view[v["name"]] = {"近一週": _qual(v.get("d7"), 1.0), "最近一個交易日": _qual(a.get("total")),
                               "近一年區間位置": "偏高" if (v.get("pos") or 0) >= 70 else "偏低" if (v.get("pos") or 100) <= 30 else "中間"}
        news = [{"標題": n.get("title", ""), "判斷": n.get("tag")} for n in news_tagged[:6]]
        system = ("你是公司內部的原料行情助理，對象是不懂金融的製造業主管。請用繁體中文（台灣用語）、白話，"
                  "寫 1 到 2 句（40 到 100 字）『新聞面與市場氣氛』說明。"
                  "規則：一、**絕對不可以出現任何阿拉伯數字或百分比**（數字由別的程式負責）；"
                  "二、只根據我提供的新聞標題與方向描述，不得編造事件；原因不確定要用『可能』；"
                  "三、不得提供買賣、投資或報價建議；四、不要重述價格數字。"
                  "只輸出 JSON：{\"note\":\"...\"}")
        res, _layer = ai_json.call(system, {"行情方向": view, "新聞": news}, temperature=0.3, max_tokens=1200)
        note = str((res or {}).get("note", "")).strip() if isinstance(res, dict) else ""
        if not _ai_ok(note):
            if note:
                print("[insight] AI 說明未通過驗收（含數字、建議字眼或長度不符），退回規則式。")
            return fallback
        text = (facts + " " + note).strip() if facts else note
        return {"text": text, "source": "ai", "facts": facts, "note": note}
    except Exception as e:  # noqa: BLE001
        print("[insight] AI 解讀失敗，使用規則式：", e)
        return fallback
