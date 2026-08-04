# -*- coding: utf-8 -*-
"""
suppliers.py — 功能 C：供應商雷達（幫九上科技找金屬加工供應商）。

來源：
  ① 104 公司搜尋（Playwright+stealth 發掘；有簡介/規模/連結）
  ② 財政部營業稅籍開放資料（下載整份 CSV，串流篩臺中+金屬；補齊小型加工廠）
流程：fetch_104 + fetch_gov → 合併去重 → 分能力類別/算鄰近 → 彙整 → AI 推薦
      → 存 data/suppliers.json → 產 docs/suppliers.html → Discord。
"""
import csv
import datetime
import io
import json
import os
import re
import urllib.parse

import browser
import config
import notify

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
SUPPLIERS_FILE = os.path.join(DATA_DIR, config.SUPPLIERS_FILE)

_CITIES = [
    "台北市", "臺北市", "新北市", "桃園市", "台中市", "臺中市", "台南市", "臺南市",
    "高雄市", "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣",
    "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "臺東縣",
    "澎湖縣", "金門縣", "連江縣",
]


# ---------------------------------------------------------------------------
# 分類 / 鄰近 / 相關性（104 與政府共用）
# ---------------------------------------------------------------------------
def categorize(blob: str) -> str:
    b = blob.lower()
    for name, kws in config.SUPPLIER_CATEGORIES:
        if any(k.lower() in b for k in kws):
            return name
    return "其他金屬加工"


def is_relevant(blob: str) -> bool:
    return any(k in blob for k in config.SUPPLIER_RELEVANCE)


def near_rank(location: str) -> int:
    """越近排越前：神岡本地=4、相鄰近區=3、其他台中=2、全台其他=1。"""
    if config.SUPPLIER_NEAR["home"] in location:
        return 4
    if any(d in location for d in config.SUPPLIER_NEAR["adjacent"]):
        return 3
    if "台中" in location or "臺中" in location:
        return 2
    return 1


def _norm_name(name: str) -> str:
    """公司名正規化（去法人字尾/空白）供跨來源去重。"""
    n = re.sub(r"\s+", "", name or "")
    n = re.sub(r"(股份有限公司|有限公司|企業社|工業社|實業|企業|工廠|公司)$", "", n)
    return n


# ---------------------------------------------------------------------------
# ① 104 公司搜尋
# ---------------------------------------------------------------------------
_COMPANY_JS = r"""
() => {
  const conts = Array.from(document.querySelectorAll('.company-list__info, [class*="company-list__info"]'));
  const out = [];
  for (const c of conts) {
    const a = c.querySelector('a[href*="/company/"]');
    if (!a || !a.innerText.trim()) continue;
    out.push({
      name: a.innerText.trim().slice(0, 40),
      url: a.href.split('?')[0],
      text: c.innerText.replace(/\s+/g, ' ').trim().slice(0, 500),
    });
  }
  return out;
}
"""


def _company_url(kw: str, page: int) -> str:
    q = urllib.parse.urlencode({"keyword": kw, "page": page})
    return f"https://www.104.com.tw/company/search/?{q}"


def _parse_company(card: dict) -> dict:
    text = card["text"]
    # 地區（縣市 + 區）
    area = ""
    m = re.search("(" + "|".join(_CITIES) + r")([一-鿿]{1,3}[區鄉鎮市])?", text)
    if m:
        area = m.group(1) + (m.group(2) or "")
    industry = ""
    mi = re.search(r"([一-鿿]{2,14}業)資本額", text) or re.search(r"[區鄉鎮市]([一-鿿]{2,14}業)", text)
    if mi:
        industry = mi.group(1)
        # {2,14} 為貪婪匹配，且字元範圍涵蓋「台中市龍井區」等字，故可能把地區一併吃進來
        # （如「台中市龍井區鋼鐵基本工業」）。逐級比對 area 的後綴，命中即剝除還原純行業別。
        for i in range(len(area)):
            if industry.startswith(area[i:]):
                industry = industry[len(area) - i:]
                break
    cap = ""
    mc = re.search(r"資本額([0-9][0-9,\.]*\s*[億萬]?)", text)
    if mc:
        cap = mc.group(1).replace(" ", "")
    emp = ""
    me = re.search(r"員工數([0-9,]+)人", text)
    if me:
        emp = me.group(1)
    return {
        "name": card["name"], "url": card["url"], "area": area,
        "industry": industry, "capital": cap, "employees": emp,
        "intro": industry or text[:60], "source": "104",
    }


