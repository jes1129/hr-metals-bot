# -*- coding: utf-8 -*-
"""
talent.py — 功能 A：人資找才（對應指南第 5、6 頁）。

流程：登入 104 → 爬候選人 → 每 BATCH_SIZE 位發一次 OpenRouter 請求評分
      → 過濾 score >= SCORE_THRESHOLD → 組 Markdown 推薦清單 → Discord 推送。
"""
import json
import os

import browser
import config
import notify


# ---------------------------------------------------------------------------
# 1. 從 104 人才庫抓候選人
# ---------------------------------------------------------------------------
async def fetch_candidates(account: str, password: str):
    """
    登入 104、暖機，再帶 Cookie 呼叫人才搜尋後端 API 取結構化候選人。

    回傳 list[dict]，每筆至少含：name, current_role, years, skills, summary。
    TODO(verify): 104 企業版人才搜尋的後端 API 網址、查詢參數與回傳欄位，
    需登入實際頁面用 DevTools Network 觀察後補實。
    """
    candidates = []
    async with browser.real_chrome(headless=True) as (page, _ctx):
        await browser.login_104(page, account, password)

        sp = config.SEARCH_PARAMS
        for pg in range(1, sp.get("max_pages", 1) + 1):
            # TODO(verify): 實際 API endpoint 與參數格式（以下為合理假設）
            api_url = (
                "https://pro.104.com.tw/psc/api/search"
                f"?keyword={sp.get('keyword','')}"
                f"&area={sp.get('area','')}"
                f"&jobcat={sp.get('job_category','')}"
                f"&pageSize={sp.get('page_size',40)}&page={pg}"
            )
            data = await browser.fetch_json(page, api_url)
            page_items = _extract_items(data)
            if not page_items:
                break
            candidates.extend(page_items)
    return candidates


def _extract_items(data):
    """
    從 API 回傳中取出候選人陣列並正規化欄位。
    TODO(verify): 依實際回傳 JSON 結構調整取值路徑。
    """
    if not isinstance(data, dict):
        return []
    raw = data.get("data") or data.get("list") or data.get("items") or []
    items = []
    for r in raw:
        items.append(
            {
                "id": r.get("id") or r.get("idNo") or "",
                "name": r.get("name") or r.get("cName") or "候選人",
                "current_role": r.get("jobTitle") or r.get("appJobName") or "",
                "years": r.get("workYear") or r.get("expYear") or "",
                "education": r.get("edu") or r.get("degree") or "",
                "skills": r.get("skill") or r.get("skills") or "",
                "summary": r.get("selfIntro") or r.get("summary") or "",
            }
        )
    return items


# ---------------------------------------------------------------------------
# 2. AI 評分（直連 Anthropic 官方 API，每批 BATCH_SIZE 位一次請求）
# ---------------------------------------------------------------------------
def _system_prompt() -> str:
    p = config.TALENT_PROFILE
    return (
        "你是一位資深招募顧問。請依「人才條件 profile」為每位候選人評分（1-10 分）。\n\n"
        "【人才條件 profile】\n"
        f"目標職位：{p.get('target_role','')}\n"
        f"必備技能：{'、'.join(p.get('must_have', []))}\n"
        f"加分技能：{'、'.join(p.get('nice_to_have', []))}\n"
        f"期望年資/學歷：{p.get('experience','')}\n"
        f"偏好特質：{'、'.join(p.get('preferred_traits', []))}\n"
        f"排除條件：{'、'.join(p.get('exclude', []))}\n\n"
        "【評分標準】\n"
        f"{config.SCORING_RUBRIC}\n\n"
        "為每位候選人回傳 index（對應輸入序號，從 0 起）、score（1-10 整數）、"
        "reason（匹配原因）、highlight（亮點）、risk（疑慮）。"
    )


# 結構化輸出 schema，保證回傳合法 JSON（對應指南第 5 頁的評分格式）
_SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "score": {"type": "integer"},
                    "reason": {"type": "string"},
                    "highlight": {"type": "string"},
                    "risk": {"type": "string"},
                },
                "required": ["index", "score", "reason", "highlight", "risk"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scores"],
    "additionalProperties": False,
}


