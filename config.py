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
# 功能 A（實驗版）— 公開職缺行情追蹤（免登入、免企業帳號）
# 目的：在還沒有 104 企業人才庫前，先追「金屬加工業」的公開職缺 + 薪資行情。
# 資料源：104 公開職缺搜尋頁（Playwright + stealth 過 Cloudflare，與未來企業版同一套）。
# 之後拿到企業帳號，只要把 market.fetch_jobs() 換成 talent.fetch_candidates() 即可，
# 「Claude 分析 → Discord 推播」整條後段不動。
# =============================================================================
# 每個關鍵字各搜一輪、彙整去重（104 空白分隔為 OR 邏輯）。聚焦金屬加工相關。
JOB_QUERIES = [
    "金屬加工",
    "CNC 金屬",
    "沖壓 金屬",
    "鑄造 壓鑄",
    "模具 金屬",
    "銅 鋁 製程",
    "金屬 材料 工程師",
    "表面處理 電鍍",
]

# 相關性過濾：職缺標題/公司/內容需命中任一關鍵字，否則視為置頂廣告雜訊剔除。
JOB_RELEVANCE = [
    "金屬", "銅", "鋁", "不鏽鋼", "鋼", "CNC", "沖壓", "鑄造", "壓鑄", "鍛造",
    "模具", "熱處理", "表面處理", "電鍍", "冶金", "軋", "擠型", "抽線",
    "板金", "沖床", "製程", "材料", "鑄件", "五金",
]

# 每個關鍵字最多抓幾頁（1 頁約 20 筆）。實驗版控制在小量、禮貌爬取。
JOB_MAX_PAGES = 2
# 職缺熱度歷史快照存放（與功能 B 的 prices.json 同一個 data/ 目錄）
JOBS_FILE = "jobs.json"

# =============================================================================
# AI 評分（直連 Anthropic 官方 API）
# 指南原用 OpenRouter 轉接 claude-3.5-haiku；因只用 Claude，改為直接接 Anthropic
# 官方 SDK，少一層依賴。判斷品質建議 claude-opus-4-8；要更省成本改 claude-haiku-4-5。
# =============================================================================
AI_MODEL = "claude-opus-4-8"   # 候選人評分模型；省成本可改 "claude-haiku-4-5"

# AI 供應商自動偵測（market.py 行情分析用）：
#   有 GEMINI_API_KEY  → 用 Google Gemini（免費額度，免綁卡，推薦）
#   有 ANTHROPIC_API_KEY → 用 Claude（品質最好，需付費）
#   兩者皆無 → 退化為純統計摘要
# Gemini 免費金鑰申請：https://aistudio.google.com/apikey
GEMINI_MODEL = "gemini-2.5-flash"   # 免費額度模型；一天一次的用量綽綽有餘
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
# 功能 B — 銅鋁監控（LME 倫敦官方價，以台幣顯示）
# 資料源：Westmetall 公布的 LME 官方結算價（USD/公噸，免金鑰、免瀏覽器）。
# 台幣：以 Yahoo 的 USDTWD 即時匯率換算。watch 區間為 USD/公噸，請依實際想盯價位調整。
# =============================================================================
LME_URL = "https://www.westmetall.com/en/markdaten.php"
FX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/USDTWD=X"  # USD→TWD 匯率

METALS = {
    "copper": {
        "name": "銅",
        "en": "COPPER · LME",
        "field": "LME_Cu_cash",  # Westmetall 欄位代碼（現金結算）
        "yh": "HG=F",            # Yahoo 日線回補（COMEX 銅，USD/磅）
        "yh_unit": "lb",         # 需 ×LB_PER_TONNE 換成 USD/公噸
        "watch_low": 12000,      # 跌破下線 → 告警（USD/公噸）
        "watch_high": 14000,     # 突破上線 → 告警（USD/公噸）
    },
    "aluminum": {
        "name": "鋁",
        "en": "ALUMINUM · LME",
        "field": "LME_Al_cash",
        "yh": "ALI=F",           # Yahoo 日線回補（LME 鋁，USD/公噸）
        "yh_unit": "t",
        "watch_low": 2900,
        "watch_high": 3400,
    },
}

# 儀表板迷你走勢取最近幾筆
TREND_POINTS = 14

# 走勢圖日線回補（Yahoo Finance，免金鑰）：現價/告警仍用 LME 官方（Westmetall），
# 走勢圖改用每日收盤以看趨勢。回補一年、每次執行更新。
YH_FX = "USDTWD=X"            # 匯率日線 symbol
LB_PER_TONNE = 2204.62       # USD/磅 → USD/公噸
DAILY_FILE = "daily.json"    # 日線資料（與 prices.json 同一個 data/ 目錄）
MA_WINDOW = 20               # 移動平均天數（月均）

# 人才頁：職務類別關鍵字規則（依序比對，命中即歸類；皆未中歸「其他」）
JOB_CATEGORIES = [
    ("CNC / 加工", ["cnc", "加工", "車床", "銑床", "磨床", "車銑"]),
    ("品管 / 檢驗", ["品管", "品保", "檢驗", "qc", "qa", "量測", "計量"]),
    ("工程師 / 研發", ["工程師", "研發", "engineer", "製程", "設計"]),
    ("模具", ["模具", "沖模", "壓鑄模"]),
    ("焊接 / 銲接", ["焊", "銲", "welding"]),
    ("作業 / 技術員", ["作業員", "技術員", "operator", "現場", "領班", "組長"]),
    ("業務 / 助理 / 行政", ["業務", "助理", "行政", "sales", "採購", "文書"]),
]

# 人才頁：技能詞頻統計詞庫（比對職缺標題 + 描述）
JOB_SKILLS = [
    "CNC", "車床", "銑床", "磨床", "沖壓", "沖床", "鑄造", "壓鑄", "鍛造",
    "焊接", "銲接", "線切割", "模具", "熱處理", "電鍍", "表面處理", "板金",
    "品管", "品保", "檢驗", "量測", "PLC", "自動化", "機械", "圖面", "製圖",
    "堆高機", "射出", "研磨", "組裝", "維修", "ISO",
]

# =============================================================================
# Secrets 對應的環境變數名稱（值存在 Modal Secret，不寫在這裡）
# =============================================================================
ENV_ANTHROPIC_KEY = "ANTHROPIC_API_KEY"
ENV_GEMINI_KEY = "GEMINI_API_KEY"
ENV_DISCORD_WEBHOOK = "DISCORD_WEBHOOK_URL"
ENV_104_ACCOUNT = "LOGIN_104_ACCOUNT"
ENV_104_PASSWORD = "LOGIN_104_PASSWORD"
