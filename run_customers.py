# -*- coding: utf-8 -*-
"""
run_customers.py — 功能 D 入口：客戶開發雷達（九上科技找潛在客戶）。

流程：104 公司搜尋 + 財政部稅籍（依目標產業）→ 合併分類 → AI 開發建議
      → docs/customers.html + Discord。需 Secrets：ANTHROPIC（第一層）/ GROQ（第二層），
        皆選配；兩者皆無則落入第三層規則式後備。DISCORD 選配。
"""
import asyncio

import customers


def main():
    asyncio.run(customers.run())


if __name__ == "__main__":
    main()
