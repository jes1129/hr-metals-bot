# -*- coding: utf-8 -*-
"""check_insight_live.py — 用真實 Groq 金鑰驗證「行情解讀」與「新聞分類」（唯讀，只印結果）。

不寫入 data/ 與 docs/、不 commit、不部署。只在 GitHub Actions 裡跑（金鑰只存在 Secrets）。
結果判讀：
  今日解讀來源：ai    → Groq 回應通過格式與數字檢查，會被採用
  今日解讀來源：rule  → 退回規則式；上方日誌會寫明原因（沒金鑰／呼叫失敗／被數字檢查擋掉）
"""
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import advice  # noqa: E402
import ai_json  # noqa: E402
import insight  # noqa: E402
import run_metals  # noqa: E402


def main() -> int:
    print("Groq 金鑰：", "已設定" if os.environ.get("GROQ_API_KEY") else "未設定")
    print("ai_json.available()：", ai_json.available())
    h = json.load(open(os.path.join(ROOT, "data", "prices.json"), encoding="utf-8"))
    d = json.load(open(os.path.join(ROOT, "data", "daily.json"), encoding="utf-8"))
    news = insight.filter_relevant(run_metals._fetch_news())
    print(f"\n抓到相關新聞 {len(news)} 則")
    tagged = insight.classify_news(news)
    for n in tagged:
        print(f"  [{n['tag']}（{n['tag_by']}）] {n['title'][:50]}")
    adv = advice.build(h, d)
    stats = {m["key"]: m for m in adv["metals"]}
    s = insight.daily_summary(stats, tagged)
    print(f"\n今日解讀來源：{s['source']}")
    print(s["text"])
    ai_tags = sum(1 for n in tagged if n["tag_by"] == "ai")
    print(f"\n新聞由 AI 判斷 {ai_tags}／{len(tagged)} 則；解讀由 {'AI' if s['source'] == 'ai' else '規則式'} 產生。")
    # 即使退回規則式也算「程式沒壞」，不讓流程失敗；來源看上面那行
    return 0


if __name__ == "__main__":
    sys.exit(main())
