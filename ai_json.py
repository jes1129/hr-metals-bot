# -*- coding: utf-8 -*-
"""ai_json.py — 回傳任意 JSON 形狀的模型呼叫（供兩輪篩選使用）。

為什麼不直接改 ai.py
--------------------
`ai.summarize()` 的契約是「輸出固定欄位的 dict」，適合評語那種形態。
兩輪篩選需要的是**陣列**：第一輪回統編清單、第二輪回每家一筆評分與理由。
故另立一條路徑，`ai.py` 完全不動——舊流程零風險。

降級鏈與 `ai.summarize()` 相同，但多三件事：

  1. **回報用了哪一層**。現行前端看不出降級發生過（靜默降級），
     回報層級才能把它變成透明降級。
  2. **難度分流**：`call_paid_first()` 讓困難或重要的案件直接送付費層。
     理由是「答得出來」不等於「答對」——弱模型面對困難案例不會拒答，
     會產出看似合理但錯誤的答案，而純可用性分層只檢查「有無回應」。
  3. **第一層放兩個不同供應商**（Gemini → Groq），且各自有自己的處理量
     （見 `plan()`）。實測到的失效彼此獨立：Gemini 回 503「需求過高」、
     Groq 回 413「TPM 超限」——同一家的兩個模型會一起被額度擋下，
     不同家不會，這才算真的備援。
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
def _key(name) -> str:
    return os.environ.get(name) or ""


# 供應商名稱 → (環境變數, 呼叫函式, 回報的層級)
# 順序即降級順序。成本優先：兩個免費的在前，付費的在後。
_CHAIN = (
    ("gemini", config.ENV_GEMINI_KEY, "_gemini", "free"),
    ("groq", config.ENV_GROQ_KEY, "_groq", "free"),
    ("paid", config.ENV_ANTHROPIC_KEY, "_anthropic", "paid"),
)


def plan() -> dict:
    """回傳「實際會用到的那一家」的處理量設定（batch／sleep／max_tokens）。

    為什麼批次大小不能是一個全域數字：實測 Gemini 每批 50 家、Groq 每批只有
    15 家（TPM 僅 8,000）。寫成全域就只能遷就最小的那一家，等於白白浪費
    Gemini 三倍以上的處理量。故由此函式依「哪把金鑰在」決定。

    誠實限制：這是**呼叫前**的預測。若 Gemini 中途失效改用 Groq，批次大小
    已經定了，那幾批就會超出 Groq 的額度而失敗——但那幾批失敗後仍有內建備援
    接手，名單不會消失。要完全避免須做動態重切批，複雜度不值得。
    """
    for name, env, _fn, _layer in _CHAIN:
        if _key(env):
            return dict(config.AI_PROVIDERS[name], provider=name)
    return dict(config.AI_PROVIDERS["groq"], provider="none")


def _run_chain(order, system, payload, temperature, max_tokens):
    """依 order 逐一嘗試，第一個成功的即回傳。"""
    tried = []
    for name, env, fn, layer in order:
        key = _key(env)
        if not key:
            continue
        tried.append(name)
        out = globals()[fn](key, system, payload, temperature, max_tokens)
        if out is not None:
            return out, layer
    if tried:
        print("[ai_json] 已試過 " + "、".join(tried) + " 皆失敗 → 由呼叫端走內建備援。")
    else:
        print("[ai_json] 無任何金鑰 → 由呼叫端走內建備援。")
    return None, None


def call(system: str, payload: dict, temperature=0.0, max_tokens=4000):
    """成本優先：Gemini → Groq → 付費層 → (None, None)。回傳 (parsed, layer)。"""
    return _run_chain(_CHAIN, system, payload, temperature, max_tokens)


def call_paid_first(system: str, payload: dict, temperature=0.0, max_tokens=4000):
    """難度分流：困難或重要的案件直接送最強的模型，不可用才降回免費層。

    「答得出來」不等於「答對」——弱模型面對困難案例不會拒答。
    """
    order = [c for c in _CHAIN if c[3] == "paid"] + \
            [c for c in _CHAIN if c[3] != "paid"]
    return _run_chain(order, system, payload, temperature, max_tokens)


def available() -> bool:
    """降級鏈是否至少有一家有金鑰。供呼叫端決定要不要直接走內建備援。"""
    return any(_key(env) for _n, env, _f, _l in _CHAIN)


# ---------------------------------------------------------------------------
# 第一層之一：Gemini（免費額度，處理量最大）
# ---------------------------------------------------------------------------
def _gemini(key, system, payload, temperature, max_tokens):
    """用 REST 直接呼叫，不裝 google SDK。

    只為了一個 POST 就多一個依賴不值得——`requirements.txt` 目前只有兩項
    （httpx、anthropic），而依賴愈少，這份專案愈容易被別人複製起來跑。

    `responseMimeType: application/json` 是 Gemini 端的 JSON 模式，
    等同 Groq 的 `response_format`。
    """
    import httpx

    model = config.GEMINI_MODEL
    try:
        r = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent",
            params={"key": key},
            json={
                "systemInstruction": {"parts": [{"text": system + _JSON_ONLY}]},
                "contents": [{"role": "user", "parts": [
                    {"text": json.dumps(payload, ensure_ascii=False)}]}],
                "generationConfig": {
                    "temperature": temperature,
                    "responseMimeType": "application/json",
                    "maxOutputTokens": max_tokens,
                },
            },
            timeout=180,
        )
        r.raise_for_status()
        d = r.json()
        # 回應可能分成多個 part，必須全部串起來才是完整的 JSON
        text = "".join(p.get("text", "")
                       for c in d.get("candidates", [])
                       for p in c.get("content", {}).get("parts", []))
        if not text.strip():
            # 有回應但沒內容——最常見是輸出被 maxOutputTokens 截斷，
            # 或整段被安全機制擋掉。兩者都要看得出來，否則只會顯示「解析失敗」。
            fin = (d.get("candidates") or [{}])[0].get("finishReason", "未知")
            print(f"[ai_json] Gemini 回應無內容（finishReason={fin}）")
            return None
        print("[ai_json] 使用 Gemini（" + model + "）。")
        return json.loads(text)
    except Exception as e:  # noqa: BLE001
        print("[ai_json] Gemini 失敗：" + str(e) + _detail(e, model))
        return None


# ---------------------------------------------------------------------------
# 第一層之二：Groq（免費額度，不同供應商）
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
# 第二層：Claude（付費，目前未設定金鑰）
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
