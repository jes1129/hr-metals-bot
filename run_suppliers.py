# -*- coding: utf-8 -*-
"""
run_suppliers.py — 功能 C 的 GitHub Actions 入口：供應商雷達（九上科技）。

流程：104 公司搜尋 + 財政部稅籍開放資料 → 合併分類 → AI 推薦 → docs/suppliers.html + Discord。
需要 Secrets：ANTHROPIC_API_KEY（第一層）或 GROQ_API_KEY（第二層），皆為選配——
兩者皆無時判斷端落入第三層規則式後備，名單與儀表板照常產出。DISCORD_WEBHOOK_URL 選配。
"""
import asyncio

import suppliers


def main():
    asyncio.run(suppliers.run())


if __name__ == "__main__":
    main()
