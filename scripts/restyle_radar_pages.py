# -*- coding: utf-8 -*-
"""
restyle_radar_pages.py — 一次性：把現有的 docs/suppliers.html、docs/customers.html 換成新外觀。

這兩頁每月 1 號才由 run_radar.py 重新產生（要重新爬資料＋AI 評分），改了 radar_page.py 之後
不想等到下個月、也不想重爬，就用這支：只換導覽列／載入圖示，emoji 換成線條圖示或拿掉，名單資料完全不動。
下個月 run_radar 用新版 radar_page.py 產生的頁面會自然取代這份。
用法：python scripts/restyle_radar_pages.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import dashboard  # noqa: E402

ICON = {"🏠": "home", "📈": "chart", "🔩": "ingot", "🏭": "factory", "🎯": "target", "🧮": "calc", "📦": "box",
        "🤖": "bot", "🗂": "db", "📖": "book", "📋": "clipboard", "⚠": "alert", "🔄": "refresh", "✨": "sparkle",
        "🔔": "bell", "🔎": "filter", "⭐": "star"}
EMO = re.compile(r"[\U0001F300-\U0001FAFF☀-➿⭐]️?")


def restyle(path: str, nav_key: str) -> bool:
    with open(path, encoding="utf-8") as f:
        page = f.read()
    # 導覽列：整段換成新版（含下拉、圖示、佈景鈕）
    page, n = re.subn(r'<div class="topbar">.*?</div>\s*(?=<div class="eyebrow")',
                      f'<div class="topbar">{dashboard._nav(nav_key)}{dashboard._THEME_BTN}</div>\n    ',
                      page, count=1, flags=re.S)
    if not n:
        print(f"[restyle] 找不到導覽列，略過：{path}")
        return False
    head, sep, body = page.partition("<body>")
    script_split = re.split(r"(<script\b.*?</script>)", body, flags=re.S)

    def fix_html(chunk: str) -> str:
        # 元素開頭的 emoji（標題、標籤、星號）→ 圖示；其餘（名單括號內的能力符號等）→ 拿掉
        def at_start(m):
            name = ICON.get(m.group(2)[0])
            icon = dashboard._ic(name) if name else ""
            if name == "star":
                icon = '<span class="star" title="神岡周邊">' + dashboard._ic("star") + "</span>"
            return m.group(1) + icon
        chunk = re.sub(r"(>\s*)(" + EMO.pattern + r") ?", at_start, chunk)
        chunk = re.sub(r" ?" + EMO.pattern, "", chunk)
        return chunk.replace("標 近", "標星號").replace("標近", "標星號")

    body = "".join(p if p.startswith("<script") else fix_html(p) for p in script_split)
    head = EMO.sub("", head)          # <title> 等
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(head + sep + body)
    left = len(EMO.findall(head + body))
    print(f"[restyle] {os.path.basename(path)} 完成（剩餘 emoji：{left}，多在頁內 script 的資料裡）")
    return True


if __name__ == "__main__":
    docs = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
    for name, key in (("suppliers.html", "suppliers"), ("customers.html", "customers")):
        p = os.path.join(docs, name)
        if os.path.exists(p):
            restyle(p, key)
