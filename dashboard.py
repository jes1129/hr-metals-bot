# -*- coding: utf-8 -*-
"""
dashboard.py — 儀表板 HTML render（首頁 index.html + 各功能頁）。

樣式與互動在 docs/assets/style.css、docs/assets/app.js（手寫、常駐、只提交一次）。
這裡產出 HTML 骨架並內嵌資料 <script>window.XXX = {...}</script>，前端 JS 負責
單位切換與銅鋁日線走勢圖、期間統計，以及各 ERP 模組互動。

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
    f'<script src="assets/palette.js?v={_VER}" defer></script>\n'
    '<script src="https://accounts.google.com/gsi/client" async defer></script>'
)
# topbar 右側：Google 登入狀態 + 深淺色切換
def _ic(name: str, cls: str = "") -> str:
    """單色線條圖示（docs/assets/icons.svg 的 symbol；顏色跟隨文字色）。"""
    c = f"ic {cls}" if cls else "ic"
    return f'<svg class="{c}" aria-hidden="true"><use href="assets/icons.svg#{name}"/></svg>'


_THEME_BTN = ('<div class="toplinks">'
              '<button type="button" id="paletteBtn" class="tsearch" aria-label="搜尋（Ctrl+K）">' + _ic("search") + '搜尋<kbd>Ctrl K</kbd></button>'
              '<a href="help.html#start">' + _ic("play") + '快速上手</a>'
              '<a href="quote.html">' + _ic("plus") + '新增報價</a>'
              '</div>'
              '<span id="gAuth" class="gauth"></span>'
              '<button id="themeBtn" class="theme-btn" aria-label="切換深淺色">' + _ic("moon") + '</button>')


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
    """頂欄品牌 + 左側選單（工廠控制室版面）。外層 .topbar 由 CSS 固定成頂欄，.side 固定在左側。"""
    def item(key, href, icon, label):
        on = ' class="on" aria-current="page"' if active == key else ""
        return f'<a{on} href="{href}">{_ic(icon)}<span>{label}</span></a>'
    return (
        '<a class="brand" href="index.html"><span class="brand-mark">九</span>'
        '<span class="brand-name">九上科技<small>智慧儀表板</small></span></a>'
        '<nav class="side" aria-label="主要功能">'
        '<div class="side-label">總覽</div>'
        + item("home", "index.html", "home", "今日總覽")
        + item("metals", "metals.html", "ingot", "原料行情")
        + '<div class="side-label">營運</div>'
        + item("quote", "quote.html", "calc", "報價試算")
        + item("orders", "orders.html", "clipboard", "訂單看板")
        + item("erp", "erp.html", "factory", "ERP 作業")
        + item("sched", "schedule.html", "gantt", "生產排程")
        + item("admin", "admin.html", "users", "行政工作台")
        + '<div class="side-label">工具</div>'
        + item("db", "db.html", "db", "資料庫")
        + item("help", "help.html", "book", "使用說明")
        + "</nav>"
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
        f'<div class="he">{_ic(emoji) if emoji else ""}</div>'
        f'<div class="ht">{html.escape(title)}</div>'
        f'<div class="hl">{lines}</div>'
        f'<div class="hcta">{html.escape(cta)} →</div>'
        "</a>"
    )


def render_home(history: dict, sup_total, sup_near, cust_total=None) -> str:
    # 大焦點：最常用的兩張主卡（訂單、每日早報）
    def _feat(href, icon, title, note, cta, ext=False, cid=""):
        idattr = f' id="{cid}"' if cid else ""
        tgt = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<a class="hfcard"{idattr} href="{href}"{tgt}>'
                f'<div class="hfic">{_ic(icon)}</div>'
                f'<div class="hfbody"><div class="hft">{title}</div><div class="hfl">{note}</div></div>'
                f'<div class="hfcta">{cta}{_ic("arrow", "after")}</div></a>')
    feat = (
        _feat("erp.html", "factory", "ERP 作業",
              "庫存成本、報價、訂單出貨收款、工單、客戶案件，一頁看本月銷售、毛利與缺料。", "打開 ERP")
        + _feat("https://mail.google.com", "mail", "每日早報信箱",
                "每天自動收 ERP 早報：待出貨、逾期、原料行情。", "開啟信箱", ext=True)
    )

    # 小捷徑：其餘功能收成一排 icon 格
    def _q(href, icon, label, ext=False, cid=""):
        idattr = f' id="{cid}"' if cid else ""
        tgt = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<a class="hq"{idattr} href="{href}"{tgt}>'
                f'<span class="hqi">{_ic(icon)}</span><span class="hqt">{label}</span></a>')
    quick_items = [
        _q("orders.html", "box", "訂單管理"),
        _q("erp.html", "factory", "ERP 作業"),
        _q("schedule.html", "gantt", "生產排程"),
        _q("admin.html", "users", "行政工作台"),
        _q("metals.html", "ingot", "原料行情"),
        _q("quote.html", "calc", "報價試算"),
    ]
    quick_items += [
        _q("db.html", "db", "九上資料庫", cid="dbCard"),
        _q("https://notebooklm.google.com", "notebook", "NotebookLM", ext=True, cid="nbCard"),
        _q("help.html", "book", "使用說明"),
    ]
    quick = "".join(quick_items)

    _tw = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    now = _tw.strftime("%Y-%m-%d %H:%M")
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
      <h1>{_ic('bars')}今日總覽</h1>
      <div class="sub">今天 {date_s}　·　這裡是今日重點 · 更新於 {now}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-k">{_ic('truck')}待出貨</div><div class="stat-v" id="stShip">—</div></div>
      <div class="stat" id="stOverCard"><div class="stat-k">{_ic('clock')}逾期未出貨</div><div class="stat-v" id="stOver">—</div></div>
      <div class="stat"><div class="stat-k">{_ic('box')}本月訂單</div><div class="stat-v" id="stCnt">—</div></div>
    </div>
    <div class="stats-hint" id="stHint">登入後這裡會帶入你的即時數字（待出貨、逾期、本月訂單數）</div>
    <div id="pinBox"></div>
    <div class="hfeat">{feat}</div>
    <div class="hqlabel">快速前往</div>
    <div class="hquick">{quick}</div>
    <div class="foot">原料價每日自動更新；報價用最新原料行情試算。全部免費、關機也會自己跑。</div>
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
    <h1>{_ic('db')}資料庫操作中心</h1>
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
# 訂單 + 進度儀表板（📦 建單/狀態看板；不顯示金額；資料走 orders 資料表）
# ===========================================================================
def render_orders_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 訂單看板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("orders")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('box')}訂單 · 進度儀表板</h1>
    <div class="sub">一眼看待辦：待出貨、逾期，加狀態看板追每張單進度 · 更新於 {now}</div>
    <div id="ordersView" class="ordersview">
      <div class="dbloading">載入中…（若一直沒出現，請先用右上角「使用 Google 帳戶登入」）</div>
    </div>
    <div class="foot">訂單存在公司自己的 Google 試算表（與資料庫操作中心同一份、免費、多裝置同步）。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# ERP 作業（🏭 料號庫存 FIFO／進貨／報價／銷售訂單／BOM 工單／客戶商機）
#   規則在 docs/assets/erp-engine.js；資料走 Apps Script 的 ERP_ 分頁，未登入為本機試用。
# ===========================================================================
def render_erp_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<link rel="stylesheet" href="assets/erp.css?v={_VER}">
<title>九上科技 · ERP 作業</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("erp")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('factory')}ERP 作業</h1>
    <div class="sub">料號庫存（先進先出成本）· 進貨 · 報價 · 銷售訂單 · BOM／工單 · 客戶商機 · 客服案件 · 服務交付 · 專案 · 更新於 {now}</div>
    <div id="erpView" class="erpview">
      <div class="dbloading">載入中…</div>
    </div>
    <div class="foot">登入後資料存在公司 Google 試算表的「ERP_」分頁（多人共用、每筆操作留紀錄）；未登入時為本機試用，不會寫入公司資料。</div>
  </div>
  <script src="assets/erp-engine.js?v={_VER}"></script>
  <script src="assets/erp-admin.js?v={_VER}"></script>
  <script src="assets/erp.js?v={_VER}"></script>
  <script src="assets/erp-crm.js?v={_VER}"></script>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 行政工作台（組織與員工、週班表、出勤、申請簽核、設備預約、公告）
#   規則在 docs/assets/erp-admin.js；資料與 ERP 同一個後端（ERP_ 分頁），未登入為本機試用。
# ===========================================================================
def render_admin_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<link rel="stylesheet" href="assets/erp.css?v={_VER}">
<title>九上科技 · 行政工作台</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("admin")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('users')}行政工作台</h1>
    <div class="sub">組織與員工 · 週班表 · 出勤 · 申請簽核 · 設備預約 · 公告 · 更新於 {now}</div>
    <div id="adminView" class="erpview">
      <div class="dbloading">載入中…</div>
    </div>
    <div class="foot">登入後資料存在公司 Google 試算表的「ERP_」分頁（與 ERP 同一個後端）；未登入時為本機試用，不會寫入公司資料。</div>
  </div>
  <script src="assets/erp-engine.js?v={_VER}"></script>
  <script src="assets/erp-admin.js?v={_VER}"></script>
  <script src="assets/erp.js?v={_VER}"></script>
  <script src="assets/erp-admin-ui.js?v={_VER}"></script>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 生產排程（多站多機型排程、插單／急單／外包／機台故障重排、甘特圖）
#   計算在 docs/assets/sched-engine.js（瀏覽器背景執行緒 sched-worker.js；Node 測試共用），畫面在 sched.js。
#   設定與排程結果登入後存公司試算表「sched」分頁（通用資料表，免重新部署 Apps Script）；未登入存本機瀏覽器。
# ===========================================================================
def render_schedule_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<link rel="stylesheet" href="assets/erp.css?v={_VER}">
<link rel="stylesheet" href="assets/sched.css?v={_VER}">
<title>九上科技 · 生產排程</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("sched")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('gantt')}生產排程</h1>
    <div class="sub">多站多機台排程 · 插單／急單／外包／機台故障重排 · 甘特圖與準時預測 · 更新於 {now}</div>
    <div id="schedView" class="erpview">
      <div class="dbloading">載入中…</div>
    </div>
    <div class="foot">排程在你的瀏覽器裡計算，不會把訂單送到任何外部服務。登入後設定與排程存在公司 Google 試算表的「sched」分頁；未登入時只存在這台電腦。方法與文獻見「方法說明」分頁。</div>
  </div>
  <script src="assets/sched-engine.js?v={_VER}"></script>
  <script src="assets/sched-data.js?v={_VER}"></script>
  <script src="assets/sched.js?v={_VER}"></script>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
def render_help_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 使用說明</title>
<style>
  .help-layout {{ display: grid; grid-template-columns: minmax(0, 1fr) 236px; gap: 22px; align-items: start; }}
  .help-main {{ min-width: 0; }}
  .help-main > .q:first-child {{ margin-top: 0; }}
  .help-toc {{ position: sticky; top: calc(var(--topbar-h) + 24px); background: var(--card); border: 1px solid var(--line);
    border-top: 3px solid var(--accent); padding: 12px 0 10px; max-height: calc(100vh - var(--topbar-h) - 48px); overflow-y: auto; }}
  .help-toc .tt {{ font-family: var(--utility-font); font-size: 11px; letter-spacing: .16em; color: var(--muted); padding: 2px 16px 8px; }}
  .help-toc .tg {{ font-size: 11.5px; font-weight: 700; color: var(--muted2); padding: 12px 16px 4px; border-top: 1px solid var(--line2); margin-top: 6px; }}
  .help-toc a {{ display: flex; align-items: center; padding: 7px 16px 7px 13px; font-size: 13.5px; color: var(--text);
    text-decoration: none; border-left: 3px solid transparent; }}
  .help-toc a .ic {{ color: var(--muted); width: 16px; height: 16px; margin-right: 9px; }}
  .help-toc a:hover {{ background: var(--line2); color: var(--accent); text-decoration: none; }}
  .help-toc a.on {{ border-left-color: var(--secondary); color: var(--accent); background: var(--accent-soft); font-weight: 600; }}
  .help-toc a.on .ic {{ color: var(--accent); }}
  .help .groups {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 14px 0 6px; }}
  .help .group {{ border: 1px solid var(--line); border-left: 4px solid var(--secondary); background: var(--bg); padding: 12px 14px; }}
  .help .group b {{ display: flex; align-items: center; font-size: 15px; color: var(--text); }}
  .help .group b .ic {{ color: var(--accent); }}
  .help .group span {{ display: block; color: var(--muted); font-size: 13px; line-height: 1.75; margin-top: 4px; }}
  @media (min-width: 1100px) {{ .help .jumpbox {{ display: none; }} }}
  @media (max-width: 1099px) {{ .help-layout {{ grid-template-columns: minmax(0, 1fr); }} .help-toc {{ display: none; }} }}
  @media (max-width: 640px) {{ .help .groups {{ grid-template-columns: 1fr; }} }}
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
    padding: 8px 16px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); }}
  .help .gobtn:hover {{ filter: brightness(1.08); }}
  /* 編號步驟 */
  .help .steps {{ counter-reset: s; list-style: none; padding-left: 0; margin: 8px 0; }}
  .help .steps li {{ counter-increment: s; position: relative; padding: 6px 0 6px 38px; }}
  .help .steps li::before {{ content: counter(s); position: absolute; left: 0; top: 5px;
    width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: var(--accent-ink);
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
  .help .demo .stbtn.on {{ background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }}
  .help kbd {{ background: var(--chip-bg); border: 1px solid var(--chip-border); border-bottom-width: 2px;
    border-radius: 6px; padding: 1px 7px; font-size: .85rem; color: var(--text); }}
  /* 更新頻率表 */
  .help .ftabwrap {{ overflow-x: auto; margin: 10px 0; }}
  .help .ftab {{ width: 100%; border-collapse: collapse; font-size: .95rem; min-width: 460px; }}
  .help .ftab th, .help .ftab td {{ text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--line); color: var(--text); }}
  .help .ftab th {{ background: var(--accent-soft); font-weight: 700; white-space: nowrap; }}
  .help .ftab tr:last-child td {{ border-bottom: 0; }}
</style>
</head>
<body>
  <div class="wrap help">
    <div class="topbar">{_nav("help")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('book')}使用說明</h1>
    <div class="sub">一頁看懂整個網站怎麼用 · 可展開／可試玩 · 更新於 {now}</div>

  <div class="help-layout">
  <div class="help-main">
    <div class="q">
      <h2>這是什麼？</h2>
      <p>這是一套幫九上科技的<b>免費小型 ERP</b>：一邊自動盯原料行情；一邊管報價、訂單、進銷存與生產（ERP）、客戶與案件，以及行政（員工、班表、出勤、請假）。資料每天自動更新，不用開電腦、不用付費、不用維護。</p>
      <div class="groups">
        <div class="group"><b>{_ic('bars')}總覽</b><span>今日總覽、原料行情：每天打開先看這兩頁。</span></div>
        <div class="group"><b>{_ic('factory')}營運</b><span>報價試算、訂單看板、ERP 作業、生產排程、行政工作台：從報價、出貨收款、排產到員工排班。</span></div>
        <div class="group"><b>{_ic('wrench')}工具</b><span>資料庫、使用說明：管名單、看教學。</span></div>
      </div>
      <p class="muted" style="margin-top:10px">選單在左側；手機上在頁面上方，可左右滑動。</p>
      <div class="jumpbox">
      <p class="muted">點下面任一顆，直接跳到該功能的詳細說明：</p>
      <div class="jump">
        <a href="#start">新手上路</a><a href="#f-login">登入</a><a href="#f-home">{_ic('home')}首頁</a><a href="#f-metals">{_ic('ingot')}原料</a>
        <a href="#f-quote">{_ic('calc')}報價</a><a href="#f-orders">{_ic('box')}訂單</a><a href="#f-erp">{_ic('factory')}ERP</a><a href="#f-sched">{_ic('gantt')}排程</a><a href="#f-admin">{_ic('users')}行政</a>
        <a href="#f-notebook">{_ic('notebook')}NotebookLM</a><a href="#f-email">早報信</a>
        <a href="#db">{_ic('db')}資料庫/試算表</a><a href="#freq">更新頻率/費用</a><a href="#map">功能地圖</a><a href="#faq">常見問題</a>
      </div>
      </div>
    </div>

    <div class="q" id="start">
      <h2>新手上路：建議使用順序</h2>
      <p>第一次用不知道從哪開始？照這個順序做一遍，就通了：</p>
      <ul class="steps">
        <li><b>用 Google 登入</b>（右上角）——這樣資料才會存進公司試算表、換裝置也看得到。</li>
        <li><b>看行情</b>：原料行情看銅、鋁價格走勢，平常參考用。</li>
        <li><b>報價</b>：客人詢價 → 報價算一算 → 存起來。</li>
        <li><b>轉訂單</b>：接到單 → 訂單「從報價轉單」或「＋新增訂單」，用看板追進度。</li>
      </ul>
      <div class="tip">只想輕鬆用？每天開<b>首頁</b>看重點卡片、需要時開 <b>ERP 作業</b>看總覽，就很夠了。</div>
    </div>

    <div class="q">
      <h2>每一項功能詳細說明</h2>
      <p class="muted">點每一條標題可以展開／收合詳細說明。</p>

      <details class="acc" id="f-login" open>
        <summary>登入 <span class="sm">— 第一件事，資料才會存起來</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>用公司的 Google 帳號登入。登入後你做的收藏、報價、訂單才會存進公司試算表，換手機、換電腦都看得到同一份、不會不見。</p>
          <p><b>怎麼用：</b></p>
          <ul class="steps">
            <li>看畫面<b>右上角</b>那顆「使用 Google 帳戶登入」，點它。</li>
            <li>跳出視窗，選<b>公司的 Google 帳號</b>登入。</li>
            <li>右上角出現你的<b>名字</b>，就成功了。</li>
          </ul>
          <p><b>小撇步：</b>登入後切換分頁<b>不會</b>登出；大約一小時要再登一次是 Google 的安全設計，正常。真的登出了再點一次那顆按鈕就好，資料都還在。</p>
        </div>
      </details>

      <details class="acc" id="f-home">
        <summary>{_ic('home')}首頁 <span class="sm">— 每天先看這頁</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>每天打開的第一頁，一眼看今天重點。</p>
          <p><b>怎麼看：</b></p>
          <ul>
            <li>最上面是<b>今日數字</b>：<b>待出貨</b>幾筆、<b>逾期未出</b>幾筆（會標紅）、<b>本月訂單</b>幾筆（登入後才有數字）。</li>
            <li>下面兩張大卡＝最常用的 <b>ERP 作業</b> 和 <b>每日早報</b>，點就進去。</li>
            <li>再下面「快速前往」小圖示＝其他功能（ERP、原料、報價、資料庫、說明⋯），點一下就到。</li>
          </ul>
          <p><b>小撇步：</b>只想輕鬆用？每天看一眼首頁「逾期未出」有沒有紅字，就大概知道今天要不要盯。</p>
          <a class="gobtn" href="index.html">前往首頁 →</a>
        </div>
      </details>

      <details class="acc" id="f-metals">
        <summary>{_ic('ingot')}原料 <span class="sm">— 銅／鋁 價格</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>盯銅、鋁的國際價格（已換算成台幣），幫你判斷進料成本。</p>
          <p><b>怎麼看：</b>每種金屬一張卡，有<b>現價、今天漲跌、走勢圖</b>。上方可切<b>單位</b>（每公噸／每磅）與<b>期間</b>（近 7／30／90 天、一年）看漲跌幅；最下面附<b>相關新聞</b>，了解漲跌原因。</p>
          <p><b>小撇步：</b>紅色↑＝變貴、進料成本要留意；綠色↓或平平＝安心。系統只給你價格，不設警報，由你自己判斷。</p>
          <a class="gobtn" href="metals.html">前往原料 →</a>
        </div>
      </details>

      <details class="acc" id="f-quote">
        <summary>{_ic('calc')}報價 <span class="sm">— 30 秒估價</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>客人問價時，30 秒估出一個報價。</p>
          <p><b>怎麼用：</b></p>
          <ul class="steps">
            <li>選<b>材質</b>（銅／鋁，會自動帶入當天最新料價）。</li>
            <li>填<b>重量</b>；不知道重量就填長寬高按「計算」自動換算。</li>
            <li>看系統算出的<b>建議報價</b>。</li>
            <li>按<b>存這筆</b>記進報價歷史（登入後同步試算表，之後可在訂單頁「從報價轉單」）。</li>
          </ul>
          <p><b>小撇步：</b>下面「試玩看看」可以現場拉一拉玩一次，馬上就懂。</p>
          <a class="gobtn" href="quote.html">前往報價 →</a>
        </div>
      </details>

      <details class="acc" id="f-orders">
        <summary>{_ic('box')}訂單 · 進度儀表板 <span class="sm">— 建單、狀態看板</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>把接到的單記進來，用看板追每張單的進度。<b>畫面不顯示金額</b>（避免員工看到營收）。</p>
          <p><b>怎麼用：</b></p>
          <ul>
            <li>上方三張卡：<b>本月訂單</b>、<b>待出貨</b>、<b>逾期未出</b>（逾期會標紅）。</li>
            <li>按<b>＋ 新增訂單</b>填客戶／品名／數量／交期；或按<b>從報價轉單</b>一鍵帶入最新一筆報價。</li>
            <li>看板五欄：<b>報價 → 接單 → 生產 → 出貨 → 結案</b>。每張卡下方的下拉改狀態，卡片就移到對應欄；點卡片可編輯或刪除。</li>
          </ul>
          <p><b>小撇步：</b>單價／金額還是可以填、會存起來記帳，只是不顯示在看板。要看金額到「資料庫 → 訂單」分頁。</p>
          <a class="gobtn" href="orders.html">前往訂單儀表板 →</a>
        </div>
      </details>

      <details class="acc" id="f-erp">
        <summary>{_ic('factory')}ERP 作業 <span class="sm">— 進銷存、生產、客戶、案件、服務、專案</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>完整的進銷存＋生產＋客戶管理。從左側選單的「ERP 作業」進入，上方分頁依序是：</p>
          <ul>
            <li><b>總覽</b>：上方切換「我是 老闆／業務／倉管／行政／全部」，每個角色看到自己需要的重點（只改顯示，不是權限）。第一次用會有<b>上手任務清單</b>，做完一項自動打勾。</li>
            <li><b>料號庫存</b>：原料（kg）與成品（件）；先進先出（FIFO）自動算成本，可盤點調整、看成本批次。</li>
            <li><b>進貨</b>：照實際進價入庫。<b>報價單</b>：發出後鎖定，改價開新版；客戶接受一鍵轉訂單。</li>
            <li><b>銷售訂單</b>：可先接單後備料，分批出貨、分次收款、退貨（依原成本退回庫存），可列印報價單／出貨單。</li>
            <li><b>BOM／工單</b>：每 1 件用料 → 工單預留、開工、完工，成品成本自動算好。</li>
            <li><b>客戶／商機</b>：商機看板與跟進紀錄；按客戶列的放大鏡看<b>客戶 360</b>：多位聯絡人、案件、訂單、服務都在一起。</li>
            <li><b>客服案件</b>：詢價、客訴、技術支援、維修；狀態從開啟到結案，結案要寫處理結果，每次變更都有紀錄。</li>
            <li><b>服務交付</b>：代工打樣、外包加工：確認 → 交付（每次一版）→ 客戶驗收或要求修改 → 收款。</li>
            <li><b>專案</b>：任務看板（待辦／進行中／完成）與里程碑，也會列出資料庫的「我的名單／待辦」。</li>
          </ul>
          <p><b>好用的小功能：</b>任何頁按 <kbd>Ctrl</kbd>＋<kbd>K</kbd>（或右上「搜尋」）找料號、客戶、單號、員工；單據詳情可按「釘選」，首頁與總覽會列出。工具列的「備份 JSON」下載整份資料，「匯入備份」可整份還原（匯入前會先自動下載目前的備份）。</p>
          <p><b>資料存哪裡：</b>登入後存在公司試算表的 <b>ERP_ 開頭分頁</b>（與原本的訂單看板、資料庫分開）。每筆操作記在「ERP_操作紀錄」。<b>請不要直接在試算表改 ERP_ 分頁</b>，改了帳會對不起來（可按「資料健檢」檢查）。未登入時是「本機試用」，資料只在自己的瀏覽器。</p>
          <p><b>誰看得到金額：</b>ERP 會顯示售價、成本、毛利。若只想讓特定人使用，請管理者在 Apps Script「專案設定 → 指令碼屬性」新增 <code>ERP_EMAILS</code>（多個 email 用逗號分隔）。</p>
          <p><b>ERP 設定（管理者做一次）：</b>在同一個 Apps Script 專案新增一個指令碼檔，貼上 repo 的 <code>google-apps-script-erp.gs</code>；把主檔 <code>default:</code> 那一行換成新版；「部署 → 管理部署 → 編輯 → 新版本 → 部署」（網址不變）。詳見 README「ERP 設定」。</p>
          <a class="gobtn" href="erp.html">前往 ERP 作業 →</a>
        </div>
      </details>

      <details class="acc" id="f-sched">
        <summary>{_ic('gantt')}生產排程 <span class="sm">— 哪台機器先做哪張單；插單、急單、外包、機台故障怎麼辦</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>把訂單排進各站的機台，算出每張單什麼時候做完、哪張會延遲、瓶頸在哪，用甘特圖畫出來。從左側選單的「生產排程」進入。<b>電腦在你的瀏覽器裡算，訂單不會送到外部。</b></p>
          <ol class="steps">
            <li><b>確認訂單</b>：「訂單」分頁新增，或按「從 ERP 匯入」把還沒做完的工單、未出貨的銷售訂單帶進來（料號要和「工廠設定」裡的產品一樣）。</li>
            <li><b>確認工廠</b>：「工廠設定」分頁。預設是 下料 → CNC 加工 → 表面處理 → 品檢包裝 四站和常見機型；每件幾分鐘只是示範值，請改成你們的實際工時。站別、台數、上班日和時數都能隨時改。</li>
            <li><b>開始排程</b>：「排程看板」選目標——<b>效率優先</b>（訂單越快做完越好）、<b>兩者兼顧</b>（建議）、<b>準時優先</b>——按「開始排程」，約 3～30 秒。</li>
            <li><b>看結果</b>：最上面是白話重點和數字卡；甘特圖每一條橫列是一台機台、顏色＝訂單，<b>點色塊</b>會標出整張單的路線；下面表格有每張單的交期狀況與「準時機率」（加工時間有誤差時準時的機會）。</li>
            <li><b>臨時狀況</b>：<b>插單、急單、外包、機台故障／保養、取消訂單、改交期或數量</b>——按看板上對應的按鈕，填幾個欄位，系統只重排「還沒開工」的部分，並盡量不大改原計畫，再給你<b>新舊對照</b>；你按「採用新排程」才會生效，不滿意按「放棄」。</li>
          </ol>
          <p><b>它怎麼想（白話）：</b>電腦先把整間工廠「模擬」一遍，算出每個方案的結果；再用「演化」的方式從數千種排法裡挑——好的排法留下、互相混合、隨機改一點，一代代變好。同一張單在同一站只用一種機型；每站依性質分三種做法：<b>整批流動</b>（一台做完，做好一批就先送下一站）、<b>拆批平行</b>（拆成子批給多台同時做）、<b>併批</b>（湊成一批一起做，如電鍍、陽極）。開始前會先試「現場經驗做法」（先到先做）、交期優先 EDD、加權急迫度 ATC，作為起點與比較基準，所以最後的綜合成績不會比現場做法差。</p>
          <p><b>方法與出處：</b>核心是陳建銘（2015，清華大學博士論文；Lin &amp; Chen, 2015, <i>Simulation Modelling Practice and Theory</i>）的「模擬＋基因演算法＋OCBA」，加上迭代貪婪（Ruiz &amp; Stützle, 2007, <i>EJOR</i>）、NEH 插入、ATC 派工、多目標（效率×準時）與插單／機台故障的事件驅動重排程。「方法說明」分頁可以看到本系統算出的結果與論文逐項<b>對答案</b>。</p>
          <p><b>要注意：</b>系統假設現場<b>照排程在做</b>（時間一到就視為已開工、不再更動）；現場進度和排程不一樣時，請在對話框的「發生時間」調整。工廠設定改過後，請按「從頭排程」。資料登入後存公司試算表的「sched」分頁；同時有人改時，以最後存的為準。</p>
          <a class="gobtn" href="schedule.html">前往 生產排程 →</a>
        </div>
      </details>

      <details class="acc" id="f-admin">
        <summary>{_ic('users')}行政工作台 <span class="sm">— 員工、班表、出勤、請假簽核、設備、公告</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>工廠日常行政，從左側選單的「行政工作台」進入，和 ERP 用同一個後端。</p>
          <ul class="steps">
            <li><b>組織與員工</b>：先建單位（工廠、部門），再加員工。員工編號建立後固定；離職請「停用」，歷史紀錄都保留。</li>
            <li><b>週班表</b>：一週一張表，點格子的「＋」排班；結束早於開始＝跨夜班。同一人時段重疊會被擋。按「把上一週複製到這週」一次排好（衝突的會略過）。</li>
            <li><b>出勤</b>：手動登錄上下班時間，系統自動和班表比對，列出<b>遲到、早退（超過 5 分鐘）、缺勤</b>；登錯就修改或作廢（作廢要寫原因）。可匯出整月 CSV。</li>
            <li><b>申請簽核</b>：請假、加班、出差、採購⋯ 草稿 → 送出 → 主管核准或退回（退回要寫原因）→ 退回可改了再送；送出後可撤回。<b>不能核准自己送出的申請</b>，每一步都留紀錄。</li>
            <li><b>設備預約</b>：量測儀、堆高機、會議室、公務車；同一設備時段不能重疊，用完按「歸還」。</li>
            <li><b>公告</b>：可置頂，過期就封存。</li>
          </ul>
          <p><b>小撇步：</b>ERP 總覽切到「行政」角色，可以一眼看到今天的班次、出勤差異與待簽核。</p>
          <a class="gobtn" href="admin.html">前往行政工作台 →</a>
        </div>
      </details>

      <details class="acc" id="f-notebook">
        <summary>{_ic('notebook')}NotebookLM 知識庫 <span class="sm">— 進階／選用</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼（白話）：</b>NotebookLM 是 Google 免費的「AI 問答筆記本」。我們每天自動幫你寫好一份「公司近況文件」，你把它放進 NotebookLM，它就變成一個<b>只懂你公司</b>的 AI——可以用問的，還能生成語音摘要用聽的。</p>
          <p><b>怎麼用：</b></p>
          <ul class="steps">
            <li>點下面「開啟 NotebookLM →」（會開新分頁）。</li>
            <li><b>第一次</b>：在裡面按「+ 新增來源／Add source」，把我們那份 Google 文件加進去（工程師幫你設好，加一次就好）。</li>
            <li>之後想問就打字問它：「這個月往來重點？」「跟大雅精密進度到哪？」，它會<b>附出處</b>回答。</li>
            <li>想用聽的：按「Audio Overview／生成語音摘要」，把近況變成兩人對談，巡廠、開車用聽的。</li>
          </ul>
          <div class="tip">文件<b>不會自己</b>跑進去——第一次要手動加來源一次；之後我們改寫<b>同一份</b>文件，你在該來源按「同步」就更新，不用重加。</div>
          <div class="tip">免費。<b>但「語音摘要」每天能生成的次數有限，需要時再生成、不必每天</b>；純打字問答日常用不會超過。</div>
          <a class="gobtn" id="nbGo" href="https://notebooklm.google.com" target="_blank" rel="noopener">開啟 NotebookLM →</a>
        </div>
      </details>

      <details class="acc" id="f-email">
        <summary>每日早報信 <span class="sm">— 每天早上自動寄給你</span><span class="chev">▾</span></summary>
        <div class="acc-body">
          <p><b>這是什麼：</b>不用開網站，<b>平日</b>早上系統自動把「今天要注意的事」寄到你的信箱（週末工廠休就不寄）。</p>
          <p><b>怎麼用：</b>什麼都不用做——平日早上打開 <b>Gmail</b>，就看到一封「<b>九上 ERP 早報</b>」。內容有：待出貨、逾期未出、最近報價、原料行情。<b>有訂單逾期時，主旨會帶</b>，一眼就知道今天要盯什麼。</p>
          <p><b>小撇步：</b>這封信只寄到你設定的信箱，<b>員工看不到</b>。收不到請工程師確認收件人設定（一次性）。</p>
          <div class="tip">免費。一天一封，離 Gmail 每天 100 封的上限差得很遠。</div>
          <a class="gobtn" href="https://mail.google.com" target="_blank" rel="noopener">開啟 Gmail →</a>
        </div>
      </details>
    </div>
    <script>(function(){{var u=(window.APP_CONFIG||{{}}).NOTEBOOK_URL;var g=document.getElementById("nbGo");if(g&&u)g.href=u;}})();</script>

    <div class="q" id="freq">
      <h2>各功能多久更新一次？會不會花錢？</h2>
      <p>大部分資料是<b>系統自動</b>按排程更新，你什麼都不用做；你自己輸入的（訂單／報價／名單）則是<b>一存就進試算表、即時</b>。</p>
      <div class="ftabwrap"><table class="ftab">
        <tr><th>功能</th><th>多久更新一次</th><th>建議</th></tr>
        <tr><td>原料價 銅／鋁 ＋ 相關新聞</td><td>每天 2 次（早上 10 點、晚上 10 點）</td><td>剛好，維持</td></tr>
        <tr><td>每日早報信</td><td>平日早上約 9 點（週末不寄）</td><td>維持</td></tr>
        <tr><td>NotebookLM 近況文件</td><td>平日早上約 9 點（週末不更新）</td><td>維持（免費）</td></tr>
        <tr><td>訂單 · 報價 · 名單／收藏</td><td>即時（你一存就同步）</td><td>—</td></tr>
      </table></div>
      <h3>會不會被收費？<b>不會。</b></h3>
      <p>整套跑在<b>免費額度</b>上（GitHub＋Google＋免費 AI），關機也會自己在雲端更新，<b>不會跟你收錢</b>。唯一要知道的是免費額度的「<b>每日上限</b>」——超過只是<b>當天暫時擋一下</b>，不是收費：</p>
      <ul>
        <li><b>NotebookLM</b>：每天自動更新的只是「寫一份文件」（免費、無限）。你手動生成的<b>「語音摘要」每天次數有限——需要時再生成、別每天狂產</b>。</li>
        <li><b>每日早報</b>：一天一封，離 Gmail 每天 100 封上限差很遠。</li>
      </ul>
      <div class="tip">一句話：<b>正常使用完全免費、不會超量</b>；唯一要節制的是 NotebookLM 的「語音摘要」別每天狂生成。</div>
    </div>

    <div class="q" id="try">
      <h2>{_ic('calc')}試玩看看：報價怎麼算</h2>
      <p class="muted">拉一拉、選一選，數字會即時變。這只是<b>示範</b>用近似料價；實際報價頁會帶入當天最新原料價。</p>
      <div class="demo">
        <div class="row">
          <label>材質
            <select id="dMat">
              <option data-p="320" value="銅">銅（約 320/kg）</option>
              <option data-p="95" value="鋁">鋁（約 95/kg）</option>
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
      <h2>{_ic('db')}資料庫 ＋ Google 試算表（你的資料存在哪）</h2>
      <p><b>這是什麼：</b>你在網站上做的<b>收藏、標記、備註、報價、訂單</b>，全部存進公司自己的一份 <b>Google 試算表</b>。所以換手機、換電腦打開，看到的都是同一份、不會不見。（前提是有<b>登入</b>，見上面「登入」。）</p>

      <h3>{_ic('db')}平常這樣用：站內「資料庫」就好，不用開試算表</h3>
      <p>左側選單的「資料庫」是<b>站內操作中心</b>——不必打開 Google 試算表，直接在網站上就能管理所有資料（下面詳述）。</p>

      <h3>想看原始的 Google 試算表？（通常用不到）</h3>
      <ul class="steps">
        <li>到<b>首頁</b>點「九上資料庫」卡片，或站內「資料庫」底部的「開啟原始試算表」。</li>
        <li>會開一個<b>新分頁</b>，就是一般的 Google 試算表，最下面有分頁（訂單、名單…）。</li>
        <li>看看就好、通常不用手動改；要改資料用站內「資料庫」比較安全好操作。</li>
      </ul>

      <h3>登入後能做什麼（下面可以試玩）</h3>
      <div class="demo">
        <div class="row">
          <span>收藏：點星星試試 →</span>
          <span class="mkfav" id="dStar" role="button" tabindex="0" title="收藏">{_ic('star')}</span>
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
        <li><b>收藏</b>：點名單上的星星收藏；勾「只看收藏」就只顯示收藏的。</li>
        <li><b>狀態</b>：每列可標「已聯絡／合作中／不合適」。</li>
        <li><b>備註</b>：想記什麼就打在備註欄。</li>
        <li><b>排提醒</b>：一鍵開 Google 日曆，預填好「拜訪某公司」事件。</li>
        <li><b>報價歷史</b>：報價頁按「存這筆」，紀錄會存進試算表。</li>
      </ul>
      <p>以上全部會同步到公司的 Google 試算表。</p>

      <h3>{_ic('db')}資料庫操作中心（免開試算表）</h3>
      <p>左側選單的「資料庫」是<b>站內操作中心</b>——不必打開 Google 試算表，直接在網站上就能管理資料：</p>
      <ul>
        <li><b>四個資料表</b>：我的名單/待辦、收藏與標記、報價歷史、訂單，點分頁切換。</li>
        <li><b>新增／編輯／刪除</b>：點「新增」或每列的編輯／刪除按鈕，跳出小表單填一填就好。</li>
        <li><b>搜尋／篩選／排序</b>：上方搜尋框打字即時過濾、點欄位標題排序、用下拉篩狀態。</li>
        <li><b>匯出 CSV</b>：一鍵下載成 Excel 可開的檔案。</li>
        <li><b>可視化</b>：上方有筆數與各狀態統計、分佈長條圖。</li>
        <li><b>新手</b>：第一次用可按「載入範例資料」看看長怎樣，之後再清掉。</li>
      </ul>
      <div class="tip">手機上表格會自動變成一張張卡片，好點好讀。需要看原始試算表時，操作中心底部也有「開啟原始試算表」連結。</div>
      <a class="gobtn" href="db.html">前往資料庫操作中心 →</a>
    </div>

    <div class="q" id="map">
      <h2>{_ic('book')}功能地圖：和一般大型 ERP 比</h2>
      <p class="muted">對照 Odoo、NetSuite 這類大型 ERP 常見的功能區塊，九上儀表板目前做到哪裡（老實說，沒有的就寫沒有）。</p>
      <div class="ftabwrap"><table class="ftab">
        <tr><th>功能區塊</th><th>狀態</th><th>九上儀表板有什麼</th><th>還沒有的</th></tr>
        <tr><td>銷售</td><td>已提供</td><td>報價（版本、轉單）、銷售訂單、分批出貨、收款、退貨、列印</td><td>信用額度控管</td></tr>
        <tr><td>庫存</td><td>已提供</td><td>FIFO 成本、成本批次、盤點調整、異動紀錄、缺料與安全庫存提醒</td><td>多倉庫、序號／批號追溯</td></tr>
        <tr><td>採購</td><td>部分</td><td>進貨單（實際進價入庫）</td><td>請購、採購單核准、供應商對帳</td></tr>
        <tr><td>製造</td><td>已提供</td><td>BOM 版本、防循環、工單預留／開工／完工、用料成本轉入成品</td><td>設備保養計畫、品質檢驗</td></tr>
        <tr><td>生產排程</td><td>已提供</td><td>多站多機型排程（整批流動／拆批平行／併批）、換線、插單／急單／外包／機台故障重排、甘特圖、準時機率、和現場做法比較</td><td>現場即時進度回報、物料齊套檢查、人員技能排班</td></tr>
        <tr><td>客戶管理（CRM）</td><td>已提供</td><td>客戶 360、多位聯絡人、商機看板、跟進紀錄</td><td>行銷活動、名單自動化</td></tr>
        <tr><td>客服</td><td>已提供</td><td>客服案件（類別、優先、期限、處理紀錄、結案結果）</td><td>客戶自助入口</td></tr>
        <tr><td>服務交付</td><td>已提供</td><td>確認、交付版次、驗收或要求修改、收款</td><td>合約與續約</td></tr>
        <tr><td>專案</td><td>已提供</td><td>任務看板、里程碑、到期提醒</td><td>工時紀錄、甘特圖</td></tr>
        <tr><td>行政</td><td>已提供</td><td>組織、員工、週班表、出勤比對、申請簽核、設備預約、公告</td><td>打卡機串接</td></tr>
        <tr><td>人資薪資</td><td>未提供</td><td>—</td><td>薪資計算、勞健保、扣繳</td></tr>
        <tr><td>會計</td><td>部分</td><td>訂單與服務的收款、應收帳款、毛利</td><td>會計科目、傳票、總帳、應付沖帳</td></tr>
        <tr><td>發票與稅務</td><td>未提供</td><td>—</td><td>電子發票、營業稅申報（建議交給加值中心或會計師）</td></tr>
        <tr><td>報表</td><td>已提供</td><td>角色總覽、各表 CSV 匯出、原料行情</td><td>自訂報表設計器</td></tr>
        <tr><td>權限</td><td>部分</td><td>Google 登入白名單、ERP_EMAILS 限定 ERP 使用者、簽核不能自己核准</td><td>細部角色權限（例：業務看不到成本）</td></tr>
        <tr><td>好用工具</td><td>已提供</td><td>全站搜尋（Ctrl+K）、釘選、備份匯出／匯入、資料健檢</td><td>—</td></tr>
      </table></div>
      <div class="tip">九上特有、大型 ERP 沒有的：<b>LME 銅鋁行情自動更新</b>，並直接帶進報價試算與原料標準成本。</div>
    </div>

    <div class="q" id="faq">
      <h2>常見問題</h2>
      <details class="acc" open>
        <summary>登出了怎麼辦？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>再點一次右上角「使用 Google 帳戶登入」就好。收藏／備註都還在（存在試算表裡，不會不見）。</p></div>
      </details>
      <details class="acc">
        <summary>看不到最新資料？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>按 <kbd>Ctrl</kbd> + <kbd>F5</kbd>（Mac 是 <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>）強制重新整理一次即可。原料價<b>一天更新兩次</b>；訂單／報價／名單是你一存就即時同步。詳見上面「各功能多久更新一次」。</p></div>
      </details>
      <details class="acc">
        <summary>要錢嗎？<span class="chev">▾</span></summary>
        <div class="acc-body"><p><b>不用。</b>整套跑在免費服務上（GitHub＋Google＋免費 AI），關機也會自己在雲端更新，不會跟你收錢。唯一要節制的是 NotebookLM 的「語音摘要」別每天狂生成（有每日免費上限）。詳見上面「各功能多久更新一次？會不會花錢？」。</p></div>
      </details>
      <details class="acc">
        <summary>右上角的月亮／太陽按鈕是什麼？<span class="chev">▾</span></summary>
        <div class="acc-body"><p>切換深色／淺色模式，看你眼睛舒服。設定會記住。</p></div>
      </details>
    </div>

    <div class="foot">有任何看不懂的地方，回到這頁再看一次就好。全部免費、自動更新。</div>
  </div>
    <aside class="help-toc" aria-label="本頁目錄">
      <div class="tt">本頁目錄</div>
      <a href="#start">{_ic('play')}新手上路</a>
      <div class="tg">功能說明</div>
      <a href="#f-login">{_ic('user')}登入</a>
      <a href="#f-home">{_ic('home')}今日總覽</a>
      <a href="#f-metals">{_ic('ingot')}原料行情</a>
      <a href="#f-quote">{_ic('calc')}報價試算</a>
      <a href="#f-orders">{_ic('clipboard')}訂單看板</a>
      <a href="#f-erp">{_ic('factory')}ERP 作業</a>
      <a href="#f-sched">{_ic('gantt')}生產排程</a>
      <a href="#f-admin">{_ic('users')}行政工作台</a>
      <a href="#f-notebook">{_ic('notebook')}NotebookLM</a>
      <a href="#f-email">{_ic('mail')}每日早報信</a>
      <div class="tg">其他</div>
      <a href="#freq">{_ic('clock')}更新頻率／費用</a>
      <a href="#try">{_ic('calc')}試玩報價</a>
      <a href="#db">{_ic('db')}資料庫與試算表</a>
      <a href="#map">{_ic('book')}功能地圖</a>
      <a href="#faq">{_ic('info')}常見問題</a>
    </aside>
  </div>
  </div>
  <script>
  (function(){{
    // 目錄：跳到手風琴段落時自動展開；捲動時標示目前讀到哪一節
    function openTarget(){{ var id=location.hash.slice(1); var el=id&&document.getElementById(id);
      if(el&&el.tagName==="DETAILS"){{ el.open=true; }} }}
    window.addEventListener("hashchange",openTarget); openTarget();
    var tocLinks=Array.prototype.slice.call(document.querySelectorAll(".help-toc a"));
    var tocTargets=tocLinks.map(function(a){{ return document.getElementById(a.getAttribute("href").slice(1)); }});
    var tocTick=false;
    function markToc(){{ tocTick=false; var cur=0;   // 最後一個頂端已捲過頂欄下緣的段落
      tocTargets.forEach(function(t,i){{ if(t&&t.getBoundingClientRect().top<=120)cur=i; }});
      tocLinks.forEach(function(a,i){{ a.classList.toggle("on",i===cur); }}); }}
    if(tocLinks.length){{ window.addEventListener("scroll",function(){{ if(!tocTick){{ tocTick=true; requestAnimationFrame(markToc); }} }},{{ passive:true }}); markToc(); }}
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
    function toggleStar(){{ on=!on; star.classList.toggle("on",on); stxt.textContent=on?"已收藏":"未收藏"; }}
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
        '<div class="mhead"><div><span class="mname">原料相關新聞</span>'
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
        star = ('<span class="star">' + _ic("star") + "</span> ") if s.get("is_near") else ""
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
      <h2>{_ic('target')}找供應商的客戶（{html.escape(profile['name'])}）</h2>
      <div class="refgrid">
        <div><span class="rk">地區</span>{html.escape(profile['address'])}</div>
        <div><span class="rk">本業</span>{html.escape(profile['business'])}</div>
      </div>
      <div class="reftags">要找的供應商能力：{needs}
        <span class="rnote">※ 神岡周邊（豐原/大雅/潭子/后里/大甲）標星號</span></div>
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
    <div class="sub">幫九上科技（神岡）找台灣金屬加工供應商 · 全台皆列、神岡周邊優先 · 每月 1 號更新 · 僅供採購參考</div>

    {ref_card}

    <div class="cards four">
      <div class="card"><div class="k">供應商總數</div><div class="v">{total}</div></div>
      <div class="card"><div class="k">{_ic('star')}神岡周邊</div><div class="v">{stats['near_count']}</div><div class="k" style="margin-top:6px">豐原/大雅/潭子…</div></div>
      <div class="card"><div class="k">來源</div><div class="v" style="font-size:15px">{src_txt or '—'}</div></div>
      <div class="card"><div class="k">有官網連結</div><div class="v">{stats.get('with_url', 0)}</div><div class="k" style="margin-top:6px">可直接看公司</div></div>
    </div>

    <div class="ai">
      <h2>{_ic('factory')}{html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">{_ic('target')}優先推薦</div><div class="txt">{html.escape(summary.get('recommend',''))}</div></div>
      <div class="row"><div class="lbl">評估重點</div><div class="txt">{html.escape(summary.get('evaluate',''))}</div></div>
      <div class="row"><div class="lbl">詢價 / 打樣</div><div class="txt">{html.escape(summary.get('quote',''))}</div></div>
      <div class="row"><div class="lbl">風險提醒</div><div class="txt">{html.escape(summary.get('risk',''))}</div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h3>{_ic('db')}能力類別分布</h3>{cat_bars}</div>
      <div class="panel"><h3>供應商所在地</h3>{area_bars}</div>
    </div>

    <div class="panel">
      <h3>供應商名錄（顯示前 {shown} 家 · 共 {total} 家）</h3>
      <div class="toolbar" style="padding:0 16px 12px">
        <input id="supSearch" placeholder="搜尋公司 / 地區關鍵字…">
        <select id="supCat"><option value="">全部能力類別</option></select>
        <label class="prionly"><input type="checkbox" id="supNear"> 只看神岡周邊</label>
        <label class="prionly"><input type="checkbox" id="supFav"> 只看我收藏的</label>
        <select id="supStatus"><option value="">狀態：全部</option><option>已聯絡</option><option>合作中</option><option>不合適</option></select>
        <div class="btnbar viewbar"><button data-view="list" class="on">清單</button><button data-view="map">地圖</button></div>
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
    <div style="text-align:center;margin:14px 0 18px"><button id="qSave" class="dbbtn primary">{_ic('save')}存這筆報價</button></div>

    <div class="panel">
      <h3>報價歷史</h3>
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
      <h2>{_ic('target')}開發客戶的一方（{html.escape(profile['name'])}）</h2>
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
      <h2>{_ic('target')}{html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">{_ic('target')}優先鎖定</div><div class="txt">{html.escape(summary.get('target',''))}</div></div>
      <div class="row"><div class="lbl">如何切入</div><div class="txt">{html.escape(summary.get('approach',''))}</div></div>
      <div class="row"><div class="lbl">我方賣點</div><div class="txt">{html.escape(summary.get('pitch',''))}</div></div>
      <div class="row"><div class="lbl">提醒</div><div class="txt">{html.escape(summary.get('risk',''))}</div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h3>{_ic('db')}目標產業分布</h3>{cat_bars}</div>
      <div class="panel"><h3>客戶所在地</h3>{area_bars}</div>
    </div>

    <div class="panel">
      <h3>客戶名錄（顯示前 {shown} 家 · 共 {total} 家）</h3>
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
