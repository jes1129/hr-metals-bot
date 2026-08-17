# -*- coding: utf-8 -*-
"""test_ai_layer.py — 判斷端的離線測試（不需金鑰、不連網、不動任何產出）。

為什麼這支要留在專案裡
----------------------
這裡驗的三件事都是**確定性程式碼**，而且都是實際壞過才補上的：

  1. `_salvage()`  被截斷的 JSON 要救回已完整的部分
     （2026-08-17 正式執行：Gemini 回 200 但 JSON 斷在第 6,058 字，
       當時整批 50 家全部丟掉，其實前面幾十家的評分是好的）
  2. 換供應商要**重切批次**
     （同一次執行：批次照 Gemini 切成 50 家，Gemini 失敗後換 Groq，
       但 Groq 的額度只吃得下 8 家，於是每批都回 413——
       備援名義上存在，實際上從來不可能成功）
  3. 兩家都掛時名單不能消失，要降級到規則層

第三點正是整個架構的核心主張。而「平常不跑的程式碼會腐爛」——
若這些路徑只在免費層失效時才走到，一年跑不到一次，
等真正需要它的那天才會發現它早就壞了。

用法：python scripts/test_ai_layer.py
"""
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 假金鑰：讓降級鏈認為兩家免費層都在，但呼叫會被下面的假函式攔掉，不會連網
os.environ["GEMINI_API_KEY"] = "fake-for-test"
os.environ["GROQ_API_KEY"] = "fake-for-test"
os.environ.pop("ANTHROPIC_API_KEY", None)

import ai_json      # noqa: E402
import ai_select    # noqa: E402
import config       # noqa: E402

_OK = _FAIL = 0


def chk(name, got, want):
    global _OK, _FAIL
    if got == want:
        _OK += 1
        print(f"  ✓ {name}")
    else:
        _FAIL += 1
        print(f"  ✗ {name}：得到 {got!r}，預期 {want!r}")


def head(t):
    print("\n" + t)
    print("-" * len(t) * 2)


# ---------------------------------------------------------------------------
# 一、被截斷的 JSON 要能救回已完整的部分
# ---------------------------------------------------------------------------
head("一、截斷搶救")

full = ('{"ranked":[{"ban":"1","score":90,"reason":"神岡區、代客加工"},'
        '{"ban":"2","score":80,"reason":"表面處理"}]}')
chk("完整 JSON 照常解析", len(ai_json._parse(full)["ranked"]), 2)

cut = ('{"ranked":[{"ban":"1","score":90,"reason":"神岡區、代客加工"},'
       '{"ban":"2","score":80,"reason":"表面處理"},{"ban":"3","score":7')
chk("斷在第三筆 → 救回前兩筆",
    [x["ban"] for x in ai_json._parse(cut)["ranked"]], ["1", "2"])

# 逐字掃描判斷括號深度與字串狀態，故理由裡的引號與大括號不會騙過它
tricky = ('{"ranked":[{"ban":"1","score":90,'
          '"reason":"稅籍寫\\"表面處理{熱}\\"，符合"},'
          '{"ban":"2","score":80,"reason":"斷在這')
r = ai_json._parse(tricky)
chk("理由含引號與大括號 → 只救回第一筆",
    [x["ban"] for x in r["ranked"]], ["1"])
chk("救回的理由內容完整", r["ranked"][0]["reason"], '稅籍寫"表面處理{熱}"，符合')

chk("空字串 → None", ai_json._parse(""), None)
chk("斷在第一筆之內 → None", ai_json._parse('{"ranked":[{"ban":"1","sc'), None)
chk("根本不是 JSON → None", ai_json._parse("抱歉，我無法處理"), None)


# ---------------------------------------------------------------------------
# 二、每家供應商有自己的處理量
# ---------------------------------------------------------------------------
head("二、供應商鏈與批次設定")

chk("Gemini 優先於 Groq", ai_json.providers(), ["gemini", "groq"])
chk("Gemini 批次大於 Groq",
    ai_json.plan("gemini")["batch"] > ai_json.plan("groq")["batch"], True)
chk("Gemini 不必等（非每分鐘額度制）", ai_json.plan("gemini")["sleep"], 0)
chk("Groq 批次間要等（TPM 是每分鐘制）",
    ai_json.plan("groq")["sleep"] > 0, True)
chk("指定不存在的供應商不會爆",
    isinstance(ai_json.plan("nope")["batch"], int), True)


