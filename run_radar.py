# -*- coding: utf-8 -*-
"""run_radar.py — 雷達代理人入口。供應商與客戶開發**共用這一份程式碼**。

「一份設定檔衍生一個代理人」在這裡是可驗證的事實，不是宣稱：
**本檔沒有任何 if 供應商 / if 客戶 的分支**，全部差異都在 config.RADARS。

    python run_radar.py suppliers    # 供應商雷達
    python run_radar.py customers    # 客戶開發雷達
    python run_radar.py suppliers --refresh    # 強制重新下載資料源

新增第三個雷達＝在 config.RADARS 多一段設定，這個檔案一行都不用改。

流程（規則做前七關，AI 只在最後兩輪介入）
    crossmatch  下載 → 六關篩選 → 統編對帳 → 能力判準 → 粗排序
    snapshot    與上期快照比對 → 新增／歇業／搬遷／資料變完整
    ai_select   兩輪細選 → 前 50 家（失敗則降級為規則粗排序）
    radar_page  產出網頁
    snapshot    寫本期快照（下期比對的基準）
    runlog      記錄本次執行（走了哪一層、耗時、降級原因）

誠實的邊界：本檔只能衍生「使用同一組資料源」的代理人。若要換資料源
（例如標案是 XML），感知端仍須新寫解析程式——設定驅動不是無條件成立。
"""
import os
import sys
import traceback

import ai_select
import config
import crossmatch
import radar_page
import runlog
import snapshot

DOCS = "docs"


def _alert(msg: str):
    """失敗告警：只寫日誌（Actions 的執行紀錄看得到）。"""
    print("[run_radar] " + msg.replace("\n", " "))


def main(argv=None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    refresh = "--refresh" in argv
    names = [a for a in argv if not a.startswith("-")]
    agent = names[0] if names else "suppliers"

    radar = config.RADARS.get(agent)
    if not radar:
        print(f"[run_radar] 未知的雷達「{agent}」。可用：{', '.join(config.RADARS)}")
        return 2

    title = radar["title"]
    profile = config.SUPPLIER_PROFILE
    out_html = os.path.join(DOCS, radar["out_html"])

    run = runlog.Run(agent)
    try:
        # --- 規則層：六關篩選 ＋ 統編對帳 ＋ 粗排序 --------------------
        cands, st, all_bans = crossmatch.run(radar, refresh=refresh)
        run.source_version("factory", st.get("version"), st.get("version_changed"))
        run.stage("crossmatch", **{k: v for k, v in st.items()
                                  if isinstance(v, (int, float))})
        if st.get("failed"):
            run.finish(ok=False, error=f"資料源取得失敗：{st['failed']}")
            _alert(f"⚠️ {title}：資料源取得失敗（{st['failed']}），本期未產出。")
            return 1
        if not cands:
            run.finish(ok=False, error="篩選後候選為零")
            _alert(f"⚠️ {title}：篩選後候選為零，請檢查篩選條件。")
            return 1

        # --- 規則層：與上期比對（相減是純計算，不需要 AI）--------------
        rules = snapshot.rules_fingerprint(radar)
        prev = snapshot.load_previous(agent)
        changes = snapshot.diff(prev, cands, all_bans, rules,
                               st.get("version"), st.get("version_changed"))
        run.stage("changes", comparable=changes["comparable"],
                  new=len(changes["new"]), gone_closed=len(changes["gone_closed"]),
                  gone_moved=len(changes["gone_moved"]),
                  improved=len(changes["improved"]),
                  partner_alerts=len(changes["partner_alerts"]))
        if not changes["comparable"]:
            run.degrade("變化比對", changes["reason"])

        # --- 判斷端：AI 兩輪（失敗則降級為規則粗排序）------------------
        top, layer = ai_select.select(profile, radar, cands, run=run)
        run.rec["layer"] = layer
        run.stage("select", top=len(top), layer=layer)

        # --- 行動端：網頁 --------------------------------------------
        os.makedirs(DOCS, exist_ok=True)
        page = radar_page.render(profile, cands, changes, st, layer=layer,
                                title=title, nav_key=agent, agent=agent,
                                radar=radar, top=top)
        with open(out_html, "w", encoding="utf-8") as f:
            f.write(page)
        print(f"[run_radar] 已更新 {out_html}（{len(page) / 1024:.0f} KB）")

        # --- 狀態留存：寫本期快照（下期比對的基準）--------------------
        snapshot.save(agent, cands, all_bans, rules, st.get("version"))

        run.finish(ok=True)
        print(f"[run_radar] 完成：{agent} 候選 {len(cands):,} 家、"
              f"前 {len(top)} 家、層級 {layer}")
        return 0

    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        run.finish(ok=False, error=f"{type(e).__name__}: {e}")
        _alert(f"⚠️ {title}：執行失敗 {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
