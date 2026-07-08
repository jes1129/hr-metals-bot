# -*- coding: utf-8 -*-
"""
config.py — 所有可調設定集中在這裡。

換目標網站 + 換這裡的 profile / 關注區間 = 一套新的自動追蹤系統，
main.py 的架構不用動（對應指南第 10 頁「關鍵原則」）。
"""

# =============================================================================
# 功能 A — 人才條件 Profile（對應指南第 6 頁）
# 系統會把 TALENT_PROFILE 加進 AI 的 System Prompt，讓評分完全符合招募需求。
# 目前條件留白，之後補上即可，不需改動程式。
# =============================================================================
TALENT_PROFILE = {
    # 目標職位：要招募的職缺（例：資深後端工程師）
    "target_role": "",
    # 必備技能：硬性門檻（例：Python、PostgreSQL）
    "must_have": [],
    # 加分技能：有更好（例：AWS、Kubernetes）
    "nice_to_have": [],
    # 期望年資 / 學歷：篩選門檻（例：5 年以上、資工相關科系）
    "experience": "",
    # 偏好特質：新創經驗、可遠端、帶人經驗…
    "preferred_traits": [],
    # 排除條件：僅接案、完全無相關經驗…
    "exclude": [],
}

# 104 人才庫搜尋參數。
# TODO(verify): 對照實際 104 企業版人才搜尋頁 / 後端 API 的查詢參數再補實。
SEARCH_PARAMS = {
    "keyword": "",        # 搜尋關鍵字
    "area": "",           # 地區代碼
    "job_category": "",   # 職務類別代碼
    "page_size": 40,      # 每頁筆數
    "max_pages": 3,       # 最多抓幾頁（控制爬取量、避免過度請求）
}

# =============================================================================
# AI 評分（直連 Anthropic 官方 API）
# 指南原用 OpenRouter 轉接 claude-3.5-haiku；因只用 Claude，改為直接接 Anthropic
# 官方 SDK，少一層依賴。判斷品質建議 claude-opus-4-8；要更省成本改 claude-haiku-4-5。
# =============================================================================
AI_MODEL = "claude-opus-4-8"   # 候選人評分模型；省成本可改 "claude-haiku-4-5"
BATCH_SIZE = 10          # 每批 10 位候選人發一次請求
SCORE_THRESHOLD = 8      # 8 分以上才推送（指南第 3 頁「每日輸出」）

# AI 評分分級標準（寫進 System Prompt，對應指南第 6 頁）
SCORING_RUBRIC = (
    "10 分：完美匹配（技能全中、年資與特質皆符合）\n"
    "8-9 分：強烈推薦，符合大部分條件\n"
    "6-7 分：值得考慮\n"
    "4-5 分：一般，有明顯缺點\n"
    "1-3 分：不推薦（技能不符、年資不足）"
)

# =============================================================================
# 功能 B — 銅鋁監控（對應指南第 8、9、14 頁）
# 關注區間數值取自指南第 14 頁範例：銅 9,200–9,800、鋁 2,400–2,900。
# =============================================================================
METALS = {
    "copper": {
        "name": "銅",
        "en": "COPPER · LME",
        "unit": "USD/t",
        "watch_low": 9200,     # 跌破下線 → 告警
        "watch_high": 9800,    # 突破上線 → 告警
        # TODO(verify): 鉅亨網銅報價實際頁面 / API 網址
        "url": "https://www.cnyes.com/futures/html5chart/COMEX:HG.html",
    },
    "aluminum": {
        "name": "鋁",
        "en": "ALUMINUM · LME",
        "unit": "USD/t",
        "watch_low": 2400,
        "watch_high": 2900,
        # TODO(verify): 鉅亨網鋁報價實際頁面 / API 網址
        "url": "https://www.cnyes.com/futures/html5chart/LME:AHD.html",
    },
}

# 儀表板迷你走勢取最近幾筆
TREND_POINTS = 14

# =============================================================================
# Secrets 對應的環境變數名稱（值存在 Modal Secret，不寫在這裡）
# =============================================================================
ENV_ANTHROPIC_KEY = "ANTHROPIC_API_KEY"
ENV_DISCORD_WEBHOOK = "DISCORD_WEBHOOK_URL"
ENV_104_ACCOUNT = "LOGIN_104_ACCOUNT"
ENV_104_PASSWORD = "LOGIN_104_PASSWORD"
