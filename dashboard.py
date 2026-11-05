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
        f'stroke-linecap="round" stroke-linejoin="round" pathLength="1" points="{" ".join(pts)}"/></svg>'
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
        + '<div class="side-label">報價</div>'
        + item("quote", "quote.html", "calc", "報價試算")
        + item("records", "records.html", "clipboard", "報價紀錄")
        + '<div class="side-label">工具</div>'
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


def _health_box(health) -> str:
    """首頁「原料資料來源」燈號：有黃／紅才顯示；另外前端會自己檢查頁面是不是太久沒更新。"""
    upd = (health or {}).get("updated") or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    lis = ""
    if health and health.get("level") != "green":
        bad = [i for i in health["items"] if i["level"] != "green"]
        lis = "".join(
            f'<li><b class="dh-{i["level"]}">{"紅燈" if i["level"] == "red" else "黃燈"}</b> {i["name"]}：{i["display"]}'
            f'<span>{i["msg"]}</span></li>' for i in bad)
        lis = f'<div class="dh-t dh-{health["level"]}">原料資料來源有{health["red"] and "紅燈" or "黃燈"}，報價先別直接照用</div><ul>{lis}</ul>'
    return f'<div id="dhBox" class="dhbox" data-upd="{upd}"{"" if lis else " hidden"}>{lis}</div>'


def _pct_html(v, suffix="%"):
    """漲跌百分比；台灣習慣紅漲綠跌。"""
    if v is None:
        return '<span class="pm">—</span>'
    cls = "up" if v > 0 else "down" if v < 0 else ""
    return f'<span class="pm {cls}">{v:+.2f}{suffix}</span>'


def _advice_html(a) -> str:
    """首頁最上面：今天該做什麼。"""
    if not a:
        return ""
    items = a.get("items") or []
    lvls = [i["level"] for i in items]
    tone = "red" if "red" in lvls else "yellow" if "yellow" in lvls else "attn" if "attention" in lvls else "ok"
    icon = {"red": "alert", "yellow": "alert", "attn": "bell", "ok": "check"}[tone]
    lis = "".join(f'<li class="adv-{i["level"]}">{html.escape(i["text"])}</li>' for i in items)
    return (f'<section class="adv adv-{tone}"><div class="adv-k">{_ic(icon)}今天該做什麼</div>'
            f'<div class="adv-t">{html.escape(a["headline"])}</div>'
            + (f"<ul>{lis}</ul>" if lis else "")
            + '<div class="adv-f">依行情自動判斷，僅供參考；實際報價與進貨請依你的判斷。</div></section>')


def _price_cards_html(a) -> str:
    if not a:
        return ""
    cards = []
    for m in a.get("metals", []):
        if m.get("price_twd") is None:
            continue
        up = (m.get("d7") or m.get("day_pct") or 0) >= 0
        pos = m.get("pos")
        posline = (f'<div class="pc-pos"><div class="pc-bar"><i style="left:{pos}%"></i></div>'
                   f'<span>近一年區間 {pos}% 位置</span></div>') if pos is not None else ""
        cards.append(
            f'<a class="pcard" href="metals.html"><div class="pc-n">{html.escape(m["name"])}</div>'
            f'<div class="pc-p">NT$<span data-count="{m["price_twd"]}">{m["price_twd"]:,}</span><small> /噸</small></div>'
            f'<div class="pc-r"><span>今天 {_pct_html(m.get("day_pct"))}</span>'
            f'<span>7 天 {_pct_html(m.get("d7"))}</span><span>30 天 {_pct_html(m.get("d30"))}</span></div>'
            f'<div class="pc-s">{_sparkline(m.get("spark") or [], up, w=260, h=44)}</div>{posline}'
            f'{_attr_html(m.get("attr"))}</a>')
    return f'<div class="pcards">{"".join(cards)}</div>'


def _week_html(a) -> str:
    wk = (a or {}).get("week") or []
    if not wk:
        return ""
    rows = "".join(
        f'<tr><td>{html.escape(w["name"])}</td><td>{_pct_html(w["d7"])}</td><td>{_pct_html(w["d30"])}</td>'
        f'<td>NT${w["lo"]:,} ～ NT${w["hi"]:,}</td><td>{_pct_html(w["ma_gap"])}</td></tr>' for w in wk)
    return ('<section class="weekbox"><div class="adv-k">' + _ic("calendar") + '本週行情摘要</div>'
            '<table><thead><tr><th></th><th>近 7 天</th><th>近 30 天</th><th>近 5 個交易日區間</th><th>對 20 日均價</th></tr></thead>'
            f'<tbody>{rows}</tbody></table></section>')


