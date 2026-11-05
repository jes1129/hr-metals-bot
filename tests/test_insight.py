# -*- coding: utf-8 -*-
"""insight.py：新聞分類、解讀的後備與防亂編。"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import insight  # noqa: E402

STATS = {"copper": {"name": "銅", "price_twd": 467440, "day_pct": 0.64, "d7": -1.32, "d30": 0.36, "pos": 91,
                    "attr": {"day": {"total": 0.34, "usd": -0.22, "fx": 0.56, "from": "2026-11-04", "to": "2026-11-05"}, "week": None}}}
NEWS = [{"title": "LME期銅下跌 全球庫存回升"}, {"title": "金屬需求轉好 鋁價上漲"}, {"title": "某公司舉辦尾牙"}]


def _fake_ai(result, call=None):
    """假的 ai_json：available() 為真，call() 回傳指定結果（或自訂函式）。"""
    default = (lambda *a, **k: (result, "free")) if result is not None else (lambda *a, **k: (None, None))
    return mock.Mock(available=lambda: True, call=call or default)


class NewsTest(unittest.TestCase):
    def test_rule_tags(self):
        out = insight.classify_news(NEWS, use_ai=False)
        self.assertEqual([n["tag"] for n in out], ["偏空", "偏多", "中性"])
        self.assertTrue(all(n["tag_by"] == "rule" for n in out))
        self.assertNotIn("tag", NEWS[0])                      # 不改原資料

    def test_filter_dedupes_and_drops_irrelevant(self):
        news = [{"title": "銅價上漲"}, {"title": "銅價上漲"}, {"title": "鋁價下跌"}, {"title": "LME 庫存"}, {"title": "尾牙抽獎"}]
        out = insight.filter_relevant(news)
        self.assertEqual([n["title"] for n in out], ["銅價上漲", "鋁價下跌", "LME 庫存"])
        few = insight.filter_relevant([{"title": "銅價"}, {"title": "尾牙"}, {"title": "旅遊"}])
        self.assertEqual(len(few), 3)                          # 相關的不到 3 則 → 保持原樣，不讓區塊變空

    def test_ai_tags_used_and_bad_values_ignored(self):
        fake = {"items": [{"i": 0, "tag": "偏多"}, {"i": 1, "tag": "亂寫"}, {"i": 99, "tag": "偏空"}]}
        with mock.patch.dict(sys.modules, {"ai_json": _fake_ai(fake)}):
            out = insight.classify_news(NEWS)
        self.assertEqual((out[0]["tag"], out[0]["tag_by"]), ("偏多", "ai"))
        self.assertEqual((out[1]["tag"], out[1]["tag_by"]), ("偏多", "rule"))   # 非法值 → 保留規則判斷


class SummaryTest(unittest.TestCase):
    TAGGED = [{"title": "LME期銅下跌 全球庫存回升", "tag": "偏空"}, {"title": "金屬需求轉好", "tag": "偏多"}]
    GOOD = "新聞面偏向庫存回升與需求回溫並存，市場氣氛可能偏謹慎，後續仍要觀察需求是否持續轉好。"

    def _run(self, result, call=None, news=None):
        ai = _fake_ai(result, call=call)
        with mock.patch.dict(sys.modules, {"ai_json": ai}):
            return insight.daily_summary(STATS, self.TAGGED if news is None else news), ai

    def test_rule_summary_has_numbers_and_driver(self):
        t = insight.rule_summary(STATS, [{"tag": "偏多"}, {"tag": "偏空"}, {"tag": "中性"}])
        self.assertIn("NT$467,440", t)
        self.assertIn("11/04→11/05", t)
        self.assertIn("匯率", t)
        self.assertIn("偏多 1 則", t)

    def test_ai_note_is_appended_to_rule_facts(self):
        r, _ = self._run({"note": self.GOOD})
        self.assertEqual(r["source"], "ai")
        self.assertIn("NT$467,440", r["text"])          # 數字句仍是程式算的
        self.assertTrue(r["text"].endswith(self.GOOD))
        self.assertEqual(r["note"], self.GOOD)

    def test_ai_never_sees_market_numbers(self):
        seen = {}

        def call(system, payload, **k):
            seen["payload"] = payload
            return {"note": self.GOOD}, "free"
        self._run(None, call=call)
        import json
        view = json.dumps(seen["payload"]["行情方向"], ensure_ascii=False)
        self.assertNotRegex(view, r"\d")                 # 價格、漲跌幅、區間位置都不能出現在給 AI 的資料裡
        self.assertIn("下跌", view)                       # 只給方向詞

    def test_ai_rejected_if_it_writes_any_digit(self):
        r, _ = self._run({"note": "銅價今天上漲0.64%，主要受匯率帶動，新聞面偏向庫存回升與需求疲軟，後續仍待觀察。"})
        self.assertEqual(r["source"], "rule")
        self.assertNotIn("0.64", r["text"])

    def test_ai_rejected_if_it_gives_advice(self):
        r, _ = self._run({"note": "新聞面庫存回升與需求疲軟並存，市場氣氛偏弱，我建議買進等待反彈，後續仍待觀察。"})
        self.assertEqual(r["source"], "rule")

    def test_ai_rejected_when_too_short_or_not_chinese(self):
        self.assertEqual(self._run({"note": "ok"})[0]["source"], "rule")
        self.assertEqual(self._run({"note": "x" * 60})[0]["source"], "rule")

    def test_no_news_means_no_ai_call(self):
        calls = []
        r, _ = self._run(None, call=lambda *a, **k: calls.append(1) or ({"note": self.GOOD}, "free"), news=[])
        self.assertEqual(r["source"], "rule")
        self.assertFalse(calls)

    def test_no_ai_key_falls_back(self):
        ai = mock.Mock(available=lambda: False)
        with mock.patch.dict(sys.modules, {"ai_json": ai}):
            self.assertEqual(insight.daily_summary(STATS, self.TAGGED)["source"], "rule")

    def test_ai_exception_falls_back(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        r, _ = self._run(None, call=boom)
        self.assertEqual(r["source"], "rule")


if __name__ == "__main__":
    unittest.main()