async def fetch_104() -> list:
    seen, out = set(), []
    async with browser.real_chrome(headless=True) as (page, _ctx):
        await browser.warm_up(page, "https://www.104.com.tw/")
        for kw in config.SUPPLIER_QUERIES:
            for pg in range(1, config.SUPPLIER_MAX_PAGES + 1):
                try:
                    await page.goto(_company_url(kw, pg),
                                    wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(3500)
                    for _ in range(3):
                        await page.mouse.wheel(0, 3000)
                        await page.wait_for_timeout(800)
                    cards = await page.evaluate(_COMPANY_JS)
                except Exception as e:  # noqa: BLE001
                    print(f"[suppliers] 104「{kw}」P{pg} 失敗：{e}")
                    continue
                new = 0
                for c in cards:
                    if c["url"] in seen:
                        continue
                    blob = c["name"] + " " + c["text"]
                    if not is_relevant(blob):
                        continue
                    seen.add(c["url"])
                    out.append(_parse_company(c))
                    new += 1
                print(f"[suppliers] 104「{kw}」P{pg}：{len(cards)} 筆，新增相關 {new}")
                if not cards:
                    break
    return out


# ---------------------------------------------------------------------------
# ② 財政部營業稅籍開放資料（下載整份 CSV，串流篩臺中+金屬）
# ---------------------------------------------------------------------------
def _gov_row(fields: list):
    """稅籍 CSV 一列 → 供應商 dict（不符回 None）。
    欄位序：0地址 1統編 2總機構 3名稱 4資本額 5設立 6組織 7發票 8行業代號 9名稱 ...(1..3)。"""
    if len(fields) < 10:
        return None
    address, ban, name = fields[0], fields[1], fields[3]
    if config.GOV_CITY not in address:
        return None
    inds = [fields[i] for i in (9, 11, 13, 15) if i < len(fields) and fields[i]]
    if not any(any(k in ind for k in config.GOV_METAL_KEYWORDS) for ind in inds):
        return None
    md = re.search(r"[臺台]中市([一-鿿]{1,3}區)", address)
    district = md.group(1) if md else ""
    return {
        "name": name, "ban": ban, "area": "台中市" + district,
        "industry": inds[0] if inds else "", "capital": fields[4],
        "employees": "", "url": "", "intro": inds[0] if inds else "",
        "address": address, "source": "gov",
    }


def fetch_gov(limit_bytes: int = None) -> list:
    """下載政府稅籍 CSV 串流過濾。limit_bytes 供本機抽樣測試用。"""
    import httpx

    out, buf, read = [], "", 0
    header_skipped = False
    seen_tc = False   # 是否已進入臺中區塊
    gap = 0           # 進入臺中後、連續非臺中列數（用來判斷區塊結束）
    stop = False
    try:
        # verify=False：政府網站憑證鏈有 OpenSSL 3 嚴格檢查不過的問題（curl 可、httpx 不可）。
        # 這是公開開放資料檔（無敏感資料），關閉驗證僅為取得公開 CSV，可接受。
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
                        fields = next(csv.reader(io.StringIO(line)))
                    except Exception:  # noqa: BLE001
                        continue
                    if fields and config.GOV_CITY in fields[0]:
                        seen_tc = True
                        gap = 0
                    elif seen_tc:
                        gap += 1
                    row = _gov_row(fields)
                    if row:
                        out.append(row)
                if len(out) >= config.GOV_HARD_CAP:
                    print("[suppliers] 政府列達硬上限，停止。")
                    stop = True
                if seen_tc and gap > config.GOV_END_GAP:
                    print("[suppliers] 臺中區塊結束，提早停止下載。")
                    stop = True
                if limit_bytes and read >= limit_bytes:
                    stop = True
                if stop:
                    break
    except Exception as e:  # noqa: BLE001
        print(f"[suppliers] 政府稅籍下載/解析失敗（略過）：{e}")
    print(f"[suppliers] 政府稅籍臺中金屬：{len(out)} 筆（讀 {read//1024//1024} MB）")
    return out


# ---------------------------------------------------------------------------
# 合併 / 彙整
# ---------------------------------------------------------------------------
def merge(rows_104: list, rows_gov: list) -> list:
    by_name = {}
    for r in rows_104 + rows_gov:
        key = _norm_name(r["name"])
        if not key:
            continue
        if key in by_name:
            ex = by_name[key]
            # 欄位互補：url 取 104、address 取 gov、其餘取有值者
            ex["url"] = ex.get("url") or r.get("url", "")
            ex["address"] = ex.get("address") or r.get("address", "")
            ex["area"] = ex.get("area") or r.get("area", "")
            ex["capital"] = ex.get("capital") or r.get("capital", "")
            ex["intro"] = ex.get("intro") or r.get("intro", "")
            if ex["source"] != r["source"]:
                ex["source"] = "both"
        else:
            by_name[key] = dict(r)

    merged = []
    for r in by_name.values():
        blob = f"{r['name']} {r.get('industry','')} {r.get('intro','')}"
        r["category"] = categorize(blob)
        r["near"] = near_rank(r.get("area", "") + r.get("address", ""))
        r["is_near"] = r["near"] >= 3  # 神岡本地或相鄰 → 神岡周邊
        w = config.SUPPLIER_SCORE                                      # 權重見 config，毋須動此處
        r["score"] = (r["near"] * w["near"]                            # 越近分越高（神岡最高）
                      + (w["category"] if r["category"] != "其他金屬加工" else 0)
                      + (w["url"] if r.get("url") else 0)
                      + (w["ban"] if r.get("ban") else 0))
        merged.append(r)
    merged.sort(key=lambda x: (x["score"], x["source"] == "both"), reverse=True)
    return merged


def select(merged: list) -> list:
    """最終保留：所有 104（含 both，全台且可聯絡）＋ 依 score 補政府（神岡周邊優先），上限 SUPPLIER_KEEP。"""
    keep_104 = [s for s in merged if s["source"] in ("104", "both")]
    rest = [s for s in merged if s["source"] == "gov"]  # 已依 score 排序
    budget = max(0, config.SUPPLIER_KEEP - len(keep_104))
    return keep_104 + rest[:budget]


def aggregate(sup: list) -> dict:
    from collections import Counter

    cats = Counter(s["category"] for s in sup)
    areas = Counter(s["area"] for s in sup if s["area"])
    src = Counter(s["source"] for s in sup)
    return {
        "total": len(sup),
        "near_count": sum(1 for s in sup if s["is_near"]),
        "categories": cats.most_common(),
        "top_areas": areas.most_common(10),
        "sources": dict(src),
        "with_url": sum(1 for s in sup if s.get("url")),
    }


# ---------------------------------------------------------------------------
# AI 推薦（共用 ai.summarize）
# ---------------------------------------------------------------------------
_FIELDS = ("headline", "recommend", "evaluate", "quote", "risk")


def ai_report(stats: dict, sup: list) -> dict:
    import ai

    p = config.SUPPLIER_PROFILE
    system = (
        f"你是採購與供應鏈顧問。客戶是「{p['name']}」（{p['address']}，{p['business']}）。"
        f"他們要找的供應商能力：{'、'.join(p['needs'])}。\n"
        "根據提供的『台灣金屬加工供應商統計＋樣本（含 104 與政府稅籍）』，"
        "用繁體中文寫出針對此客戶、具體可行動的分析，引用實際數字。每欄 2-3 句。\n"
        "欄位：headline（一句話總結供應商供給概況與鄰近性）、"
        "recommend（優先推薦哪類/哪區供應商與原因）、"
        "evaluate（評估供應商該看哪些點：能力、規模、認證、距離）、"
        "quote（詢價/打樣要注意什麼、如何快速比價）、"
        "risk（風險與提醒：資料侷限、需實地查核等）。"
    )
    sample = [
        {"name": s["name"], "category": s["category"], "area": s["area"],
         "capital": s.get("capital", ""), "source": s["source"]}
        for s in sup[:config.AI_SAMPLE_SIZE]
    ]
    out = ai.summarize(system, {"統計": stats, "供應商樣本": sample}, _FIELDS)
    return out or _fallback(stats)


def _fallback(stats: dict) -> dict:
    cats = "、".join(f"{c}{n}" for c, n in stats["categories"][:4]) or "—"
    return {
        "headline": f"台灣金屬加工供應商 {stats['total']} 家，神岡周邊 {stats['near_count']} 家",
        "recommend": f"可優先接觸神岡周邊 {stats['near_count']} 家（距離近、溝通打樣快）。",
        "evaluate": f"能力分佈：{cats}。評估看能力類別、規模（資本額）、認證與距離。",
        "quote": "（未啟用 AI）建議一次向 3-5 家同類供應商發詢價/打樣比較。",
        "risk": "名單源自公開資料，實際產能/品質/認證需電話與實地查核。",
    }


# ---------------------------------------------------------------------------
# 存檔 / 主流程
# ---------------------------------------------------------------------------
def save(sup: list):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SUPPLIERS_FILE, "w", encoding="utf-8") as f:
        json.dump(sup, f, ensure_ascii=False, indent=2)


