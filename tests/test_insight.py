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
    def test_rule_summary_has_numbers_and_driver(self):
        t = insight.rule_summary(STATS, [{"tag": "偏多"}, {"tag": "偏空"}, {"tag": "中性"}])
        self.assertIn("NT$467,440", t)
        self.assertIn("11/04→11/05", t)
        self.assertIn("匯率", t)
        self.assertIn("偏多 1 則", t)

    def _with_ai(self, summary):
        with mock.patch.dict(sys.modules, {"ai_json": _fake_ai({"summary": summary})}):
            return insight.daily_summary(STATS, [])

    def test_ai_used_when_numbers_are_real(self):
        r = self._with_ai("銅目前約 467,440 元每噸，近 7 天下跌 1.3%，最近一個交易日的小幅上漲主要來自匯率變動，國際價其實略為走低。")
        self.assertEqual(r["source"], "ai")

    def test_ai_rejected_when_it_invents_numbers(self):
        r = self._with_ai("銅目前約 512,300 元每噸，近 7 天大漲 8.8%，預期還會再漲，國際價與匯率都在推升價格表現相當強勁。")
        self.assertEqual(r["source"], "rule")

    def test_ai_rejected_when_too_short_or_not_chinese(self):
        self.assertEqual(self._with_ai("ok")["source"], "rule")

    def test_no_ai_key_falls_back(self):
        ai = mock.Mock(available=lambda: False)
        with mock.patch.dict(sys.modules, {"ai_json": ai}):
            self.assertEqual(insight.daily_summary(STATS, [])["source"], "rule")

    def test_ai_exception_falls_back(self):
        def boom(*a, **k):
            raise RuntimeError("x")
        with mock.patch.dict(sys.modules, {"ai_json": _fake_ai(None, call=boom)}):
            self.assertEqual(insight.daily_summary(STATS, [])["source"], "rule")


if __name__ == "__main__":
    unittest.main()
