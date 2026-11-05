# -*- coding: utf-8 -*-
"""advice.py：今天該做什麼的規則。"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import advice  # noqa: E402


def _daily(start_usd, end_usd, rate=30.0, n=60):
    """n 天線性變化的日線（最後一天 = 今天）。"""
    today = datetime.date(2026, 11, 5)
    rows = []
    for i in range(n):
        d = today - datetime.timedelta(days=n - 1 - i)
        rows.append({"ts": d.isoformat(), "usd": start_usd + (end_usd - start_usd) * i / (n - 1), "rate": rate})
    return rows


def _hist(price, pct):
    return [{"price_twd": price, "change_pct": pct}]


class AdviceTest(unittest.TestCase):
    def test_calm_market(self):
        a = advice.build({"copper": _hist(300000, 0.2), "aluminum": _hist(90000, -0.1)},
                         {"copper": _daily(9900, 10000), "aluminum": _daily(2990, 3000)})
        self.assertIn("沒有需要處理", a["headline"])
        self.assertFalse([i for i in a["items"] if i["level"] in ("red", "yellow", "attention")])

    def test_big_day_move_up_and_down(self):
        a = advice.build({"copper": _hist(300000, 2.0), "aluminum": _hist(90000, -1.8)},
                         {"copper": _daily(9900, 10000), "aluminum": _daily(2990, 3000)})
        texts = " ".join(i["text"] for i in a["items"])
        self.assertIn("銅今天漲 2.00%", texts)
        self.assertIn("鋁今天跌 1.80%", texts)
        self.assertIn("今天有 2 件事要注意", a["headline"])

    def test_week_move(self):
        # 最後 7 天內由 9000 → 10000（約 +11%）
        rows = _daily(9000, 9000, n=53) + [dict(r) for r in []]
        today = datetime.date(2026, 11, 5)
        for i in range(7):
            d = today - datetime.timedelta(days=6 - i)
            rows.append({"ts": d.isoformat(), "usd": 9000 + 1000 * (i + 1) / 7, "rate": 30.0})
        rows = [r for r in rows if r["ts"] <= today.isoformat()]
        a = advice.build({"copper": _hist(300000, 0.1), "aluminum": _hist(90000, 0.0)}, {"copper": rows, "aluminum": _daily(3000, 3000)})
        self.assertTrue(any("近 7 天累計漲" in i["text"] for i in a["items"]))

    def test_health_red_comes_first(self):
        health = {"level": "red", "items": [{"name": "報價新鮮度（銅）", "level": "red"}]}
        a = advice.build({"copper": _hist(300000, 0.1), "aluminum": _hist(90000, 0.0)},
                         {"copper": _daily(9900, 10000), "aluminum": _daily(2990, 3000)}, health)
        self.assertEqual(a["items"][0]["level"], "red")
        self.assertIn("別直接照用", a["items"][0]["text"])

    def test_missing_data_does_not_crash(self):
        a = advice.build({}, {})
        self.assertIn("headline", a)
        a = advice.build(None, None)
        self.assertEqual(len(a["metals"]), 2)

    def test_attribution_splits_usd_and_fx(self):
        rows = [{"ts": "2026-11-04", "usd": 10000, "rate": 30.0}, {"ts": "2026-11-05", "usd": 10100, "rate": 30.3}]
        rows = _daily(10000, 10000, n=10)[:-2] + rows
        st = advice.metal_stats({"copper": _hist(300000, 0.1)}, {"copper": rows})["copper"]
        d = st["attr"]["day"]
        self.assertAlmostEqual(d["usd"], 1.0, places=2)
        self.assertAlmostEqual(d["fx"], 1.0, places=2)
        self.assertAlmostEqual(d["total"], 2.01, places=2)      # (1.01*1.01-1)
        self.assertEqual((d["from"], d["to"]), ("2026-11-04", "2026-11-05"))

    def test_attribution_missing_data(self):
        st = advice.metal_stats({}, {"copper": [{"ts": "2026-11-05", "usd": 1, "rate": 30}]})["copper"]
        self.assertIsNone(st["attr"]["day"])


if __name__ == "__main__":
    unittest.main()
