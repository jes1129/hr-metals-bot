# -*- coding: utf-8 -*-
"""diagnose_crossmatch.py — 唯讀診斷：工廠登記名錄 × 財政部稅籍 統編對帳分佈。

目的（計畫第九之二節）：在改動任何產出之前，先取得真實的家數分佈。
現行所有數字都是在 SUPPLIER_KEEP = 1500 這個人為上限之下量到的。

本腳本回答四個問題：
  1. 稅籍臺中金屬篩選後有幾筆
  2. 兩邊統編對得上幾家          ← 交叉驗證的核心指標
  3. 規則粗排序的最高分有幾家並列 ← 量化「排序區分力不足」的缺口
  4. 前 50 名實際長什麼樣        ← 檢查「規模不納入」是否讓大廠上榜

唯讀保證：不寫入 data/、不產生 HTML、不發 Discord、不呼叫 AI。
只寫 .cache/（下載快取，沿用 compare_factory_source.py 的既有做法）。

用法：
    python scripts/diagnose_crossmatch.py            # 用快取
    python scripts/diagnose_crossmatch.py --refresh  # 強制重新下載
"""
import collections
import csv
import io
import json
import os
import re
import sys
import zipfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("METALS_DATA_DIR", os.path.join(ROOT, "data"))

import config      # noqa: E402
import rules       # noqa: E402

CACHE_DIR = os.path.join(ROOT, ".cache")
FACTORY_ZIP = os.path.join(CACHE_DIR, "factory_registry.zip")
FACTORY_INDEX = "https://www.ida.gov.tw/opendata/02/SDD6569.csv"
TAX_CACHE = os.path.join(CACHE_DIR, "tax_taichung.json")

# 這兩組之後會搬進 config.py（計畫第十節），診斷階段先放這裡
SUPPLIER_CODES = {"24", "25", "29"}          # 基本金屬／金屬製品／機械設備
EXCLUDE_WORDS = ["非金屬", "塑膠", "食品", "蔬果", "橡膠"]

# 「○○有限公司二廠」的廠別後綴——本腳本改用統編去重，此處僅供顯示時清理
_PLANT_SUFFIX = re.compile(r"(第?[一二三四五六七八九十百]+|\d+)廠$")


def hr(title=""):
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


# ---------------------------------------------------------------------------
# 一、工廠登記名錄
# ---------------------------------------------------------------------------
def factory_version(refresh=False):
    """回傳 (實際檔案網址, 是否為新下載)。索引檔僅 205 bytes。"""
    import httpx

    try:
        idx = httpx.get(FACTORY_INDEX, timeout=60, follow_redirects=True).content
        lines = idx.decode("utf-8-sig").splitlines()
        row = next(csv.reader(io.StringIO(lines[1])))
        return row[4].strip()
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 取索引檔失敗（不影響診斷，僅無法確認版本）：{e}")
        return None


def load_factory(refresh=False) -> list:
    if not refresh and os.path.exists(FACTORY_ZIP):
        print(f"[factory] 使用快取 {os.path.getsize(FACTORY_ZIP)/1048576:.1f} MB")
        blob = open(FACTORY_ZIP, "rb").read()
    else:
        import httpx
        url = factory_version()
        if not url:
            sys.exit("[fatal] 無快取且取不到索引檔，無法繼續")
        print(f"[factory] 下載 {url[:80]}")
        blob = httpx.get(url, timeout=300, follow_redirects=True).content
        os.makedirs(CACHE_DIR, exist_ok=True)
        open(FACTORY_ZIP, "wb").write(blob)
        print(f"[factory] 完成 {len(blob)/1048576:.1f} MB")

    z = zipfile.ZipFile(io.BytesIO(blob))
    name = z.namelist()[0]
    txt = z.read(name).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(txt)))
    print(f"[factory] 檔內 {name}，共 {len(rows):,} 筆")
    return rows


def factory_codes(row) -> set:
    """產業類別可能有多組，抓每一組開頭兩碼。"""
    return {m.group(1) for m in re.finditer(r"(\d{2})", row.get("產業類別", ""))}


