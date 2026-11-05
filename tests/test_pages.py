# -*- coding: utf-8 -*-
"""頁面產生：每個頁面引用的檔案都存在、需要的腳本有掛上（曾經發生過把腳本掛到錯的頁面）。"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import advice  # noqa: E402
import dashboard  # noqa: E402


def _load(name):
    with open(os.path.join(ROOT, "data", name), encoding="utf-8") as f:
        return json.load(f)


class PagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        h, d = _load("prices.json"), _load("daily.json")
        adv = advice.build(h, d)
        ins = {"text": "測試解讀", "source": "rule", "updated": "x"}
        cls.pages = {
            "index": dashboard.render_home(h, advice_data=adv, insight=ins),
            "metals": dashboard.render_html(h, d),
            "quote": dashboard.render_quote_html(h, d),
            "records": dashboard.render_records_html(h),
            "help": dashboard.render_help_html(),
        }

    def test_every_referenced_asset_exists(self):
        for name, html in self.pages.items():
            for ref in re.findall(r'(?:src|href)="(assets/[\w.\-]+)', html):
                self.assertTrue(os.path.exists(os.path.join(ROOT, "docs", ref)), f"{name} 引用了不存在的 {ref}")

    def test_required_scripts_are_on_the_right_pages(self):
        want = {"quote": ["assets/inquiry.js"], "records": ["assets/quote-stats.js"]}
        for page, scripts in want.items():
            for s in scripts:
                self.assertIn(s, self.pages[page], f"{page} 缺少 {s}")
        for page in ("index", "metals", "help"):                      # 不該掛到不需要的頁面
            self.assertNotIn("assets/quote-stats.js", self.pages[page])
            self.assertNotIn("assets/inquiry.js", self.pages[page])
        for page, html in self.pages.items():
            self.assertIn("assets/app.js", html, page)

    def test_features_have_their_dom_hooks(self):
        """app.js 靠這些 id 初始化；少一個功能就悄悄失效。"""
        hooks = {
            "quote": ["inqText", "inqRun", "inqRes", "qSim", "qCopy", "qSave"],
            "records": ["rStats", "rStatus", "rBody", "rPurgeBtn", "rCsv"],
            "index": ["speakBtn", "watchBox"],
            "metals": ["alertBox"],
        }
        for page, ids in hooks.items():
            for i in ids:
                self.assertIn(f'id="{i}"', self.pages[page], f"{page} 缺少 id={i}")

    def test_records_table_has_status_column(self):
        self.assertIn("<th>狀態</th>", self.pages["records"])


if __name__ == "__main__":
    unittest.main()
