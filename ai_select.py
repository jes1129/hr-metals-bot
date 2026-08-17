# -*- coding: utf-8 -*-
"""ai_select.py — 判斷端：AI 兩輪篩選（從約 1,400 家挑出前 50 家）。

為什麼要兩輪
------------
規則粗排序只有三項（能力吻合／距離／來源數），實測**最高分曾有 703 家並列**，
不足以決定「哪 50 家」。此缺口由 AI 補上，並藉此把 AI 從「解釋者」升級為
「判斷者」——它真的在決定結果，不是事後配旁白。

    規則：門檻 → 粗排序 → 約 1,400 家     ← 確定性，每次都跑
        ↓ 第一輪：快速二分，只回統編清單
      約 200 家
        ↓ 第二輪：細排序 ＋ 理由 ＋ 推工法 ＋ 解釋矛盾
      前 50 家

為什麼第一道篩必須由規則做（三個理由，任一皆足以否決「AI 直接篩全部」）
------------------------------------------------------------------------
1. **資料量是硬牆**：全部 12,959 家約需 50–100 萬 tokens，
   免費層上限 12.8 萬，差一個數量級。
2. **變動偵測需要確定性基準**：若篩選結果每期浮動，「少了 50 家」就分不出
   是真的消失還是模型判斷不同，狀態留存整個失效。
3. **平常不跑的程式碼會腐爛**：若規則只在 AI 失效時執行，一年跑不到一次，
   等真正需要它的那天才會發現它早就壞了。第三層可信的前提正是它每次都在跑。

三層的分工
----------
    第一、二層  決定「答得多好」
    第三層      決定「會不會有答案」——而無人值守的系統，存亡比品質重要

第三層（內建備援）不是例外處理，是**主要路徑**：名單、家數、可信度、距離、
本月變化全部完整保留，只有「前 50 家怎麼挑」退回規則粗排序。
"""
import config
import ai_json
import prompts


def _slim(rec: dict, full=False) -> dict:
    """送進模型的欄位——只給判斷所需，控制 token 量。

    ★ 中文的 token 密度約為一字一 token，比英文差 3–4 倍。
      第一輪精簡後每家約 120 tokens；第二輪給完整欄位約 300 tokens。
      實測教訓：一次送 1,409 家（未精簡）被回 context_length_exceeded。
    """
    if not full:
        # 第一輪只判斷「相關／不相關」，用不到地區、資本額、設立年份
        return {
            "ban": rec["ban"],
            "name": rec["name"][:14],
            "caps": rec.get("caps", []),
            "product": rec.get("product", "")[:18],
            "tax": [n[:16] for n in rec.get("tax_names", [])[:2]],
        }
    return {
        "ban": rec["ban"],
        "name": rec["name"][:24],
        "caps": rec.get("caps", []),
        "area": rec.get("area", "")[:14],
        "product": rec.get("product", "")[:40],
        "tax": [n[:24] for n in rec.get("tax_names", [])[:4]],
        "capital": rec.get("capital", ""),
        "since": rec.get("since", ""),
        "org": rec.get("org", ""),
        "near": rec.get("near"),
    }


# ---------------------------------------------------------------------------
# 第一輪：快速二分
# ---------------------------------------------------------------------------
def round1(profile: dict, radar: dict, cands: list, keep_to: int, run=None) -> tuple:
    """分批快速二分。回傳 (保留的候選 list, layer)。全批皆失敗才回 (None, None)。

    上限 AI_ROUND1_KEEP 在此套用（依規則粗排序取前段）——這是**模型的輸入
    限制**，不該影響名單本身。若在 crossmatch 就截斷，快照存的會是截斷後的
    名單，下期在邊界製造假的「新增／消失」。

    **必須分批**：一次送 1,409 家實測被回 context_length_exceeded（中文的
    token 密度約為英文的 3–4 倍）。

    單批失敗的處理：**保留該批全部**。第一輪的職責是「剔除明顯不相關」，
    模型做不到時就不剔除——寧可多留給第二輪處理，也不要因一個請求失敗
    而丟掉整條 AI 路徑。降級會記入執行紀錄。
    """
    if len(cands) > config.AI_ROUND1_KEEP:
        print(f"[ai_select] 候選 {len(cands):,} 家超過第一輪上限，"
              f"取粗排序前 {config.AI_ROUND1_KEEP:,} 家")
        cands = cands[:config.AI_ROUND1_KEEP]

    system = prompts.radar_screen_system(profile, radar)
    batch = max(config.AI_ROUND1_BATCH, 1)
    kept, layer, failed = [], None, 0
    total_batches = (len(cands) + batch - 1) // batch

    for i in range(0, len(cands), batch):
        chunk = cands[i:i + batch]
        no = i // batch + 1
        out, l = ai_json.call(system, {"候選廠商": [_slim(c) for c in chunk]},
                              max_tokens=4000)
        if not out or not isinstance(out.get("keep"), list):
            failed += 1
            kept.extend(chunk)          # 剔不掉就不剔——保留該批全部
            print(f"[ai_select] 第一輪第 {no}/{total_batches} 批失敗 → 該批全數保留")
            continue
        layer = layer or l
        by_ban = {c["ban"]: c for c in chunk}
        # 模型只可能「挑選」，不可能「新增」——不在輸入清單中的統編一律丟棄
        picked = [by_ban[b] for b in out["keep"] if b in by_ban]
        kept.extend(picked)
        print(f"[ai_select] 第一輪第 {no}/{total_batches} 批："
              f"{len(chunk)} → {len(picked)} 家（{l}）")

    if failed == total_batches:
        print("[ai_select] 第一輪全批失敗 → 視為失敗")
        return None, None
    if failed and run:
        run.degrade("第一輪部分批次失敗", f"{failed}/{total_batches} 批未經 AI 篩選")

    # 若保留數超過第二輪容量，依規則粗排序取前段
    kept.sort(key=lambda x: (-x.get("score", 0), x["ban"]))
    print(f"[ai_select] 第一輪合計：{len(cands):,} → {len(kept):,} 家"
          f"（{total_batches - failed}/{total_batches} 批成功）")
    return kept[:keep_to], layer