def _attr_html(attr) -> str:
    """價格變動拆解：台幣價 = 國際價（美元）× 匯率。"""
    if not attr:
        return ""
    rows = []
    for key, label in (("day", "最近一天"), ("week", "近 7 天")):
        a = attr.get(key)
        if not a or a.get("total") is None:
            continue
        if key == "day" and a.get("from"):
            label = f"{a['from'][5:7]}/{a['from'][8:10]}→{a['to'][5:7]}/{a['to'][8:10]}"
        rows.append(f'<div class="pc-a"><b>{label}</b> {_pct_html(a["total"])} ＝ 國際價 {_pct_html(a["usd"])} ＋ 匯率 {_pct_html(a["fx"])}</div>')
    if not rows:
        return ""
    return ('<div class="pc-attr"><div class="pc-at">為什麼漲跌？<i>（日線收盤對收盤，和上方即時價的漲跌幅來源不同，數字會有落差）</i></div>' + "".join(rows) + "</div>")


def _insight_html(ins) -> str:
    """AI 或規則整理的今日行情白話解讀。"""
    if not ins or not ins.get("text"):
        return ""
    is_ai = ins.get("source") == "ai"
    label = "AI 行情解讀" if is_ai else "今日行情整理"
    foot = ("行情數字由程式計算；新聞面的說明由 AI 依新聞標題寫成，只說明行情，不是買賣建議。" if is_ai
            else "依規則自動整理（AI 目前未啟用或暫時不可用）。")
    return (f'<section class="insight"><div class="adv-k">{_ic("book")}{label}'
            f'<span class="ins-badge {"ai" if is_ai else ""}">{"AI" if is_ai else "自動"}</span></div>'
            f'<p>{html.escape(ins["text"])}</p>'
            f'<div class="adv-f">{foot}{" 更新於 " + html.escape(ins.get("updated", "")) if ins.get("updated") else ""}</div></section>')


def _news_tag(n) -> str:
    tag = n.get("tag")
    if tag not in ("偏多", "偏空", "中性"):
        return ""
    cls = {"偏多": "up", "偏空": "down", "中性": "mid"}[tag]
    by = "AI 判斷" if n.get("tag_by") == "ai" else "關鍵字判斷"
    return f'<span class="ntag t-{cls}" title="{by}，僅供參考">{tag}</span> '


def _home_data_script(a) -> str:
    """首頁「報價盯盤」要用的現價（每公斤）。"""
    mats = []
    for m in (a or {}).get("metals", []):
        if m.get("price_twd"):
            mats.append({"key": m["key"], "name": m["name"], "nt": round(m["price_twd"] / 1000, 1)})
    return "<script>window.RECORD_MATERIALS = " + json.dumps(mats, ensure_ascii=False) + ";</script>"


