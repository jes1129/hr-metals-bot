# -*- coding: utf-8 -*-
"""
dashboard.py — 儀表板 HTML render（銅鋁 index.html + 人才 jobs.html）。

樣式與互動在 docs/assets/style.css、docs/assets/app.js（手寫、常駐、只提交一次）。
這裡產出 HTML 骨架並內嵌資料 <script>window.XXX = {...}</script>，前端 JS 負責
單位切換、日線走勢圖（含 MA 均線、關注線、期間統計）、匯率/比價圖、職缺搜尋與圖表。

分工：現價與告警用 LME 官方（Westmetall，history/prices.json）；走勢圖用 Yahoo
每日收盤（daily.json）以看趨勢。
"""
import datetime
import html
import json

import config
import metals as metals_mod

# 資產版本（破瀏覽器快取）：每次產生頁面時更新，讓 CSS/JS 更新後使用者自動拿到新版，
# 不必手動強制重新整理（對非科技用戶很重要）。
_VER = datetime.datetime.utcnow().strftime("%Y%m%d%H%M")

_HEAD = (
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    f'<link rel="stylesheet" href="assets/style.css?v={_VER}">\n'
    f'<script src="config.js?v={_VER}"></script>\n'
    '<script src="https://accounts.google.com/gsi/client" async defer></script>'
)
# topbar 右側：Google 登入狀態 + 深淺色切換
_THEME_BTN = ('<span id="gAuth" class="gauth"></span>'
              '<button id="themeBtn" class="theme-btn" aria-label="切換深淺色">🌙</button>')


def _fmt(v, nd=1):
    return "—" if v is None else f"{v:,.{nd}f}"


def _sparkline(points, up: bool, w=120, h=32) -> str:
    vals = [p for p in points if p is not None]
    if len(vals) < 2:
        return f'<svg width="{w}" height="{h}"></svg>'
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1
    n = len(vals)
    color = "#c0392b" if up else "#1e8449"
    pts = []
    for i, v in enumerate(vals):
        x = i / (n - 1) * (w - 4) + 2
        y = h - 2 - (v - lo) / span * (h - 4)
        pts.append(f"{x:.1f},{y:.1f}")
    return (
        f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<polyline fill="none" stroke="{color}" stroke-width="1.6" '
        f'stroke-linecap="round" stroke-linejoin="round" points="{" ".join(pts)}"/></svg>'
    )


def _nav(active: str) -> str:
    a = ' class="on"'
    # 市場情報（原料/招募/供應商/客戶）收進一個下拉，讓上排不擁擠
    intel = active in ("metals", "jobs", "suppliers", "customers")
    intel_on = a if intel else ""   # 避免在 f-string 內用反斜線（Python 3.11 不允許）
    return (
        '<div class="nav">'
        f'<a{a if active == "home" else ""} href="index.html">🏠 首頁</a>'
        '<details class="navdrop">'
        f'<summary{intel_on}>📈 情報 ▾</summary>'
        '<div class="navmenu">'
        f'<a{a if active == "metals" else ""} href="metals.html">🔩 原料行情</a>'
        f'<a{a if active == "jobs" else ""} href="jobs.html">🔧 招募雷達</a>'
        f'<a{a if active == "suppliers" else ""} href="suppliers.html">🏭 供應商</a>'
        f'<a{a if active == "customers" else ""} href="customers.html">🎯 客戶開發</a>'
        '</div></details>'
        f'<a{a if active == "quote" else ""} href="quote.html">🧮 報價</a>'
        f'<a{a if active == "orders" else ""} href="orders.html">📦 訂單</a>'
        f'<a{a if active == "ai" else ""} href="assistant.html">🤖 助手</a>'
        f'<a{a if active == "db" else ""} href="db.html">🗂️ 資料庫</a>'
        f'<a{a if active == "help" else ""} href="help.html">📖 說明</a>'
        "</div>"
    )


def _hbars(items) -> str:
    """水平長條圖（伺服器端靜態）。items: [(label, value, display)]。"""
    items = [i for i in items if i]
    if not items:
        return '<div style="padding:14px 16px;color:var(--muted)">資料不足</div>'
    mx = max(v for _, v, _ in items) or 1
    rows = []
    for label, v, disp in items:
        w = round(v / mx * 100)
        rows.append(
            f'<div class="hrow"><div class="hlabel">{html.escape(str(label))}</div>'
            f'<div class="htrack"><div class="hbar" style="width:{w}%"></div></div>'
            f'<div class="hval">{html.escape(str(disp))}</div></div>'
        )
    return '<div class="hbars">' + "".join(rows) + "</div>"



# ===========================================================================
# 首頁總覽（簡單、白話、大卡片；給非科技用戶）
# ===========================================================================
def _hcard(href: str, emoji: str, title: str, lines: str, cta: str) -> str:
    return (
        f'<a class="hcard" href="{href}">'
        f'<div class="he">{emoji}</div>'
        f'<div class="ht">{html.escape(title)}</div>'
        f'<div class="hl">{lines}</div>'
        f'<div class="hcta">{html.escape(cta)} →</div>'
        "</a>"
    )


def render_home(history: dict, jobs_total, sup_total, sup_near, cust_total=None) -> str:
    # 大焦點：最常用的兩張主卡（訂單、每日早報）
    def _feat(href, icon, title, note, cta, ext=False, cid=""):
        idattr = f' id="{cid}"' if cid else ""
        tgt = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<a class="hfcard"{idattr} href="{href}"{tgt}>'
                f'<div class="hfic">{icon}</div>'
                f'<div class="hfbody"><div class="hft">{title}</div><div class="hfl">{note}</div></div>'
                f'<div class="hfcta">{cta} →</div></a>')
    feat = (
        _feat("assistant.html", "🤖", "AI 助手",
              "問一句就答：逾期、營收、待出貨…＋🗣️ 中越對話（老闆⇄越南員工）。", "問問看")
        + _feat("https://mail.google.com", "📧", "每日早報信箱",
                "每天自動收 ERP 早報：營收、待出貨、逾期、原料行情。", "開啟信箱", ext=True)
    )

    # 小捷徑：其餘功能收成一排 icon 格
    def _q(href, icon, label, ext=False, cid=""):
        idattr = f' id="{cid}"' if cid else ""
        tgt = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<a class="hq"{idattr} href="{href}"{tgt}>'
                f'<span class="hqi">{icon}</span><span class="hqt">{label}</span></a>')
    quick_items = [
        _q("orders.html", "📦", "訂單管理"),
        _q("metals.html", "🔩", "原料行情"),
        _q("quote.html", "🧮", "報價試算"),
    ]
    if cust_total is not None:
        quick_items.append(_q("customers.html", "🎯", "客戶開發"))
    quick_items += [
        _q("suppliers.html", "🏭", "供應商"),
        _q("jobs.html", "🔧", "招募雷達"),
        _q("db.html", "🗂️", "九上資料庫", cid="dbCard"),
        _q("https://notebooklm.google.com", "🧠", "NotebookLM", ext=True, cid="nbCard"),
        _q("help.html", "📖", "使用說明"),
    ]
    quick = "".join(quick_items)

    _tw = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    now = _tw.strftime("%Y-%m-%d %H:%M")
    greeting = "早安" if _tw.hour < 11 else ("午安" if _tw.hour < 18 else "晚安")
    date_s = _tw.strftime("%Y/%m/%d") + "（週" + "一二三四五六日"[_tw.weekday()] + "）"
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 智慧儀表板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("home")}{_THEME_BTN}</div>
    <div class="hero">
      <div class="eyebrow">九上科技 · 智慧儀表板</div>
      <h1>{greeting}，老闆 👋</h1>
      <div class="sub">今天 {date_s}　·　這裡是今日重點 · 更新於 {now}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-k">💰 本月營收</div><div class="stat-v" id="stRev">—</div></div>
      <div class="stat"><div class="stat-k">🚚 待出貨</div><div class="stat-v" id="stShip">—</div></div>
      <div class="stat" id="stOverCard"><div class="stat-k">⏰ 逾期未出貨</div><div class="stat-v" id="stOver">—</div></div>
      <div class="stat"><div class="stat-k">📦 本月訂單</div><div class="stat-v" id="stCnt">—</div></div>
    </div>
    <div class="stats-hint" id="stHint">🔒 登入後這裡會帶入你的即時數字（本月營收、待出貨、逾期、訂單數）</div>
    <div class="hfeat">{feat}</div>
    <div class="hqlabel">快速前往</div>
    <div class="hquick">{quick}</div>
    <div class="foot">原料價／招募／供應商每日自動更新；報價用最新原料行情試算。全部免費、關機也會自己跑。</div>
  </div>
  <script>(function(){{var u=(window.APP_CONFIG||{{}}).NOTEBOOK_URL;var c=document.getElementById("nbCard");if(c&&u)c.href=u;}})();</script>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 資料庫操作中心（🗂️ 站內增刪改查，免開 Google 試算表；ERP 各模組地基）
