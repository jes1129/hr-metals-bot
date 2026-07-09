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

_HEAD = (
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    '<link rel="stylesheet" href="assets/style.css">'
)
_THEME_BTN = '<button id="themeBtn" class="theme-btn" aria-label="切換深淺色">🌙</button>'


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
    return (
        '<div class="nav">'
        f'<a{a if active == "home" else ""} href="index.html">🏠 首頁</a>'
        f'<a{a if active == "metals" else ""} href="metals.html">🔩 原料</a>'
        f'<a{a if active == "jobs" else ""} href="jobs.html">🔧 招募</a>'
        f'<a{a if active == "suppliers" else ""} href="suppliers.html">🏭 供應商</a>'
        f'<a{a if active == "quote" else ""} href="quote.html">🧮 報價</a>'
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


_STATUS_LABEL = {
    "break_high": "突破上線", "break_low": "跌破下線",
    "in_range": "區間內", "unknown": "無資料",
}


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
    # 原料卡：每個金屬一行白話（買方視角：漲=成本高要注意、跌/區間=OK）
    metal_lines = []
    for key, cfg in config.METALS.items():
        series = history.get(key, [])
        latest = series[-1] if series else {}
        price_twd = latest.get("price_twd")
        pct = latest.get("change_pct")
        status = metals_mod.check_status(key, latest.get("price"))
        if status == "break_high":
            light, note = "🔴", "漲破上線，原料變貴注意成本"
        elif status == "break_low":
            light, note = "🟢", "跌破下線，變便宜可考慮進貨"
        elif status == "in_range":
            light, note = "🟢", "區間內，正常不用擔心"
        else:
            light, note = "⚪", "尚無資料"
        price_s = f"NT${price_twd:,}/噸" if price_twd else "—"
        if pct is not None:
            arrow = "▲" if pct >= 0 else "▼"
            pct_s = f'<span style="color:{"var(--up)" if pct >= 0 else "var(--down)"}">{arrow}{abs(pct):.1f}%</span>'
        else:
            pct_s = ""
        metal_lines.append(
            f'<div class="mrow">{light} <b>{html.escape(cfg["name"])}</b> {price_s} {pct_s}'
            f'<div class="mnote">{note}</div></div>'
        )
    metals_card = _hcard("metals.html", "🔩", "原料行情", "".join(metal_lines), "看銅鋁鎳鋼走勢")

    jobs_card = _hcard(
        "jobs.html", "🔧", "招募雷達",
        f'<div class="big">{jobs_total} <span>筆</span></div>'
        '<div class="mnote">台中金屬加工・品管職缺（⭐符合重點者已標）</div>',
        "看招募行情")

    near_s = f'<div class="mnote">神岡周邊 {sup_near} 家 ⭐</div>' if sup_near is not None else ""
    sup_card = _hcard(
        "suppliers.html", "🏭", "供應商雷達",
        f'<div class="big">{sup_total} <span>家</span></div>{near_s}',
        "找金屬加工供應商")

    quote_card = _hcard(
        "quote.html", "🧮", "報價試算",
        '<div class="mnote">選材質、輸入重量，用<b>當下行情</b>算料錢＋建議報價</div>',
        "開始試算")

    cards = [metals_card, jobs_card, sup_card, quote_card]
    if cust_total is not None:
        cards.insert(3, _hcard(
            "customers.html", "🎯", "客戶開發雷達",
            f'<div class="big">{cust_total} <span>家</span></div>'
            '<div class="mnote">會買精密金屬零件的潛在客戶</div>',
            "找新客戶"))

    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>九上科技 · 智慧儀表板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("home")}{_THEME_BTN}</div>
    <div class="eyebrow">九上科技 · 智慧儀表板</div>
    <h1>今日重點總覽</h1>
    <div class="sub">點下面任一張卡片進入該功能 · 資料每日自動更新 · 更新於 {now}</div>
    <div class="hcards">{''.join(cards)}</div>
    <div class="foot">原料價／招募／供應商每日自動更新；報價用最新原料行情試算。全部免費、關機也會自己跑。</div>
  </div>