async def run() -> dict:
    rows_104 = await fetch_104()
    rows_gov = fetch_gov()
    sup = select(merge(rows_104, rows_gov))  # 全 104 + 神岡周邊優先的政府，上限 SUPPLIER_KEEP
    print(f"[suppliers] 104 {len(rows_104)} + 政府 {len(rows_gov)} → 合併保留 {len(sup)} 家")
    if not sup:
        notify.send("**🏭 供應商雷達**\n今日未取得供應商資料（104 被擋或政府檔下載失敗）。")
        return {"suppliers": [], "stats": None}

    stats = aggregate(sup)
    summary = ai_report(stats, sup)
    save(sup)

    import dashboard
    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "suppliers.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_suppliers_html(config.SUPPLIER_PROFILE, stats, summary, sup))
    print("[suppliers] 已更新 docs/suppliers.html")

    content = f"**🏭 供應商雷達 · 九上科技**（{datetime.date.today():%Y/%m/%d}）"
    notify.send_embeds(_build_embeds(stats, summary), content=content)
    return {"suppliers": sup, "stats": stats, "summary": summary}


def _build_embeds(stats: dict, summary: dict) -> list:
    cats = "\n".join(f"· {c}（{n}）" for c, n in stats["categories"]) or "—"
    return [
        {"title": f"🏭 {summary['headline']}"[:256], "color": 0x2C7BE5,
         "fields": [
             {"name": "🎯 優先推薦", "value": summary["recommend"][:1024]},
             {"name": "🔍 評估重點", "value": summary["evaluate"][:1024]},
             {"name": "💬 詢價/打樣", "value": summary["quote"][:1024]},
             {"name": "⚠️ 風險提醒", "value": summary["risk"][:1024]},
         ]},
        {"title": "📊 供應商數據", "color": 0x6C757D,
         "fields": [
             {"name": "供應商總數", "value": f"{stats['total']} 家", "inline": True},
             {"name": "⭐ 神岡周邊", "value": f"{stats['near_count']} 家", "inline": True},
             {"name": "來源", "value": "、".join(f"{k} {v}" for k, v in stats["sources"].items()), "inline": True},
             {"name": "🗂️ 能力類別", "value": cats[:1024]},
         ]},
    ]
