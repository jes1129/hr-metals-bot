# -*- coding: utf-8 -*-
"""ai_json.py — 回傳任意 JSON 形狀的模型呼叫（供兩輪篩選使用）。

為什麼不直接改 ai.py
--------------------
`ai.summarize()` 的契約是「輸出固定欄位的 dict」，適合評語那種形態。
兩輪篩選需要的是**陣列**：第一輪回統編清單、第二輪回每家一筆評分與理由。
故另立一條路徑，`ai.py` 完全不動——舊流程零風險。

三層降級鏈與 `ai.summarize()` 相同，但多兩件事：

  1. **回報用了哪一層**。現行前端看不出降級發生過（靜默降級），
     回報層級才能把它變成透明降級。
  2. **難度分流**：`call_paid_first()` 讓困難或重要的案件直接送付費層。
     理由是「答得出來」不等於「答對」——弱模型面對困難案例不會拒答，
     會產出看似合理但錯誤的答案，而純可用性分層只檢查「有無回應」。
"""
import json
import os

import config

_JSON_ONLY = "\n\n只輸出 JSON，不要任何說明文字，不要程式碼框。"


def _detail(exc, model=None) -> str:
    """把回應內容與模型名稱一併記下。

    只印狀態碼的話，降級成因只能事後猜。而模型名稱特別重要——實測
    2026-08-17 遇到 Groq 回 404，原因是 llama-3.3-70b-versatile 已下架；
    若日誌沒印模型名，這個 404 會被誤判為網址或金鑰問題。
    """
    bits = []
    if model:
        bits.append(f"模型={model}")
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            body = (resp.text or "").strip()
            bits.append("回應=" + (body[:300].replace("\n", " ") if body else "（空）"))
        except Exception:  # noqa: BLE001
            bits.append("回應=無法讀取")
    return ("　｜　" + "；".join(bits)) if bits else ""


# ---------------------------------------------------------------------------
# 三層降級鏈
# ---------------------------------------------------------------------------
def call(system: str, payload: dict, temperature=0.0, max_tokens=4000):
    """成本優先：免費層 → 付費層 → (None, None)。回傳 (parsed, layer)。"""
    gk = os.environ.get(config.ENV_GROQ_KEY)
    ak = os.environ.get(config.ENV_ANTHROPIC_KEY)
    if gk:
        out = _groq(gk, system, payload, temperature, max_tokens)
        if out is not None:
            return out, "free"
    if ak:
        out = _anthropic(ak, system, payload, temperature, max_tokens)
        if out is not None:
            return out, "paid"
    print("[ai_json] 前兩層皆不可用 → 由呼叫端走內建備援。")
    return None, None


def call_paid_first(system: str, payload: dict, temperature=0.0, max_tokens=4000):
    """難度分流：困難或重要的案件直接送最強的模型，付費層不可用才降回免費層。"""
    ak = os.environ.get(config.ENV_ANTHROPIC_KEY)
    gk = os.environ.get(config.ENV_GROQ_KEY)
    if ak:
        out = _anthropic(ak, system, payload, temperature, max_tokens)
        if out is not None:
            return out, "paid"
    if gk:
        out = _groq(gk, system, payload, temperature, max_tokens)
        if out is not None:
            return out, "free"
    print("[ai_json] 前兩層皆不可用 → 由呼叫端走內建備援。")
    return None, None


def available() -> bool:
    """兩層是否至少有一層有金鑰。供呼叫端決定要不要直接走內建備援。"""
    return bool(os.environ.get(config.ENV_GROQ_KEY)
                or os.environ.get(config.ENV_ANTHROPIC_KEY))


# ---------------------------------------------------------------------------
# 第一層：Groq（免費額度）
# ---------------------------------------------------------------------------
def _groq(key, system, payload, temperature, max_tokens):
    import httpx

    try:
        r = httpx.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": "Bearer " + key},
            json={
                "model": config.GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system + _JSON_ONLY},
                    {"role": "user",
                     "content": json.dumps(payload, ensure_ascii=False)},
                ],
                "response_format": {"type": "json_object"},
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
            timeout=180,
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
        print("[ai_json] 使用 Groq（" + config.GROQ_MODEL + "）。")
        return json.loads(text)
    except Exception as e:  # noqa: BLE001
        print("[ai_json] Groq 失敗：" + str(e) + _detail(e, config.GROQ_MODEL))
        return None


# ---------------------------------------------------------------------------
# 第二層：Claude（付費）
# ---------------------------------------------------------------------------
def _anthropic(key, system, payload, temperature, max_tokens):
    import anthropic

    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model=config.AI_MODEL,
            max_tokens=max_tokens,
            system=system + _JSON_ONLY,
            messages=[{"role": "user",
                       "content": json.dumps(payload, ensure_ascii=False)}],
        )
        text = next(b.text for b in resp.content if b.type == "text").strip()
        if text.startswith("```"):          # 保險：去掉程式碼框
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
        print("[ai_json] 使用 Claude。")
        return json.loads(text)
    except Exception as e:  # noqa: BLE001
        print("[ai_json] Claude 失敗：" + str(e) + _detail(e, config.AI_MODEL))
        return None
