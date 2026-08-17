# -*- coding: utf-8 -*-
"""snapshot.py — 狀態留存與變化偵測（CDRA 的第四元素）。

為什麼需要這個模組
------------------
「生產中工廠清冊」實測 100,634 筆中有 100,625 筆狀態為「生產中」——
**歇業的工廠根本不在檔案裡**。所以：

    單一份快照只能回答「現在誰在」，永遠無法回答「誰不見了」。
    而「我的協力廠倒了」只能由第二種資訊得知。

實作方式：以版本控制作為狀態留存機制。每次執行寫檔並 commit，每個 commit
即一份快照，免費、免伺服器、天生具備完整歷史。原始檔（約 192 MB）跑完即丟。

每期存三份
----------
    篩選後名單    完整欄位，下期比對的基準
    全國統編清單  約 1 MB，用來分辨「歇業」與「搬遷／改行業」
    規則指紋      篩選條件；規則變了則變化數字不可比

介面
----
    load_previous()   讀上期的三份快照
    save()            寫本期的三份快照
    diff()            比對 → 新增／消失（分兩種）／資料變完整
    rules_fingerprint()  目前的篩選規則指紋
"""
import json
import os

import config

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")


def _path(template: str, agent: str):
    """檔名必須帶代理人名稱。兩個雷達若共用同一組檔名會互相覆蓋——實測後果是
    跑完客戶雷達，供應商的比對基準就被蓋掉，下期變化偵測全錯。
    """
    return os.path.join(DATA_DIR, template.format(agent=agent))


def _read(template: str, agent: str, default):
    try:
        with open(_path(template, agent), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


# ---------------------------------------------------------------------------
# 規則指紋
# ---------------------------------------------------------------------------
def rules_fingerprint(radar: dict) -> dict:
    """本期使用的篩選條件。規則變了，變化數字就與上期不可比。

    不記這個的話，改一次白名單就會憑空「新增」數千家，而系統會把它
    當成真實變化報出去——這與本專案要消除的靜默失敗屬同一類問題。

    指紋必須涵蓋**所有會改變結果的設定**，包含要不要套第六關、
    要不要排除工具機廠、距離是否計分——漏記任何一項都會讓比對失真。
    """
    caps = radar.get("capability_rules")
    return {
        "city": config.GOV_CITY,
        "whitelist": sorted(radar["codes"]),
        "exclude_codes": sorted(config.FACTORY_CODES_EXCLUDE),
        "capabilities": [name for name, _ in caps] if caps else None,
        "exclude_machine_builders": bool(radar.get("exclude_machine_builders")),
        "near_matters": bool(radar.get("near_matters", True)),
        "machine_builder_codes": sorted(config.MACHINE_BUILDER_CODES),
        "gov_exclude_words": sorted(config.GOV_EXCLUDE_WORDS),
        "near_threshold": config.SUPPLIER_NEAR_THRESHOLD,
    }


# ---------------------------------------------------------------------------
# 讀寫
# ---------------------------------------------------------------------------
def load_previous(agent: str) -> dict:
    """讀上期快照。首次執行時三者皆為空，diff() 會據此判定「無基準」。"""
    return {
        "list": _read(config.SNAP_LIST_FILE, agent, None),
        "bans": set(_read(config.SNAP_BANS_FILE, agent, []) or []),
        "rules": _read(config.SNAP_RULES_FILE, agent, None),
    }


def save(agent: str, cands: list, all_bans, rules: dict, version=None):
    """寫本期三份快照。all_bans 為全國工廠統編（不經篩選）。"""
    os.makedirs(DATA_DIR, exist_ok=True)

    # 名單只留下期比對需要的欄位，避免檔案無謂膨脹
    slim = [{
        "ban": c["ban"], "name": c["name"], "area": c["area"],
        "near": c["near"], "caps": c["caps"], "category": c["category"],
        "score": c["score"], "capital": c.get("capital", ""),
        "product": c.get("product", ""),
    } for c in cands]
    with open(_path(config.SNAP_LIST_FILE, agent), "w", encoding="utf-8") as f:
        json.dump(slim, f, ensure_ascii=False, indent=1)

    with open(_path(config.SNAP_BANS_FILE, agent), "w", encoding="utf-8") as f:
        json.dump(sorted(all_bans), f, ensure_ascii=False)

    with open(_path(config.SNAP_RULES_FILE, agent), "w", encoding="utf-8") as f:
        json.dump({"rules": rules, "version": version}, f,
                  ensure_ascii=False, indent=1)


# ---------------------------------------------------------------------------
# 比對
# ---------------------------------------------------------------------------
def diff(prev: dict, cands: list, all_bans, rules: dict,
         version=None, version_changed=None) -> dict:
    """比對上期與本期。回傳可直接餵給儀表板與推播的結構。

    comparable=False 的三種情形，各有不同的輸出訊息——**不可一律顯示
    「本月無變化」**，那會在看舊資料的情況下宣稱一切正常：
        無上期快照      首次執行
        政府未發布新版  比對的是同一份檔案，變化必然為零
        篩選規則已變更  數字與上期不可比
    """
    out = {
        "comparable": False, "reason": "", "new": [], "gone_closed": [],
        "gone_moved": [], "improved": [], "partner_alerts": [],
        "total": len(cands), "prev_total": len(prev["list"] or []),
    }

    if prev["list"] is None:
        out["reason"] = "首次執行，尚無上期快照可比對"
        return out
    if version_changed is False:
        out["reason"] = "政府尚未發布新版資料，無法比對變化"
        return out
    if prev["rules"] and prev["rules"].get("rules") != rules:
        out["reason"] = "本期篩選規則已變更，變化數字與上期不可比"
        return out

    out["comparable"] = True
    prev_by = {r["ban"]: r for r in prev["list"]}
    curr_by = {c["ban"]: c for c in cands}
    partners = set(config.CURRENT_PARTNERS)

    for ban, c in curr_by.items():
        if ban not in prev_by:
            out["new"].append({
                "ban": ban, "name": c["name"], "area": c["area"],
                "caps": c["caps"], "near": c["near"],
            })
        else:
            p = prev_by[ban]
            gained = [x for x in c["caps"] if x not in p.get("caps", [])]
            if gained:
                out["improved"].append({
                    "ban": ban, "name": c["name"], "gained": gained,
                })

    for ban, p in prev_by.items():
        if ban in curr_by:
            continue
        # 關鍵區分：查全國清單決定是「歇業」還是「搬遷／改行業」
        still = ban in all_bans
        item = {"ban": ban, "name": p["name"], "area": p.get("area", ""),
                "caps": p.get("caps", [])}
        (out["gone_moved"] if still else out["gone_closed"]).append(item)

    # 現有協力廠的任何變化 → 立刻推播（其餘只寫月報）
    for kind in ("gone_closed", "gone_moved", "improved"):
        for it in out[kind]:
            if it["ban"] in partners:
                out["partner_alerts"].append(dict(it, kind=kind))

    return out


def summary_line(d: dict) -> str:
    """一行摘要，供推播與執行紀錄使用。"""
    if not d["comparable"]:
        return f"（{d['reason']}）名單 {d['total']:,} 家"
    return (f"新增 {len(d['new'])} 家｜歇業 {len(d['gone_closed'])} 家｜"
            f"搬遷或改行業 {len(d['gone_moved'])} 家｜"
            f"資料變完整 {len(d['improved'])} 家｜名單 {d['total']:,} 家")
