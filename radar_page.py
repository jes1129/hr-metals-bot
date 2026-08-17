# -*- coding: utf-8 -*-
"""radar_page.py — 雷達頁（新版）：交叉驗證 ＋ 變動偵測。

與舊的 dashboard.render_suppliers_html 的三個差別：

  1. 原本五欄「AI 評語」的位置改為「本月變化」
     判斷端的輸出契約從**描述性文字**改為**可行動的變化清單**——
     評語看完沒有人的行為會改變，變化清單會（知道該打給誰、誰倒了）。

  2. 只嵌入前 DASHBOARD_TOP 家（50），不再把整份名單寫死進網頁。
     舊版 docs/suppliers.html 為 178 KB；本版約 40 KB。
     完整名單留在 data/ 的快照檔（下期比對的基準需要它）。

  3. 顯示篩選漏斗與降級標記——把「靜默降級」改成「透明降級」。
     使用者看得出這份結果是由哪一層產出的。

樣式沿用 docs/assets/style.css 的既有 class 與 CSS 變數，不自帶樣式。
舊函式完全不動，確認本版無誤後才切換 run_suppliers.py。
"""
import collections
import datetime
import html
import re

import config
from dashboard import _HEAD, _THEME_BTN, _VER, _hbars, _nav

_CAP_EMOJI = {"代客加工": "🔧", "表面處理": "✨", "鍛造": "🔨", "板金": "📐"}
_LAYER = {
    "rule": ("⚪ 內建備援（未呼叫外部模型）", "var(--muted)"),
    "free": ("🟢 免費層", "var(--down)"),
    "paid": ("🔵 付費層", "var(--accent)"),
}


def _area(s: str, n=12) -> str:
    return re.sub(r"^臺中市", "", s or "")[:n]


def _change_block(ch: dict) -> str:
    """本月變化——取代原本的五欄評語。"""
    if not ch.get("comparable"):
        return ('<div class="ai"><h2>📋 本月變化</h2>'
                '<div class="row"><div class="lbl">狀態</div>'
                f'<div class="txt">{html.escape(ch.get("reason", ""))}'
                f'　（名單 {ch.get("total", 0):,} 家）</div></div></div>')

    def lst(items, n=8):
        if not items:
            return "—"
        out = []
        for it in items[:n]:
            caps = "".join(_CAP_EMOJI.get(c, "") for c in it.get("caps", []))
            out.append(f'{html.escape(it["name"][:18])}'
                       f'<span class="rnote">（{html.escape(_area(it.get("area", ""), 10))}'
                       f'{caps}）</span>')
        more = f'　…另 {len(items) - n} 家' if len(items) > n else ""
        return "、".join(out) + more

    blocks = [
        ("⚠️ 確認歇業", ch["gone_closed"], "已不在「生產中工廠清冊」內，建議儘快確認並找替代"),
        ("🔄 搬遷或改行業", ch["gone_moved"], "仍在全國清冊中，只是不再符合本期條件（非歇業）"),
        ("✨ 本月新增", ch["new"], "新登記的工廠通常正在找生意"),
        ("📈 資料變完整", ch["improved"], ""),
    ]
    body = ""
    for label, items, note in blocks:
        if not items and label.startswith(("⚠️", "🔄")):
            continue          # 沒有壞消息時不佔版面
        body += (f'<div class="row"><div class="lbl">{label} {len(items)}</div>'
                 f'<div class="txt">{lst(items)}'
                 + (f'<div class="rnote">{note}</div>' if note and items else "")
                 + "</div></div>")

    alert = ""
    if ch.get("partner_alerts"):
        names = "、".join(html.escape(a["name"][:18]) for a in ch["partner_alerts"])
        alert = ('<div class="row" style="border-left:3px solid var(--up);padding-left:10px">'
                 '<div class="lbl">🔔 現有協力廠</div>'
                 f'<div class="txt"><b>{names}</b> 發生變化，已即時推播</div></div>')

    return (f'<div class="ai"><h2>📋 本月變化（名單 {ch["total"]:,} 家，'
            f'上期 {ch["prev_total"]:,} 家）</h2>{alert}{body}</div>')