def score_batch(batch: list) -> list:
    """對一批候選人請求評分，回傳與 batch 對齊的評分 dict list。

    目前直連 Anthropic 官方 API（只用 Claude，最單純穩定）。
    未來若要改回 OpenRouter 轉接、或讓多家模型（GPT/Gemini）各評一次比對，
    只需替換本函式內的呼叫，其餘流程（_align_scores、門檻過濾、推送）不用動。
    """
    api_key = os.environ.get(config.ENV_ANTHROPIC_KEY)
    if not api_key:
        print("[talent] 缺少 ANTHROPIC_API_KEY，略過 AI 評分。")
        return [{"index": i, "score": 0, "reason": "未評分", "highlight": "", "risk": ""}
                for i in range(len(batch))]

    import anthropic  # 延遲匯入（本地可能未裝）

    client = anthropic.Anthropic(api_key=api_key)
    user_payload = json.dumps(
        [{"index": i, **c} for i, c in enumerate(batch)], ensure_ascii=False
    )
    try:
        resp = client.messages.create(
            model=config.AI_MODEL,
            max_tokens=4096,
            system=_system_prompt(),
            messages=[{"role": "user", "content": f"候選人清單：\n{user_payload}"}],
            output_config={"format": {"type": "json_schema", "schema": _SCORE_SCHEMA}},
        )
        text = next(b.text for b in resp.content if b.type == "text")
        arr = json.loads(text).get("scores", [])
        return _align_scores(arr, len(batch))
    except Exception as e:  # noqa: BLE001
        print(f"[talent] Anthropic 評分失敗：{e}")
        return [{"index": i, "score": 0, "reason": "評分失敗", "highlight": "", "risk": ""}
                for i in range(len(batch))]


def _align_scores(arr: list, n: int) -> list:
    """把模型回傳依 index 對齊回 batch 順序，缺漏補 0 分。"""
    by_index = {int(a.get("index", i)): a for i, a in enumerate(arr)}
    return [by_index.get(i, {"index": i, "score": 0, "reason": "", "highlight": "", "risk": ""})
            for i in range(n)]


# ---------------------------------------------------------------------------
# 3. 組 Discord embed 卡片並推送（每位候選人一張，依分數上色）
# ---------------------------------------------------------------------------
def _field(v) -> str:
    """Discord field value 需非空且 <= 1024 字。"""
    s = str(v or "").strip()
    return (s[:1024] or "—")


def _score_color(score: int) -> int:
    if score >= 10:
        return 0xF1C40F  # 滿分金
    if score >= 9:
        return 0x27AE60  # 深綠
    return 0x2ECC71      # 綠


def build_embeds(scored: list) -> list:
    """scored: list[(candidate, score_dict)]，已過門檻並排序 → Discord embed list。"""
    embeds = []
    for c, s in scored:
        embeds.append(
            {
                "title": f"⭐ {s['score']}/10 · {_field(c['name'])}"[:256],
                "color": _score_color(s.get("score", 0)),
                "fields": [
                    {"name": "現職 / 年資",
                     "value": f"{_field(c['current_role'])}｜{_field(c['years'])}"[:1024]},
                    {"name": "匹配原因", "value": _field(s.get("reason"))},
                    {"name": "亮點", "value": _field(s.get("highlight"))},
                    {"name": "疑慮", "value": _field(s.get("risk"))},
                ],
            }
        )
    return embeds


async def run(account: str, password: str) -> str:
    """功能 A 主流程。回傳推送內容（供測試/記錄）。"""
    candidates = await fetch_candidates(account, password)
    print(f"[talent] 取得候選人 {len(candidates)} 位")
    if not candidates:
        return ""

    scored = []
    for i in range(0, len(candidates), config.BATCH_SIZE):
        batch = candidates[i : i + config.BATCH_SIZE]
        for c, s in zip(batch, score_batch(batch)):
            scored.append((c, s))

    passed = [(c, s) for c, s in scored if s.get("score", 0) >= config.SCORE_THRESHOLD]
    passed.sort(key=lambda x: x[1].get("score", 0), reverse=True)
    print(f"[talent] {config.SCORE_THRESHOLD} 分以上：{len(passed)} 位")

    if not passed:
        notify.send("**📋 今日人才推薦**\n今日無達標候選人。")
        return ""

    content = f"**📋 今日人才推薦**（{len(passed)} 位 · {config.SCORE_THRESHOLD} 分以上）"
    notify.send_embeds(build_embeds(passed), content=content)
    return content
