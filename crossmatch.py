# -*- coding: utf-8 -*-
"""crossmatch.py — 交叉驗證篩選：經濟部工廠登記名錄 × 財政部稅籍。

取代原本「104 公司搜尋 ＋ 稅籍」的 merge 去重。兩者的差別是：

    merge（舊）  兩份名單合成一份，重複的只留一個 → 丟掉「幾個來源證實」這個資訊
    對帳（新）  以統一編號比對，保留「出現在幾個來源」→ 升級為主要判斷依據

六關篩選，門檻與代碼白名單全部放在 config.py（換客戶只需改設定）。
各關的實測數字與「為什麼這樣訂」的理由見 config.py 的註解。

    load_factory()    下載／讀取生產中工廠清冊
    factory_pool()    第一~四關：地理、代碼白名單、代碼排除、統編去重
    tax_pool()        稅籍串流讀取（保留四組行業名稱，舊版只取第一組）
    crossmatch()      第五關：統編對帳 → 三組
    tag_capability()  第六關：能力判準
    coarse_rank()     規則粗排序（工法吻合 > 距離 > 來源數）；規模不列入
    run()             跑完整條流水線，回傳 (候選 list, 統計 dict)

規則層的鐵則：本模組產出的欄位，判斷端的 AI 不得覆寫。
"""
import collections
import csv
import io
import json
import os
import re

import config
import rules       # 規則層共用判定（near_rank / categorize）

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
FACTORY_ZIP = os.path.join(CACHE_DIR, "factory_registry.zip")
FACTORY_VER = os.path.join(CACHE_DIR, "factory_version.txt")
TAX_CACHE = os.path.join(CACHE_DIR, "tax_taichung.json")

_UA = {"User-Agent": "Mozilla/5.0"}
_BAN = re.compile(r"\d{8}")
_CODE2 = re.compile(r"(\d{2})")


# ---------------------------------------------------------------------------
# 工廠登記名錄
# ---------------------------------------------------------------------------
def factory_version():
    """回傳實際 ZIP 的網址（即版本識別）。取不到回 None。

    索引檔僅 205 bytes。政府更新頻率為「不定期」，若網址與上期相同即代表
    沒有新版——此時不該回報「本月無變化」，而要回報「政府尚未發布新版」，
    否則就是在看舊資料的情況下宣稱一切正常（靜默失敗）。
    """
    import httpx

    try:
        # verify=False：ida.gov.tw 的憑證缺 Subject Key Identifier，OpenSSL 3 嚴格
        # 檢查不過（與 eip.fia.gov.tw 同一類毛病，見 tax_pool 的相同註解）。
        # 取的是公開開放資料的索引檔，關閉驗證僅為取得該公開檔案。
        idx = httpx.get(config.FACTORY_INDEX_URL, timeout=60, verify=False,
                        follow_redirects=True, headers=_UA).content
        lines = idx.decode("utf-8-sig").splitlines()
        return next(csv.reader(io.StringIO(lines[1])))[4].strip()
    except Exception as e:  # noqa: BLE001
        print(f"[crossmatch] 取索引檔失敗（無法確認版本）：{e}")
        return None


def last_version():
    try:
        return open(FACTORY_VER, encoding="utf-8").read().strip() or None
    except Exception:  # noqa: BLE001
        return None


def load_factory(refresh=False) -> list:
    """回傳工廠清冊的 dict list。有快取且未指定 refresh 時直接用快取。"""
    if not refresh and os.path.exists(FACTORY_ZIP):
        blob = open(FACTORY_ZIP, "rb").read()
        print(f"[factory] 快取 {len(blob)/1048576:.1f} MB")
    else:
        import httpx
        url = factory_version()
        if not url:
            print("[factory] 無快取且取不到索引檔")
            return []
        print(f"[factory] 下載 {url[:78]}")
        blob = httpx.get(url, timeout=300, follow_redirects=True, headers=_UA).content
        os.makedirs(CACHE_DIR, exist_ok=True)
        open(FACTORY_ZIP, "wb").write(blob)
        with open(FACTORY_VER, "w", encoding="utf-8") as f:
            f.write(url)
        print(f"[factory] 完成 {len(blob)/1048576:.1f} MB")

    try:
        z = zipfile_open(blob)
        txt = z.read(z.namelist()[0]).decode("utf-8-sig")
        return list(csv.DictReader(io.StringIO(txt)))
    except Exception as e:  # noqa: BLE001
        print(f"[factory] 解壓/解析失敗：{e}")
        return []