def _funnel_block(st: dict) -> str:
    """篩選漏斗。「篩掉幾家」本身就是價值證明，所以要顯示。"""
    base = st.get("factory_total") or 1
    steps = [
        ("全國生產中工廠", st.get("factory_total")),
        (config.GOV_CITY, st.get("factory_城市內")),
        ("金屬機械類、排除兼營非金屬、統編去重", st.get("factory_去重後")),
        ("稅籍也查得到（交叉驗證）", st.get("both")),
        ("能力明確對應需求", st.get("candidates")),
    ]
    rows = ""
    for label, n in steps:
        if n is None:
            continue
        rows += (f'<div class="hrow"><div class="hlabel">{html.escape(str(label))}</div>'
                 f'<div class="htrack"><div class="hbar" style="width:'
                 f'{round(n / base * 100, 2)}%"></div></div>'
                 f'<div class="hval">{n:,}</div></div>')
    notes = []
    if st.get("only_tax"):
        notes.append(f'另有 <b>{st["only_tax"]:,}</b> 家僅有稅籍登記、無工廠登記'
                     f'（多為貿易商或工程行），未列入')
    if st.get("dropped_machine_builder"):
        notes.append(f'<b>{st["dropped_machine_builder"]:,}</b> 家為工具機／機械製造廠'
                     f'（只有 291／293 代碼、無 254 代客加工）——它們是賣機器的，不是加工服務廠')
    if st.get("dropped_no_capability"):
        notes.append(f'<b>{st["dropped_no_capability"]:,}</b> 家能力不明，無法判斷是否符合需求')
    if st.get("factory_兼營非金屬而剔除"):
        notes.append(f'<b>{st["factory_兼營非金屬而剔除"]:,}</b> 列因兼營塑膠／橡膠／食品等而剔除')
    note = ""
    if notes:
        note = ('<div class="rnote" style="padding:0 16px 12px">'
                + "；".join(notes) + "。</div>")
    return f'<div class="hbars">{rows}</div>{note}'


def _runstrip(agent: str) -> str:
    """執行紀錄燈號——雷達每月才跑一次，某期失敗最糟要等一個月才會發現。
    老闆看一眼就知道機器還活著。綠＝正常、黃＝降級、紅＝失敗。
    """
    try:
        import runlog
        rows = runlog.status(agent, 12)
        age = runlog.last_ok_age_days(agent)
    except Exception:  # noqa: BLE001
        return ""
    if not rows:
        return ""
    dots = "".join(
        f'<span title="{html.escape(r["title"])}" style="color:{r["color"]};'
        f'font-size:17px;line-height:1;cursor:default">{r["sym"]}</span>'
        for r in rows)
    age_txt = ("最後成功：今天" if age is not None and age < 1 else
               f"最後成功：{age:.0f} 天前" if age is not None else "尚無成功紀錄")
    return (f'<div class="panel" style="padding:12px 16px">'
            f'<span class="rk">最近 {len(rows)} 期</span>'
            f'<span style="letter-spacing:5px;margin:0 10px">{dots}</span>'
            f'<span class="rnote">{age_txt}　（滑過燈號看該次詳情）</span></div>')


