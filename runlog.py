# -*- coding: utf-8 -*-
"""runlog.py — 執行紀錄／健康檢查表。

為什麼雷達特別需要這個
----------------------
雷達**每月才跑一次**。若某期失敗，最糟情況要等一個月才會發現——而
「失效持續數週而不被察覺」正是無人值守自動化最實際的風險。

原料監控每天跑兩次，壞了隔天就看得出來；雷達沒有這個保護。

記什麼
------
每次執行追加一筆，含資料源版本、各關家數、走了哪一層、耗時、推播結果。
儀表板顯示「最近 12 期」的狀態燈號，老闆看一眼就知道機器還活著。

此紀錄同時是論文實測數據的自動來源——現行 3.3 節的數字是人工記錄的。
"""
import datetime
import json
import os
import time

import config

DATA_DIR = os.environ.get("METALS_DATA_DIR", "/data")
RUNS_FILE = "runs.json"
KEEP = 24          # 保留期數；儀表板顯示最近 12 期


def _path():
    return os.path.join(DATA_DIR, RUNS_FILE)


def load() -> list:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, list) else []
    except Exception:  # noqa: BLE001
        return []


class Run:
    """一次執行的紀錄。用法：

        r = runlog.Run("suppliers")
        ...
        r.stage("crossmatch", candidates=1409)
        r.layer = "rule"
        r.finish(ok=True)
    """

    def __init__(self, agent: str):
        self.agent = agent
        self.t0 = time.monotonic()
        self.rec = {
            "agent": agent,
            "ts": datetime.datetime.now(
                datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="seconds"),
            "stages": {},
            "layer": None,          # rule / free / paid —— 走了哪一層
            "degraded": [],         # 哪些階段降級了
            "notified": None,
            "ok": None,
            "error": None,
        }

    # -- 記錄 --------------------------------------------------------------
    def stage(self, name: str, **kv):
        self.rec["stages"][name] = kv

    def degrade(self, what: str, why: str):
        """明確記下降級——不記的話，事後只能從產物反推，日誌上看不出來。"""
        self.rec["degraded"].append({"what": what, "why": why})

    def source_version(self, name: str, version, changed=None):
        self.rec.setdefault("sources", {})[name] = {
            "version": version, "changed": changed,
        }

    # -- 收尾 --------------------------------------------------------------
    def finish(self, ok=True, error=None, notified=None):
        self.rec["ok"] = bool(ok)
        self.rec["error"] = error
        self.rec["notified"] = notified
        self.rec["seconds"] = round(time.monotonic() - self.t0, 1)
        self._save()
        return self.rec

    def _save(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        runs = [r for r in load() if r.get("agent") == self.agent]
        others = [r for r in load() if r.get("agent") != self.agent]
        runs.append(self.rec)
        runs = runs[-KEEP:]
        with open(_path(), "w", encoding="utf-8") as f:
            json.dump(others + runs, f, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------------------
# 儀表板用
# ---------------------------------------------------------------------------
def status(agent: str, n=12) -> list:
    """最近 n 期，新到舊。每筆給 (符號, 顏色, 提示文字)。"""
    runs = [r for r in load() if r.get("agent") == agent][-n:]
    out = []
    for r in runs:
        if not r.get("ok"):
            sym, col = "✕", "var(--up)"
            hint = f"失敗：{r.get('error') or '未記錄原因'}"
        elif r.get("degraded"):
            sym, col = "▲", "#c8930a"
            hint = "降級：" + "；".join(d["what"] for d in r["degraded"])
        else:
            sym, col = "●", "var(--down)"
            hint = "正常"
        cands = (r.get("stages", {}).get("crossmatch", {}) or {}).get("candidates")
        layer = {"rule": "內建備援", "free": "免費層", "paid": "付費層"}.get(r.get("layer"), "—")
        out.append({
            "sym": sym, "color": col,
            "title": f"{r.get('ts', '')[:16]}｜{hint}｜{layer}"
                     + (f"｜候選 {cands:,} 家" if cands else "")
                     + f"｜{r.get('seconds', '?')} 秒",
        })
    return list(reversed(out))


def last_ok_age_days(agent: str):
    """距離最近一次成功執行幾天。無紀錄回 None。"""
    runs = [r for r in load() if r.get("agent") == agent and r.get("ok")]
    if not runs:
        return None
    try:
        ts = datetime.datetime.fromisoformat(runs[-1]["ts"])
        now = datetime.datetime.now(ts.tzinfo)
        return round((now - ts).total_seconds() / 86400, 1)
    except Exception:  # noqa: BLE001
        return None