# ---------------------------------------------------------------------------
# 三、換供應商要重切批次；兩家都掛時名單不能消失
# ---------------------------------------------------------------------------
head("三、降級行為")

config.AI_PROVIDERS["groq"]["sleep"] = 0        # 測試不要真的睡滿一分鐘

_CALLS = []


def _cands(n):
    return [{
        "ban": f"{10000000 + i}", "name": f"第{i}號金屬工業有限公司",
        "caps": ["代客加工"], "area": "臺中市神岡區",
        "product": "254金屬加工處理",
        "tax_names": ["未分類其他金屬加工處理"], "near": 4, "score": 100 - i,
    } for i in range(n)]


def _fake(gemini_ok: bool):
    def call_one(provider, system, payload, temperature=0.0, max_tokens=4000):
        rows = payload["候選廠商"]
        _CALLS.append((provider, len(rows)))
        if provider == "gemini" and not gemini_ok:
            return None, None                    # 模擬 503 需求過高
        return {"ranked": [{"ban": r["ban"], "score": 50,
                            "reason": "位於神岡區，且做代客加工"}
                           for r in rows]}, "free"
    return call_one


def _run(gemini_ok):
    _CALLS.clear()
    ai_json.call_one = _fake(gemini_ok)
    top, layer = ai_select.select(config.SUPPLIER_PROFILE,
                                  config.RADARS["suppliers"],
                                  _cands(100), top_n=50)
    sizes = {}
    for prov, n in _CALLS:
        sizes.setdefault(prov, []).append(n)
    return sizes, top, layer


sizes, top, layer = _run(gemini_ok=True)
chk("Gemini 正常 → 只用 Gemini", list(sizes), ["gemini"])
chk("Gemini 正常 → 回 50 家", len(top), 50)
chk("Gemini 正常 → 層級為 free", layer, "free")

sizes, top, layer = _run(gemini_ok=False)
chk("Gemini 全掛 → 兩家都試過", list(sizes), ["gemini", "groq"])
chk("★ Groq 接手時重切批次（不沿用 Gemini 的大小）",
    max(sizes["groq"]), ai_json.plan("groq")["batch"])
chk("Gemini 全掛 → 名單仍完整回 50 家", len(top), 50)
chk("Gemini 全掛 → 層級仍為 free（由 Groq 產出）", layer, "free")


def _both_fail(provider, system, payload, temperature=0.0, max_tokens=4000):
    return None, None


ai_json.call_one = _both_fail
top, layer = ai_select.select(config.SUPPLIER_PROFILE,
                              config.RADARS["suppliers"], _cands(100), top_n=50)
chk("兩家都掛 → 降級到規則層", layer, "rule")
chk("★ 兩家都掛 → 名單仍有 50 家（絕不消失）", len(top), 50)


# ---------------------------------------------------------------------------
# 四、驗證層：理由必須有資料依據
# ---------------------------------------------------------------------------
head("四、驗證層")

base = {"ban": "1", "name": "某某金屬工業", "product": "254金屬加工處理",
        "tax_names": ["基本金屬表面處理"], "area": "臺中市神岡區",
        "caps": ["代客加工"], "ai_score": 50}

ok, dropped = ai_select.verify([dict(base, ai_reason="稅籍登記基本金屬表面處理")])
chk("理由引用實際欄位 → 通過", (len(ok), dropped), (1, 0))

ok, dropped = ai_select.verify([dict(base, ai_reason="這家有五軸加工中心與雷射切割")])
chk("理由是捏造的設備 → 剔除", (len(ok), dropped), (0, 1))

ok, dropped = ai_select.verify([dict(base, ai_reason="")])
chk("空理由 → 剔除", (len(ok), dropped), (0, 1))

# 曾有的索引缺陷：滑動窗口為 4，短於 4 字的理由一次都比不到，
# 於是**永遠**被剔除——那是長度計算的副作用，不是我們的判斷
ok, dropped = ai_select.verify([dict(base, ai_reason="神岡")])
chk("兩字理由但確有依據 → 通過（不被長度計算誤殺）", (len(ok), dropped), (1, 0))

ok, dropped = ai_select.verify([dict(base, ai_reason="台北")])
chk("兩字理由且查無依據 → 剔除", (len(ok), dropped), (0, 1))


print(f"\n{'=' * 60}")
print(f"通過 {_OK}　失敗 {_FAIL}")
sys.exit(1 if _FAIL else 0)