# ===========================================================================
def render_db_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 資料庫操作中心</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("db")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>🗂️ 資料庫操作中心</h1>
    <div class="sub">站內直接管理資料，免開 Google 試算表 · 手機也能用 · 更新於 {now}</div>
    <div id="dbConsole" class="dbconsole">
      <div class="dbloading">載入中…（若一直沒出現，請先用右上角「使用 Google 帳戶登入」）</div>
    </div>
    <div class="foot">所有資料存在公司自己的 Google 試算表（團隊共用、多裝置同步、免費）。不會用到你的個人帳號。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 訂單 + 老闆 KPI 儀表板（📦 建單/看板/營收圖；資料走 orders 資料表）
# ===========================================================================
def render_orders_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 訂單與老闆儀表板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("orders")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>📦 訂單 · 老闆儀表板</h1>
    <div class="sub">一眼看營收與待辦：本月營收、待出貨、逾期，加狀態看板 · 更新於 {now}</div>
    <div id="ordersView" class="ordersview">
      <div class="dbloading">載入中…（若一直沒出現，請先用右上角「使用 Google 帳戶登入」）</div>
    </div>
    <div class="foot">訂單存在公司自己的 Google 試算表（與資料庫操作中心同一份、免費、多裝置同步）。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# AI 助手（🤖 快速問答本地即時算 + 自由提問走免費 Gemini）
# ===========================================================================
def render_assistant_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · AI 助手</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("ai")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>🤖 AI 助手</h1>
    <div class="sub">問一句就答：逾期、營收、待出貨 · 快速問答免設定、免費 · ＋🗣️ 中越對話 · 更新於 {now}</div>
    <div id="aiView" class="aiview">
      <div class="dbloading">載入中…（若一直沒出現，請先用右上角「使用 Google 帳戶登入」）</div>
    </div>
    <div class="foot">快速問答由系統即時計算（不外傳、免費）。自由提問使用客戶自己的免費 AI 金鑰（Groq，放在 Apps Script）。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 說明頁（📖 白話使用教學；給非科技用戶）
