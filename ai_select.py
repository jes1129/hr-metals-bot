# -*- coding: utf-8 -*-
"""ai_select.py — 判斷端：AI 對候選評分並排序。

處理量由免費層的速率額度決定，不是由設計偏好決定
--------------------------------------------------
額度是拿金鑰實測撞出來的（`scripts/probe_free_models.py`），不是查文件得知：

    2026-08-17  Groq   413：tokens per minute (TPM): Limit 8000 → 每批僅 15 家
    2026-08-17  Gemini gemini-3.6-flash 每批 50 家、50/50 全評、13,600 tokens

瓶頸不是上下文長度，而是**每分鐘額度**，而且兩家差了三倍以上。
故每批幾家、要不要等，一律問 `ai_json.plan()`——這裡不假設用的是哪一家。

  ✗ 原設想「AI 從 1,409 家挑 50」在任一免費層都塞不進去
  ✓ 改為「規則收斂到 AI_POOL 家 → AI 分批評分 → 全域前 N 家」

**成本前提直接限制了 AI 能承擔的職責範圍。** 若日後啟用付費層（額度高得多），
把 config.AI_POOL 調大即可放大處理量——分層設計的價值正在於此。

為什麼分批後仍能得到全域排序
----------------------------
每批都對「輸入中的每一家」評絕對分數（提示詞明定分數區間），不由模型挑選。
呼叫端合併所有批次後依分數取全域前 N——若讓每批各自挑前 N，跨批就不可比。

三層的分工
----------
    第一、二層  決定「答得多好」
    第三層      決定「會不會有答案」——無人值守的系統，存亡比品質重要

第三層（內建備援）不是例外處理，是**主要路徑**：名單、家數、可信度、距離、
本月變化全部完整保留，只有「前 N 家怎麼挑」退回規則粗排序。
"""
import time

import ai_json
import config
import prompts


def _slim(rec: dict) -> dict:
    """送進模型的欄位。

    ★ 各家的中文分詞效率差很多，同一份資料的 token 數不同（實測 10 家）：
        Gemini 3.6-flash    1,313      Groq gpt-oss-20b   1,390
        Groq compound-mini  2,976
      在額度極小的免費層，分詞效率直接換算成「能處理幾家」。
      故欄位一律裁短——每多一個字元，就少評一家。
    """
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


def _apply(chunk: list, items: list) -> list:
    """把模型回傳的評分套回候選記錄上。丟棄捏造的與無理由的。"""
    by_ban = {c["ban"]: c for c in chunk}
    out = []
    for item in items:
        rec = by_ban.get(str(item.get("ban", "")))
        if not rec:
            continue                       # 不在輸入清單中 → 捏造，丟棄
        reason = str(item.get("reason", "")).strip()
        if not reason:
            continue                       # 無理由不採用（可溯源要求）
        try:
            score = int(item.get("score"))
        except (TypeError, ValueError):
            continue
        r = dict(rec)
        r["ai_score"] = max(0, min(100, score))
        r["ai_reason"] = reason
        r["ai_processes"] = str(item.get("processes", "")).strip()
        r["ai_conflict"] = str(item.get("conflict", "")).strip()
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# 驗證層（第三軸：輸出品質）
# ---------------------------------------------------------------------------
def verify(scored: list) -> tuple:
    """檢查理由是否有資料依據。回傳 (通過的 list, 被剔除數)。

    捏造「這家會做電鍍」的代價很高——主管會照著打電話。故採可溯源要求：
    理由中必須出現輸入資料實際存在的字串片段，否則剔除該筆。

    這是本機的確定性檢查，不呼叫模型也不消耗額度。
    """
    ok, dropped = [], 0
    for r in scored:
        haystack = " ".join([r.get("name", ""), r.get("product", ""),
                             " ".join(r.get("tax_names", [])),
                             r.get("area", "")] + r.get("caps", []))
        reason = r.get("ai_reason", "")
        cited = any(reason[i:i + 4] in haystack
                    for i in range(max(len(reason) - 3, 0)))
        if cited:
            ok.append(r)
        else:
            dropped += 1
    if dropped:
        print(f"[ai_select] 驗證層剔除 {dropped} 筆（理由無資料依據）")
    return ok, dropped


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def select(profile: dict, radar: dict, cands: list, top_n=None, run=None) -> tuple:
    """回傳 (最終前 N 家, layer)。layer 為 "rule" / "free" / "paid"。"""
    top_n = top_n or config.DASHBOARD_TOP

    def fallback(why):
        if run:
            run.degrade("AI 評分", why)
        print(f"[ai_select] 降級至內建備援：{why}")
        return cands[:top_n], "rule"

    if not ai_json.available():
        return fallback("兩層皆未設定金鑰")
    if len(cands) <= top_n:
        return fallback(f"候選僅 {len(cands)} 家，未超過 {top_n}，無需 AI 取捨")

    pool = cands[:config.AI_POOL]
    system = prompts.radar_rank_system(profile, radar, top_n)

    # 批次大小是「供應商」的性質，不是全域偏好——Gemini 每批 50 家，
    # Groq 只有 15 家。寫死一個數字就只能遷就最小的那一家。
    p = ai_json.plan()
    batch = max(p["batch"], 1)
    total = (len(pool) + batch - 1) // batch
    print(f"[ai_select] 供應商 {p['provider']}：{len(pool)} 家分 {total} 批，"
          f"每批 {batch} 家，批次間隔 {p['sleep']} 秒")

    scored, layer, failed = [], None, 0
    for i in range(0, len(pool), batch):
        chunk = pool[i:i + batch]
        no = i // batch + 1
        if no > 1 and p["sleep"]:
            # 只有按分鐘計額度的供應商需要等（Groq）；Gemini 的 sleep 為 0
            print(f"[ai_select] 等待 {p['sleep']} 秒（該供應商為每分鐘額度制）…")
            time.sleep(p["sleep"])

        # max_tokens 在 Groq 會被預扣進 TPM，故上限也由供應商決定
        out, l = ai_json.call(system, {"候選廠商": [_slim(c) for c in chunk]},
                              max_tokens=p["max_tokens"])
        if not out or not isinstance(out.get("ranked"), list):
            failed += 1
            print(f"[ai_select] 第 {no}/{total} 批失敗")
            continue
        got = _apply(chunk, out["ranked"])
        scored.extend(got)
        layer = layer or l
        print(f"[ai_select] 第 {no}/{total} 批：{len(chunk)} 家 → 有效評分 {len(got)} 筆（{l}）")

    if not scored:
        return fallback(f"全部 {total} 批皆失敗或無有效評分")

    scored, dropped = verify(scored)
    if not scored:
        return fallback("驗證層剔除全部結果")
    if run and (failed or dropped):
        run.degrade("部分 AI 結果未採用",
                    f"失敗 {failed}/{total} 批；驗證剔除 {dropped} 筆")

    # 合併所有批次後才取全域前 N（每批各自挑前 N 會使跨批不可比）
    scored.sort(key=lambda x: (-x["ai_score"], -x.get("score", 0), x["ban"]))

    # 不足 top_n 時用規則排序補齊（補齊者不帶 ai_reason，前端據此不顯示理由）
    if len(scored) < top_n:
        have = {r["ban"] for r in scored}
        scored += [c for c in cands if c["ban"] not in have][:top_n - len(scored)]

    print(f"[ai_select] 完成：規則前 {len(pool)} 家 → AI 評分 → 全域前 {top_n} 家")
    return scored[:top_n], layer
