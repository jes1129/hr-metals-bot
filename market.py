# -*- coding: utf-8 -*-
"""
market.py — 功能 A（實驗版）：公開職缺行情追蹤。

流程：Playwright（+stealth，過 Cloudflare）爬 104 公開職缺搜尋
      → 解析薪資/地區/年資 → 相關性過濾 → 彙整統計 + 存快照算週熱度變化
      → Claude 產生市場行情分析 → Discord 推送每日摘要。

與未來企業版的關係（使用者需求「只換資料源」）：
  fetch_jobs() 這一層日後換成 talent.fetch_candidates()（登入人才庫）即可，
  後段「Claude 分析 → Discord 推播」完全共用。
"""
import datetime
import json
import os
import re
import statistics
import urllib.parse

import browser
import config
import notify

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")  # 與功能 B 共用同一資料夾
JOBS_FILE = os.path.join(DATA_DIR, config.JOBS_FILE)

SEARCH_BASE = "https://www.104.com.tw/jobs/search/"
HOME = "https://www.104.com.tw/"

# 台灣縣市（104 用「台」不用「臺」）
_CITIES = [
    "台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市",
    "新竹市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義市",
    "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣",
]


# ---------------------------------------------------------------------------
# 1. 爬取公開職缺（Playwright + stealth，複用 browser.real_chrome）
# ---------------------------------------------------------------------------
def _search_url(keyword: str, page: int) -> str:
    q = urllib.parse.urlencode(
        {"keyword": keyword, "order": "15", "asc": "0", "page": page, "mode": "s"}
    )
    return f"{SEARCH_BASE}?{q}"


# 在瀏覽器內把每張職缺卡片（div.info-container）取成結構化資料
_EXTRACT_JS = r"""
() => {
  const cards = Array.from(document.querySelectorAll('div.info-container'));
  return cards.map(c => {
    const job = c.querySelector('a.info-job__text, a[href*="/job/"]');
    const comp = c.querySelector('a.info-company__text, a[href*="/company/"]');
    return {
      title: job ? job.innerText.trim() : '',
      url: job ? job.href.split('?')[0] : '',
      company: comp ? comp.innerText.trim() : '',
      text: c.innerText.replace(/\s+/g, ' ').trim().slice(0, 600),
    };
  }).filter(x => x.title && x.url);
}
"""