# ---------------------------------------------------------------------------
# 第二輪：細緻排序
# ---------------------------------------------------------------------------
def round2(profile: dict, radar: dict, cands: list, top_n: int, hard=False) -> tuple:
    """回傳 (排序後的 list, layer)。hard=True 走難度分流（直接送付費層）。"""
    payload = {"候選廠商": [_slim(c, full=True) for c in cands]}
    system = prompts.radar_rank_system(profile, radar, top_n)
    fn = ai_json.call_paid_first if hard else ai_json.call
    out, layer = fn(system, payload, max_tokens=8000)
    if not out or not isinstance(out.get("ranked"), list):
        return None, None

    by_ban = {c["ban"]: c for c in cands}
    ranked = []
    for item in out["ranked"]:
        rec = by_ban.get(str(item.get("ban", "")))
        if not rec:
            continue                      # 捏造的統編一律丟棄
        reason = str(item.get("reason", "")).strip()
        if not reason:
            continue                      # 無理由者不採用（可溯源要求）
        r = dict(rec)
        r["ai_score"] = item.get("score")
        r["ai_reason"] = reason
        r["ai_processes"] = str(item.get("processes", "")).strip()
        r["ai_conflict"] = str(item.get("conflict", "")).strip()
        ranked.append(r)
    if not ranked:
        print("[ai_select] 第二輪無有效結果 → 視為失敗")
        return None, None
    print(f"[ai_select] 第二輪：{len(cands):,} → {len(ranked):,} 家（{layer}）")
    return ranked[:top_n], layer


# ---------------------------------------------------------------------------
# 驗證層（第三軸：輸出品質）
# ---------------------------------------------------------------------------
def verify(ranked: list, top_n: int) -> tuple:
    """檢查 AI 的理由是否有資料依據。回傳 (通過的 list, 被剔除數)。

    捏造「這家會做電鍍」的代價很高——主管會照著打電話。故採可溯源要求：
    理由中必須出現輸入資料實際存在的字串片段，否則剔除該筆。

    這是本機的確定性檢查，不呼叫模型；`prompts.verify_system()` 的模型驗證
    留給評語型輸出使用（那種沒有可比對的原始欄位）。
    """
    ok, dropped = [], 0
    for r in ranked:
        haystack = " ".join([r.get("name", ""), r.get("product", ""),
                             " ".join(r.get("tax_names", [])),
                             r.get("area", "")] + r.get("caps", []))
        reason = r.get("ai_reason", "")
        # 理由中至少要引用一個實際存在的片段（取 4 字以上的連續片段比對）
        cited = any(haystack.find(reason[i:i + 4]) >= 0
                    for i in range(0, max(len(reason) - 3, 0)))
        if cited:
            ok.append(r)
        else:
            dropped += 1
    if dropped:
        print(f"[ai_select] 驗證層剔除 {dropped} 筆（理由無資料依據）")
    return ok[:top_n], dropped


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def select(profile: dict, radar: dict, cands: list, top_n=None, run=None) -> tuple:
    """回傳 (最終前 N 家, layer)。layer 為 "rule" / "free" / "paid"。

    任一輪失敗即整體降級為 "rule"（規則粗排序取前 N），
    因為部分套用 AI 會讓「這份名單是怎麼來的」變得說不清楚。
    """
    top_n = top_n or config.DASHBOARD_TOP

    def fallback(why):
        if run:
            run.degrade("AI 兩輪篩選", why)
        print(f"[ai_select] 降級至內建備援：{why}")
        return cands[:top_n], "rule"

    if not ai_json.available():
        return fallback("兩層皆未設定金鑰")
    if len(cands) <= top_n:
        return fallback(f"候選僅 {len(cands)} 家，未超過 {top_n}，無需 AI 取捨")

    kept, l1 = round1(profile, radar, cands, config.AI_ROUND2_KEEP, run=run)
    if kept is None:
        return fallback("第一輪（快速二分）全批失敗")

    # 難度分流：第一輪收斂比例異常低 → 資訊模糊，直接送付費層
    hard = len(kept) < config.AI_ROUND2_KEEP * 0.3
    ranked, l2 = round2(profile, radar, kept, top_n, hard=hard)
    if ranked is None:
        return fallback("第二輪（細緻排序）失敗")

    ranked, dropped = verify(ranked, top_n)
    if not ranked:
        return fallback("驗證層剔除全部結果")
    if run and dropped:
        run.degrade("部分 AI 結果未通過驗證", f"剔除 {dropped} 筆")

    # 若 AI 給的不足 top_n，用規則排序補齊（補齊者不帶 ai_reason）
    if len(ranked) < top_n:
        have = {r["ban"] for r in ranked}
        ranked += [c for c in cands if c["ban"] not in have][:top_n - len(ranked)]

    return ranked[:top_n], (l2 or l1)
