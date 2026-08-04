# -*- coding: utf-8 -*-
"""
customers.py — 功能 D：客戶開發雷達（找會買精密金屬零件的潛在客戶，全台）。

沿用 suppliers.py 同一套（104 公司搜尋 Playwright + 財政部稅籍開放資料 httpx 串流），
差別在關鍵字/分類/AI 角度（＝這些是九上科技的潛在客戶，怎麼開發）。
"""
import csv
import datetime
import io
import json
import os
import re

import ai
import browser
import config
import notify
import suppliers  # 複用 104 爬取原語與工具

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
CUSTOMERS_FILE = os.path.join(DATA_DIR, config.CUSTOMERS_FILE)


def categorize(blob: str) -> str:
    b = blob.lower()
    for name, kws in config.CUSTOMER_CATEGORIES:
        if any(k.lower() in b for k in kws):
            return name
    return "其他潛在客戶"


def _is_relevant(blob: str) -> bool:
    return any(k in blob for k in config.CUSTOMER_RELEVANCE)


# 製造業關鍵（政府稅籍需為「製造/生技」才是會買精密金屬零件的客戶，
# 排除運輸/維修/批發/零售/租賃等雜訊）
_MFG_HINT = ("製造", "半導體", "晶圓", "光電", "生技", "科技")


def _cust_gov_match(inds: list) -> bool:
    for ind in inds:
        if any(k in ind for k in config.CUSTOMER_GOV_KEYWORDS) and any(h in ind for h in _MFG_HINT):
            return True
    return False


# ---------------------------------------------------------------------------
# ① 104 公司搜尋（複用 suppliers 的卡片解析）
# ---------------------------------------------------------------------------
async def fetch_104() -> list:
    seen, out = set(), []
    async with browser.real_chrome(headless=True) as (page, _ctx):
        await browser.warm_up(page, "https://www.104.com.tw/")
        for kw in config.CUSTOMER_QUERIES:
            for pg in range(1, config.CUSTOMER_MAX_PAGES + 1):
                try:
                    await page.goto(suppliers._company_url(kw, pg),
                                    wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(3500)
                    for _ in range(3):
                        await page.mouse.wheel(0, 3000)
                        await page.wait_for_timeout(800)
                    cards = await page.evaluate(suppliers._COMPANY_JS)
                except Exception as e:  # noqa: BLE001
                    print(f"[customers] 104「{kw}」P{pg} 失敗：{e}")
                    continue
                new = 0
                for c in cards:
                    if c["url"] in seen:
                        continue
                    if not _is_relevant(c["name"] + " " + c["text"]):
                        continue
                    seen.add(c["url"])
                    out.append(suppliers._parse_company(c))  # source "104"
                    new += 1
                print(f"[customers] 104「{kw}」P{pg}：{len(cards)} 筆，新增相關 {new}")
                if not cards:
                    break
    return out


# ---------------------------------------------------------------------------
# ② 政府稅籍（全台，依客戶產業關鍵字過濾；讀整份檔）
# ---------------------------------------------------------------------------
def _gov_area(address: str) -> str:
    for city in suppliers._CITIES:
        if city in address:
            m = re.search(re.escape(city) + r"([一-鿿]{1,3}[區鄉鎮市])", address)
            return city.replace("臺", "台") + (m.group(1) if m else "")
    return "其他"


def fetch_gov(limit_bytes: int = None) -> list:
    import httpx

    out, buf, read = [], "", 0
    header_skipped = False
    try:
        with httpx.stream("GET", config.GOV_CSV_URL, timeout=None, verify=False,
                          headers={"User-Agent": "Mozilla/5.0"}) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes(chunk_size=1 << 16):
                read += len(chunk)
                buf += chunk.decode("utf-8", "replace")
                lines = buf.split("\n")
                buf = lines.pop()
                for line in lines:
                    if not header_skipped:
                        header_skipped = True
                        continue
                    try:
                        f = next(csv.reader(io.StringIO(line)))
                    except Exception:  # noqa: BLE001
                        continue
                    if len(f) < 10:
                        continue
                    inds = [f[i] for i in (9, 11, 13, 15) if i < len(f) and f[i]]
                    if not _cust_gov_match(inds):    # 需為目標產業「製造業」
                        continue
                    out.append({
                        "name": f[3], "ban": f[1], "area": _gov_area(f[0]),
                        "industry": inds[0] if inds else "", "capital": f[4],
                        "employees": "", "url": "", "intro": inds[0] if inds else "",
                        "address": f[0], "source": "gov",
                    })
                if len(out) >= config.GOV_HARD_CAP:
                    print("[customers] 政府列達硬上限，停止。")
                    break
                if limit_bytes and read >= limit_bytes:
                    break
    except Exception as e:  # noqa: BLE001
        print(f"[customers] 政府稅籍下載/解析失敗（略過）：{e}")
    print(f"[customers] 政府稅籍潛在客戶：{len(out)} 筆（讀 {read//1024//1024} MB）")
    return out


# ---------------------------------------------------------------------------
# 合併 / 彙整 / AI
# ---------------------------------------------------------------------------
def merge(rows_104: list, rows_gov: list) -> list:
    by_name = {}
    for r in rows_104 + rows_gov:
        key = suppliers._norm_name(r["name"])
        if not key:
            continue
        if key in by_name:
            ex = by_name[key]
            ex["url"] = ex.get("url") or r.get("url", "")
            ex["address"] = ex.get("address") or r.get("address", "")
            ex["area"] = ex.get("area") or r.get("area", "")
            ex["intro"] = ex.get("intro") or r.get("intro", "")
            if ex["source"] != r["source"]:
                ex["source"] = "both"
        else:
            by_name[key] = dict(r)
    merged = []
    for r in by_name.values():
        blob = f"{r['name']} {r.get('industry','')} {r.get('intro','')}"
        r["category"] = categorize(blob)
        w = config.CUSTOMER_SCORE                                      # 權重見 config，毋須動此處
        r["score"] = ((w["category"] if r["category"] != "其他潛在客戶" else 0)
                      + (w["url"] if r.get("url") else 0)
                      + (w["ban"] if r.get("ban") else 0))
        merged.append(r)
    merged.sort(key=lambda x: (x["score"], x["source"] == "both"), reverse=True)
    return merged


def select(merged: list) -> list:
    keep_104 = [s for s in merged if s["source"] in ("104", "both")]
    rest = [s for s in merged if s["source"] == "gov"]
    budget = max(0, config.CUSTOMER_KEEP - len(keep_104))
    return keep_104 + rest[:budget]


def aggregate(cus: list) -> dict:
    from collections import Counter
    cats = Counter(c["category"] for c in cus)
    areas = Counter(c["area"] for c in cus if c["area"])
    src = Counter(c["source"] for c in cus)
    return {
        "total": len(cus),
        "categories": cats.most_common(),
        "top_areas": areas.most_common(10),
        "sources": dict(src),
        "with_url": sum(1 for c in cus if c.get("url")),
    }


_FIELDS = ("headline", "target", "approach", "pitch", "risk")


def ai_report(stats: dict, cus: list) -> dict:
    p = config.SUPPLIER_PROFILE
    system = (
        f"你是 B2B 業務開發顧問。客戶是「{p['name']}」（{p['business']}），"
        "他們做精密金屬零件加工，想開發下游『會買精密金屬零件』的潛在客戶。\n"
        "根據提供的『台灣潛在客戶統計＋樣本（含 104 與政府稅籍）』，用繁體中文寫出"
        "具體可行動的開發建議，引用實際數字。每欄 2-3 句。\n"
        "欄位：headline（一句話總結潛在客戶概況）、target（優先鎖定哪類/哪區客戶與原因）、"
        "approach（如何切入接觸：管道、開發信重點）、pitch（對這些客戶九上科技的賣點）、"
        "risk（提醒：資料為公開推估、需查證需求真偽）。"
    )
    sample = [{"name": c["name"], "category": c["category"], "area": c["area"], "source": c["source"]}
              for c in cus[:config.AI_SAMPLE_SIZE]]
    return ai.summarize(system, {"統計": stats, "客戶樣本": sample}, _FIELDS) or _fallback(stats)


def _fallback(stats: dict) -> dict:
    cats = "、".join(f"{c}{n}" for c, n in stats["categories"][:4]) or "—"
    return {
        "headline": f"全台潛在客戶 {stats['total']} 家（會用到精密金屬零件的產業）",
        "target": f"產業分佈：{cats}。可優先鎖定光學/醫療/半導體等高精度需求者。",
        "approach": "先從有官網/104 曝光者切入（好查聯絡窗口），寄開發信＋附加工實績。",
        "pitch": "九上科技：精密車削、ISO 認證、神岡在地、可小量打樣快速交期。",
        "risk": "名單為公開資料推估，實際採購需求需電話/拜訪查證。",
    }


def save(cus: list):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CUSTOMERS_FILE, "w", encoding="utf-8") as f:
        json.dump(cus, f, ensure_ascii=False, indent=2)


