# -*- coding: utf-8 -*-
"""
run_suppliers.py — 功能 C 的 GitHub Actions 入口：供應商雷達（九上科技）。

流程：104 公司搜尋 + 財政部稅籍開放資料 → 合併分類 → AI 推薦 → docs/suppliers.html + Discord。
需要 Secrets：GEMINI_API_KEY 或 ANTHROPIC_API_KEY（選配，AI 分析）、DISCORD_WEBHOOK_URL。
"""
import asyncio

import suppliers


def main():
    asyncio.run(suppliers.run())


if __name__ == "__main__":
    main()
