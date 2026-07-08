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
        price = latest.get("price")
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
          <td class="num price">{_fmt(price)} <span class="unit">{cfg['unit']}</span></td>
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
    <div class="eyebrow">METALS TRACKER · Yahoo Finance</div>
    <h1>銅鋁價格追蹤儀表板</h1>
    <div class="sub">每日 10:00 與 22:00（台灣時間）更新 · 突破關注區間時另發 Discord 告警</div>

    <div class="cards">
      <div class="card"><div class="k">追蹤金屬</div><div class="v">{len(config.METALS)} <span style="font-size:13px;color:#999">{' · '.join(m['name'] for m in config.METALS.values())}</span></div></div>
      <div class="card"><div class="k">告警中</div><div class="v">{alert_count} <span style="font-size:13px;color:#999">項突破區間</span></div></div>
      <div class="card"><div class="k">最後更新</div><div class="v" style="font-size:18px">{last_update}</div></div>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>金屬</th><th>現價</th><th>漲跌</th><th>漲跌幅</th>
            <th>近 {config.TREND_POINTS} 筆走勢</th><th>狀態</th><th>關注區間</th>
          </tr>
        </thead>
        <tbody>{''.join(rows_html)}</tbody>
      </table>
    </div>
    <div class="foot">資料來源：Yahoo Finance（COMEX）· 僅供內部參考。狀態燈依 config.py 關注區間自動標示。</div>
  </div>
</body>
</html>"""
