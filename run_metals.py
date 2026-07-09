# -*- coding: utf-8 -*-
"""
run_metals.py — 功能 B 的 GitHub Actions 入口（取代 Modal 的排程 function）。

流程：爬鉅亨網銅鋁 → 存 data/prices.json 時間序列 → 產生 docs/index.html 儀表板
      → 突破區間時發 Discord 告警。
歷史與儀表板由 workflow commit 回 repo；Pages 從 main/docs 提供網址。
"""
import asyncio
import os

# 歷史已於此重置為純 LME 起點
import dashboard
import metals
import notify


def main():
    result = asyncio.run(metals.run())  # 內部已寫入 data/prices.json（Westmetall 現價/告警）
    daily = metals.backfill_daily()     # 回補一年日線 → data/daily.json（走勢圖）

    # 產生儀表板到 docs/（GitHub Pages 來源）
    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "index.html"), "w", encoding="utf-8") as f:
        f.write(dashboard.render_html(result["history"], daily))
    print("[run_metals] 已更新 docs/index.html")

    # 突破區間才發 Discord 告警
    if result["alerts"]:
        notify.send_embeds(result["alerts"], content="**⚠️ 銅鋁突破告警**")


if __name__ == "__main__":
    main()