async def fetch_jobs() -> list:
    """對每個 JOB_QUERIES 關鍵字翻頁爬取，彙整去重（依職缺網址）。回傳原始卡片 list。"""
    seen, cards = set(), []
    async with browser.real_chrome(headless=True) as (page, _ctx):
        await browser.warm_up(page, HOME)  # 首頁暖機拿 Cloudflare Cookie
        for kw in config.JOB_QUERIES:
            for pg in range(1, config.JOB_MAX_PAGES + 1):
                try:
                    await page.goto(_search_url(kw, pg),
                                    wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(3500)
                    for _ in range(3):  # 捲動觸發 lazy load
                        await page.mouse.wheel(0, 3000)
                        await page.wait_for_timeout(900)
                    batch = await page.evaluate(_EXTRACT_JS)
                except Exception as e:  # noqa: BLE001
                    print(f"[market] 抓「{kw}」第 {pg} 頁失敗：{e}")
                    continue
                new = 0
                for c in batch:
                    if c["url"] in seen:
                        continue
                    seen.add(c["url"])
                    cards.append(c)
                    new += 1
                print(f"[market] 「{kw}」P{pg}：{len(batch)} 筆，新增 {new}")
                if not batch:  # 沒有更多結果就跳下一個關鍵字
                    break
    return cards


# ---------------------------------------------------------------------------
# 2. 解析 + 相關性過濾
# ---------------------------------------------------------------------------
def _parse_salary(text: str):
    """回傳 (月薪下限, 月薪上限, 類別)。面議/時薪/年薪各自標記。抓不到回 (None,None,'其他')。"""
    m = re.search(r"月薪\s*([\d,]+)\s*(?:~\s*([\d,]+))?\s*元\s*(以上)?", text)
    if m:
        low = int(m.group(1).replace(",", ""))
        if m.group(2):
            high = int(m.group(2).replace(",", ""))
        else:
            high = None if m.group(3) else low  # 「以上」→ 無上限
        return low, high, "monthly"
    m = re.search(r"年薪\s*([\d,]+)", text)
    if m:  # 年薪換算月（÷12）方便併入分布
        yearly = int(m.group(1).replace(",", ""))
        return round(yearly / 12), None, "yearly"
    if "面議" in text:
        return None, None, "面議"
    if "時薪" in text:
        return None, None, "時薪"
    return None, None, "其他"


def _parse_area(text: str) -> str:
    for city in _CITIES:
        if city in text:
            return city
    return "其他/海外"


def _parse_district(text: str) -> str:
    """台中市底下的行政區（如「大雅區」）。抓不到回「其他」。"""
    m = re.search(r"台中市([一-鿿]{1,3}區)", text)
    return m.group(1) if m else "其他"


def _is_relevant(card: dict) -> bool:
    blob = f"{card['title']} {card['company']} {card['text']}"
    return any(kw in blob for kw in config.JOB_RELEVANCE)


def _match_info(job: dict):
    """符合招募重點判定。回傳 (match_score, is_priority)。
    is_priority = 職稱本身是品管職（role 命中「標題」）且 (量測設備 或 金屬加工產業) 命中。
    role 只看標題，避免業務/助理職因描述提到品管而誤判。"""
    title = job["title"].lower()
    blob = (job["title"] + " " + job.get("desc", "") + " " + job["company"]).lower()
    role = any(k in title for k in config.RECRUIT_MATCH["role"])       # 只看標題
    equip = any(k in blob for k in config.RECRUIT_MATCH["equip"])
    industry = any(k in blob for k in config.RECRUIT_MATCH["industry"])
    district_hit = any(d in job.get("district", "") for d in config.RECRUIT_DISTRICTS)
    score = (2 if role else 0) + (2 if equip else 0) + (1 if industry else 0) + (1 if district_hit else 0)
    return score, bool(role and (equip or industry))


def parse_and_filter(cards: list) -> list:
    """解析卡片 → 剔除不相關 → 只留指定縣市 → 標記行政區與招募符合度。"""
    jobs = []
    for c in cards:
        if not _is_relevant(c):
            continue
        area = _parse_area(c["text"])
        if config.JOB_AREA_FILTER and area != config.JOB_AREA_FILTER:
            continue  # 只聚焦設定縣市（台中）
        low, high, kind = _parse_salary(c["text"])
        job = {
            "title": c["title"],
            "company": c["company"],
            "url": c["url"],
            "area": area,
            "district": _parse_district(c["text"]),
            "salary_low": low,
            "salary_high": high,
            "salary_kind": kind,
            "desc": c["text"][:200],  # 供技能/分類/符合度挖掘（不嵌前端）
        }
        job["match_score"], job["is_priority"] = _match_info(job)
        jobs.append(job)
    return jobs


# ---------------------------------------------------------------------------
# 3. 彙整統計
# ---------------------------------------------------------------------------
def _salary_mid(j: dict):
    """單筆代表薪資（有區間取中位，只有下限取下限）。面議/時薪回 None。"""
    lo, hi = j["salary_low"], j["salary_high"]
    if lo is None:
        return None
    return round((lo + hi) / 2) if hi else lo


def aggregate(jobs: list) -> dict:
    """算職缺數、薪資分布、熱門公司/地區、面議比例等。"""
    from collections import Counter

    sal = [s for s in (_salary_mid(j) for j in jobs) if s]
    companies = Counter(j["company"] for j in jobs if j["company"])
    districts = Counter(j["district"] for j in jobs)
    negotiable = sum(1 for j in jobs if j["salary_kind"] == "面議")

    stats = {
        "total": len(jobs),
        "priority_count": sum(1 for j in jobs if j.get("is_priority")),
        "salary_count": len(sal),
        "salary_min": min(sal) if sal else None,
        "salary_median": round(statistics.median(sal)) if sal else None,
        "salary_max": max(sal) if sal else None,
        "salary_avg": round(statistics.mean(sal)) if sal else None,
        "negotiable": negotiable,
        "top_companies": companies.most_common(5),
        "top_districts": districts.most_common(8),
        "district_salary": _district_salary(jobs),
        "categories": _categorize(jobs),
        "skills": _skill_freq(jobs),
    }
    return stats


def _district_salary(jobs: list) -> list:
    """各行政區月薪中位數（有可解析薪資、且該區樣本 >= 2）。回傳 [(district, median, n)]。"""
    from collections import defaultdict

    bucket = defaultdict(list)
    for j in jobs:
        v = _salary_mid(j)
        if v:
            bucket[j["district"]].append(v)
    rows = [(a, round(statistics.median(vs)), len(vs)) for a, vs in bucket.items() if len(vs) >= 2]
    rows.sort(key=lambda x: x[1], reverse=True)
    return rows[:8]


def _categorize(jobs: list) -> list:
    """依標題關鍵字歸類職務。回傳 [(label, count)]（含「其他」，去零、由多到少）。"""
    from collections import Counter

    cnt = Counter()
    for j in jobs:
        t = j["title"].lower()
        label = "其他"
        for name, kws in config.JOB_CATEGORIES:
            if any(k.lower() in t for k in kws):
                label = name
                break
        cnt[label] += 1
    return cnt.most_common()


def _skill_freq(jobs: list) -> list:
    """技能詞頻（比對標題 + 描述）。回傳前 12 名 [(skill, count)]。"""
    from collections import Counter

    cnt = Counter()
    for j in jobs:
        blob = (j["title"] + " " + j.get("desc", "")).lower()
        for skill in config.JOB_SKILLS:
            if skill.lower() in blob:
                cnt[skill] += 1
    return cnt.most_common(12)


# ---------------------------------------------------------------------------
# 4. 歷史快照（存 data/jobs.json，供週熱度變化）
# ---------------------------------------------------------------------------
def load_history() -> list:
    if not os.path.exists(JOBS_FILE):
        return []
    try:
        with open(JOBS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return []


def save_snapshot(history: list, stats: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    snap = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "total": stats["total"],
        "salary_median": stats["salary_median"],
        "salary_avg": stats["salary_avg"],
    }
    history.append(snap)
    with open(JOBS_FILE, "w", encoding="utf-8") as f:
        json.dump(history[-90:], f, ensure_ascii=False, indent=2)  # 最多留 90 筆


def _delta(history: list, stats: dict) -> dict:
    """與上一筆快照比較職缺數與薪資中位數變化。"""
    if not history:
        return {"total": None, "salary_median": None}
    prev = history[-1]
    d = {}
    for k in ("total", "salary_median"):
        cur, old = stats[k], prev.get(k)
        d[k] = (cur - old) if (cur is not None and old is not None) else None
    return d


# ---------------------------------------------------------------------------
# 5. AI 產生市場行情分析（共用 ai.summarize：Gemini 免費優先 → Claude → 後備）
# ---------------------------------------------------------------------------
_SUMMARY_FIELDS = ("headline", "salary", "demand", "skills", "advice")


def _summary_system() -> str:
    p = config.RECRUIT_PROFILE
    return (
        "你是台灣製造業的人資與薪酬顧問。以下是一個實際招募案，請針對它做分析：\n"
        f"・職缺：{p['role']}\n・產業：{p['industry']}\n・地區：{p['region']}\n"
        f"・設備技能：{p['equipment']}\n・經歷要求：{p['experience']}\n・現況：{p['context']}\n\n"
        "根據提供的『104 台中公開職缺統計 + 樣本』，用繁體中文寫出針對此招募案、"
        "具體可行動的分析。數字要引用實際統計；不要空泛。每欄 2-3 句即可。\n"
        "欄位：headline（一句話總結台中金屬加工品管人才市場）、"
        "salary（薪資行情與對標：這案品管職該開多少才有競爭力）、"
        "demand（供給熱度：哪些行政區、多少同類職缺在搶人）、"
        "skills（對症技能：2.5D 量測／品管相關，雇主普遍怎麼開條件）、"
        "advice（給這個招募案的具體建議）。"
    )


def _summary_payload(stats: dict, jobs: list) -> dict:
    sample = [
        {"title": j["title"], "company": j["company"],
         "area": j["area"], "salary_low": j["salary_low"], "salary_high": j["salary_high"]}
        for j in jobs[:40]
    ]
    return {"統計": stats, "職缺樣本": sample}


def ai_market_summary(stats: dict, jobs: list) -> dict:
    """行情分析：共用 ai.summarize（Gemini 免費優先 → Claude），皆無或失敗則純統計後備。"""
    import ai

    out = ai.summarize(_summary_system(), _summary_payload(stats, jobs), _SUMMARY_FIELDS)
    return out or _fallback_summary(stats)


def _fallback_summary(stats: dict) -> dict:
    """沒有 API 金鑰或呼叫失敗時的純統計摘要，確保仍有內容可推。"""
    med = f"{stats['salary_median']:,}" if stats["salary_median"] else "—"
    top = "、".join(c for c, _ in stats["top_companies"][:3]) or "—"
    return {
        "headline": f"台中金屬加工/品管相關公開職缺 {stats['total']} 筆，符合招募重點 {stats.get('priority_count', 0)} 筆",
        "salary": f"可解析月薪的職缺中位數約 NT${med}，面議 {stats['negotiable']} 筆。",
        "demand": f"台中徵才熱區：{'、'.join(a for a, _ in stats['top_districts'][:3]) or '—'}。",
        "skills": "（未啟用 AI 分析，僅提供統計數據）",
        "advice": f"目前釋出較多職缺的公司：{top}。",
    }


# ---------------------------------------------------------------------------
# 6. Discord 推播（複用 notify.send_embeds）
# ---------------------------------------------------------------------------
def _fmt_delta(v, unit=""):
    if v is None:
        return ""
    if v > 0:
        return f"（▲{v:,}{unit}）"
    if v < 0:
        return f"（▼{abs(v):,}{unit}）"
    return "（持平）"


def build_embeds(stats: dict, summary: dict, delta: dict, jobs: list) -> list:
    """一張行情分析主卡 + 一張數據卡。"""
    med = f"NT${stats['salary_median']:,}" if stats["salary_median"] else "—"
    avg = f"NT${stats['salary_avg']:,}" if stats["salary_avg"] else "—"
    rng = (
        f"NT${stats['salary_min']:,} ~ NT${stats['salary_max']:,}"
        if stats["salary_min"] else "—"
    )
    companies = "\n".join(f"· {c}（{n} 筆）" for c, n in stats["top_companies"]) or "—"
    areas = "、".join(f"{a} {n}" for a, n in stats["top_districts"]) or "—"

    main = {
        "title": f"🔧 台中品管招募雷達 · {summary['headline']}"[:256],
        "color": 0x2C7BE5,
        "fields": [
            {"name": "💰 薪資行情", "value": summary["salary"][:1024]},
            {"name": "📈 需求趨勢", "value": summary["demand"][:1024]},
            {"name": "🛠️ 雇主要的技能", "value": summary["skills"][:1024]},
            {"name": "💡 招募建議", "value": summary["advice"][:1024]},
        ],
    }
    data = {
        "title": "📊 今日數據",
        "color": 0x6C757D,
        "fields": [
            {"name": "職缺總數（台中）",
             "value": f"{stats['total']} 筆{_fmt_delta(delta['total'])}", "inline": True},
            {"name": "⭐ 符合招募重點", "value": f"{stats.get('priority_count', 0)} 筆", "inline": True},
            {"name": "面議", "value": f"{stats['negotiable']} 筆", "inline": True},
            {"name": "月薪中位數",
             "value": f"{med}{_fmt_delta(delta['salary_median'])}", "inline": True},
            {"name": "月薪平均", "value": avg, "inline": True},
            {"name": "月薪區間", "value": rng, "inline": True},
            {"name": "🏢 徵才較多的公司", "value": companies[:1024]},
            {"name": "📍 台中徵才熱區", "value": areas[:1024]},
        ],
    }
    return [main, data]


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
async def run() -> dict:
    cards = await fetch_jobs()
    jobs = parse_and_filter(cards)
    print(f"[market] 原始 {len(cards)} 筆 → 相關 {len(jobs)} 筆")
    if not jobs:
        notify.send("**🔧 金屬加工人才行情**\n今日未抓到相關公開職缺（可能被 Cloudflare 擋或關鍵字無結果）。")
        return {"jobs": [], "stats": None}

    stats = aggregate(jobs)
    history = load_history()
    delta = _delta(history, stats)
    summary = ai_market_summary(stats, jobs)
    save_snapshot(history, stats)  # history 追加今日 → 供走勢圖含今日

    # 產生網頁儀表板到 docs/jobs.html（與銅鋁 index.html 同一個 GitHub Pages）
    import dashboard  # 延遲匯入，避免無關流程也載入
    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "jobs.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_jobs_html(stats, summary, jobs, history, delta))
    print("[market] 已更新 docs/jobs.html")

    content = f"**🔧 台中・金屬加工・品管招募雷達**（{datetime.date.today():%Y/%m/%d}）"
    notify.send_embeds(build_embeds(stats, summary, delta, jobs), content=content)
    print(f"[market] 已推送：職缺 {stats['total']} 筆")
    return {"jobs": jobs, "stats": stats, "summary": summary}
