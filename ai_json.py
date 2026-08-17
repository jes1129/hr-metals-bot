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
import time

import config

_JSON_ONLY = "\n\n只輸出 JSON，不要任何說明文字，不要程式碼框。"


def _status(exc):
    """取 HTTP 狀態碼，取不到回 None。"""
    resp = getattr(exc, "response", None)
    return getattr(resp, "status_code", None) if resp is not None else None


# 可重試 vs 不可重試——這個區分是實測換來的，不是猜的。
#   503「需求過高」：Google 的錯誤訊息自己寫「Spikes are usually temporary」
#   429 額度用盡：等一下就會恢復
#   413 請求過大：**重試一百次也一樣**，要改的是請求本身
#   404 模型下架：永久，重試無意義
_RETRY_STATUS = {429, 500, 502, 503, 504}


def _salvage(text: str, key: str) -> dict:
    """從被截斷的 JSON 裡救出已經完整的物件。

    為什麼需要這個：實測 2026-08-17 正式執行時，Gemini 回了 HTTP 200，但 JSON
    在第 6,058 字被截斷（輸出撞到上限）。當時的行為是整批 50 家全部丟掉——
    可是前面四十幾家的評分是**完好的**，只有最後一筆斷在半句話。

    這是本機的確定性處理，不呼叫模型、不消耗額度，把「整批失敗」變成
    「少幾筆」。以逐字掃描判斷括號深度與字串狀態，故不會被理由文字裡的
    引號或大括號騙過去。
    """
    i = text.find("[", text.find(f'"{key}"'))
    if i < 0:
        return {}
    items, depth, start, in_str, esc = [], 0, -1, False, False
    for j in range(i + 1, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            if depth == 0:
                start = j
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                items.append(text[start:j + 1])
                start = -1
        elif c == "]" and depth == 0:
            break
    out = []
    for s in items:
        try:
            out.append(json.loads(s))
        except Exception:  # noqa: BLE001
            pass                      # 斷在半途的那一筆，跳過即可
    if out:
        print(f"[ai_json] 回應被截斷，已救回 {len(out)} 筆完整結果")
    return {key: out} if out else {}


def _parse(text: str, salvage_key="ranked"):
    """先正常解析；失敗才嘗試搶救被截斷的內容。"""
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        got = _salvage(text, salvage_key)
        return got or None


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


def providers() -> list:
    """回傳目前有金鑰、可依序嘗試的供應商名稱。

    呼叫端據此**逐家重切批次**——這是實測換來的修正。原本只在開頭決定一次
    批次大小（照首選的 Gemini 切成 50 家），Gemini 一失敗就換 Groq，但 Groq
    的額度只吃得下 8 家，於是每一批都回 413。**備援名義上存在，實際上
    從來不可能成功。** 批次大小必須跟著供應商一起換。
    """
    return [n for n, env, _f, _l in _CHAIN if _key(env)]


def plan(provider=None) -> dict:
    """回傳某一家供應商的處理量設定（batch／sleep／max_tokens）。

    為什麼批次大小不能是一個全域數字：實測 Gemini 每批 25 家、Groq 每批只有
    8 家（TPM 僅 8,000）。寫成全域就只能遷就最小的那一家，等於白白浪費
    Gemini 三倍的處理量。不給 provider 時回傳降級鏈第一家的設定。
    """
    name = provider
    if not name:
        avail = providers()
        name = avail[0] if avail else "none"
    return dict(config.AI_PROVIDERS.get(name, config.AI_PROVIDERS["groq"]),
                provider=name)


def call_one(provider: str, system: str, payload: dict,
             temperature=0.0, max_tokens=4000):
    """只打指定的那一家。供呼叫端自行控制「換供應商就重切批次」的流程。"""
    for name, env, fn, layer in _CHAIN:
        if name != provider:
            continue
        key = _key(env)
        if not key:
            return None, None
        out = globals()[fn](key, system, payload, temperature, max_tokens)
        return (out, layer) if out is not None else (None, None)
    return None, None


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
    """成本優先：Gemini → Groq → 付費層 → (None, None)。回傳 (parsed, layer)。

    注意：這條路徑**不重切批次**，適合單一請求（如評語）。分批處理請改用
    `providers()` ＋ `call_one()`，否則換供應商後批次大小會不合（見 providers）。
    """
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
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent")
    body = {
        "systemInstruction": {"parts": [{"text": system + _JSON_ONLY}]},
        "contents": [{"role": "user", "parts": [
            {"text": json.dumps(payload, ensure_ascii=False)}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json",
            "maxOutputTokens": max_tokens,
        },
    }
    for attempt in range(config.AI_RETRY + 1):
        try:
            r = httpx.post(url, params={"key": key}, json=body, timeout=180)
            r.raise_for_status()
            d = r.json()
            # 回應可能分成多個 part，必須全部串起來才是完整的 JSON
            text = "".join(p.get("text", "")
                           for c in d.get("candidates", [])
                           for p in c.get("content", {}).get("parts", []))
            if not text.strip():
                # 有回應但沒內容——最常見是輸出被 maxOutputTokens 吃完
                # （★ Gemini 3.x 的思考 tokens 也算在裡面），或被安全機制擋掉。
                # 印出 finishReason，否則只會看到「解析失敗」而查錯方向。
                fin = (d.get("candidates") or [{}])[0].get("finishReason", "未知")
                print(f"[ai_json] Gemini 回應無內容（finishReason={fin}）")
                return None
            out = _parse(text)
            if out is None:
                print(f"[ai_json] Gemini 回應無法解析（{len(text)} 字，"
                      f"且無可搶救的完整結果）")
                return None
            print("[ai_json] 使用 Gemini（" + model + "）。")
            return out
        except Exception as e:  # noqa: BLE001
            code = _status(e)
            last = attempt >= config.AI_RETRY
            if code in _RETRY_STATUS and not last:
                wait = config.AI_RETRY_WAIT * (attempt + 1)
                print(f"[ai_json] Gemini 暫時性失敗（HTTP {code}），"
                      f"等 {wait} 秒後重試（第 {attempt + 1} 次）")
                time.sleep(wait)
                continue
            print("[ai_json] Gemini 失敗：" + str(e) + _detail(e, model))
            return None
    return None


# ---------------------------------------------------------------------------
# 第一層之二：Groq（免費額度，不同供應商）
# ---------------------------------------------------------------------------
def _groq(key, system, payload, temperature, max_tokens):
    import httpx

    model = config.GROQ_MODEL
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system + _JSON_ONLY},
            {"role": "user",
             "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    for attempt in range(config.AI_RETRY + 1):
        try:
            r = httpx.post("https://api.groq.com/openai/v1/chat/completions",
                           headers={"Authorization": "Bearer " + key},
                           json=body, timeout=180)
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
            out = _parse(text)
            if out is None:
                print(f"[ai_json] Groq 回應無法解析（{len(text)} 字）")
                return None
            print("[ai_json] 使用 Groq（" + model + "）。")
            return out
        except Exception as e:  # noqa: BLE001
            code = _status(e)
            last = attempt >= config.AI_RETRY
            # 413（請求過大）刻意**不重試**——請求本身就超額，重試一百次也一樣。
            # 該改的是批次大小，而那是呼叫端的事。
            if code in _RETRY_STATUS and not last:
                wait = config.AI_RETRY_WAIT * (attempt + 1)
                print(f"[ai_json] Groq 暫時性失敗（HTTP {code}），"
                      f"等 {wait} 秒後重試（第 {attempt + 1} 次）")
                time.sleep(wait)
                continue
            print("[ai_json] Groq 失敗：" + str(e) + _detail(e, model))
            return None
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