def zipfile_open(blob: bytes):
    import zipfile
    return zipfile.ZipFile(io.BytesIO(blob))


def _codes2(row) -> set:
    """產業類別可能有多組（如「29機械設備製造業、25金屬」）→ 取每組開頭兩碼。"""
    return set(_CODE2.findall(row.get("產業類別", "")))


def factory_pool(rows: list, whitelist: set) -> dict:
    """第一~四關。回傳 {統編: rec}。

    第四關以統編去重而非公司名：同一公司各廠共用統編（實測台積電 40 間廠），
    用公司名會算成 40 家。同統編多廠時取距離最近的那一間。
    """
    out, stat = {}, collections.Counter()
    for r in rows:
        addr = r.get("工廠地址", "")
        if config.GOV_CITY not in addr:          # 第一關：地理
            continue
        stat["城市內"] += 1
        c = _codes2(r)
        if not (c & whitelist):                  # 第二關：代碼白名單
            continue
        stat["白名單命中"] += 1
        if c & config.FACTORY_CODES_EXCLUDE:     # 第三關：代碼排除
            stat["兼營非金屬而剔除"] += 1
            continue
        ban = r.get("統一編號", "").strip()
        if not _BAN.fullmatch(ban):
            stat["無有效統編"] += 1
            continue

        area = r.get("工廠市鎮鄉村里", "") or addr
        rank = rules.near_rank(area)
        rec = {
            "ban": ban,
            "name": r.get("工廠名稱", "").strip(),
            "addr": addr,
            "area": area,
            "near": rank,
            "codes": sorted(c & whitelist),
            "product": r.get("主要產品", "").strip(),
            "industry_f": r.get("產業類別", "").strip(),
            "since": r.get("工廠登記核准日期", "").strip(),
            "org": r.get("工廠組織型態", "").strip(),
            "plants": 1,
            # 工廠負責人姓名為自然人資料，於此解析階段即排除，不進入後續流程
        }
        if ban in out:                           # 第四關：統編去重
            rec["plants"] = out[ban]["plants"] + 1
            if rank > out[ban]["near"]:
                out[ban] = rec
            else:
                out[ban]["plants"] = rec["plants"]
        else:
            out[ban] = rec
    stat["去重後"] = len(out)
    return out, stat


