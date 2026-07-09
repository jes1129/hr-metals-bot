# -*- coding: utf-8 -*-
"""
dashboard.py — 銅鋁儀表板 HTML render（對應指南第 11、14 頁）。

版型：
  頂部摘要（追蹤金屬數、告警數、最後更新時間）
  每金屬列：現價、漲跌、漲跌幅、近 N 日迷你走勢 SVG、狀態燈（突破上線/跌破下線/區間內）
"""
import datetime
import html

import config
import metals as metals_mod


def _fmt(v, nd=1):
    if v is None:
        return "—"
    return f"{v:,.{nd}f}"


def _sparkline(points, up: bool, w=120, h=32) -> str:
    """把一串價格畫成迷你 SVG 折線。"""
    vals = [p for p in points if p is not None]
    if len(vals) < 2:
        return f'<svg width="{w}" height="{h}"></svg>'
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1
    n = len(vals)
    color = "#c0392b" if up else "#1e8449"  # 漲紅跌綠（華人市場慣例）
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


_STATUS_STYLE = {
    "break_high": ("突破上線", "#c0392b", "#fbe9e7"),
    "break_low": ("跌破下線", "#1e8449", "#e8f5e9"),
    "in_range": ("區間內", "#2e7d32", "#eef7ee"),
    "unknown": ("無資料", "#777", "#eee"),
}