</body>
</html>"""


# ===========================================================================
# 功能 B — 銅鋁儀表板
# ===========================================================================
def render_html(history: dict, daily: dict = None) -> str:
    daily = daily or {}
    metals_data = {}
    panels = []
    alert_count = 0
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
            "watch_low": cfg["watch_low"], "watch_high": cfg["watch_high"],
            "series": dseries,
        }

        # 現價/告警：LME 官方（Westmetall）最新一筆
        hist = history.get(key, [])
        latest = hist[-1] if hist else {}
        price = latest.get("price")
        price_twd = latest.get("price_twd")
        rate = latest.get("rate")
        change = latest.get("change")
        status = metals_mod.check_status(key, price)
        if status in ("break_high", "break_low"):
            alert_count += 1

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
        if rate:
            watch_txt = f"NT${round(cfg['watch_low']*rate):,}/t ~ NT${round(cfg['watch_high']*rate):,}/t"
        else:
            watch_txt = f"US${cfg['watch_low']:,}/t ~ US${cfg['watch_high']:,}/t"

        fb = _sparkline([d.get("usd") for d in dseries[-30:]], up=(change or 0) >= 0, w=600, h=200)

        panels.append(
            f"""
    <section class="mpanel" data-key="{key}">
      <div class="mhead">
        <div><span class="mname">{html.escape(cfg['name'])}</span><span class="men">{html.escape(cfg['en'])}</span></div>
        <span class="badge {status}">{_STATUS_LABEL[status]}</span>
      </div>
      <div class="mfigs">
        <div class="fig"><div class="flabel">現價（LME 官方）</div><div class="fval price">{price_txt}</div></div>
        <div class="fig"><div class="flabel">漲跌</div><div class="fval chg">{chg_txt}</div></div>
        <div class="fig"><div class="flabel">關注區間</div><div class="fval watch">{watch_txt}</div></div>
      </div>
      <div class="mstats">
        <span class="chip">7日 <b class="c7">—</b></span>
        <span class="chip">30日 <b class="c30">—</b></span>
        <span class="chip">90日 <b class="c90">—</b></span>
        <span class="chip">期間高 <b class="phi">—</b></span>
        <span class="chip">期間低 <b class="plo">—</b></span>
        <span class="chip">距上線 <b class="dhi">—</b></span>
        <span class="chip">距下線 <b class="dlo">—</b></span>
      </div>
      <div class="chart" data-chart="{key}">{fb}</div>
      <div class="legend"><span class="lg-line"></span>每日收盤（Yahoo）　<span class="lg-ma"></span>MA{config.MA_WINDOW} 均線　<span class="lg-watch"></span>關注線</div>
    </section>"""
        )

    # 匯率、銅鋁比價序列
    fx_series = daily.get("fx", [])
    cu = {d["ts"]: d["usd"] for d in daily.get("copper", []) if d.get("usd")}
    al = {d["ts"]: d["usd"] for d in daily.get("aluminum", []) if d.get("usd")}
    ratio = [{"ts": d, "v": round(cu[d] / al[d], 3)}
             for d in sorted(set(cu) & set(al)) if al.get(d)]

    fx_panel = """
    <div class="grid2">
      <section class="mpanel" data-fx="1">
        <div class="mhead"><div><span class="mname">匯率</span><span class="men">USD / TWD</span></div><span class="fval sm" id="fxNow">—</span></div>
        <div class="chart sm" data-chart="fx"></div>
      </section>
      <section class="mpanel" data-ratio="1">
        <div class="mhead"><div><span class="mname">銅鋁比價</span><span class="men">COPPER / ALUMINUM</span></div><span class="fval sm" id="ratioNow">—</span></div>
        <div class="chart sm" data-chart="ratio"></div>
      </section>
    </div>"""

    names = " · ".join(m["name"] for m in config.METALS.values())
    data_script = (
        "<script>window.METALS_DATA = " + json.dumps(metals_data, ensure_ascii=False) + ";"
        "window.FX_DATA = " + json.dumps(fx_series, ensure_ascii=False) + ";"
        "window.RATIO_DATA = " + json.dumps(ratio, ensure_ascii=False) + ";</script>"
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
    <div class="sub">現價與告警＝LME 官方結算價（Westmetall）· 走勢圖＝每日收盤（Yahoo）· 台幣依匯率換算 · 每日 10:00 與 22:00（台灣時間）更新</div>

    <div class="cards">
      <div class="card"><div class="k">追蹤金屬</div><div class="v">{len(config.METALS)} <span style="font-size:13px;color:var(--muted)">{names}</span></div></div>
      <div class="card"><div class="k">告警中</div><div class="v">{alert_count} <span style="font-size:13px;color:var(--muted)">項突破區間</span></div></div>
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
{''.join(panels)}
{fx_panel}
    <div class="foot">現價/告警：LME 官方價（Westmetall）· 走勢圖：Yahoo Finance 每日收盤（銅為 COMEX 近月，與 LME 走勢近乎一致）· 匯率 Yahoo · 單位由美元/公噸換算 · 僅供內部參考。</div>
  </div>
{data_script}
  <script src="assets/app.js"></script>
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
        <span class="count" id="jobCount"></span>
      </div>
      <table>
        <thead><tr>
          <th class="sortable" data-key="title">職缺 <span class="arrow"></span></th>
          <th class="sortable" data-key="company">公司 <span class="arrow"></span></th>
          <th class="sortable" data-key="district">行政區 <span class="arrow"></span></th>
          <th class="sortable num" data-key="salary">月薪 <span class="arrow"></span></th>
        </tr></thead>
        <tbody id="jobBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：104 人力銀行公開職缺（聚焦台中）· 最後更新 {last_update} · ⭐＝品管職且命中量測/金屬關鍵字 · 僅供內部招募參考，非即時、不含企業人才庫。</div>
  </div>
{data_script}
  <script src="assets/app.js"></script>
</body>
</html>"""


# ===========================================================================
# 功能 C — 供應商雷達（九上科技找金屬加工供應商）
# ===========================================================================
_SRC_LABEL = {"104": "104", "gov": "政府", "both": "政府+104"}


def render_suppliers_html(profile: dict, stats: dict, summary: dict, suppliers: list) -> str:
    EMBED_CAP = 1200  # 前端內嵌上限（已依 score 排序，取前段）
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
            f"<td>{_SRC_LABEL.get(s.get('source'),'')}</td></tr>"
        )
    fb_rows = fb_rows or '<tr><td colspan="5">—</td></tr>'

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
        <div><span class="rk">地址</span>{html.escape(profile['address'])}（{html.escape(profile['phone'])}）</div>
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
        </tr></thead>
        <tbody id="supBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">來源：104 公司搜尋（Playwright）＋ 財政部營業稅籍登記開放資料（篩臺中金屬）· 完整名單見 repo 的 data/suppliers.json · 名單為公開資料，實際產能/品質/認證請自行電話與實地查核。</div>
  </div>
{data_script}
  <script src="assets/app.js"></script>
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
    <div class="foot">料價為 LME/期貨原料行情換算之參考值，不含供應商加價、運費、稅；實際採購價請以報價單為準。此工具僅供快速估算。</div>
  </div>
{data_script}
  <script src="assets/app.js"></script>
</body>
</html>"""
