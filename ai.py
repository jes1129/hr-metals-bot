# -*- coding: utf-8 -*-
"""
ai.py — 共用 AI 摘要分派（market 行情、suppliers 供應商分析共用）。

判斷端三層降級鏈：
  第一層 ANTHROPIC_API_KEY → Claude（品質最佳，付費）
  第二層 GROQ_API_KEY      → Groq（免費額度模型）
  第三層                    → 回 None，由呼叫端做規則式後備
三層共用同一份輸出契約：回傳只含 fields 指定欄位的 dict（皆字串）。
"""
import json
import os

import config


def _clean(data: dict, fields) -> dict:
    return {k: str(data.get(k, "")).strip() for k in fields}


def _detail(exc) -> str:
    """把 HTTP 回應內容一併記下——只印狀態碼的話，配額類型（每分鐘限流／
    當日用盡／免費層關閉）會看不出來，降級成因就只能事後猜。"""
    resp = getattr(exc, "response", None)
    if resp is None:
        return ""
    try:
        return " ｜ 回應：" + resp.text[:300].replace("\n", " ")
    except Exception:  # noqa: BLE001
        return ""


def summarize(system: str, payload: dict, fields):
    """system＝角色/任務說明；payload＝資料 dict；fields＝要求的輸出欄位名。"""
    anthropic_key = os.environ.get(config.ENV_ANTHROPIC_KEY)
    groq_key = os.environ.get(config.ENV_GROQ_KEY)
    if anthropic_key:  # 第一層：Claude（付費）
        out = _anthropic(anthropic_key, system, payload, fields)
        if out:
            return out
    if groq_key:  # 第二層：Groq（免費額度）
        out = _groq(groq_key, system, payload, fields)
        if out:
            return out
    # 無論是「未設金鑰」或「設了但呼叫失敗」，一律留下降級紀錄——否則事後
    # 只能從產物裡的「（未啟用 AI）」標記反推，日誌上看不出降級發生過。
    print("[ai] 前兩層皆不可用，改用第三層規則式後備。")
    return None


def _groq(key: str, system: str, payload: dict, fields):
    """Groq（OpenAI 相容介面）。免費額度寬鬆，作為第二層——第一層 Claude 無金鑰或失敗時接手。"""
    import httpx

    instruction = (
        system
        + "\n\n只輸出一個 JSON 物件，鍵為 " + " / ".join(fields)
        + "，值皆為字串。**務必使用繁體中文（台灣用語），不得出現簡體字。**"
    )
    try:
        r = httpx.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": config.GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": instruction},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.4,
            },
            timeout=60,
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
        print(f"[ai] 使用 Groq（{config.GROQ_MODEL}）。")
        return _clean(json.loads(text), fields)
    except Exception as e:  # noqa: BLE001
        print(f"[ai] Groq 失敗：{e}{_detail(e)}")
        return None


def _anthropic(key: str, system: str, payload: dict, fields):
    import anthropic

    schema = {
        "type": "object",
        "properties": {f: {"type": "string"} for f in fields},
        "required": list(fields),
        "additionalProperties": False,
    }
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=config.AI_MODEL,
            max_tokens=1500,
            system=system,
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        text = next(b.text for b in resp.content if b.type == "text")
        print("[ai] 使用 Claude。")
        return _clean(json.loads(text), fields)
    except Exception as e:  # noqa: BLE001
        print(f"[ai] Claude 失敗：{e}{_detail(e)}")
        return None
