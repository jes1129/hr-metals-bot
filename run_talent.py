# -*- coding: utf-8 -*-
"""
run_talent.py — 功能 A 的 GitHub Actions 入口。

【目前：實驗版】追蹤 104 公開職缺行情（免登入、免企業帳號）：
  Playwright 爬公開職缺 → 解析薪資/地區 → 彙整 → Claude 行情分析 → Discord 推播。
  需要 Secrets：ANTHROPIC_API_KEY / DISCORD_WEBHOOK_URL（沒有 ANTHROPIC 也能跑，退化為純統計）。

【未來：企業版】拿到 104 企業人才庫帳號後，把下面的 market.run() 換成：
      import talent
      asyncio.run(talent.run(account, password))
  並在 workflow 補回 LOGIN_104_ACCOUNT / LOGIN_104_PASSWORD 兩個 Secret。
  「Claude 分析 → Discord 推播」的後段架構兩版共用，不用改。
"""
import asyncio

import market


def main():
    asyncio.run(market.run())


if __name__ == "__main__":
    main()