async def run() -> dict:
    rows_104 = await fetch_104()
    rows_gov = fetch_gov()
    cus = select(merge(rows_104, rows_gov))
    print(f"[customers] 104 {len(rows_104)} + 政府 {len(rows_gov)} → 保留 {len(cus)} 家")
    if not cus:
        notify.send("**🎯 客戶開發雷達**\n今日未取得客戶資料。")
        return {"customers": [], "stats": None}

    stats = aggregate(cus)
    summary = ai_report(stats, cus)
    save(cus)

    import dashboard
    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "customers.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_customers_html(config.SUPPLIER_PROFILE, stats, summary, cus))
    print("[customers] 已更新 docs/customers.html")

    content = f"**🎯 客戶開發雷達 · 九上科技**（{datetime.date.today():%Y/%m/%d}）"
    notify.send_embeds(_build_embeds(stats, summary), content=content)
    return {"customers": cus, "stats": stats, "summary": summary}


def _build_embeds(stats: dict, summary: dict) -> list:
    cats = "\n".join(f"· {c}（{n}）" for c, n in stats["categories"]) or "—"
    return [
        {"title": f"🎯 {summary['headline']}"[:256], "color": 0x2C7BE5,
         "fields": [
             {"name": "🎯 優先鎖定", "value": summary["target"][:1024]},
             {"name": "📨 如何切入", "value": summary["approach"][:1024]},
             {"name": "💪 我方賣點", "value": summary["pitch"][:1024]},
             {"name": "⚠️ 提醒", "value": summary["risk"][:1024]},
         ]},
        {"title": "📊 客戶數據", "color": 0x6C757D,
         "fields": [
             {"name": "潛在客戶", "value": f"{stats['total']} 家", "inline": True},
             {"name": "有官網", "value": f"{stats['with_url']} 家", "inline": True},
             {"name": "🗂️ 產業分類", "value": cats[:1024]},
         ]},
    ]