def factory_filter(rows) -> dict:
    """臺中 × 供應商代碼 → {統編: dict}。同統編多廠時取最近的那一間。"""
    out = {}
    dropped_no_ban = 0
    for r in rows:
        addr = r.get("工廠地址", "")
        if config.GOV_CITY not in addr:
            continue
        if not (factory_codes(r) & SUPPLIER_CODES):
            continue
        ban = r.get("統一編號", "").strip()
        if not re.fullmatch(r"\d{8}", ban):
            dropped_no_ban += 1
            continue
        area = r.get("工廠市鎮鄉村里", "") or addr
        rank = rules.near_rank(area)
        rec = {
            "ban": ban,
            "name": _PLANT_SUFFIX.sub("", r.get("工廠名稱", "").strip()),
            "addr": addr,
            "area": area,
            "codes": sorted(factory_codes(r) & SUPPLIER_CODES),
            "product": r.get("主要產品", "").strip(),
            "industry_f": r.get("產業類別", "").strip(),
            "since": r.get("工廠登記核准日期", "").strip(),
            "org": r.get("工廠組織型態", "").strip(),
            "near": rank,
            "plants": 1,
        }
        if ban in out:
            out[ban]["plants"] += 1
            if rank > out[ban]["near"]:      # 取最近的那一間
                rec["plants"] = out[ban]["plants"]
                out[ban] = rec
        else:
            out[ban] = rec
    if dropped_no_ban:
        print(f"[factory] 無有效統編而略過：{dropped_no_ban} 筆")
    return out


