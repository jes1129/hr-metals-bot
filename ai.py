# -*- coding: utf-8 -*-
"""
ai.py — 共用 AI 摘要分派（market 行情、suppliers 供應商分析共用）。

自動選供應商：有 GEMINI_API_KEY → Google Gemini（免費）優先；
否則有 ANTHROPIC_API_KEY → Claude；兩者皆無回 None（由呼叫端做規則式後備）。
回傳只含 fields 指定欄位的 dict（皆字串）。
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
    gemini_key = os.environ.get(config.ENV_GEMINI_KEY)
    anthropic_key = os.environ.get(config.ENV_ANTHROPIC_KEY)
    if gemini_key:
        out = _gemini(gemini_key, system, payload, fields)
        if out:
            return out
    if anthropic_key:
        out = _anthropic(anthropic_key, system, payload, fields)
        if out:
            return out
    if not gemini_key and not anthropic_key:
        print("[ai] 未設 GEMINI_API_KEY / ANTHROPIC_API_KEY，改用規則式後備。")
    return None


def _gemini(key: str, system: str, payload: dict, fields):
    import httpx

    prompt = (
        system
        + "\n\n只輸出一個 JSON 物件，鍵為 " + " / ".join(fields)
        + "，值皆為繁體中文字串。\n\n資料：\n"
        + json.dumps(payload, ensure_ascii=False)
    )
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"{config.GEMINI_MODEL}:generateContent")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4},
    }
    try:
        r = httpx.post(url, params={"key": key}, json=body, timeout=60)
        r.raise_for_status()
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        print("[ai] 使用 Gemini。")
        return _clean(json.loads(text), fields)
    except Exception as e:  # noqa: BLE001
        print(f"[ai] Gemini 失敗：{e}{_detail(e)}")
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
