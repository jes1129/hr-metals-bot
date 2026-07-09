# -*- coding: utf-8 -*-
"""
dashboard.py — 儀表板 HTML render（銅鋁 index.html + 人才 jobs.html）。

版面樣式與互動邏輯抽到 docs/assets/style.css、docs/assets/app.js（手寫、常駐、
只提交一次）。這裡只產出 HTML 骨架，並把資料以 <script>window.XXX = {...}</script>
內嵌進頁面，前端 JS 負責單位切換、互動走勢圖、職缺搜尋/排序、深色模式。
"""
import datetime
import html
import json

import config
import metals as metals_mod

# 資產相對路徑（index.html / jobs.html 皆位於 docs/ 根，assets 在 docs/assets/）
_HEAD = (
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    '<link rel="stylesheet" href="assets/style.css">'
)
_THEME_BTN = '<button id="themeBtn" class="theme-btn" aria-label="切換深淺色">🌙</button>'


def _fmt(v, nd=1):
    return "—" if v is None else f"{v:,.{nd}f}"


def _sparkline(points, up: bool, w=120, h=32) -> str:
    """迷你 SVG 折線（無 JS 時的後備圖）。"""
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
        f'<a{a if active == "metals" else ""} href="index.html">🔩 銅鋁價格</a>'
        f'<a{a if active == "jobs" else ""} href="jobs.html">🔧 人才行情</a>'
        "</div>"
    )


_STATUS_LABEL = {
    "break_high": "突破上線", "break_low": "跌破下線",
    "in_range": "區間內", "unknown": "無資料",
}


