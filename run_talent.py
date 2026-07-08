# -*- coding: utf-8 -*-
"""
run_talent.py — 功能 A 的 GitHub Actions 入口（取代 Modal 的排程 function）。

流程：登入 104 → 爬候選人 → Claude AI 評分 → 8 分以上以 Discord embed 卡片推送。
需要 Secrets：LOGIN_104_ACCOUNT / LOGIN_104_PASSWORD / ANTHROPIC_API_KEY / DISCORD_WEBHOOK_URL
"""
import asyncio
import os

import config
import talent


def main():
    account = os.environ.get(config.ENV_104_ACCOUNT, "")
    password = os.environ.get(config.ENV_104_PASSWORD, "")
    if not account or not password:
        print("[run_talent] 缺少 104 帳密 Secret，功能 A 略過。")
        return
    asyncio.run(talent.run(account, password))


if __name__ == "__main__":
    main()