def render_home(history: dict, health=None, advice_data=None, insight=None) -> str:
    # 小捷徑：其餘功能收成一排 icon 格
    def _q(href, icon, label, ext=False, cid=""):
        idattr = f' id="{cid}"' if cid else ""
        tgt = ' target="_blank" rel="noopener"' if ext else ""
        return (f'<a class="hq"{idattr} href="{href}"{tgt}>'
                f'<span class="hqi">{_ic(icon)}</span><span class="hqt">{label}</span></a>')
    quick_items = [
        _q("metals.html", "ingot", "原料行情"),
        _q("quote.html", "calc", "報價試算"),
        _q("records.html", "clipboard", "報價紀錄"),
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
    {_advice_html(advice_data)}
    {_insight_html(insight)}
    {_price_cards_html(advice_data)}
    <section class="watchbox" id="watchBox" hidden></section>
    {_health_box(health)}
    {_week_html(advice_data)}
    <div class="hqlabel">快速前往</div>
    <div class="hquick">{quick}</div>
    <div class="foot">原料價每日自動更新；報價用最新原料行情試算。全部免費、關機也會自己跑。</div>
  </div>
  <script>(function(){{var u=(window.APP_CONFIG||{{}}).NOTEBOOK_URL;var c=document.getElementById("nbCard");if(c&&u)c.href=u;}})();</script>
{_home_data_script(advice_data)}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 使用說明（精簡版：只講現在還在的功能）
# ===========================================================================
def render_help_html() -> str:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 使用說明</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("help")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>{_ic('book')}使用說明</h1>
    <div class="sub">這是一個每天自動幫你看銅鋁行情的助理 · 更新於 {now}</div>
    <div class="panel">
      <h2>它每天做什麼</h2>
      <ul>
        <li><b>抓行情：</b>每天 10:00、22:00 自動抓銅、鋁價格（LME 與匯率），不用手動更新。</li>
        <li><b>告訴你今天該做什麼：</b>首頁最上面用白話說明，例如「鋁今天漲 1.72%，要報價的話確認一下是否需要加價」。沒事的日子會寫「今天沒有需要處理的事」。</li>
        <li><b>查資料健康：</b>價格太久沒更新、漲跌異常、兩個來源差太多時，首頁會亮黃燈或紅燈，報價先別照用。</li>
        <li><b>寄信提醒：</b>價格到你設的線、存過的報價成本漲太多、每週一的行情週報，都會寄 Email（需登入 Google 並由管理者安裝）。</li>
      </ul>
    </div>
    <div class="panel">
      <h2>有哪些頁面</h2>
      <ul>
        <li><b>今日總覽：</b>今天該做什麼、AI 行情解讀、銅鋁價格卡、<b>為什麼漲跌</b>（拆成國際價與匯率）、<b>報價盯盤</b>、本週摘要。</li>
        <li><b>原料行情：</b>走勢圖、相關新聞（標示偏多／偏空／中性），以及<b>我的提醒</b>：選金屬與條件、填數字，價格到線就寄 Email。</li>
        <li><b>報價試算：</b>左邊填資料、右邊即時看報價與毛利。可輸入其他材料（會記住）；<b>情境模擬</b>滑桿可以看「料價漲 10%、匯率貶 2%」時毛利剩多少。</li>
        <li><b>報價紀錄：</b>存過的報價都在這裡，可搜尋客戶、篩選材質與時間、刪除單筆、<b>清除舊資料</b>、匯出 CSV。</li>
      </ul>
    </div>
    <div class="panel">
      <h2>幾件要知道的事</h2>
      <ul>
        <li><b>請登入 Google：</b>沒登入時，報價與提醒只存在這個瀏覽器，同事看不到，也不會寄信。登入後才會同步到公司試算表。</li>
        <li><b>「AI 行情解讀」與「今日行情整理」：</b>前者由 AI 寫、後者是規則自動整理（AI 暫時不可用時）。兩者都只說明行情，<b>不是買賣或報價建議</b>，數字以價格卡為準。</li>
        <li><b>漲跌幅為什麼兩個數字不一樣：</b>價格卡上方是最新價的漲跌；「為什麼漲跌」是日線收盤對收盤，來源不同，會有落差。</li>
        <li><b>報價公式：</b>（重量 × 料價 ＋ 加工費）×（1 ＋ 利潤%）。利潤是加在成本上，不是毛利率；毛利率另外顯示。料價是行情換算的參考，不含運費與稅，也沒計入材料損耗。</li>
      </ul>
    </div>
    <div class="panel">
      <h2>費用</h2>
      <p>全部跑在 GitHub Actions 與 GitHub Pages，免費；電腦關機也會自己跑。AI 只用免費額度，不使用付費服務。</p>
    </div>
    <div class="foot">專注在行情、報價與自動提醒；不做 ERP 與生產管理。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 功能 B — 銅鋁儀表板
# ===========================================================================
def _alerts_panel_html(history, daily) -> str:
    """原料頁：我的提醒（規則存本機，登入後同步到試算表，由 price-alerts.gs 寄信）。"""
    import advice
    ctx = {}
    for k, st in advice.metal_stats(history, daily).items():
        ctx[k] = {"price_twd": st["price_twd"], "d7": st["d7"]}
    return (
        '<section class="alertbox" id="alertBox">'
        f'<h3>{_ic("bell")}我的提醒</h3>'
        '<div class="al-sub">設好條件，價格到線時系統寄 Email 通知你，不用每天盯著看。行情每天 10:00、22:00 更新，所以最快一天通知兩次。</div>'
        '<div class="alform">'
        '<select id="alMetal"><option value="copper">銅</option><option value="aluminum">鋁</option></select>'
        '<select id="alType"><option value="above">價格超過</option><option value="below">價格低於</option>'
        '<option value="week_up">7 天漲幅超過</option><option value="week_down">7 天跌幅超過</option></select>'
        '<input id="alVal" type="number" step="any" min="0" placeholder="數字"><span id="alUnit">NT$ / 噸</span>'
        '<button id="alAdd" class="dbbtn primary" type="button">新增提醒</button></div>'
        '<div id="alList"></div><div class="al-note" id="alNote"></div></section>'
        '<script>window.ALERT_CTX = ' + json.dumps(ctx, ensure_ascii=False) + ';</script>'
    )


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
            f'<div class="nm">{_news_tag(n)}{html.escape(n.get("source", ""))}'
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
{_alerts_panel_html(history, daily)}
{news_panel}
    <div class="foot">現價：LME 官方結算價（Westmetall）· 走勢圖：Yahoo Finance 每日收盤（銅為 COMEX 近月，與 LME 走勢近乎一致）· 匯率 Yahoo · 新聞：Google 新聞 · 單位由美元/公噸換算 · 僅供內部參考。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 報價試算器（純前端；內嵌各金屬當前 NT$/kg 與密度）
# ===========================================================================
_DENSITY = {"copper": 8.96, "aluminum": 2.70, "steel": 7.85, "stainless": 7.93}


def render_quote_html(history: dict, daily: dict = None) -> str:
    import advice
    stats = advice.metal_stats(history, daily)
    adv = advice.build(history, daily)

    def _nt_per_kg(key):
        s = history.get(key, [])
        twd = s[-1].get("price_twd") if s else None
        return round(twd / 1000, 1) if twd else None

    def _hint(name):
        for it in adv["items"]:
            if it["level"] == "attention" and it["text"].startswith(name):
                return it["text"]
        return ""

    mats = []
    for key, name in (("copper", "銅"), ("aluminum", "鋁")):
        st = stats[key]
        mats.append({"key": key, "name": name, "nt": _nt_per_kg(key), "density": _DENSITY[key], "live": True,
                     "day_pct": st["day_pct"], "d7": st["d7"], "hint": _hint(name), "spark": st["spark"]})
    data_script = "<script>window.QUOTE_MATERIALS = " + json.dumps(mats, ensure_ascii=False) + ";</script>"

    strip = "".join(
        f'<div class="qs"><div class="qs-n">{m["name"]}</div><div class="qs-p">NT${m["nt"]}<small> /公斤</small></div>'
        f'<div class="qs-r">今天 {_pct_html(m["day_pct"])}　7 天 {_pct_html(m["d7"])}</div>'
        f'<div class="qs-s">{_sparkline(m.get("spark") or [], (m["d7"] or 0) >= 0, w=200, h=26)}</div></div>'
        for m in mats if m["nt"] is not None)

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
    <div class="sub">選材質、填重量，用<b>當前原料行情</b>算料錢與建議報價 · 料價已帶入最新價、可自行修改</div>

    <div class="qstrip">{strip}</div>
    <div class="qhint" id="qHint" hidden></div>
    <div class="qlogin" id="qLogin" hidden></div>

    <div class="qgrid">
      <div class="panel qformp">
        <div class="qform">
          <label class="qf"><span>客戶／備註（選填，之後可以用它查找）</span>
            <input id="qNote" type="text" maxlength="60" placeholder="例如：○○公司 銅軸套"></label>
          <label class="qf"><span>材質</span>
            <select id="qMat"></select></label>
          <div class="qf qother" id="qOther" hidden><span>其他材料：名稱與密度</span>
            <div class="qrow"><input id="qOName" type="text" maxlength="30" placeholder="例如：不鏽鋼 304">
              <input id="qODen" type="number" min="0" step="0.01" placeholder="密度 g/cm³（選填）"></div>
            <div class="qnote">密度只用在「用尺寸算重量」，不知道可以不填，直接輸入重量。常見密度：鐵 7.85、不鏽鋼 7.93、黃銅 8.5、鈦 4.5。存報價時會記住這個材料，下次直接從選單選。</div></div>
          <button type="button" class="qforget" id="qForget" hidden>從「我的材料」移除這一項</button>
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

      <div class="qside">
        <div class="qresult" id="qResult">
          <div class="qr big"><div class="qk">建議報價</div><div class="qv" id="qQuote">—</div></div>
          <div class="qr"><div class="qk">料錢</div><div class="qv" id="qMatCost">—</div></div>
          <div class="qr"><div class="qk">總成本（料＋工）</div><div class="qv" id="qTotal">—</div></div>
          <div class="qr"><div class="qk">毛利率</div><div class="qv" id="qMarginPct">—</div></div>
        </div>
        <div class="qsens" id="qSens"></div>
        <div class="qbtns"><button id="qCopy" class="dbbtn">{_ic('clipboard')}複製報價文字</button><button id="qSave" class="dbbtn primary">{_ic('save')}存這筆報價</button></div>
        <div class="qsaved" id="qSaved" hidden></div>
        <div class="qsim" id="qSim" hidden>
          <div class="adv-k">{_ic('calc')}情境模擬：行情變了，報價會怎樣？</div>
          <label>料價變動 <b id="qSimAV">0%</b><input type="range" id="qSimA" min="-20" max="20" step="1" value="0"></label>
          <label>匯率變動 <b id="qSimFV">0%</b><input type="range" id="qSimF" min="-5" max="5" step="0.5" value="0"></label>
          <div class="qsim-out" id="qSimOut"></div>
          <button type="button" class="qforget" id="qSimReset">滑桿歸零</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>最近的報價</h3>
      <div id="qHistory" style="padding:8px 16px 4px"></div>
      <div style="padding:0 16px 14px"><a href="records.html" class="qmore">查看全部報價紀錄、搜尋與清理 →</a></div>
    </div>
    <div class="foot">料價為 LME/期貨原料行情換算之參考值，不含供應商加價、運費、稅；實際採購價請以報價單為準。此工具僅供快速估算。報價存在你的瀏覽器；登入 Google 後會同步到公司試算表（團隊共用）。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""


# ===========================================================================
# 報價紀錄：專門存放與管理報價資料的頁面（搜尋、篩選、刪除單筆、清除舊資料、匯出）
# ===========================================================================
def render_records_html(history: dict) -> str:
    mats = []
    for key, name in (("copper", "銅"), ("aluminum", "鋁")):
        s = history.get(key, [])
        twd = s[-1].get("price_twd") if s else None
        mats.append({"key": key, "name": name, "nt": round(twd / 1000, 1) if twd else None})
    data_script = "<script>window.RECORD_MATERIALS = " + json.dumps(mats, ensure_ascii=False) + ";</script>"
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>報價紀錄 · 九上科技</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("records")}{_THEME_BTN}</div>
    <div class="eyebrow">QUOTE · 報價資料庫</div>
    <h1>{_ic('clipboard')}報價紀錄</h1>
    <div class="sub">在「報價試算」按「存這筆報價」的資料都在這裡 · 可搜尋、篩選、刪除，也能一次清掉舊資料</div>
    <div class="qlogin" id="rLogin" hidden></div>

    <div class="rbar">
      <input id="rSearch" type="search" placeholder="搜尋客戶、備註、材質…">
      <select id="rMat"><option value="">全部材質</option></select>
      <select id="rDays"><option value="0">全部時間</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select>
      <button id="rCsv" class="dbbtn" type="button">{_ic('save')}匯出 CSV</button>
      <button id="rPurgeBtn" class="dbbtn" type="button">{_ic('alert')}清除舊資料…</button>
    </div>
    <div class="rpurge" id="rPurge" hidden>
      刪除 <input id="rPurgeDays" type="number" min="1" value="90"> 天以前的報價紀錄
      <span id="rPurgeInfo"></span>
      <button id="rPurgeGo" class="dbbtn primary" type="button">確定刪除</button>
      <button id="rPurgeCancel" class="dbbtn" type="button">取消</button>
      <div class="rpurge-n">刪除後無法復原。如果已登入，公司試算表裡的紀錄也會一起刪除。建議先按「匯出 CSV」留一份。</div>
    </div>
    <div class="rcount" id="rCount"></div>
    <div class="rwrap">
      <table class="rtable">
        <thead><tr><th>日期</th><th>客戶／備註</th><th>材質</th><th>重量</th><th>料價</th><th>加工費</th><th>利潤</th><th>報價</th><th>和現在比</th><th></th></tr></thead>
        <tbody id="rBody"></tbody>
      </table>
    </div>
    <div class="foot">紀錄存在這個瀏覽器；登入 Google 後同步到公司試算表「報價紀錄」分頁（團隊共用）。「和現在比」是用今天的料價重算成本，看當時報價現在是賺還是賠。</div>
  </div>
{data_script}
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""
