# -*- coding: utf-8 -*-
"""probe_free_models.py — 探測免費 AI 服務的實際可用性（唯讀，不動任何產出）。

為什麼需要這支腳本
------------------
免費層的失效模式無法從文件推測，只能實測：

  2026-07-25  Gemini 2.5-flash 回 404（金鑰無存取權）；2.0-flash 回 429
  2026-08-17  Groq llama-3.3-70b-versatile 回 404（已下架）
  2026-08-17  Groq gpt-oss-120b 回 413（TPM 上限 8,000）

而且 Gemini 官方文件**不公布**免費層的 RPM／TPM 數字（要在 AI Studio 後台看）。
所以判斷「這把金鑰現在能用什麼」的唯一可靠方法，就是拿金鑰去問。

本腳本對每個服務做三件事：
  1. 列出這把金鑰實際能存取的模型
  2. 用最小的請求試一次 JSON 輸出
  3. 用真實規模（N 家廠商）試一次，把額度上限撞出來

唯讀保證：不寫入 data/、不產生 HTML、不發通知、不改任何設定。
只印結果。

用法（需要環境變數提供金鑰）：
    GEMINI_API_KEY=... GROQ_API_KEY=... python scripts/probe_free_models.py
    python scripts/probe_free_models.py --size 20    # 改用 20 家做規模測試
    python scripts/probe_free_models.py --gemini gemini-3.6-flash,gemini-3.5-flash
"""
import io
import json
import os
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SIZE = 10
ONLY_GEMINI = []     # 指定要測哪些 Gemini 模型（空 = 自動挑 flash 系列）
ONLY_GROQ = []
for i, a in enumerate(sys.argv):
    nxt = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
    if a == "--size" and nxt:
        SIZE = int(nxt)
    elif a == "--gemini" and nxt:
        ONLY_GEMINI = [x.strip() for x in nxt.split(",") if x.strip()]
    elif a == "--groq" and nxt:
        ONLY_GROQ = [x.strip() for x in nxt.split(",") if x.strip()]


def _cap(provider: str, default: int) -> int:
    """取正式設定的輸出上限。設定檔讀不到就用預設值——探測腳本不該因為
    設定檔改壞而整個跑不起來。"""
    try:
        import config
        return int(config.AI_PROVIDERS[provider]["max_tokens"])
    except Exception:  # noqa: BLE001
        return default


def hr(t=""):
    print("\n" + "=" * 74)
    if t:
        print(t)
        print("=" * 74)


def sample_payload(n: int) -> dict:
    """用真實形狀的中文廠商資料當測試輸入。

    兩件事刻意做到：
      1. 中文——token 密度是關鍵變數，各家的分詞器差異很大
      2. 每家名稱與工法都不同——若全部一模一樣，模型可能合併成一筆回答，
         就測不出「有沒有漏評」這個真正要測的問題
    """
    caps_pool = [["代客加工"], ["表面處理"], ["代客加工", "鍛造"],
                 ["板金"], ["表面處理", "板金"]]
    tax_pool = [["未分類其他金屬加工處理"], ["基本金屬表面處理"],
                ["金屬鍛造業", "未分類其他金屬加工處理"],
                ["金屬板金製造"], ["電鍍業", "金屬裁剪"]]
    area_pool = ["臺中市神岡區社南里", "臺中市大雅區秀山里", "臺中市豐原區翁子里",
                 "臺中市西屯區何厝里", "彰化縣和美鎮塗厝里"]
    rows = []
    for i in range(n):
        rows.append({
            "ban": f"{10000000 + i * 37}",
            "name": f"第{i + 1}號精密五金工業有限公司",
            "caps": caps_pool[i % len(caps_pool)],
            "area": area_pool[i % len(area_pool)],
            "product": "254金屬加工處理、259其他金屬製品",
            "tax": tax_pool[i % len(tax_pool)],
            "capital": str(1000000 * (i % 9 + 1)),
            "since": "0920121", "org": "有限公司",
            "near": 4 - (i % 4),
        })
    return {"候選廠商": rows}