# ---------------------------------------------------------------------------
# 財政部稅籍（串流；讀到臺中區塊結束即停）
# ---------------------------------------------------------------------------
def tax_pool(refresh=False) -> dict:
    """回傳 {統編: rec}。rec 保留**四組**行業代號與名稱。

    舊版 suppliers._gov_row() 只取第一組（inds[0]），另外三組被浪費。
    實測：8,574 家中有 5,384 家登記 2 組以上；696 家只看第一組無法分類、
    看完四組才分類得出。
    """
    if not refresh and os.path.exists(TAX_CACHE):
        d = json.load(open(TAX_CACHE, encoding="utf-8"))
        print(f"[tax] 快取 {len(d):,} 家")
        return d

    import httpx

    out, buf, read = {}, "", 0
    header = seen = gap = 0
    rows_city = 0
    stop = False
    print("[tax] 串流下載（約 186 MB，讀到臺中區塊結束即停）…")
    try:
        # verify=False：政府網站憑證鏈在 OpenSSL 3 的嚴格檢查下不過（curl 可、httpx 不可）。
        # 這是公開開放資料檔，關閉驗證僅為取得公開 CSV。
        with httpx.stream("GET", config.GOV_CSV_URL, timeout=None, verify=False,
                          headers=_UA) as r:
            r.raise_for_status()
            for chunk in r.iter_bytes(chunk_size=1 << 16):
                read += len(chunk)
                buf += chunk.decode("utf-8", "replace")
                lines = buf.split("\n")
                buf = lines.pop()
                for line in lines:
                    if not header:
                        header = 1
                        continue
                    try:
                        f = next(csv.reader(io.StringIO(line)))
                    except Exception:  # noqa: BLE001
                        continue
                    if len(f) < 16:
                        continue
                    if config.GOV_CITY in f[0]:
                        seen, gap = 1, 0
                    elif seen:
                        gap += 1
                        continue
                    else:
                        continue

                    rows_city += 1
                    # 四組：代號在 8/10/12/14，名稱在 9/11/13/15
                    names = [f[i].strip() for i in (9, 11, 13, 15) if f[i].strip()]
                    blob = " ".join(names)
                    if not any(k in blob for k in config.GOV_METAL_KEYWORDS):
                        continue
                    if any(x in blob for x in config.GOV_EXCLUDE_WORDS):
                        continue
                    ban = f[1].strip()
                    if not _BAN.fullmatch(ban):
                        continue
                    out[ban] = {
                        "ban": ban, "name": f[3].strip(), "addr": f[0].strip(),
                        "capital": f[4].strip(), "since": f[5].strip(),
                        "org": f[6].strip(),
                        "codes": [f[i].strip() for i in (8, 10, 12, 14) if f[i].strip()],
                        "names": names,
                    }
                if seen and gap > config.GOV_END_GAP:
                    print("[tax] 臺中區塊結束，提早停止")
                    stop = True
                if read > 320 * 1048576:      # 安全閥
                    print("[tax] 達安全閥 320 MB，停止")
                    stop = True
                if stop:
                    break
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL][tax] 下載/解析失敗：{type(e).__name__}: {e}")
        return {}

    print(f"[tax] 讀 {read//1048576} MB，城市內 {rows_city:,} 列 → 金屬且未排除 {len(out):,} 家")
    os.makedirs(CACHE_DIR, exist_ok=True)
    json.dump(out, open(TAX_CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return out


# ---------------------------------------------------------------------------
# 第五關：對帳
# ---------------------------------------------------------------------------
def crossmatch(fac: dict, tax: dict) -> dict:
    """回傳三組統編集合。名單成員只可能來自工廠名錄（門檻要求有工廠登記）。"""
    return {
        "both": set(fac) & set(tax),
        "only_factory": set(fac) - set(tax),
        "only_tax": set(tax) - set(fac),
    }


# ---------------------------------------------------------------------------
# 第六關：能力判準
# ---------------------------------------------------------------------------
def tag_capability(product: str, tax_names, rules) -> list:
    """回傳命中的能力清單。rules 為 None 代表**不套第六關**（客戶雷達）。

    空 list 的兩種意義由呼叫端區分：
        rules 有值而回空  → 能力不明，第六關剔除
        rules 為 None     → 這個雷達不篩能力，一律保留
    """
    if not rules:
        return []
    blob = " ".join(tax_names) if tax_names else ""
    hits = []
    for name, rule in rules:
        if any(k in product for k in rule.get("product", [])):
            hits.append(name)
            continue
        if any(k in blob for k in rule.get("tax", [])):
            hits.append(name)
    return hits


def is_machine_builder(product: str, caps: list) -> bool:
    """只做機器（291/293）而無 254 代客加工 → 工具機廠，不是加工服務廠。

    注意：此判定只對**供應商**雷達有意義。對客戶雷達，工具機廠反而是好客戶
    （它們造機器、需要精密零件），故由呼叫端以設定決定是否套用。
    """
    if caps:
        return False
    return any(c in product for c in config.MACHINE_BUILDER_CODES)


# ---------------------------------------------------------------------------
# 規則粗排序
# ---------------------------------------------------------------------------
def coarse_score(rec, near_matters=True) -> int:
    """能力吻合 > 距離 > 來源數。**規模不列入**（使用者決定）。

    此排序不決定最終 50 家——實測最高分曾有 703 家並列，區分力不足。
    它的職責是粗篩出 AI 吃得下的量（AI_ROUND1_KEEP），最終取捨由 AI 兩輪負責。

    near_matters=False（客戶雷達）時距離不計分——客戶願意跨區下單，
    強迫鄰近只會把真正的好客戶排到後面。
    """
    s = len(rec["caps"]) * 6 + rec["sources"] * 2
    if near_matters:
        s += rec["near"] * 3
    return s


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def all_factory_bans(rows: list) -> set:
    """全國所有生產中工廠的統編（**不經任何篩選**）。

    用途：分辨「從名單消失」是歇業還是搬遷／改行業。只存篩選後名單的話
    這兩者分不出來，就會把搬遷誤報為倒閉。約 86,000 個統編、1 MB。
    """
    return {b for b in (r.get("統一編號", "").strip() for r in rows)
            if _BAN.fullmatch(b)}


def run(radar: dict, refresh=False) -> tuple:
    """跑完六關 ＋ 粗排序。回傳 (候選 list, 統計 dict, 全國統編 set)。

    radar 為 config.RADARS 裡的一段設定。**本函式沒有任何針對特定雷達的分支**
    ——所有差異（代碼白名單、要不要套第六關、要不要排除工具機廠、距離是否計分）
    全部由該設定決定。新增一個雷達只需在 config.RADARS 多一段。
    """
    whitelist = radar["codes"]
    cap_rules = radar.get("capability_rules")
    excl_mach = radar.get("exclude_machine_builders", False)
    near_matters = radar.get("near_matters", True)

    stats = {"version": factory_version(), "last_version": last_version()}
    stats["version_changed"] = (
        None if not stats["version"] else stats["version"] != stats["last_version"]
    )

    rows = load_factory(refresh)
    if not rows:
        return [], dict(stats, failed="factory"), set()
    stats["factory_total"] = len(rows)
    all_bans = all_factory_bans(rows)
    stats["all_factory_bans"] = len(all_bans)

    fac, fstat = factory_pool(rows, whitelist)
    stats.update({f"factory_{k}": v for k, v in fstat.items()})

    tax = tax_pool(refresh)
    if not tax:
        return [], dict(stats, failed="tax"), all_bans
    stats["tax_pool"] = len(tax)

    groups = crossmatch(fac, tax)
    stats.update({k: len(v) for k, v in groups.items()})

    cands, dropped_cap, dropped_mach = [], 0, 0
    for ban in groups["both"]:                 # 第五關：必須兩邊都有
        f, t = fac[ban], tax[ban]
        caps = tag_capability(f["product"], t["names"], cap_rules)
        if excl_mach and is_machine_builder(f["product"], caps):
            dropped_mach += 1
            continue
        # 第六關：只有設定了 capability_rules 的雷達才篩能力。
        # cap_rules 為 None（客戶雷達）時一律保留——代碼白名單已鎖定目標產業。
        if cap_rules and not caps:
            dropped_cap += 1
            continue
        rec = dict(f)
        rec.update({
            "caps": caps, "sources": 2,
            "tax_names": t["names"], "tax_codes": t["codes"],
            "capital": t["capital"],
            "category": rules.categorize(
                f"{f['name']} {f['industry_f']} {f['product']} {' '.join(t['names'])}"),
        })
        rec["score"] = coarse_score(rec, near_matters)
        cands.append(rec)

    stats["dropped_no_capability"] = dropped_cap
    stats["dropped_machine_builder"] = dropped_mach
    cands.sort(key=lambda x: (-x["score"], x["ban"]))
    stats["candidates"] = len(cands)
    stats["cap_counts"] = dict(collections.Counter(
        c for r in cands for c in r["caps"]))
    stats["tie_at_top"] = sum(1 for r in cands if r["score"] == cands[0]["score"]) if cands else 0
    # 回傳**完整**名單，不套 AI_ROUND1_KEEP。
    # 那個上限是模型的輸入限制，屬 ai_select 的職責——若在此截斷，
    # 快照存的就是截斷後的名單，下期排序稍有變動就會在邊界製造假的
    # 「新增」與「消失」，整個變化偵測被污染。實測 customers 曾被截掉 211 家。
    return cands, stats, all_bans
