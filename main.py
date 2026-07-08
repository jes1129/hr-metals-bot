# -*- coding: utf-8 -*-
"""
main.py — Modal 部署進入點（對應指南第 7 頁「三步完成雲端部署」）。

  步驟 1：建立 Image（安裝系統依賴、Google Chrome Stable、Playwright、playwright-stealth）
  步驟 2：Secrets 在 Modal Dashboard 建立（automation-secrets），執行時自動注入
  步驟 3：Cron 排程 + 常駐儀表板 web endpoint，最後 `modal deploy main.py`

兩個功能共用同一個 Modal 專案、同一組 Image / Secrets：
  功能 A 人才搜尋  → 每天台灣 08:00（Cron "0 0 * * *" UTC）
  功能 B 銅鋁監控  → 每天台灣 10:00 & 22:00（Cron "0 2,14 * * *" UTC）
  儀表板          → 常駐 FastAPI web endpoint，提供持久網址

本檔的 modal 匯入採容錯處理：本地沒裝 modal 時仍可 `python main.py --mock`
用假資料產生儀表板 HTML 做版型驗證。
"""
import asyncio
import os

import config

try:
    import modal

    HAS_MODAL = True
except ImportError:  # 本地無 modal 時只跑 --mock
    HAS_MODAL = False


# =============================================================================
# 步驟 1 — Image（安裝環境）
# =============================================================================
if HAS_MODAL:
    image = (
        modal.Image.debian_slim(python_version="3.11")
        # Google Chrome 執行所需的系統依賴
        .apt_install(
            "wget", "gnupg", "ca-certificates", "fonts-liberation",
            "libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libcups2",
            "libdbus-1-3", "libdrm2", "libgbm1", "libgtk-3-0", "libnspr4",
            "libnss3", "libx11-xcb1", "libxcomposite1", "libxdamage1",
            "libxfixes3", "libxkbcommon0", "libxrandr2", "xdg-utils",
            # 中文字型，儀表板/擷取時中文才不會變豆腐
            "fonts-noto-cjk",
        )
        # 下載安裝真實 Google Chrome Stable（指南第 4 頁：真實 Chrome 繞 Cloudflare 成功率高）
        .run_commands(
            "wget -q -O /tmp/chrome.deb "
            "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
            "apt-get update && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb",
        )
        .pip_install(
            "playwright==1.48.0",
            "playwright-stealth",
            "httpx",
            "anthropic",
            "fastapi[standard]",
        )
        # 讓 Playwright 認得系統安裝的 Chrome
        .run_commands("playwright install-deps")
    )

    app = modal.App("hr-metals-automation")

    # 步驟 2 — Secrets（在 Modal Dashboard 以名稱 automation-secrets 建立）
    #   ANTHROPIC_API_KEY / DISCORD_WEBHOOK_URL
    #   LOGIN_104_ACCOUNT / LOGIN_104_PASSWORD
    secrets = modal.Secret.from_name("automation-secrets")

    # Volume — 持久保存銅鋁價格歷史（掛在 /data）
    vol = modal.Volume.from_name("metals-history", create_if_missing=True)

    # -------------------------------------------------------------------------
    # 步驟 3a — 功能 A：人才搜尋（每天台灣 08:00）
    # -------------------------------------------------------------------------
    @app.function(
        image=image,
        secrets=[secrets],
        schedule=modal.Cron("0 0 * * *"),  # UTC 00:00 = 台灣 08:00
        timeout=900,
    )
    async def run_talent_search():
        import talent

        account = os.environ.get(config.ENV_104_ACCOUNT, "")
        password = os.environ.get(config.ENV_104_PASSWORD, "")
        if not account or not password:
            print("[main] 缺少 104 帳密 Secret，功能 A 略過。")
            return
        await talent.run(account, password)

    # -------------------------------------------------------------------------
    # 步驟 3b — 功能 B：銅鋁監控（每天台灣 10:00 & 22:00）
    # -------------------------------------------------------------------------
    @app.function(
        image=image,
        secrets=[secrets],
        volumes={"/data": vol},
        schedule=modal.Cron("0 2,14 * * *"),  # UTC 02:00 & 14:00 = 台灣 10:00 & 22:00
        timeout=300,
    )
    async def run_metals_monitor():
        import notify
        import metals

        result = await metals.run()
        vol.commit()  # 確保歷史寫回 Volume
        if result["alerts"]:
            notify.send_embeds(result["alerts"], content="**⚠️ 銅鋁突破告警**")

    # -------------------------------------------------------------------------
    # 步驟 3c — 常駐儀表板 web endpoint（提供持久網址）
    # -------------------------------------------------------------------------
    @app.function(image=image, volumes={"/data": vol})
    @modal.asgi_app()
    def dashboard_app():
        from fastapi import FastAPI
        from fastapi.responses import HTMLResponse

        import dashboard
        import metals

        web = FastAPI()

        @web.get("/", response_class=HTMLResponse)
        def index():
            vol.reload()  # 讀取最新寫入的歷史
            history = metals.load_history()
            return dashboard.render_html(history)

        return web


# =============================================================================
# 本地驗證：python main.py --mock
# 用假的銅鋁時間序列產生 dashboard.html，方便無憑證時目視版型（不需 modal）。
# =============================================================================
def _mock_history():
    import datetime

    base = datetime.datetime(2026, 7, 7, 10, 0, tzinfo=datetime.timezone.utc)
    # 銅：一路走高到突破上線 9800；鋁：緩跌但仍在區間內
    copper = [9500 + i * 35 for i in range(config.TREND_POINTS)]      # 末值 ~9955 > 9800 突破
    alu = [2720 - i * 9 for i in range(config.TREND_POINTS)]          # 末值 ~2603 在 2400-2900 內
    hist = {"copper": [], "aluminum": []}
    for i in range(config.TREND_POINTS):
        ts = (base + datetime.timedelta(hours=12 * i)).isoformat()
        pc, pa = copper[i], alu[i]
        prev_c = copper[i - 1] if i else pc
        prev_a = alu[i - 1] if i else pa
        hist["copper"].append(
            {"ts": ts, "price": pc, "change": round(pc - prev_c, 1),
             "change_pct": round((pc - prev_c) / prev_c * 100, 2)}
        )
        hist["aluminum"].append(
            {"ts": ts, "price": pa, "change": round(pa - prev_a, 1),
             "change_pct": round((pa - prev_a) / prev_a * 100, 2)}
        )
    return hist


def _run_mock():
    import dashboard

    html = dashboard.render_html(_mock_history())
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard_preview.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[mock] 已產生儀表板預覽：{out}")


if HAS_MODAL:
    @app.local_entrypoint()
    def main(mock: bool = False):
        """modal run main.py  或  modal run main.py --mock"""
        if mock:
            _run_mock()
        else:
            print("觸發一次銅鋁監控…")
            run_metals_monitor.remote()


if __name__ == "__main__":
    import sys

    if "--mock" in sys.argv or not HAS_MODAL:
        _run_mock()
    else:
        print("請用 `modal run main.py` 或 `modal deploy main.py`；"
              "本地版型預覽用 `python main.py --mock`。")