# ===========================================================================
def render_help_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 使用說明</title>
<style>
  .help {{ max-width: 900px; }}
  .help .q {{ background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    padding: 20px 22px; margin: 16px 0; box-shadow: var(--shadow); color: var(--text); }}
  .help h2 {{ font-size: 1.18rem; margin: 4px 0 10px; color: var(--text); }}
  .help h3 {{ font-size: 1.02rem; margin: 14px 0 4px; color: var(--text); }}
  .help p, .help li {{ line-height: 1.85; color: var(--text); }}
  .help .muted {{ color: var(--muted); }}
  .help ul {{ margin: 6px 0 6px 2px; padding-left: 20px; }}
  /* 快速跳轉 chips */
  .help .jump {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 2px; }}
  .help .jump a {{ text-decoration: none; font-size: .9rem; padding: 6px 12px; border-radius: 999px;
    background: var(--chip-bg); border: 1px solid var(--chip-border); color: var(--text); transition: .15s; }}
  .help .jump a:hover {{ border-color: var(--accent); color: var(--accent); }}
  .help .tag {{ display: inline-block; background: var(--chip-bg); border: 1px solid var(--chip-border);
    color: var(--text); border-radius: 999px; padding: 2px 11px; font-size: .86rem; margin: 2px 4px 2px 0; white-space: nowrap; }}
  .help .tip {{ background: var(--line2); border-left: 4px solid var(--accent);
    border-radius: 10px; padding: 12px 16px; margin: 12px 0; color: var(--text); }}
  /* 可展開手風琴 */
  .help details.acc {{ border: 1px solid var(--line); border-radius: 12px; margin: 10px 0; background: var(--card); overflow: hidden; }}
  .help details.acc > summary {{ cursor: pointer; padding: 14px 16px; font-weight: 600; color: var(--text);
    display: flex; align-items: center; gap: 8px; list-style: none; user-select: none; }}
  .help details.acc > summary::-webkit-details-marker {{ display: none; }}
  .help details.acc > summary:hover {{ background: var(--line2); }}
  .help details.acc > summary .chev {{ margin-left: auto; transition: transform .2s; color: var(--muted); }}
  .help details.acc[open] > summary .chev {{ transform: rotate(180deg); }}
  .help details.acc > summary .sm {{ font-weight: 400; color: var(--muted); font-size: .9rem; }}
  .help .acc-body {{ padding: 2px 18px 16px; }}
  .help .gobtn {{ display: inline-block; margin-top: 8px; text-decoration: none; font-size: .92rem;
    padding: 8px 16px; border-radius: 10px; background: var(--accent); color: #fff; }}
  .help .gobtn:hover {{ filter: brightness(1.08); }}
  /* 編號步驟 */
  .help .steps {{ counter-reset: s; list-style: none; padding-left: 0; margin: 8px 0; }}
  .help .steps li {{ counter-increment: s; position: relative; padding: 6px 0 6px 38px; }}
  .help .steps li::before {{ content: counter(s); position: absolute; left: 0; top: 5px;
    width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff;
    text-align: center; line-height: 26px; font-size: .85rem; font-weight: 600; }}
  /* 互動示範元件 */
  .help .demo {{ border: 1px dashed var(--chip-border); border-radius: 12px; padding: 16px; margin: 12px 0; background: var(--line2); }}
  .help .demo .row {{ display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 12px; }}
  .help .demo label {{ font-size: .9rem; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }}
  .help .demo select, .help .demo input[type=number] {{ padding: 7px 10px; border-radius: 8px;
    border: 1px solid var(--chip-border); background: var(--card); color: var(--text); font-size: .95rem; }}
  .help .demo input[type=range] {{ accent-color: var(--accent); width: 160px; }}
  .help .demo .out {{ font-size: 1.05rem; color: var(--text); }}
  .help .demo .out b {{ color: var(--accent); font-size: 1.35rem; }}
  .help .demo .brk {{ color: var(--muted); font-size: .88rem; margin-top: 4px; }}
  .help .demo .star {{ cursor: pointer; font-size: 1.5rem; user-select: none; }}
  .help .demo .stbtn {{ padding: 6px 10px; border-radius: 8px; border: 1px solid var(--chip-border);
    background: var(--card); color: var(--text); cursor: pointer; font-size: .9rem; }}
  .help .demo .stbtn.on {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
  .help kbd {{ background: var(--chip-bg); border: 1px solid var(--chip-border); border-bottom-width: 2px;
    border-radius: 6px; padding: 1px 7px; font-size: .85rem; color: var(--text); }}
</style>
</head>
<body>
  <div class="wrap help">
    <div class="topbar">{_nav("help")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>📖 使用說明</h1>
    <div class="sub">一頁看懂整個網站怎麼用 · 可展開／可試玩 · 更新於 {now}</div>

    <div class="q">
      <h2>這是什麼？</h2>
      <p>這是一套幫九上科技的<b>免費小型 ERP</b>：一邊自動盯原料行情、找人才、找供應商、開發客戶；一邊管報價、訂單，還有 AI 助手（含中越對話）。資料每天自動更新，不用開電腦、不用付費、不用維護。</p>
      <p>上面一排分成幾類：<b>🏠 首頁</b>總覽、<b>📈 情報</b>（原料/招募/供應商/客戶，點開是下拉選單）、以及營運工具 <b>🧮 報價 · 📦 訂單 · 🤖 助手 · 🗂️ 資料庫</b>，最後是 <b>📖 說明</b>（本頁）。</p>
      <p class="muted">👇 點下面任一顆，直接跳到該功能的詳細說明：</p>
      <div class="jump">
        <a href="#start">🚀 新手上路</a><a href="#f-home">🏠 首頁</a><a href="#f-metals">🔩 原料</a><a href="#f-jobs">🔧 招募</a>
        <a href="#f-sup">🏭 供應商</a><a href="#f-cust">🎯 客戶</a><a href="#f-quote">🧮 報價</a>
        <a href="#f-orders">📦 訂單</a><a href="#f-ai">🤖 助手</a><a href="#f-notebook">🧠 NotebookLM</a><a href="#f-email">📧 信箱</a><a href="#db">🔐 資料庫</a><a href="#faq">❓ 常見問題</a>
      </div>
    </div>

    <div class="q" id="start">
      <h2>🚀 新手上路：建議使用順序</h2>
      <p>第一次用不知道從哪開始？照這個順序做一遍，就通了：</p>
      <ul class="steps">
        <li><b>用 Google 登入</b>（右上角）——這樣資料才會存進公司試算表、換裝置也看得到。</li>
        <li><b>看情報</b>：📈 情報裡的原料行情、供應商、客戶，平常參考用。</li>
        <li><b>報價</b>：客人詢價 → 🧮 報價算一算 → 存起來。</li>
        <li><b>轉訂單</b>：接到單 → 📦 訂單「從報價轉單」或「＋新增訂單」，用看板追進度。</li>
        <li><b>問 AI</b>：🤖 助手點按鈕或打字，隨時問「哪些逾期 / 營收多少 / 待出貨」；要跟越南員工溝通就切「🗣️ 中越對話」。</li>
      </ul>
      <div class="tip">💡 只想輕鬆用？每天開<b>首頁</b>看重點卡片、需要時點 🤖 <b>助手</b>問一句，就很夠了。</div>
    </div>

    <div class="q">
      <h2>每一項功能詳細說明</h2>
      <p class="muted">點每一條標題可以展開／收合詳細說明。</p>

      <details class="acc" id="f-home" open>
        <summary>🏠 首頁 <span class="sm">— 每天先看這頁</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>每天打開先看這頁。每張大卡片就是一個功能，卡片上會顯示今天的重點數字（原料漲跌、追蹤到的職缺數、供應商家數、客戶家數）。<b>點卡片</b>就進到那個功能。</p>
          <p>還有一張「🗂️ 九上資料庫」卡片，點下去直接打開公司的 Google 試算表，看所有存下來的收藏、備註、報價。</p>
          <a class="gobtn" href="index.html">前往首頁 →</a>
        </div>
      </details>

      <details class="acc" id="f-metals">
        <summary>🔩 原料 <span class="sm">— 銅／鋁／鎳／鋼 價格</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>追蹤銅、鋁、鎳、鋼的國際價格（已換算成台幣）。每種金屬一張面板，有<b>現價、今日漲跌、走勢圖</b>（含月均線與你設的關注上下限）。</p>
          <ul>
            <li>上方可切<b>單位</b>（每公噸／每磅）。</li>
            <li>可切<b>期間</b>（近 7 天／30 天／90 天／一年）看漲跌幅。</li>
            <li>下面還有<b>匯率圖</b>與<b>比價圖</b>。</li>
          </ul>
          <p class="muted">買方視角：漲＝進料成本變高要留意；跌／區間內＝安心。</p>
          <a class="gobtn" href="metals.html">前往原料 →</a>
        </div>
      </details>

      <details class="acc" id="f-jobs">
        <summary>🔧 招募 <span class="sm">— 台中品管職缺行情</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>自動抓台中金屬加工、品管（QC）相關的<b>公開職缺</b>，幫你掌握招募的市場行情。</p>
          <ul>
            <li><b>搜尋框</b>打關鍵字（例：品管、量測）即時篩選。</li>
            <li>點欄位<b>標題可排序</b>（公司、薪資⋯）。</li>
            <li>勾<b>只看收藏</b>，只顯示你收藏的。</li>
            <li><b>薪資分布長條圖</b>看行情落在哪個區間。</li>
          </ul>
          <a class="gobtn" href="jobs.html">前往招募 →</a>
        </div>
      </details>

      <details class="acc" id="f-sup">
        <summary>🏭 供應商 <span class="sm">— 找金屬加工廠</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>幫你找金屬加工供應商（CNC、表面處理、材料、螺絲沖壓、鑄造、模具⋯）。</p>
          <ul>
            <li><b>類別下拉</b>篩選你要的能力。</li>
            <li>勾<b>只看神岡周邊</b>看附近的（<b>⭐近</b>＝神岡周邊，溝通打樣快）。</li>
            <li>切<b>地圖</b>檢視看位置分佈。</li>
            <li>每一列可<b>收藏／標狀態／寫備註</b>（需登入）。</li>
          </ul>
          <a class="gobtn" href="suppliers.html">前往供應商 →</a>
        </div>
      </details>

      <details class="acc" id="f-cust">
        <summary>🎯 客戶 <span class="sm">— 找潛在買主</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>找可能會買精密金屬零件的<b>潛在客戶</b>（光學、醫療、半導體、自動化、自行車、汽車⋯），用來主動開發。</p>
          <ul>
            <li><b>產業下拉</b>篩選。</li>
            <li><b>搜尋</b>公司名。</li>
            <li>每列可<b>收藏／標記／備註</b>（需登入）。</li>
          </ul>
          <a class="gobtn" href="customers.html">前往客戶 →</a>
        </div>
      </details>

      <details class="acc" id="f-quote">
        <summary>🧮 報價 <span class="sm">— 快速估價</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>快速估報價的四個步驟：</p>
          <ol>
            <li>選<b>材質</b>（會自動帶入最新原料價）。</li>
            <li>填<b>重量</b>；不知道重量？填長寬高按「計算」自動換算。</li>
            <li>看<b>建議報價</b>。</li>
            <li>按<b>存這筆</b>記進報價歷史（登入後同步到試算表）。</li>
          </ol>
          <p class="muted">👇 下面「試玩看看」可以直接體驗報價怎麼算。</p>
          <a class="gobtn" href="quote.html">前往報價 →</a>
        </div>
      </details>

      <details class="acc" id="f-orders">
        <summary>📦 訂單 · 老闆儀表板 <span class="sm">— 建單、看板、營收圖</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>把接到的單記進來，老闆一眼看營收與進度。</p>
          <ul>
            <li><b>上方 KPI 卡</b>：本月營收、本月訂單數、待出貨、逾期未出（逾期會標紅）。</li>
            <li><b>狀態看板</b>：報價 → 接單 → 生產 → 出貨 → 結案。每張訂單卡下方的下拉選單改狀態，就會移到對應欄位；點卡片可編輯或刪除。</li>
            <li><b>營收圖</b>：近 6 個月營收長條圖、訂單狀態分佈。</li>
            <li><b>＋ 新增訂單</b>：填客戶、品名、數量、單價（金額留空會自動＝數量×單價）、交期。</li>
            <li><b>🧮 從報價轉單</b>：一鍵把最新一筆報價帶成新訂單。</li>
          </ul>
          <p class="muted">訂單和資料庫是同一份試算表；要批次整理可到「🗂️ 資料庫」的「訂單」分頁。</p>
          <a class="gobtn" href="orders.html">前往訂單儀表板 →</a>
        </div>
      </details>

      <details class="acc" id="f-ai">
        <summary>🤖 AI 助手 <span class="sm">— 問一句就答 ＋ 🗣️ 中越對話</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>登入後，點按鈕或打字就能問公司資料：</p>
          <ul>
            <li><b>快速問答</b>（免設定、免費、即時）：本月要補哪些料、哪些訂單逾期、本月營收概況、待出貨清單、庫存過低品項。</li>
            <li><b>自由提問</b>：直接打一句話問，什麼都能聊（需啟用免費 AI，見下方）。</li>
            <li><b>🗣️ 中越對話</b>（頁面上方可切換的獨立模式）：讓老闆與越南員工雙向溝通——點<b>常用句</b>立刻同時顯示中文＋越南文（免登入、免設定、即時，把手機拿給對方看即可）；要講別的話就打字，按「中 → 越」或「越 → 中」翻譯（需啟用免費 AI）。</li>
          </ul>
          <h3>（選用）啟用「自由提問」：一次性設定（用免費 Groq）</h3>
          <ol>
            <li>去 <b>console.groq.com</b> 用 Google 登入，建立免費 API 金鑰（免綁卡，複製起來）。</li>
            <li>打開公司試算表 → 擴充功能 → Apps Script → 左側 <b>「專案設定」⚙️</b>。</li>
            <li>下方 <b>「指令碼屬性」→ 新增屬性</b>：名稱填 <b>GROQ_API_KEY</b>、值貼上金鑰 → 儲存。</li>
            <li>回程式碼把最新版 <code>google-apps-script.gs</code> 貼上、重新部署（新版本）即可。</li>
          </ol>
          <p class="muted">不設定也沒關係——快速問答與「教我用網站」本來就能用。</p>
          <a class="gobtn" href="assistant.html">前往 AI 助手 →</a>
        </div>
      </details>

      <details class="acc" id="f-notebook">
        <summary>🧠 NotebookLM 知識庫 <span class="sm">— 進階／選用</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>NotebookLM</b> 是 Google 的免費 AI 筆記工具。我們每天自動把公司的 ERP 現況（訂單、營收、待出貨、逾期、報價、往來重點）寫成一份 Google 文件；你把這份文件、加上公司自己的文件（SOP、報價政策、產品規格、合約…）放進 NotebookLM，它就變成一個<b>公司專屬 AI 知識庫</b>：</p>
          <ul>
            <li>🔎 <b>問答附出處</b>：問「這個月要補什麼料？」「跟大雅精密往來如何？」「我們報價怎麼抓？」。</li>
            <li>🎧 <b>音檔導覽</b>：把資料變成兩人對談的 Podcast，巡廠/開車用聽的。</li>
            <li>📋 <b>自動生成</b>：FAQ、教育訓練大綱、簡報、重點摘要。</li>
          </ul>
          <div class="tip">💡 重要：文件<b>不會自動</b>跑進 NotebookLM——<b>第一次要手動「加來源」一次</b>；之後系統改寫<b>同一份</b>文件，你在 NotebookLM 該來源按「同步」就更新，不必重加。</div>
          <p class="muted">它負責「文件知識庫＋問答/音檔」，跟網站的「即時運算/儀表板」互補。設定步驟（貼 <code>notebooklm-export.gs</code>、開每日更新、加來源）由工程師協助一次即可。</p>
          <a class="gobtn" id="nbGo" href="https://notebooklm.google.com" target="_blank" rel="noopener">開啟 NotebookLM →</a>
        </div>
      </details>

      <details class="acc" id="f-email">
        <summary>📧 信箱通知 <span class="sm">— 每日自動寄早報給你</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p>系統每天早上用公司 Gmail 帳號，自動把 ERP 現況寄到你信箱，不用開網站就收到重點：</p>
          <ul>
            <li><b>每日 ERP 早報</b>：本月營收、待出貨、逾期未出貨、最近報價，加原料行情。</li>
            <li><b>警示</b>：有訂單逾期時，信件主旨會帶 <b>⚠️</b>，一眼看出今天要注意什麼。</li>
          </ul>
          <div class="tip">💡 一次性設定（工程師協助）：貼 <code>email-notify.gs</code>、在指令碼屬性填 <b>NOTIFY_EMAILS</b>（收件人 email）、執行 <code>installEmailTrigger</code> 開每日自動。</div>
          <a class="gobtn" href="https://mail.google.com" target="_blank" rel="noopener">開啟 Gmail →</a>
        </div>
      </details>
    </div>
    <script>(function(){{var u=(window.APP_CONFIG||{{}}).NOTEBOOK_URL;var g=document.getElementById("nbGo");if(g&&u)g.href=u;}})();</script>

    <div class="q">
      <h2>🧮 試玩看看：報價怎麼算</h2>
      <p class="muted">拉一拉、選一選，數字會即時變。這只是<b>示範</b>用近似料價；實際報價頁會帶入當天最新原料價。</p>
      <div class="demo">
        <div class="row">
          <label>材質
            <select id="dMat">
              <option data-p="90" value="不鏽鋼">不鏽鋼（約 90/kg）</option>
              <option data-p="320" value="銅">銅（約 320/kg）</option>
              <option data-p="95" value="鋁">鋁（約 95/kg）</option>
              <option data-p="40" value="碳鋼">碳鋼／鐵（約 40/kg）</option>
            </select>
          </label>
          <label>重量（kg）
            <input id="dW" type="number" min="0" step="0.1" value="3">
          </label>
          <label>加工＋利潤倍數 <span id="dMx" class="muted">2.2×</span>
            <input id="dMul" type="range" min="1.5" max="3" step="0.1" value="2.2">
          </label>
        </div>
        <div class="out">建議報價：<b id="dQ">NT$ —</b></div>
        <div class="brk" id="dBrk"></div>
      </div>
    </div>

    <div class="q" id="db">
      <h2>🔐 資料庫怎麼用（重點）</h2>
      <p>「資料庫」就是把你在網站上做的<b>收藏、標記、報價</b>統統存進公司自己的 <b>Google 試算表</b>，
      這樣換手機、換電腦都看得到同一份，不會不見。</p>

      <h3>第一步：用 Google 登入</h3>
      <ul class="steps">
        <li>點右上角的「使用 Google 帳戶登入」按鈕。</li>
        <li>選公司的 Google 帳號登入。</li>
        <li>登入後右上角會顯示 👤 名字，就成功了。</li>
      </ul>
      <div class="tip">💡 登入之後<b>切換分頁不會登出</b>，大約一小時後才需要再登入一次（這是 Google 的安全設計，正常）。</div>

      <h3>登入後能做什麼（下面可以試玩）</h3>
      <div class="demo">
        <div class="row">
          <span>⭐ 收藏：點星星試試 →</span>
          <span class="star" id="dStar" role="button" tabindex="0">☆</span>
          <span class="muted" id="dStarTxt">未收藏</span>
        </div>
        <div class="row">
          <span>狀態：點按鈕切換 →</span>
          <button class="stbtn" data-v="已聯絡">已聯絡</button>
          <button class="stbtn" data-v="合作中">合作中</button>
          <button class="stbtn" data-v="不合適">不合適</button>
          <span class="muted" id="dStatTxt">未設定</span>
        </div>
      </div>
      <ul>
        <li><b>⭐ 收藏</b>：點名單上的星星收藏；勾「只看收藏」就只顯示收藏的。</li>
        <li><b>狀態</b>：每列可標「已聯絡／合作中／不合適」。</li>
        <li><b>📝 備註</b>：想記什麼就打在備註欄。</li>
        <li><b>📅 排提醒</b>：一鍵開 Google 日曆，預填好「拜訪某公司」事件。</li>
        <li><b>🧮 報價歷史</b>：報價頁按「存這筆」，紀錄會存進試算表。</li>
      </ul>
      <p>以上全部會同步到公司的 Google 試算表。</p>

      <h3>🗂️ 資料庫操作中心（免開試算表）</h3>
      <p>上方分頁的「🗂️ 資料庫」是<b>站內操作中心</b>——不必打開 Google 試算表，直接在網站上就能管理資料：</p>
      <ul>
        <li><b>三個資料表</b>：我的名單/待辦、收藏與標記、報價歷史，點分頁切換。</li>
        <li><b>新增／編輯／刪除</b>：點「＋ 新增」或每列的 ✏️／🗑️，跳出小表單填一填就好。</li>
        <li><b>搜尋／篩選／排序</b>：上方搜尋框打字即時過濾、點欄位標題排序、用下拉篩狀態。</li>
        <li><b>⬇ 匯出 CSV</b>：一鍵下載成 Excel 可開的檔案。</li>
        <li><b>可視化</b>：上方有筆數與各狀態統計、分佈長條圖。</li>
        <li><b>新手</b>：第一次用可按「載入範例資料」看看長怎樣，之後再清掉。</li>
      </ul>
      <div class="tip">💡 手機上表格會自動變成一張張卡片，好點好讀。需要看原始試算表時，操作中心底部也有「開啟原始試算表」連結。</div>
      <a class="gobtn" href="db.html">前往資料庫操作中心 →</a>
    </div>

    <div class="q" id="faq">
      <h2>❓ 常見問題</h2>
      <details class="acc" open>
        <summary>登出了怎麼辦？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>再點一次右上角「使用 Google 帳戶登入」就好。收藏／備註都還在（存在試算表裡，不會不見）。</p></div>
      </details>
      <details class="acc">
        <summary>看不到最新資料？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>按 <kbd>Ctrl</kbd> + <kbd>F5</kbd>（Mac 是 <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>）強制重新整理一次即可。原料價一天更新兩次，其他名單每天更新。</p></div>
      </details>
      <details class="acc">
        <summary>名單好像只顯示一部分？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>頁面上為了速度只放最相關的前 600 筆（已按「離神岡近／有分類」排序）。<b>完整名單</b>在 Google 試算表裡，點首頁「🗂️ 九上資料庫」就能看全部。</p></div>
      </details>
      <details class="acc">
        <summary>要錢嗎？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>不用。整套都跑在免費服務上（GitHub + Google），關機也會自己在雲端更新。</p></div>
      </details>
      <details class="acc">
        <summary>右上角🌙是什麼？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>切換深色／淺色模式，看你眼睛舒服。設定會記住。</p></div>
      </details>
    </div>

    <div class="foot">有任何看不懂的地方，回到這頁再看一次就好。全部免費、自動更新。</div>
  </div>
  <script>
  (function(){{
    // 報價示範
    var mat=document.getElementById("dMat"), w=document.getElementById("dW"),
        mul=document.getElementById("dMul"), mx=document.getElementById("dMx"),
        q=document.getElementById("dQ"), brk=document.getElementById("dBrk");
    function calc(){{
      var p=parseFloat(mat.options[mat.selectedIndex].getAttribute("data-p"))||0;
      var kg=parseFloat(w.value)||0, m=parseFloat(mul.value)||2.2;
      mx.textContent=m.toFixed(1)+"×";
      var cost=p*kg, quote=Math.round(cost*m);
      q.textContent="NT$ "+quote.toLocaleString();
      brk.textContent="材料成本 NT$ "+Math.round(cost).toLocaleString()+"（"+p+"/kg × "+kg+"kg）× "+m.toFixed(1)+" 倍（含加工與利潤）";
    }}
    if(mat){{ [mat,w,mul].forEach(function(el){{ el.addEventListener("input",calc); }}); calc(); }}
    // 收藏星星示範
    var star=document.getElementById("dStar"), stxt=document.getElementById("dStarTxt"), on=false;
    function toggleStar(){{ on=!on; star.textContent=on?"⭐":"☆"; stxt.textContent=on?"已收藏":"未收藏"; }}
    if(star){{ star.addEventListener("click",toggleStar);
      star.addEventListener("keydown",function(e){{ if(e.key==="Enter"||e.key===" "){{ e.preventDefault(); toggleStar(); }} }}); }}
    // 狀態按鈕示範
    var stat=document.getElementById("dStatTxt");
    Array.prototype.forEach.call(document.querySelectorAll(".stbtn"),function(b){{
      b.addEventListener("click",function(){{
        var was=b.classList.contains("on");
        document.querySelectorAll(".stbtn").forEach(function(x){{ x.classList.remove("on"); }});
        if(!was){{ b.classList.add("on"); stat.textContent="已標記："+b.getAttribute("data-v"); }}
        else {{ stat.textContent="未設定"; }}
      }});
    }});
  }})();
  </script>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 功能 B — 銅鋁儀表板
# ===========================================================================
def render_html(history: dict, daily: dict = None, news: list = None) -> str:
    daily = daily or {}
    metals_data = {}
    panels = []
    last_update = "—"

    for key, cfg in config.METALS.items():
        # 走勢圖資料：優先 daily.json 日線；無則退化用 prices.json 快照
        dseries = daily.get(key) or []
        if not dseries:
            dseries = [
                {"ts": p.get("ts"), "usd": p.get("price"), "rate": p.get("rate")}
                for p in history.get(key, [])
            ]
        metals_data[key] = {
            "name": cfg["name"], "en": cfg["en"],
            "series": dseries,
        }

        # 現價/告警：LME 官方（Westmetall）最新一筆
        hist = history.get(key, [])
        latest = hist[-1] if hist else {}
        price = latest.get("price")
        price_twd = latest.get("price_twd")
        rate = latest.get("rate")
        change = latest.get("change")

        if latest.get("ts"):
            try:
                dt = datetime.datetime.fromisoformat(latest["ts"]).astimezone(
                    datetime.timezone(datetime.timedelta(hours=8))
                )
                last_update = dt.strftime("%Y-%m-%d %H:%M")
            except Exception:  # noqa: BLE001
                pass

        price_txt = f"NT${price_twd:,}/t" if price_twd else "—"
        if change is not None and rate:
            nt_chg = round(change * rate)
            chg_txt = f'{"+" if nt_chg >= 0 else "−"}NT${abs(nt_chg):,}/t'
        else:
            chg_txt = "—"

        fb = _sparkline([d.get("usd") for d in dseries[-30:]], up=(change or 0) >= 0, w=600, h=200)

        panels.append(
            f"""
    <section class="mpanel" data-key="{key}">
      <div class="mhead">
        <div><span class="mname">{html.escape(cfg['name'])}</span><span class="men">{html.escape(cfg['en'])}</span></div>
      </div>
      <div class="mfigs">
        <div class="fig"><div class="flabel">現價（LME 官方）</div><div class="fval price">{price_txt}</div></div>
        <div class="fig"><div class="flabel">漲跌</div><div class="fval chg">{chg_txt}</div></div>
      </div>
      <div class="mstats">
        <span class="chip">7日 <b class="c7">—</b></span>
        <span class="chip">30日 <b class="c30">—</b></span>
        <span class="chip">90日 <b class="c90">—</b></span>
        <span class="chip">期間高 <b class="phi">—</b></span>
        <span class="chip">期間低 <b class="plo">—</b></span>
      </div>
      <div class="chart" data-chart="{key}">{fb}</div>
      <div class="legend"><span class="lg-line"></span>每日收盤（Yahoo）</div>
    </section>"""
        )

    # 原料相關新聞（run_metals 抓 Google 新聞傳入；本機重生時為空 → 顯示占位）
    if news:
        _items = "".join(
            f'<a class="newsitem" href="{html.escape(n.get("link", ""))}" target="_blank" rel="noopener">'
            f'<div class="nt">{html.escape(n.get("title", ""))}</div>'
            f'<div class="nm">{html.escape(n.get("source", ""))}'
            f'{" · " + html.escape(n.get("date", "")) if n.get("date") else ""}</div></a>'
            for n in news
        )
    else:
        _items = '<div class="mnote" style="padding:14px 4px">（新聞每日自動更新，稍後顯示）</div>'
    news_panel = (
        '<section class="mpanel newspanel">'
        '<div class="mhead"><div><span class="mname">📰 原料相關新聞</span>'
        '<span class="men">了解為什麼會漲跌</span></div></div>'
        f'<div class="newslist">{_items}</div></section>'
    )

    names = " · ".join(m["name"] for m in config.METALS.values())
    data_script = (
        "<script>window.METALS_DATA = " + json.dumps(metals_data, ensure_ascii=False) + ";</script>"
    )

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>銅鋁價格追蹤儀表板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("metals")}{_THEME_BTN}</div>
    <div class="eyebrow">METALS TRACKER · LME 倫敦金屬交易所</div>
    <h1>銅鋁價格追蹤儀表板</h1>
    <div class="sub">現價＝LME 官方結算價（Westmetall）· 走勢圖＝每日收盤（Yahoo）· 台幣依匯率換算 · 每日 10:00 與 22:00（台灣時間）更新</div>

    <div class="cards">
      <div class="card"><div class="k">追蹤金屬</div><div class="v">{len(config.METALS)} <span style="font-size:13px;color:var(--muted)">{names}</span></div></div>
      <div class="card"><div class="k">最後更新</div><div class="v" style="font-size:18px">{last_update}</div></div>
    </div>

    <div class="controls">
      <div class="btnbar unitbar">
        <button data-unit="twd_t">NT$/公噸</button>
        <button data-unit="usd_t">US$/公噸</button>
        <button data-unit="usd_lb">US$/磅</button>
        <button data-unit="twd_kg">NT$/公斤</button>
      </div>
      <div class="btnbar rangebar">
        <button data-range="30">30 天</button>
        <button data-range="90">90 天</button>
        <button data-range="365">1 年</button>
      </div>
    </div>
    <div class="unitnote">單位說明：<b>/t = 每公噸</b>（1 公噸＝1,000 公斤）· /lb ＝每磅 · /kg ＝每公斤 · NT$＝新台幣、US$＝美元。國際原料習慣用「每公噸」報價。</div>
{''.join(panels)}
{news_panel}
    <div class="foot">現價：LME 官方結算價（Westmetall）· 走勢圖：Yahoo Finance 每日收盤（銅為 COMEX 近月，與 LME 走勢近乎一致）· 匯率 Yahoo · 新聞：Google 新聞 · 單位由美元/公噸換算 · 僅供內部參考。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 功能 A（實驗版）— 金屬加工人才行情儀表板
# ===========================================================================
def _salary_disp(j: dict) -> str:
    lo, hi, kind = j.get("salary_low"), j.get("salary_high"), j.get("salary_kind")
    if lo is None:
        return {"面議": "面議", "時薪": "時薪", "yearly": "年薪制"}.get(kind, "—")
    if hi:
        return f"NT${lo:,}~{hi:,}"
    return f"NT${lo:,} 以上"


def _delta_span(v) -> str:
    if v is None:
        return ""
    if v > 0:
        return f'<span style="color:var(--up);font-size:13px">▲{v:,}</span>'
    if v < 0:
        return f'<span style="color:var(--down);font-size:13px">▼{abs(v):,}</span>'
    return '<span style="color:var(--muted);font-size:13px">持平</span>'


def render_jobs_html(stats: dict, summary: dict, jobs: list,
                     history: list, delta: dict) -> str:
    last_update = "—"
    if history:
        try:
            dt = datetime.datetime.fromisoformat(history[-1]["ts"]).astimezone(
                datetime.timezone(datetime.timedelta(hours=8))
            )
            last_update = dt.strftime("%Y-%m-%d %H:%M")
        except Exception:  # noqa: BLE001
            pass

    totals = [h.get("total") for h in history[-config.TREND_POINTS:]]
    meds = [h.get("salary_median") for h in history[-config.TREND_POINTS:]]
    spark_total = _sparkline(totals, up=(len(totals) >= 2 and (totals[-1] or 0) >= (totals[0] or 0)))
    spark_med = _sparkline(meds, up=(len(meds) >= 2 and (meds[-1] or 0) >= (meds[0] or 0)))

    med = f"NT${stats['salary_median']:,}" if stats["salary_median"] else "—"
    avg = f"NT${stats['salary_avg']:,}" if stats["salary_avg"] else "—"
    rng = (f"NT${stats['salary_min']:,} ~ NT${stats['salary_max']:,}"
           if stats["salary_min"] else "—")

    comp_rows = "".join(
        f"<tr><td>{html.escape(c)}</td><td class='num'>{n}</td></tr>"
        for c, n in stats["top_companies"]
    ) or "<tr><td>—</td><td></td></tr>"
    dist_rows = "".join(
        f"<tr><td>{html.escape(a)}</td><td class='num'>{n}</td></tr>"
        for a, n in stats["top_districts"]
    ) or "<tr><td>—</td><td></td></tr>"

    # 三張靜態長條圖
    dist_sal_bars = _hbars([(a, m, f"NT${m:,}") for a, m, _n in stats.get("district_salary", [])])
    cat_bars = _hbars([(lbl, n, str(n)) for lbl, n in stats.get("categories", [])])
    skill_bars = _hbars([(s, n, str(n)) for s, n in stats.get("skills", [])])

    # ⭐ 符合招募重點職缺（品管職 + 量測/金屬），依 match_score 排序
    pri = sorted([j for j in jobs if j.get("is_priority")],
                 key=lambda x: x.get("match_score", 0), reverse=True)
    pri_rows = "".join(
        f"""<tr><td><a href="{html.escape(j['url'])}" target="_blank" rel="noopener">{html.escape(j['title'][:40])}</a></td>
        <td>{html.escape(j['company'][:22])}</td><td>{html.escape(j.get('district','—'))}</td>
        <td class="num">{_salary_disp(j)}</td></tr>""" for j in pri[:20]
    ) or '<tr><td colspan="4" style="color:var(--muted)">今日無完全符合招募重點的職缺（品管＋量測/金屬）。可看下方完整清單。</td></tr>'

    # 完整清單後備（依薪資高→低）
    def _mid(j):
        lo, hi = j.get("salary_low"), j.get("salary_high")
        return (lo + hi) / 2 if (lo and hi) else (lo or 0)
    fb = sorted(jobs, key=_mid, reverse=True)[:30]
    fb_rows = "".join(
        f"""<tr><td>{'⭐ ' if j.get('is_priority') else ''}<a href="{html.escape(j['url'])}" target="_blank" rel="noopener">{html.escape(j['title'][:40])}</a></td>
        <td>{html.escape(j['company'][:22])}</td><td>{html.escape(j.get('district','—'))}</td>
        <td class="num">{_salary_disp(j)}</td></tr>""" for j in fb
    ) or '<tr><td colspan="4">—</td></tr>'

    # 招募重點參考卡
    rp = config.RECRUIT_PROFILE
    ref_card = f"""
    <div class="ai" style="border-left:3px solid var(--accent)">
      <h2>🎯 招募重點（{html.escape(rp['title'])}）</h2>
      <div class="refgrid">
        <div><span class="rk">職缺</span>{html.escape(rp['role'])}</div>
        <div><span class="rk">產業</span>{html.escape(rp['industry'])}</div>
        <div><span class="rk">地區</span>{html.escape(rp['region'])}</div>
        <div><span class="rk">設備技能</span>{html.escape(rp['equipment'])}</div>
        <div><span class="rk">經歷要求</span>{html.escape(rp['experience'])}</div>
        <div><span class="rk">現況</span>{html.escape(rp['context'])}</div>
      </div>
      <div class="reftags">錄取關鍵字：{' '.join('<span class="rtag">'+html.escape(k)+'</span>' for k in rp['keywords'])}
        <span class="rnote">※ 2.5D＝2.5 次元影像量測儀</span></div>
    </div>"""

    jobs_min = [
        {"title": j["title"], "company": j["company"], "url": j["url"], "area": j["area"],
         "district": j.get("district", "其他"), "salary_low": j["salary_low"],
         "salary_high": j["salary_high"], "salary_kind": j["salary_kind"],
         "is_priority": bool(j.get("is_priority")), "match_score": j.get("match_score", 0)}
        for j in jobs
    ]
    hist_min = [
        {"ts": h.get("ts"), "total": h.get("total"), "salary_median": h.get("salary_median")}
        for h in history
    ]
    data_script = (
        "<script>window.JOBS_DATA = " + json.dumps(jobs_min, ensure_ascii=False) + ";"
        "window.JOBS_HISTORY = " + json.dumps(hist_min, ensure_ascii=False) + ";</script>"
    )

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>台中・金屬加工・品管招募雷達</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("jobs")}{_THEME_BTN}</div>
    <div class="eyebrow">TALENT RADAR · 104 公開職缺 · 聚焦台中</div>
    <h1>台中・金屬加工・品管招募雷達</h1>
    <div class="sub">聚焦台中（潭雅神清水）金屬加工品管職 · 104 公開職缺每日 08:00 彙整 · ⭐＝符合招募重點（品管＋量測/金屬）· 僅供招募參考</div>

    {ref_card}

    <div class="cards four">
      <div class="card"><div class="k">台中職缺數</div><div class="v">{stats['total']} {_delta_span(delta.get('total'))}</div><div class="spk">{spark_total}</div></div>
      <div class="card"><div class="k">⭐ 符合招募重點</div><div class="v">{stats.get('priority_count', 0)}</div><div class="k" style="margin-top:6px">品管＋量測/金屬</div></div>
      <div class="card"><div class="k">月薪中位數</div><div class="v">{med} {_delta_span(delta.get('salary_median'))}</div><div class="spk">{spark_med}</div></div>
      <div class="card"><div class="k">月薪平均</div><div class="v">{avg}</div><div class="k" style="margin-top:6px">區間 {rng}</div></div>
    </div>

    <div class="ai">
      <h2>🔧 {html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">💰 薪資行情</div><div class="txt">{html.escape(summary.get('salary',''))}</div></div>
      <div class="row"><div class="lbl">📈 供給熱度</div><div class="txt">{html.escape(summary.get('demand',''))}</div></div>
      <div class="row"><div class="lbl">🛠️ 對症技能</div><div class="txt">{html.escape(summary.get('skills',''))}</div></div>
      <div class="row"><div class="lbl">💡 招募建議</div><div class="txt">{html.escape(summary.get('advice',''))}</div></div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <h3>⭐ 符合招募重點的職缺（品管＋量測/金屬）</h3>
      <table>
        <thead><tr><th>職缺</th><th>公司</th><th>行政區</th><th class="num">月薪</th></tr></thead>
        <tbody>{pri_rows}</tbody>
      </table>
    </div>

    <div class="grid2">
      <section class="mpanel"><div class="mhead"><div><span class="mname">台中職缺數</span><span class="men">趨勢</span></div></div><div class="chart sm" data-chart="jobsTotal"></div></section>
      <section class="mpanel"><div class="mhead"><div><span class="mname">月薪中位數</span><span class="men">趨勢</span></div></div><div class="chart sm" data-chart="jobsMed"></div></section>
    </div>

    <div class="grid2">
      <div class="panel"><h3>🏢 徵才較多的公司</h3><table><tbody>{comp_rows}</tbody></table></div>
      <div class="panel"><h3>📍 台中徵才熱區（行政區）</h3><table><tbody>{dist_rows}</tbody></table></div>
    </div>

    <div class="panel" style="margin-bottom:16px"><h3>💵 各行政區月薪中位數</h3>{dist_sal_bars}</div>

    <div class="grid2">
      <div class="panel"><h3>🗂️ 職務類別分布</h3>{cat_bars}</div>
      <div class="panel"><h3>🏷️ 熱門技能關鍵字</h3>{skill_bars}</div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <h3>📊 月薪分布</h3>
      <div class="hist" id="hist"></div>
    </div>

    <div class="panel">
      <h3>🔎 職缺清單</h3>
      <div class="toolbar" style="padding:0 16px 12px">
        <input id="jobSearch" placeholder="搜尋職缺 / 公司關鍵字…">
        <select id="jobArea"><option value="">全部行政區</option></select>
        <label class="prionly"><input type="checkbox" id="jobPriority"> 只看 ⭐ 符合招募重點</label>
        <label class="prionly"><input type="checkbox" id="jobFav"> 只看我收藏的</label>
        <select id="jobStatus"><option value="">狀態：全部</option><option>已聯絡</option><option>合作中</option><option>不合適</option></select>
        <span class="count" id="jobCount"></span>
      </div>
      <table>
        <thead><tr>
          <th class="sortable" data-key="title">職缺 <span class="arrow"></span></th>
          <th class="sortable" data-key="company">公司 <span class="arrow"></span></th>
          <th class="sortable" data-key="district">行政區 <span class="arrow"></span></th>
          <th class="sortable num" data-key="salary">月薪 <span class="arrow"></span></th>
          <th>追蹤（狀態/備註）</th>
        </tr></thead>
        <tbody id="jobBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：104 人力銀行公開職缺（聚焦台中）· 最後更新 {last_update} · ⭐＝品管職且命中量測/金屬關鍵字 · 僅供內部招募參考，非即時、不含企業人才庫。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 功能 C — 供應商雷達（九上科技找金屬加工供應商）
# ===========================================================================
_SRC_LABEL = {"104": "104", "gov": "政府", "both": "政府+104"}


def render_suppliers_html(profile: dict, stats: dict, summary: dict, suppliers: list) -> str:
    EMBED_CAP = 600  # 前端內嵌上限（已依 score 排序，取前段；完整名單在 data/*.json 與試算表）
    embed = suppliers[:EMBED_CAP]

    cat_bars = _hbars([(c, n, str(n)) for c, n in stats.get("categories", [])])
    area_bars = _hbars([(a, n, str(n)) for a, n in stats.get("top_areas", [])])

    def _size(s):
        if s.get("capital"):
            return f"資本額 {s['capital']}"
        if s.get("employees"):
            return f"員工 {s['employees']} 人"
        return "—"

    fb = suppliers[:40]
    fb_rows = ""
    for s in fb:
        name_cell = (
            f'<a href="{html.escape(s["url"])}" target="_blank" rel="noopener">{html.escape(s["name"][:34])}</a>'
            if s.get("url") else html.escape(s["name"][:34])
        )
        star = "⭐ " if s.get("is_near") else ""
        fb_rows += (
            f"<tr><td>{star}{name_cell}</td><td>{html.escape(s.get('category',''))}</td>"
            f"<td>{html.escape(s.get('area','') or '—')}</td><td>{html.escape(_size(s))}</td>"
            f"<td>{_SRC_LABEL.get(s.get('source'),'')}</td><td></td></tr>"
        )
    fb_rows = fb_rows or '<tr><td colspan="6">—</td></tr>'

    sup_min = [
        {"name": s["name"], "url": s.get("url", ""), "area": s.get("area", ""),
         "category": s.get("category", ""), "size": _size(s),
         "source": _SRC_LABEL.get(s.get("source"), ""), "is_near": bool(s.get("is_near")),
         "address": s.get("address", ""), "ban": s.get("ban", "")}
        for s in embed
    ]
    data_script = ("<script>window.SUPPLIERS_DATA = "
                   + json.dumps(sup_min, ensure_ascii=False) + ";</script>")

    needs = "".join(f'<span class="rtag">{html.escape(n)}</span>' for n in profile["needs"])
    ref_card = f"""
    <div class="ai" style="border-left:3px solid var(--accent)">
      <h2>🎯 找供應商的客戶（{html.escape(profile['name'])}）</h2>
      <div class="refgrid">
        <div><span class="rk">地區</span>{html.escape(profile['address'])}</div>
        <div><span class="rk">本業</span>{html.escape(profile['business'])}</div>
      </div>
      <div class="reftags">要找的供應商能力：{needs}
        <span class="rnote">※ 神岡周邊（豐原/大雅/潭子/后里/大甲）標 ⭐近</span></div>
    </div>"""

    total = stats["total"]
    shown = len(embed)
    src_txt = "、".join(f"{_SRC_LABEL.get(k, k)} {v}" for k, v in stats.get("sources", {}).items())

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<title>九上科技 · 供應商雷達</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("suppliers")}{_THEME_BTN}</div>
    <div class="eyebrow">SUPPLIER RADAR · 104 公司 + 政府稅籍登記</div>
    <h1>供應商雷達 · 九上科技</h1>
    <div class="sub">幫九上科技（神岡）找台灣金屬加工供應商 · 全台皆列、神岡周邊優先 ⭐ · 每月 1 號更新 · 僅供採購參考</div>

    {ref_card}

    <div class="cards four">
      <div class="card"><div class="k">供應商總數</div><div class="v">{total}</div></div>
      <div class="card"><div class="k">⭐ 神岡周邊</div><div class="v">{stats['near_count']}</div><div class="k" style="margin-top:6px">豐原/大雅/潭子…</div></div>
      <div class="card"><div class="k">來源</div><div class="v" style="font-size:15px">{src_txt or '—'}</div></div>
      <div class="card"><div class="k">有官網連結</div><div class="v">{stats.get('with_url', 0)}</div><div class="k" style="margin-top:6px">可直接看公司</div></div>
    </div>

    <div class="ai">
      <h2>🏭 {html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">🎯 優先推薦</div><div class="txt">{html.escape(summary.get('recommend',''))}</div></div>
      <div class="row"><div class="lbl">🔍 評估重點</div><div class="txt">{html.escape(summary.get('evaluate',''))}</div></div>
      <div class="row"><div class="lbl">💬 詢價 / 打樣</div><div class="txt">{html.escape(summary.get('quote',''))}</div></div>
      <div class="row"><div class="lbl">⚠️ 風險提醒</div><div class="txt">{html.escape(summary.get('risk',''))}</div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h3>🗂️ 能力類別分布</h3>{cat_bars}</div>
      <div class="panel"><h3>📍 供應商所在地</h3>{area_bars}</div>
    </div>

    <div class="panel">
      <h3>🔎 供應商名錄（顯示前 {shown} 家 · 共 {total} 家）</h3>
      <div class="toolbar" style="padding:0 16px 12px">
        <input id="supSearch" placeholder="搜尋公司 / 地區關鍵字…">
        <select id="supCat"><option value="">全部能力類別</option></select>
        <label class="prionly"><input type="checkbox" id="supNear"> 只看 ⭐ 神岡周邊</label>
        <label class="prionly"><input type="checkbox" id="supFav"> 只看我收藏的</label>
        <select id="supStatus"><option value="">狀態：全部</option><option>已聯絡</option><option>合作中</option><option>不合適</option></select>
        <div class="btnbar viewbar"><button data-view="list" class="on">📋 清單</button><button data-view="map">🗺️ 地圖</button></div>
        <span class="count" id="supCount"></span>
      </div>
      <div id="supMap" class="supmap" style="display:none"></div>
      <table id="supTable">
        <thead><tr>
          <th class="sortable" data-key="name">公司 <span class="arrow"></span></th>
          <th class="sortable" data-key="category">能力類別 <span class="arrow"></span></th>
          <th class="sortable" data-key="area">地區 <span class="arrow"></span></th>
          <th>規模</th>
          <th class="sortable" data-key="source">來源 <span class="arrow"></span></th>
          <th>追蹤（狀態/備註）</th>
        </tr></thead>
        <tbody id="supBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">來源：104 公司搜尋（Playwright）＋ 財政部營業稅籍登記開放資料（篩臺中金屬）· 完整名單見 repo 的 data/suppliers.json · 名單為公開資料，實際產能/品質/認證請自行電話與實地查核。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 報價試算器（純前端；內嵌各金屬當前 NT$/kg 與密度）
# ===========================================================================
_DENSITY = {"copper": 8.96, "aluminum": 2.70, "steel": 7.85, "stainless": 7.93}


def render_quote_html(history: dict) -> str:
    def _nt_per_kg(key):
        s = history.get(key, [])
        twd = s[-1].get("price_twd") if s else None
        return round(twd / 1000, 1) if twd else None

    mats = [
        {"key": "copper", "name": "銅", "nt": _nt_per_kg("copper"),
         "density": _DENSITY["copper"], "live": True},
        {"key": "aluminum", "name": "鋁", "nt": _nt_per_kg("aluminum"),
         "density": _DENSITY["aluminum"], "live": True},
        {"key": "stainless", "name": "不鏽鋼(304)", "nt": 90.0,
         "density": _DENSITY["stainless"], "live": False,
         "note": "不鏽鋼無即時行情，預設為參考值，請填你的實際採購價"},
        {"key": "steel", "name": "鋼(碳鋼)", "nt": _nt_per_kg("steel"),
         "density": _DENSITY["steel"], "live": True},
    ]
    data_script = "<script>window.QUOTE_MATERIALS = " + json.dumps(mats, ensure_ascii=False) + ";</script>"

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>報價試算器 · 九上科技</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("quote")}{_THEME_BTN}</div>
    <div class="eyebrow">QUOTE · 原料成本 / 報價試算</div>
    <h1>報價試算器</h1>
    <div class="sub">選材質、填重量，用<b>當前原料行情</b>幫你算料錢＋建議報價 · 料價已帶入最新價、可自行修改</div>

    <div class="panel" style="padding:18px 20px;margin-bottom:16px">
      <div class="qform">
        <label class="qf"><span>材質</span>
          <select id="qMat"></select></label>
        <label class="qf"><span>重量（公斤）</span>
          <input id="qWeight" type="number" min="0" step="0.01" placeholder="直接輸入重量"></label>
        <div class="qf qdim"><span>或用尺寸算重量（公分）</span>
          <div class="qrow">
            <input id="qL" type="number" min="0" step="0.1" placeholder="長">
            <input id="qW" type="number" min="0" step="0.1" placeholder="寬">
            <input id="qH" type="number" min="0" step="0.1" placeholder="高">
            <button id="qCalc" type="button">算重量</button>
          </div></div>
        <label class="qf"><span>每公斤料價（NT$）</span>
          <input id="qPrice" type="number" min="0" step="0.1"></label>
        <div class="qnote" id="qPriceNote"></div>
        <label class="qf"><span>加工費（NT$，選填）</span>
          <input id="qProc" type="number" min="0" step="1" placeholder="車削/表面處理等"></label>
        <label class="qf"><span>利潤（%）</span>
          <input id="qMargin" type="number" min="0" step="1" value="20"></label>
      </div>
    </div>

    <div class="qresult" id="qResult">
      <div class="qr"><div class="qk">料錢</div><div class="qv" id="qMatCost">—</div></div>
      <div class="qr"><div class="qk">總成本（料＋工）</div><div class="qv" id="qTotal">—</div></div>
      <div class="qr big"><div class="qk">建議報價</div><div class="qv" id="qQuote">—</div></div>
    </div>
    <div style="text-align:center;margin:14px 0 18px"><button id="qSave" class="gbtn" style="font-size:14px;padding:9px 18px">💾 存這筆報價</button></div>

    <div class="panel">
      <h3>🧾 報價歷史</h3>
      <div id="qHistory" style="padding:8px 16px 14px"></div>
    </div>
    <div class="foot">料價為 LME/期貨原料行情換算之參考值，不含供應商加價、運費、稅；實際採購價請以報價單為準。此工具僅供快速估算。報價歷史存在瀏覽器（設定 Google 後改存公司試算表、可同步）。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 功能 D — 客戶開發雷達
# ===========================================================================
def render_customers_html(profile: dict, stats: dict, summary: dict, customers: list) -> str:
    EMBED_CAP = 600  # 前端內嵌上限（完整名單在 data/*.json 與試算表）
    embed = customers[:EMBED_CAP]
    cat_bars = _hbars([(c, n, str(n)) for c, n in stats.get("categories", [])])
    area_bars = _hbars([(a, n, str(n)) for a, n in stats.get("top_areas", [])])

    fb = customers[:40]
    fb_rows = ""
    for s in fb:
        name = (f'<a href="{html.escape(s["url"])}" target="_blank" rel="noopener">{html.escape(s["name"][:34])}</a>'
                if s.get("url") else html.escape(s["name"][:34]))
        fb_rows += (f"<tr><td>{name}</td><td>{html.escape(s.get('category',''))}</td>"
                    f"<td>{html.escape(s.get('area','') or '—')}</td>"
                    f"<td>{_SRC_LABEL.get(s.get('source'),'')}</td><td></td></tr>")
    fb_rows = fb_rows or '<tr><td colspan="5">—</td></tr>'

    cus_min = [
        {"name": s["name"], "url": s.get("url", ""), "area": s.get("area", ""),
         "category": s.get("category", ""), "source": _SRC_LABEL.get(s.get("source"), ""),
         "address": s.get("address", "")}
        for s in embed
    ]
    data_script = "<script>window.CUSTOMERS_DATA = " + json.dumps(cus_min, ensure_ascii=False) + ";</script>"

    ref_card = f"""
    <div class="ai" style="border-left:3px solid var(--accent)">
      <h2>🎯 開發客戶的一方（{html.escape(profile['name'])}）</h2>
      <div class="refgrid">
        <div><span class="rk">本業</span>{html.escape(profile['business'])}</div>
        <div><span class="rk">賣點</span>精密車削・ISO・神岡在地・可小量打樣快交期</div>
      </div>
      <div class="reftags">目標客戶：會用到精密金屬零件的產業（光學/醫療/半導體/工具機/自行車…）</div>
    </div>"""

    total = stats["total"]
    shown = len(embed)
    src_txt = "、".join(f"{_SRC_LABEL.get(k, k)} {v}" for k, v in stats.get("sources", {}).items())

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 客戶開發雷達</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("customers")}{_THEME_BTN}</div>
    <div class="eyebrow">CUSTOMER RADAR · 104 公司 + 政府稅籍登記</div>
    <h1>客戶開發雷達 · 九上科技</h1>
    <div class="sub">找「會買精密金屬零件」的潛在客戶（全台）· 每月 1 號更新 · 僅供業務開發參考</div>

    {ref_card}

    <div class="cards">
      <div class="card"><div class="k">潛在客戶</div><div class="v">{total}</div></div>
      <div class="card"><div class="k">有官網連結</div><div class="v">{stats.get('with_url', 0)}</div><div class="k" style="margin-top:6px">好找聯絡窗口</div></div>
      <div class="card"><div class="k">來源</div><div class="v" style="font-size:15px">{src_txt or '—'}</div></div>
    </div>

    <div class="ai">
      <h2>🎯 {html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">🎯 優先鎖定</div><div class="txt">{html.escape(summary.get('target',''))}</div></div>
      <div class="row"><div class="lbl">📨 如何切入</div><div class="txt">{html.escape(summary.get('approach',''))}</div></div>
      <div class="row"><div class="lbl">💪 我方賣點</div><div class="txt">{html.escape(summary.get('pitch',''))}</div></div>
      <div class="row"><div class="lbl">⚠️ 提醒</div><div class="txt">{html.escape(summary.get('risk',''))}</div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h3>🗂️ 目標產業分布</h3>{cat_bars}</div>
      <div class="panel"><h3>📍 客戶所在地</h3>{area_bars}</div>
    </div>

    <div class="panel">
      <h3>🔎 客戶名錄（顯示前 {shown} 家 · 共 {total} 家）</h3>
      <div class="toolbar" style="padding:0 16px 12px">
        <input id="custSearch" placeholder="搜尋公司 / 地區關鍵字…">
        <select id="custCat"><option value="">全部產業</option></select>
        <label class="prionly"><input type="checkbox" id="custFav"> 只看我收藏的</label>
        <select id="custStatus"><option value="">狀態：全部</option><option>已聯絡</option><option>合作中</option><option>不合適</option></select>
        <span class="count" id="custCount"></span>
      </div>
      <table>
        <thead><tr>
          <th class="sortable" data-key="name">公司 <span class="arrow"></span></th>
          <th class="sortable" data-key="category">目標產業 <span class="arrow"></span></th>
          <th class="sortable" data-key="area">地區 <span class="arrow"></span></th>
          <th class="sortable" data-key="source">來源 <span class="arrow"></span></th>
          <th>追蹤（狀態/備註）</th>
        </tr></thead>
        <tbody id="custBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">來源：104 公司搜尋（Playwright）＋ 財政部營業稅籍登記開放資料（依目標產業篩選）· 完整名單見 data/customers.json · 名單為公開資料推估，實際採購需求請自行查證。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""
