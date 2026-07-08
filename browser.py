# -*- coding: utf-8 -*-
"""
browser.py — Playwright 共用工具（對應指南第 4、8 頁「如何繞過反爬蟲」）。

四個關鍵：
  1. 使用真實 Google Chrome（channel="chrome"），指紋完整、繞 Cloudflare 成功率高。
  2. playwright-stealth 隱藏 navigator.webdriver 等自動化痕跡。
  3. 企業帳號登入 + 首頁暖機讓 Cloudflare 發 Cookie。
  4. 帶 context 的 Cookie，用 page.evaluate() 呼叫後端 JSON API 取結構化資料。
"""
import contextlib

# 注意：playwright / playwright-stealth 只存在於 Modal Image，本地通常沒裝。
# 因此第三方套件一律「延遲匯入」（放在函式內），讓本檔在本地也能 import 成功。


async def apply_stealth_async(page):
    """套用 stealth，隱藏 navigator.webdriver 等自動化痕跡。相容新舊版 API。"""
    try:  # 新版：from playwright_stealth import Stealth
        from playwright_stealth import Stealth  # type: ignore

        await Stealth().apply_stealth_async(page)
        return
    except Exception:  # noqa: BLE001
        pass
    try:  # 舊版：stealth_async(page)
        from playwright_stealth import stealth_async  # type: ignore

        await stealth_async(page)
    except Exception:  # noqa: BLE001  # 沒裝時退化為 no-op
        print("[browser] 未安裝 playwright-stealth，略過 stealth。")


# 真實使用者的 User-Agent（Google Chrome Stable）。TODO(verify): 部署後對齊 image 內實際 Chrome 版本。
REAL_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@contextlib.asynccontextmanager
async def real_chrome(headless: bool = True):
    """開一個帶 stealth 的真實 Chrome context，yield (page, context)。"""
    from playwright.async_api import async_playwright  # 延遲匯入

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            channel="chrome",  # 真實 Google Chrome，而非內建 Chromium
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        context = await browser.new_context(
            user_agent=REAL_UA,
            locale="zh-TW",
            timezone_id="Asia/Taipei",
            viewport={"width": 1440, "height": 900},
        )
        page = await context.new_page()
        await apply_stealth_async(page)
        try:
            yield page, context
        finally:
            await context.close()
            await browser.close()


async def warm_up(page, home_url: str):
    """訪問首頁讓 Cloudflare 發 Cookie（指南「首頁暖機」）。"""
    await page.goto(home_url, wait_until="networkidle", timeout=60000)
    await page.wait_for_timeout(2000)  # 稍等 Cloudflare 挑戰完成


async def login_104(page, account: str, password: str):
    """
    企業帳號登入 104 並保存 session（指南第 6 頁步驟 03）。

    TODO(verify): 以下選擇器/流程為依 104 企業登入頁的合理假設，
    需對照實際頁面（登入網址、input name、送出按鈕）微調。
    """
    LOGIN_URL = "https://pro.104.com.tw/psc"  # TODO(verify): 企業服務登入入口
    await page.goto(LOGIN_URL, wait_until="networkidle", timeout=60000)

    # TODO(verify): 帳密欄位選擇器
    await page.fill('input[name="account"], input#account', account)
    await page.fill('input[name="password"], input#password', password)
    # 模擬人類節奏，降低被判定為機器人的機率
    await page.wait_for_timeout(800)
    # TODO(verify): 送出按鈕選擇器
    await page.click('button[type="submit"], button:has-text("登入")')
    await page.wait_for_load_state("networkidle", timeout=60000)

    # 登入後回首頁暖機，確保 Cookie 齊全
    await warm_up(page, "https://pro.104.com.tw/")


async def fetch_json(page, url: str):
    """
    帶 context 的 Cookie，用瀏覽器內 fetch 呼叫後端 JSON API（指南第 6 頁步驟 04）。
    因為是在頁面 context 內執行，會自動帶上登入後的 Cookie 與正確 Origin/Referer。
    """
    return await page.evaluate(
        """async (url) => {
            const r = await fetch(url, {
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            });
            const text = await r.text();
            try { return JSON.parse(text); }
            catch (e) { return { __raw: text, __status: r.status }; }
        }""",
        url,
    )