# ===========================================================================
# 功能 B — 銅鋁儀表板
# ===========================================================================
def render_html(history: dict) -> str:
    data = {}          # 內嵌給前端的資料
    panels = []
    alert_count = 0
    last_update = "—"

    for key, cfg in config.METALS.items():
        series = history.get(key, [])
        data[key] = {
            "name": cfg["name"], "en": cfg["en"],
            "watch_low": cfg["watch_low"], "watch_high": cfg["watch_high"],
            "series": [
                {"ts": p.get("ts"), "usd": p.get("price"), "rate": p.get("rate")}
                for p in series
            ],
        }

        latest = series[-1] if series else {}
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

        # 無 JS 後備文字（預設單位 NT$/公噸；JS 載入後即接管換算）
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

        trend_twd = [p.get("price_twd") for p in series[-config.TREND_POINTS:]]
        fallback = _sparkline(trend_twd, up=(change or 0) >= 0, w=600, h=200)

        panels.append(
            f"""
    <section class="mpanel" data-key="{key}">
      <div class="mhead">
        <div><span class="mname">{html.escape(cfg['name'])}</span><span class="men">{html.escape(cfg['en'])}</span></div>
        <span class="badge {status}">{_STATUS_LABEL[status]}</span>
      </div>
      <div class="mfigs">
        <div class="fig"><div class="flabel">現價</div><div class="fval price">{price_txt}</div></div>
        <div class="fig"><div class="flabel">漲跌</div><div class="fval chg">{chg_txt}</div></div>
        <div class="fig"><div class="flabel">關注區間</div><div class="fval watch">{watch_txt}</div></div>
      </div>
      <div class="chart" data-chart="{key}">{fallback}</div>
    </section>"""
        )

    names = " · ".join(m["name"] for m in config.METALS.values())
    data_script = "<script>window.METALS_DATA = " + json.dumps(data, ensure_ascii=False) + ";</script>"

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
    <div class="sub">LME 官方結算價 · 台幣依即時匯率換算 · 每日 10:00 與 22:00（台灣時間）更新 · 突破關注區間時另發 Discord 告警</div>

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
        <button data-range="7">近 7 筆</button>
        <button data-range="30">近 30 筆</button>
        <button data-range="all">全部</button>
      </div>
    </div>
{''.join(panels)}
    <div class="foot">資料來源：LME 官方價（Westmetall）· 匯率 Yahoo Finance · 單位皆由 LME 美元/公噸換算，僅供內部參考。</div>
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
    area_rows = "".join(
        f"<tr><td>{html.escape(a)}</td><td class='num'>{n}</td></tr>"
        for a, n in stats["top_areas"]
    ) or "<tr><td>—</td><td></td></tr>"

    # 伺服器端後備：先渲染前 30 筆（依薪資高→低）；JS 載入後接管搜尋/篩選/排序
    def _mid(j):
        lo, hi = j.get("salary_low"), j.get("salary_high")
        return (lo + hi) / 2 if (lo and hi) else (lo or 0)
    fb = sorted(jobs, key=_mid, reverse=True)[:30]
    fb_rows = "".join(
        f"""<tr><td><a href="{html.escape(j['url'])}" target="_blank" rel="noopener">{html.escape(j['title'][:40])}</a></td>
        <td>{html.escape(j['company'][:22])}</td><td>{html.escape(j['area'])}</td>
        <td class="num">{_salary_disp(j)}</td></tr>""" for j in fb
    ) or '<tr><td colspan="4">—</td></tr>'

    jobs_min = [
        {"title": j["title"], "company": j["company"], "url": j["url"], "area": j["area"],
         "salary_low": j["salary_low"], "salary_high": j["salary_high"], "salary_kind": j["salary_kind"]}
        for j in jobs
    ]
    data_script = "<script>window.JOBS_DATA = " + json.dumps(jobs_min, ensure_ascii=False) + ";</script>"

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>金屬加工人才行情儀表板</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav("jobs")}{_THEME_BTN}</div>
    <div class="eyebrow">TALENT MARKET · 104 公開職缺</div>
    <h1>金屬加工人才行情</h1>
    <div class="sub">104 公開職缺每日彙整 · 每日 08:00（台灣時間）更新 · 資料來源為公開徵才頁，僅供招募行情參考</div>

    <div class="cards four">
      <div class="card"><div class="k">職缺總數</div><div class="v">{stats['total']} {_delta_span(delta.get('total'))}</div><div class="spk">{spark_total}</div></div>
      <div class="card"><div class="k">月薪中位數</div><div class="v">{med} {_delta_span(delta.get('salary_median'))}</div><div class="spk">{spark_med}</div></div>
      <div class="card"><div class="k">月薪平均</div><div class="v">{avg}</div><div class="k" style="margin-top:6px">區間 {rng}</div></div>
      <div class="card"><div class="k">面議職缺</div><div class="v">{stats['negotiable']}</div><div class="k" style="margin-top:6px">未列薪資</div></div>
    </div>

    <div class="ai">
      <h2>🔧 {html.escape(summary.get('headline',''))}</h2>
      <div class="row"><div class="lbl">💰 薪資行情</div><div class="txt">{html.escape(summary.get('salary',''))}</div></div>
      <div class="row"><div class="lbl">📈 需求趨勢</div><div class="txt">{html.escape(summary.get('demand',''))}</div></div>
      <div class="row"><div class="lbl">🛠️ 雇主要的技能</div><div class="txt">{html.escape(summary.get('skills',''))}</div></div>
      <div class="row"><div class="lbl">💡 招募建議</div><div class="txt">{html.escape(summary.get('advice',''))}</div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h3>🏢 徵才較多的公司</h3><table><tbody>{comp_rows}</tbody></table></div>
      <div class="panel"><h3>📍 徵才熱區</h3><table><tbody>{area_rows}</tbody></table></div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <h3>📊 月薪分布</h3>
      <div class="hist" id="hist"></div>
    </div>

    <div class="panel">
      <h3>🔎 職缺清單</h3>
      <div class="toolbar" style="padding:0 16px 12px">
        <input id="jobSearch" placeholder="搜尋職缺 / 公司關鍵字…">
        <select id="jobArea"><option value="">全部地區</option></select>
        <span class="count" id="jobCount"></span>
      </div>
      <table>
        <thead><tr>
          <th class="sortable" data-key="title">職缺 <span class="arrow"></span></th>
          <th class="sortable" data-key="company">公司 <span class="arrow"></span></th>
          <th class="sortable" data-key="area">地區 <span class="arrow"></span></th>
          <th class="sortable num" data-key="salary">月薪 <span class="arrow"></span></th>
        </tr></thead>
        <tbody id="jobBody">{fb_rows}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：104 人力銀行公開職缺 · 最後更新 {last_update} · 僅供內部招募行情參考，非即時、不含企業人才庫。</div>
  </div>
{data_script}
  <script src="assets/app.js"></script>
</body>
</html>"""
