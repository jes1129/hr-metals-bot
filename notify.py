# -*- coding: utf-8 -*-
"""
notify.py — Discord 推送（改用 Discord Webhook，取代原本的 Telegram）。

Discord Webhook 最單純：頻道設定 → 整合 → Webhook → 建立 → 複製網址，
存進 Modal Secret 的 DISCORD_WEBHOOK_URL 即可，不需 Bot Token / Chat ID。
訊息用 Markdown（**粗體**），單則上限 2000 字，超過會自動分段送出。
"""
import os

import config

DISCORD_LIMIT = 2000  # Discord 單則訊息字數上限


def _safe_print(text: str):
    """印到主控台而不會因編碼而中斷。

    Windows 主控台預設 cp950，遇到 emoji（如 🏭）會拋 UnicodeEncodeError。
    這裡是「沒有 webhook 時印出內容預覽」的路徑——本身不影響產出，
    卻會讓呼叫端誤判為推播失敗，故必須容錯。
    GitHub Actions 為 UTF-8，不會走到 except。
    """
    try:
        print(text)
    except UnicodeEncodeError:
        enc = (getattr(__import__("sys").stdout, "encoding", None) or "utf-8")
        print(text.encode(enc, "replace").decode(enc, "replace"))


def _webhook_url():
    return os.environ.get(config.ENV_DISCORD_WEBHOOK)


def _split(text: str, limit: int = DISCORD_LIMIT):
    """把長訊息依行切成不超過 limit 的多段（盡量不切斷單行）。"""
    chunks, cur = [], ""
    for line in text.split("\n"):
        # 單行就超長時硬切
        while len(line) > limit:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(line[:limit])
            line = line[limit:]
        add = (cur + "\n" + line) if cur else line
        if len(add) > limit:
            chunks.append(cur)
            cur = line
        else:
            cur = add
    if cur:
        chunks.append(cur)
    return chunks


def send(text: str) -> bool:
    """送一則 Markdown 純文字訊息到 Discord。回傳是否成功。"""
    url = _webhook_url()
    if not url:
        print("[notify] 缺少 DISCORD_WEBHOOK_URL，略過推送。")
        print("[notify] 內容預覽：\n" + text)
        return False

    import httpx  # 延遲匯入（本地可能未裝）

    ok = True
    for chunk in _split(text):
        try:
            resp = httpx.post(url, json={"content": chunk}, timeout=30)
            resp.raise_for_status()
        except Exception as e:  # noqa: BLE001
            print(f"[notify] Discord 推送失敗：{e}")
            ok = False
    return ok


def send_embeds(embeds: list, content: str = None) -> bool:
    """送 embed 卡片到 Discord（每則最多 10 張，超過自動分批）。
    content 只掛在第一則作為標題文字。回傳是否成功。"""
    if not embeds:
        return send(content) if content else False

    url = _webhook_url()
    if not url:
        print("[notify] 缺少 DISCORD_WEBHOOK_URL，略過推送。")
        titles = "、".join(e.get("title", "") for e in embeds)
        _safe_print(f"[notify] embed 預覽（{len(embeds)} 張）：{titles}")
        return False

    import httpx  # 延遲匯入（本地可能未裝）

    ok = True
    for i in range(0, len(embeds), 10):  # Discord 單則最多 10 張 embed
        payload = {"embeds": embeds[i : i + 10]}
        if i == 0 and content:
            payload["content"] = content[:DISCORD_LIMIT]
        try:
            resp = httpx.post(url, json=payload, timeout=30)
            resp.raise_for_status()
        except Exception as e:  # noqa: BLE001
            print(f"[notify] Discord embed 推送失敗：{e}")
            ok = False
    return ok