def render_html(history: dict) -> str:
    """history: {metal_key: [ {ts, price, change, change_pct}, ... ]}。"""
    rows_html = []
    alert_count = 0
    last_update = "—"

    for key, cfg in config.METALS.items():
        series = history.get(key, [])
        latest = series[-1] if series else {}
        price = latest.get("price")           # USD/公噸
        price_twd = latest.get("price_twd")   # NT$/公噸
        change = latest.get("change")
        pct = latest.get("change_pct")
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

        trend = [p.get("price") for p in series[-config.TREND_POINTS :]]
        up = (change or 0) >= 0
        spark = _sparkline(trend, up)
        chg_color = "#c0392b" if up else "#1e8449"
        label, fg, bg = _STATUS_STYLE[status]
        watch = f'{cfg["watch_low"]:,}–{cfg["watch_high"]:,}'

        rows_html.append(
            f"""
        <tr>
          <td class="metal">
            <div class="m-name">{html.escape(cfg['name'])}</div>
            <div class="m-en">{html.escape(cfg['en'])}</div>
          </td>
          <td class="num price">{('NT$' + format(price_twd, ',')) if price_twd else '—'}<div class="usd">{('US$' + _fmt(price)) if price is not None else ''}</div></td>
          <td class="num" style="color:{chg_color}">{('+' if up else '')}{_fmt(change)}</td>
          <td class="num" style="color:{chg_color}">{('+' if up else '')}{_fmt(pct,2)}%</td>
          <td class="spark">{spark}</td>
          <td><span class="badge" style="color:{fg};background:{bg}">{label} {cfg['watch_high'] if status=='break_high' else cfg['watch_low'] if status=='break_low' else ''}</span></td>
          <td class="watch">{watch}</td>
        </tr>"""
        )

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>銅鋁價格追蹤儀表板</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
         margin: 0; background: #f5f5f4; color: #1a1a1a; }}
  .wrap {{ max-width: 920px; margin: 32px auto; padding: 0 20px; }}
  .nav {{ display: flex; gap: 8px; margin-bottom: 18px; }}
  .nav a {{ font-size: 13px; text-decoration: none; padding: 7px 14px; border-radius: 999px;
            border: 1px solid #e2e2e2; color: #555; background: #fff; }}
  .nav a.on {{ background: #1a1a1a; color: #fff; border-color: #1a1a1a; }}
  .eyebrow {{ font-size: 12px; letter-spacing: 2px; color: #999; }}
  h1 {{ font-size: 26px; margin: 4px 0 2px; }}
  .sub {{ color: #666; font-size: 13px; margin-bottom: 20px; }}
  .cards {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }}
  .card {{ background: #fff; border: 1px solid #eee; border-radius: 10px; padding: 14px 16px; }}
  .card .k {{ font-size: 11px; color: #999; letter-spacing: 1px; }}
  .card .v {{ font-size: 22px; font-weight: 700; margin-top: 4px; }}
  .panel {{ background: #fff; border: 1px solid #eee; border-radius: 12px; overflow-x: auto; }}
  table {{ width: 100%; border-collapse: collapse; min-width: 640px; }}
  th, td {{ padding: 14px 16px; text-align: right; font-size: 14px; }}
  th {{ font-size: 11px; color: #999; font-weight: 500; letter-spacing: 1px;
        border-bottom: 1px solid #eee; text-align: right; }}
  th:first-child, td:first-child {{ text-align: left; }}
  tr + tr td {{ border-top: 1px solid #f2f2f2; }}
  .metal .m-name {{ font-size: 17px; font-weight: 700; }}
  .metal .m-en {{ font-size: 11px; color: #aaa; letter-spacing: 1px; }}
  .num {{ font-variant-numeric: tabular-nums; }}
  .price {{ font-size: 17px; font-weight: 700; }}
  .price .usd {{ font-size: 11px; color: #aaa; font-weight: 400; margin-top: 2px; }}
  .unit {{ font-size: 11px; color: #aaa; font-weight: 400; }}
  .spark {{ text-align: center; }}
  .watch {{ color: #aaa; font-size: 12px; }}
  .badge {{ display: inline-block; padding: 3px 10px; border-radius: 999px;
            font-size: 12px; font-weight: 600; white-space: nowrap; }}
  .foot {{ color: #aaa; font-size: 12px; margin-top: 14px; }}
  @media (max-width: 560px) {{ .cards {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
  <div class="wrap">
    <div class="nav"><a class="on" href="index.html">🔩 銅鋁價格</a><a href="jobs.html">🔧 人才行情</a></div>
    <div class="eyebrow">METALS TRACKER · LME 倫敦金屬交易所</div>
    <h1>銅鋁價格追蹤儀表板</h1>
    <div class="sub">LME 官方結算價 · 台幣依即時匯率換算 · 每日 10:00 與 22:00（台灣時間）更新 · 突破關注區間時另發 Discord 告警</div>

    <div class="cards">
      <div class="card"><div class="k">追蹤金屬</div><div class="v">{len(config.METALS)} <span style="font-size:13px;color:#999">{' · '.join(m['name'] for m in config.METALS.values())}</span></div></div>
      <div class="card"><div class="k">告警中</div><div class="v">{alert_count} <span style="font-size:13px;color:#999">項突破區間</span></div></div>
      <div class="card"><div class="k">最後更新</div><div class="v" style="font-size:18px">{last_update}</div></div>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>金屬</th><th>現價 (NT$/t)</th><th>漲跌 (US$)</th><th>漲跌幅</th>
            <th>近 {config.TREND_POINTS} 筆走勢</th><th>狀態</th><th>關注區間 (US$)</th>
          </tr>
        </thead>
        <tbody>{''.join(rows_html)}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：LME 官方價（Westmetall）· 匯率 Yahoo Finance · 僅供內部參考。狀態燈依 config.py 關注區間自動標示。</div>
  </div>
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


def _delta_span(v, unit="") -> str:
    if v is None:
        return ""
    if v > 0:
        return f'<span style="color:#c0392b;font-size:13px">▲{v:,}{unit}</span>'
    if v < 0:
        return f'<span style="color:#1e8449;font-size:13px">▼{abs(v):,}{unit}</span>'
    return '<span style="color:#999;font-size:13px">持平</span>'


def render_jobs_html(stats: dict, summary: dict, jobs: list,
                     history: list, delta: dict) -> str:
    """金屬加工人才行情儀表板。history: [{ts,total,salary_median,salary_avg},...]。"""
    # 最後更新時間（取 history 最後一筆或現在）
    last_update = "—"
    if history:
        try:
            dt = datetime.datetime.fromisoformat(history[-1]["ts"]).astimezone(
                datetime.timezone(datetime.timedelta(hours=8))
            )
            last_update = dt.strftime("%Y-%m-%d %H:%M")
        except Exception:  # noqa: BLE001
            pass

    # 走勢：職缺數 / 月薪中位數
    totals = [h.get("total") for h in history[-config.TREND_POINTS:]]
    meds = [h.get("salary_median") for h in history[-config.TREND_POINTS:]]
    spark_total = _sparkline(totals, up=(len(totals) >= 2 and (totals[-1] or 0) >= (totals[0] or 0)))
    spark_med = _sparkline(meds, up=(len(meds) >= 2 and (meds[-1] or 0) >= (meds[0] or 0)))

    med = f"NT${stats['salary_median']:,}" if stats["salary_median"] else "—"
    avg = f"NT${stats['salary_avg']:,}" if stats["salary_avg"] else "—"
    rng = (f"NT${stats['salary_min']:,} ~ NT${stats['salary_max']:,}"
           if stats["salary_min"] else "—")

    # 熱門公司 / 熱區
    comp_rows = "".join(
        f"<tr><td>{html.escape(c)}</td><td class='num'>{n}</td></tr>"
        for c, n in stats["top_companies"]
    ) or "<tr><td>—</td><td></td></tr>"
    area_rows = "".join(
        f"<tr><td>{html.escape(a)}</td><td class='num'>{n}</td></tr>"
        for a, n in stats["top_areas"]
    ) or "<tr><td>—</td><td></td></tr>"

    # 值得注意的職缺：可解析薪資者取薪資最高前 8
    def _mid(j):
        lo, hi = j.get("salary_low"), j.get("salary_high")
        return (lo + hi) / 2 if (lo and hi) else (lo or 0)
    notable = sorted([j for j in jobs if j.get("salary_low")],
                     key=_mid, reverse=True)[:8]
    job_rows = "".join(
        f"""<tr>
          <td><a href="{html.escape(j['url'])}" target="_blank" rel="noopener">{html.escape(j['title'][:38])}</a></td>
          <td>{html.escape(j['company'][:20])}</td>
          <td>{html.escape(j['area'])}</td>
          <td class="num">{_salary_disp(j)}</td>
        </tr>""" for j in notable
    ) or "<tr><td colspan='4'>—</td></tr>"

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>金屬加工人才行情儀表板</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
         margin: 0; background: #f5f5f4; color: #1a1a1a; }}
  .wrap {{ max-width: 920px; margin: 32px auto; padding: 0 20px; }}
  .nav {{ display: flex; gap: 8px; margin-bottom: 18px; }}
  .nav a {{ font-size: 13px; text-decoration: none; padding: 7px 14px; border-radius: 999px;
            border: 1px solid #e2e2e2; color: #555; background: #fff; }}
  .nav a.on {{ background: #1a1a1a; color: #fff; border-color: #1a1a1a; }}
  .eyebrow {{ font-size: 12px; letter-spacing: 2px; color: #999; }}
  h1 {{ font-size: 26px; margin: 4px 0 2px; }}
  .sub {{ color: #666; font-size: 13px; margin-bottom: 20px; }}
  .cards {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }}
  .card {{ background: #fff; border: 1px solid #eee; border-radius: 10px; padding: 14px 16px; }}
  .card .k {{ font-size: 11px; color: #999; letter-spacing: 1px; }}
  .card .v {{ font-size: 20px; font-weight: 700; margin-top: 4px; }}
  .card .spk {{ margin-top: 6px; }}
  .ai {{ background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }}
  .ai h2 {{ font-size: 15px; margin: 0 0 12px; }}
  .ai .row {{ margin-bottom: 10px; }}
  .ai .lbl {{ font-size: 12px; color: #2c7be5; font-weight: 600; }}
  .ai .txt {{ font-size: 14px; color: #333; margin-top: 2px; line-height: 1.55; }}
  .grid2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }}
  .panel {{ background: #fff; border: 1px solid #eee; border-radius: 12px; overflow-x: auto; }}
  .panel h3 {{ font-size: 13px; margin: 0; padding: 14px 16px 8px; color: #444; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ padding: 10px 16px; text-align: left; font-size: 13px; }}
  th {{ font-size: 11px; color: #999; font-weight: 500; letter-spacing: 1px; border-bottom: 1px solid #eee; }}
  tr + tr td {{ border-top: 1px solid #f5f5f5; }}
  td a {{ color: #2c7be5; text-decoration: none; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  th.num {{ text-align: right; }}
  .foot {{ color: #aaa; font-size: 12px; margin-top: 14px; }}
  @media (max-width: 640px) {{ .cards {{ grid-template-columns: 1fr 1fr; }} .grid2 {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
  <div class="wrap">
    <div class="nav"><a href="index.html">🔩 銅鋁價格</a><a class="on" href="jobs.html">🔧 人才行情</a></div>
    <div class="eyebrow">TALENT MARKET · 104 公開職缺</div>
    <h1>金屬加工人才行情</h1>
    <div class="sub">104 公開職缺每日彙整 · 每日 08:00（台灣時間）更新 · 資料來源為公開徵才頁，僅供招募行情參考</div>

    <div class="cards">
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

    <div class="panel">
      <h3>⭐ 值得注意的職缺（薪資最高）</h3>
      <table>
        <thead><tr><th>職缺</th><th>公司</th><th>地區</th><th class="num">月薪</th></tr></thead>
        <tbody>{job_rows}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：104 人力銀行公開職缺 · 最後更新 {last_update} · 僅供內部招募行情參考，非即時、不含企業人才庫。</div>
  </div>
</body>
</html>"""