def render(profile: dict, cands: list, changes: dict, st: dict,
           layer="rule", title="供應商雷達", nav_key="suppliers",
           agent="suppliers", radar=None, top=None) -> str:
    """radar 為 config.RADARS 的一段；top 為 AI（或規則）選出的前 N 家。"""
    radar = radar or {}
    top = (top or cands)[:config.DASHBOARD_TOP]
    near_th = config.SUPPLIER_NEAR_THRESHOLD

    cap_bars = _hbars([(k, v, str(v)) for k, v in
                       sorted(st.get("cap_counts", {}).items(), key=lambda x: -x[1])])
    areas = collections.Counter(_area(c.get("area", ""), 6) for c in cands if c.get("area"))
    area_bars = _hbars([(a, n, str(n)) for a, n in areas.most_common(10)])

    rows = ""
    for i, c in enumerate(top, 1):
        caps = " ".join(f'<span class="rtag">{_CAP_EMOJI.get(x, "")}{html.escape(x)}</span>'
                        for x in c.get("caps", []))
        star = "⭐ " if c.get("near", 0) >= near_th else ""
        cap = str(c.get("capital", "") or "")
        cap_txt = f"{int(cap):,}" if cap.isdigit() else (html.escape(cap) or "—")
        reason = c.get("ai_reason", "")
        why = (f'<div class="rnote">{html.escape(reason[:150])}</div>' if reason else "")
        conflict = c.get("ai_conflict", "")
        if conflict:
            why += (f'<div class="rnote" style="color:var(--up)">⚠️ '
                    f'{html.escape(conflict[:110])}</div>')
        rows += (f"<tr><td>{i}</td><td>{star}{html.escape(c['name'][:30])}{why}</td>"
                 f"<td>{caps}</td><td>{html.escape(_area(c.get('area', '')))}</td>"
                 f'<td class="num">{cap_txt}</td>'
                 f'<td class="num">{c.get("ai_score") or c.get("score", "")}</td></tr>')
    rows = rows or '<tr><td colspan="6">—</td></tr>'

    lab, col = _LAYER.get(layer, _LAYER["rule"])
    vc = st.get("version_changed")
    ver_txt = ("已確認為最新版" if vc else
               "政府尚未發布新版" if vc is False else "版本無法確認")
    needs = "".join(f'<span class="rtag">{html.escape(n)}</span>'
                    for n in profile.get(radar.get("needs_key", "needs"), []))
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    near_cnt = sum(1 for c in cands if c.get("near", 0) >= near_th)

    return f"""<!doctype html>
<html lang="zh-TW">
<head>
{_HEAD}
<title>{html.escape(profile.get('name', ''))} · {html.escape(title)}</title>
</head>
<body>
  <div class="wrap">
    <div class="topbar">{_nav(nav_key)}{_THEME_BTN}</div>
    <div class="eyebrow">工廠登記名錄 × 財政部稅籍 · 以統一編號交叉驗證</div>
    <h1>{html.escape(title)} · {html.escape(profile.get('name', ''))}</h1>
    <div class="sub">六關篩選 ＋ 統編對帳 ＋ 與上期快照比對 · 每月 1 號更新 ·
      產出 {now:%Y-%m-%d %H:%M} · <span style="color:{col}">{lab}</span> ·
      資料版本：{ver_txt}</div>

    <div class="ai" style="border-left:3px solid var(--accent)">
      <h2>🎯 要找什麼樣的供應商</h2>
      <div class="refgrid">
        <div><span class="rk">地區</span>{html.escape(profile.get('address', ''))}</div>
        <div><span class="rk">本業</span>{html.escape(profile.get('business', ''))}</div>
      </div>
      <div class="reftags">需求能力：{needs}
        <span class="rnote">※ 神岡周邊標 ⭐近　※ 金屬材料（棒材）無法由本資料源取得
        ——材料商是貿易商、無工廠登記，需另一組門檻</span></div>
    </div>

    <div class="cards four">
      <div class="card"><div class="k">通過六關的候選</div><div class="v">{len(cands):,}</div>
        <div class="k" style="margin-top:6px">母體 {st.get('factory_城市內', 0):,} 家</div></div>
      <div class="card"><div class="k">⭐ 神岡周邊</div><div class="v">{near_cnt:,}</div></div>
      <div class="card"><div class="k">本月新增</div>
        <div class="v">{len(changes.get('new', []))}</div></div>
      <div class="card"><div class="k">⚠️ 確認歇業</div>
        <div class="v">{len(changes.get('gone_closed', []))}</div>
        <div class="k" style="margin-top:6px">已離開生產中清冊</div></div>
    </div>

    {_runstrip(agent)}

    {_change_block(changes)}

    <div class="grid2">
      <div class="panel"><h3>🗂️ 能力分佈（一家可符合多項）</h3>{cap_bars}</div>
      <div class="panel"><h3>所在行政區（前 10）</h3>{area_bars}</div>
    </div>

    <div class="panel"><h3>🔎 篩選漏斗（每一關剔除了多少）</h3>{_funnel_block(st)}</div>

    <div class="panel">
      <h3>值得優先接觸的 {len(top)} 家</h3>
      <div class="rnote" style="padding:0 16px 10px">
        {"由 AI 兩輪細選（理由顯示於公司名下方）" if layer != "rule" else
          "由規則粗排序：能力吻合" + ("＞ 距離 " if radar.get("near_matters", True) else "")
          + "＞ 來源數"}；<b>規模不列入</b>。
        完整 {len(cands):,} 家名單見 repo 的 <code>data/{config.SNAP_LIST_FILE.format(agent=agent)}</code>。
      </div>
      <table>
        <thead><tr><th>#</th><th>公司</th><th>能力</th><th>行政區</th>
          <th class="num">資本額</th><th class="num">分數</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>

    <div class="foot">來源：經濟部產業發展署「生產中工廠清冊」＋ 財政部營業稅籍登記開放資料，
      均採政府資料開放授權條款第 1 版。名單成員全部來自工廠登記名錄（門檻為有工廠登記且生產中）；
      稅籍僅用於判斷工法與提供資本額。資料源含負責人姓名，系統於解析階段即排除，
      不進入後續流程或產物。實際產能／品質／認證請自行電話與實地查核。</div>
  </div>
  <script src="assets/app.js?v={_VER}"></script>
</body>
</html>"""