# ---------------------------------------------------------------------------
# 二、財政部稅籍（串流，讀到臺中區塊結束即停）
# ---------------------------------------------------------------------------
def load_tax(refresh=False) -> dict:
    if not refresh and os.path.exists(TAX_CACHE):
        d = json.load(open(TAX_CACHE, encoding="utf-8"))
        print(f"[tax] 使用快取 {len(d):,} 筆")
        return d

    import httpx

    out, buf, read = {}, "", 0
    seen_tc = gap = 0
    header = False
    stop = False
    kept_raw = 0
    print("[tax] 開始串流下載（約 186 MB，讀到臺中區塊結束即停）…")
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
                    if not header:
                        header = True
                        continue
                    try:
                        f = next(csv.reader(io.StringIO(line)))
                    except Exception:  # noqa: BLE001
                        continue
                    if len(f) < 16:
                        continue
                    if config.GOV_CITY in f[0]:
                        seen_tc = 1
                        gap = 0
                    elif seen_tc:
                        gap += 1
                        continue
                    else:
                        continue

                    kept_raw += 1
                    # 四組行業代號與名稱：代號在 8/10/12/14，名稱在 9/11/13/15
                    codes = [f[i].strip() for i in (8, 10, 12, 14) if f[i].strip()]
                    names = [f[i].strip() for i in (9, 11, 13, 15) if f[i].strip()]
                    blob = " ".join(names)
                    if not any(k in blob for k in config.GOV_METAL_KEYWORDS):
                        continue
                    if any(x in blob for x in EXCLUDE_WORDS):
                        continue
                    ban = f[1].strip()
                    if not re.fullmatch(r"\d{8}", ban):
                        continue
                    out[ban] = {
                        "ban": ban, "name": f[3].strip(), "addr": f[0].strip(),
                        "capital": f[4].strip(), "since": f[5].strip(),
                        "org": f[6].strip(), "codes": codes, "names": names,
                    }
                if seen_tc and gap > config.GOV_END_GAP:
                    print("[tax] 臺中區塊結束，提早停止")
                    stop = True
                if read > 320 * 1048576:      # 安全閥
                    print("[tax] 達安全閥 320 MB，停止")
                    stop = True
                if stop:
                    break
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] 稅籍下載/解析失敗：{type(e).__name__}: {e}")
        return {}

    print(f"[tax] 讀 {read//1048576} MB，臺中列 {kept_raw:,} 筆 → 金屬且未排除 {len(out):,} 家")
    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump(out, open(TAX_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return out


# ---------------------------------------------------------------------------
# 三、對帳 + 粗排序
# ---------------------------------------------------------------------------
def coarse_score(rec) -> int:
    """規則粗排序：工法吻合度(最高) > 距離 > 來源數。規模不納入。"""
    cat = rec["category"]
    fit = 6 if cat != "其他金屬加工" else 0        # 工法吻合
    return fit + rec["near"] * 3 + rec["sources"] * 2


def main():
    refresh = "--refresh" in sys.argv

    fac_raw = load_factory(refresh)
    fac = factory_filter(fac_raw)
    hr("一、母體")
    print(f"  工廠名錄全國生產中          {len(fac_raw):>8,}")
    print(f"  臺中 × 供應商類(24/25/29)   {len(fac):>8,}  （已依統編去重）")
    multi = sum(1 for v in fac.values() if v["plants"] > 1)
    print(f"    其中同統編多廠者          {multi:>8,}")

    tax = load_tax(refresh)
    if not tax:
        hr("執行中止")
        print("  稅籍取得失敗，無法進行對帳。請回報此訊息。")
        return 1
    print(f"  稅籍臺中 × 金屬（已排除）   {len(tax):>8,}")

    # --- 對帳 ---
    both = set(fac) & set(tax)
    only_f = set(fac) - set(tax)
    only_t = set(tax) - set(fac)
    hr("二、統編對帳（交叉驗證核心指標）")
    tot = len(fac | tax.keys())
    for label, s in (("兩邊都有", both), ("只有工廠名錄", only_f), ("只有稅籍", only_t)):
        print(f"  {label:<14} {len(s):>8,}  ({len(s)/max(tot,1)*100:5.1f}%)")
    print(f"  {'合計':<14} {tot:>8,}")

    # --- 組成候選（門檻：有工廠登記且生產中 → 只有工廠名錄有的才算）---
    cands = []
    for ban in sorted(both | only_f):
        f = fac[ban]
        t = tax.get(ban)
        names = t["names"] if t else []
        blob = f"{f['name']} {f['industry_f']} {f['product']} {' '.join(names)}"
        cands.append({
            "ban": ban, "name": f["name"], "area": f["area"], "near": f["near"],
            "product": f["product"], "tax_names": names,
            "capital": t["capital"] if t else "", "since": f["since"],
            "org": f["org"], "sources": 2 if t else 1,
            "category": rules.categorize(blob),
        })

    hr("三、門檻後（有工廠登記且生產中 ＋ 代碼白名單 ＋ 臺中）")
    print(f"  通過門檻                    {len(cands):>8,}")
    print(f"  （只有稅籍的 {len(only_t):,} 家未通過門檻——無工廠登記）")
    nearc = sum(1 for c in cands if c["near"] >= config.SUPPLIER_NEAR_THRESHOLD)
    print(f"  其中神岡＋相鄰              {nearc:>8,}")
    print(f"  其中神岡本地                {sum(1 for c in cands if c['near'] == 4):>8,}")

    hr("四、能力分類分佈（同一個 categorize()）")
    for k, v in collections.Counter(c["category"] for c in cands).most_common():
        print(f"  {k:<18} {v:>7,}")

    # --- 粗排序與並列統計 ---
    for c in cands:
        c["score"] = coarse_score(c)
    cands.sort(key=lambda x: (-x["score"], x["ban"]))
    hr("五、規則粗排序的區分力（本節是「為何需要 AI 細選」的量化依據）")
    dist = collections.Counter(c["score"] for c in cands)
    print("  分數  家數")
    for s in sorted(dist, reverse=True)[:8]:
        print(f"  {s:>4}  {dist[s]:>7,}")
    top = max(dist) if dist else 0
    print(f"\n  最高分 {top} 分有 {dist[top]:,} 家並列 → 要從中挑 50 家，規則無法區分")
    cut = cands[49]["score"] if len(cands) > 50 else None
    if cut is not None:
        tie = sum(1 for c in cands if c["score"] == cut)
        print(f"  第 50 名的分數為 {cut}，同分者共 {tie:,} 家")

    hr("六、稅籍第 2–4 組行業名稱有沒有補上工法（納入計畫的改動）")
    withtax = [c for c in cands if c["sources"] == 2 and c["tax_names"]]
    multi_n = sum(1 for c in withtax if len(c["tax_names"]) > 1)
    print(f"  兩邊都有且稅籍有行業名稱      {len(withtax):>7,}")
    print(f"  其中登記 2 組以上行業         {multi_n:>7,}  ← 現行只用第 1 組，這些被浪費")
    gain = 0
    for c in withtax:
        if len(c["tax_names"]) < 2:
            continue
        first = rules.categorize(f"{c['name']} {c['product']} {c['tax_names'][0]}")
        allc = rules.categorize(f"{c['name']} {c['product']} {' '.join(c['tax_names'])}")
        if first == "其他金屬加工" and allc != "其他金屬加工":
            gain += 1
    print(f"  只看第 1 組無法分類、看完四組才分類得出：{gain:,} 家  ← 這就是改動的實際收益")

    hr("七、稅籍行業代號 vs 工廠名錄代碼 是否同一套編碼（抽樣）")
    sample = [t for t in tax.values() if t["codes"]][:5]
    for t in sample:
        print(f"  {t['name'][:16]:18} 代號={t['codes']}  名稱={t['names'][:2]}")
    print("  → 若代號為 6 碼且前兩碼落在 24/25/29，即與工廠名錄同屬行業標準分類")

    hr("八、前 50 名（人工檢視：有沒有不合用的大廠上榜）")
    print(f"  {'':<3}{'公司名':<22}{'分類':<12}{'區':<12}{'資本額':>10}  來源")
    for i, c in enumerate(cands[:50], 1):
        area = re.sub(r"^臺中市", "", c["area"])[:10]
        print(f"  {i:<3}{c['name'][:20]:<22}{c['category']:<12}{area:<12}"
              f"{c['capital'][:10]:>10}  {c['sources']}")

    hr()
    print("（唯讀腳本：未寫入 data/、未產生 HTML、未發通知、未呼叫 AI）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
