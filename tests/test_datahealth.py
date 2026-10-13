# -*- coding: utf-8 -*-
"""datahealth.py 的測試：python -m unittest discover -s tests -p "test_*.py" """
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import datahealth as h  # noqa: E402

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 14, 2, 0, tzinfo=UTC)


def ts(hours_ago):
    return (NOW - datetime.timedelta(hours=hours_ago)).isoformat()


def series(prices, gap=12, last_ago=2, rate=32.0):
    n = len(prices)
    return [{"ts": ts(last_ago + gap * (n - 1 - i)), "price": p, "rate": rate} for i, p in enumerate(prices)]


def good():
    hist = {"copper": series([10000, 10050, 10100]), "aluminum": series([2600, 2610, 2620])}
    daily = {"copper": [{"ts": "2026-10-13", "usd": 10100}], "aluminum": [{"ts": "2026-10-13", "usd": 2620}],
             "fx": [{"ts": "2026-10-13", "rate": 32.0}]}
    return hist, daily


def find(r, fid, metal=None):
    return next(i for i in r["items"] if i["id"] == fid and (metal is None or i["metal"] == metal))


class Health(unittest.TestCase):
    def test_all_green(self):
        r = h.assess(*good(), now=NOW)
        self.assertEqual((r["level"], r["red"], r["yellow"]), ("green", 0, 0))

    def test_stale_data_goes_yellow_then_red(self):
        hist, daily = good()
        hist["copper"] = series([10000, 10050, 10100], last_ago=40)
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "F1", "copper")["level"], "yellow")
        hist["copper"] = series([10000, 10050, 10100], last_ago=100)
        r = h.assess(hist, daily, now=NOW)
        self.assertEqual(find(r, "F1", "copper")["level"], "red")
        self.assertEqual(r["level"], "red")

    def test_failed_fetches_do_not_hide_staleness(self):
        hist, daily = good()
        hist["copper"] += [{"ts": ts(1), "price": None}, {"ts": ts(0.5), "price": None}, {"ts": ts(0.1), "price": None}]
        r = h.assess(hist, daily, now=NOW)
        self.assertEqual(find(r, "F2", "copper")["level"], "red")          # 連 3 次抓不到
        self.assertEqual(find(r, "F1", "copper")["display"], "2 小時前")      # 新鮮度只看「有效」報價

    def test_single_day_jump(self):
        hist, daily = good()
        hist["copper"] = series([10000, 10600])                              # +6%
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "J1", "copper")["level"], "yellow")
        hist["copper"] = series([10000, 11000])                              # +10%
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "J1", "copper")["level"], "red")

    def test_two_source_gap(self):
        hist, daily = good()
        daily["aluminum"][-1]["usd"] = 2400                                  # 差約 8.3%
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "G1", "aluminum")["level"], "red")
        daily["aluminum"] = []
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "G1", "aluminum")["level"], "yellow")   # 沒第二來源 = 看不到，也算警訊

    def test_frozen_price(self):
        hist, daily = good()
        hist["copper"] = series([10100] * 20)                                # 20 筆 × 12 小時 = 約 9.5 天完全一樣
        r = h.assess(hist, daily, now=NOW)
        self.assertEqual(find(r, "S1", "copper")["level"], "red")
        self.assertEqual(find(r, "S1", "aluminum")["level"], "green")

    def test_weekend_gap_is_not_flagged(self):
        hist, daily = good()
        hist["copper"] = series([10100] * 6)                                 # 6 筆 × 12 小時 = 2.5 天（週末）
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "S1", "copper")["level"], "green")

    def test_fx_gap(self):
        hist, daily = good()
        daily["fx"][-1]["rate"] = 30.0                                       # 差 6.7%
        self.assertEqual(find(h.assess(hist, daily, now=NOW), "X1")["level"], "red")

    def test_empty_history_is_flagged_not_a_crash(self):
        r = h.assess({}, {}, now=NOW)
        self.assertEqual(find(r, "F1", "copper")["level"], "yellow")        # 沒資料 = 算不出 → 黃（不是綠）
        self.assertIn("原料資料來源", h.summary(r))

    def test_summary(self):
        self.assertIn("正常", h.summary(h.assess(*good(), now=NOW)))


if __name__ == "__main__":
    unittest.main()