_SIMPLE = (
    "你是採購顧問。為輸入中的每一家評分（0-100）並說明理由。"
    "只輸出 JSON 物件："
    '{"ranked":[{"ban":"統編","score":整數,"reason":"一句話，須引用實際欄位"}]}'
    "陣列必須包含輸入中的每一家，不可遺漏。"
)


def _system() -> str:
    """--real-prompt 時改用正式流程的提示詞。

    這件事必須測：正式提示詞比上面的簡化版長得多、要求的欄位也多，
    而 Gemini 3.x 把**思考 tokens 也算進 maxOutputTokens**。用簡化提示詞
    測過就上線，很可能在正式跑時被截斷——而截斷的症狀是「回應無內容」，
    看起來像解析失敗，會把除錯帶往錯的方向。
    """
    if "--real-prompt" not in sys.argv:
        return _SIMPLE
    import config
    import prompts
    print("  （使用正式提示詞 prompts.radar_rank_system）")
    return prompts.radar_rank_system(config.SUPPLIER_PROFILE,
                                     config.RADARS["suppliers"],
                                     config.DASHBOARD_TOP)


SYSTEM = _system()


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------
def probe_gemini(key: str):
    import httpx

    base = "https://generativelanguage.googleapis.com/v1beta"

    hr("Gemini — 這把金鑰實際能用哪些模型")
    usable = []
    try:
        r = httpx.get(f"{base}/models", params={"key": key}, timeout=60)
        if r.status_code != 200:
            print(f"  ✗ 列模型失敗 HTTP {r.status_code}：{r.text[:300]}")
            return
        for m in r.json().get("models", []):
            name = m.get("name", "").replace("models/", "")
            methods = m.get("supportedGenerationMethods", [])
            if "generateContent" not in methods:
                continue
            usable.append(name)
        print(f"  支援 generateContent 的模型共 {len(usable)} 個：")
        for n in usable:
            print(f"    {n}")
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ 列模型例外：{type(e).__name__}: {e}")
        return

    if ONLY_GEMINI:
        prefer = ONLY_GEMINI
    else:
        # 挑最可能適用的：flash 系列（快、免費額度較寬），排除非文字用途的
        prefer = [n for n in usable if "flash" in n
                  and not any(x in n for x in
                              ("image", "tts", "live", "omni", "banana"))]
        prefer.sort()
    if not prefer:
        prefer = usable[:3]

    for model in prefer:
        hr(f"Gemini {model} — 規模測試（{SIZE} 家中文資料）")
        body = {
            "systemInstruction": {"parts": [{"text": SYSTEM}]},
            "contents": [{"role": "user", "parts": [
                {"text": json.dumps(sample_payload(SIZE), ensure_ascii=False)}]}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                # 用正式設定的上限，否則測過的與上線跑的不是同一件事
                "maxOutputTokens": _cap("gemini", 16384),
            },
        }
        try:
            t0 = time.time()
            r = httpx.post(f"{base}/models/{model}:generateContent",
                           params={"key": key}, json=body, timeout=180)
            secs = time.time() - t0
            if r.status_code != 200:
                print(f"  ✗ HTTP {r.status_code}")
                print(f"    {r.text[:420]}")
                continue
            d = r.json()
            usage = d.get("usageMetadata", {})
            txt = ""
            for c in d.get("candidates", []):
                for p in c.get("content", {}).get("parts", []):
                    txt += p.get("text", "")
            try:
                got = len(json.loads(txt).get("ranked", []))
                ok = "✓"
            except Exception:  # noqa: BLE001
                got, ok = 0, "✗ JSON 解析失敗"
            print(f"  {ok} 送 {SIZE} 家 → 回 {got} 筆評分，耗時 {secs:.1f} 秒")
            print(f"    tokens：輸入 {usage.get('promptTokenCount')} ／ "
                  f"輸出 {usage.get('candidatesTokenCount')} ／ "
                  f"合計 {usage.get('totalTokenCount')}")
            if usage.get("thoughtsTokenCount"):
                print(f"    思考 tokens：{usage['thoughtsTokenCount']}"
                      f"（也計入額度）")
            if got and got < SIZE:
                print(f"    ⚠️ 少回 {SIZE - got} 筆——指令遵循不完整")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ 例外：{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Groq
# ---------------------------------------------------------------------------
def probe_groq(key: str):
    import httpx

    hr("Groq — 這把金鑰實際能用哪些模型")
    models = []
    try:
        r = httpx.get("https://api.groq.com/openai/v1/models",
                      headers={"Authorization": "Bearer " + key}, timeout=60)
        if r.status_code != 200:
            print(f"  ✗ 列模型失敗 HTTP {r.status_code}：{r.text[:300]}")
        else:
            for m in r.json().get("data", []):
                mid = m.get("id", "")
                if any(x in mid for x in ("whisper", "tts", "guard", "prompt")):
                    continue
                models.append(mid)
            for m in sorted(models):
                print(f"    {m}")
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ 例外：{type(e).__name__}: {e}")

    targets = ONLY_GROQ or [m for m in models
                            if "gpt-oss" in m or "compound" in m] or models[:2]
    for idx, model in enumerate(targets):
        # Groq 的額度是**每分鐘**的，連續測會自己撞自己的 429
        # （實測 2026-08-17：compound-mini 用掉 3,819 後 gpt-oss-120b 就被擋）
        if idx:
            print(f"\n  （等 65 秒讓 Groq 的每分鐘額度重置）")
            time.sleep(65)
        hr(f"Groq {model} — 規模測試（{SIZE} 家中文資料）")
        body = {
            "model": model,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user",
                          "content": json.dumps(sample_payload(SIZE), ensure_ascii=False)}],
            "response_format": {"type": "json_object"},
            "temperature": 0,
            "max_tokens": _cap("groq", 2500),
        }
        try:
            r = httpx.post("https://api.groq.com/openai/v1/chat/completions",
                           headers={"Authorization": "Bearer " + key},
                           json=body, timeout=180)
            if r.status_code != 200:
                print(f"  ✗ HTTP {r.status_code}")
                print(f"    {r.text[:420]}")
                continue
            d = r.json()
            u = d.get("usage", {})
            txt = d["choices"][0]["message"]["content"]
            try:
                got = len(json.loads(txt).get("ranked", []))
                ok = "✓"
            except Exception:  # noqa: BLE001
                got, ok = 0, "✗ JSON 解析失敗"
            print(f"  {ok} 送 {SIZE} 家 → 回 {got} 筆評分")
            print(f"    tokens：輸入 {u.get('prompt_tokens')} ／ "
                  f"輸出 {u.get('completion_tokens')} ／ 合計 {u.get('total_tokens')}")
            if got and got < SIZE:
                print(f"    ⚠️ 少回 {SIZE - got} 筆——指令遵循不完整")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ 例外：{type(e).__name__}: {e}")


def main() -> int:
    print(f"規模測試每批 {SIZE} 家（可用 --size N 調整）")
    gk = os.environ.get("GEMINI_API_KEY")
    qk = os.environ.get("GROQ_API_KEY")
    ak = os.environ.get("ANTHROPIC_API_KEY")

    hr("金鑰盤點")
    for n, v in (("GEMINI_API_KEY", gk), ("GROQ_API_KEY", qk),
                 ("ANTHROPIC_API_KEY", ak)):
        print(f"  {n:<20}{'已設定' if v else '未設定'}")

    if gk:
        probe_gemini(gk)
    else:
        hr("Gemini")
        print("  跳過：未設定 GEMINI_API_KEY")

    if qk:
        probe_groq(qk)
    else:
        hr("Groq")
        print("  跳過：未設定 GROQ_API_KEY")

    hr()
    print("（唯讀腳本：未寫入 data/、未產生 HTML、未發通知、未改設定）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
