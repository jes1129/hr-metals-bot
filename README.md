# 九上科技 · 智慧儀表板（原料行情自動化助理）

每天自動抓銅、鋁行情，告訴你「今天該做什麼」，並幫忙報價、盯報價、寄提醒與週報。
**不做 ERP，也不做生產管理**——這是一個每天幫你看盤的助理，不是資源管理系統。

**部署方式：GitHub Actions + GitHub Pages（免費、不綁卡、關機也照跑）**

## 有哪些功能

| 頁面 / 功能 | 做什麼 |
|---|---|
| **今日總覽** | 「今天該做什麼」白話建議、AI 行情解讀、銅鋁價格卡（含走勢、近一年位置）、漲跌原因拆解（國際價 vs 匯率）、報價盯盤、本週行情摘要、資料健康燈號 |
| **原料行情** | 銅鋁日線走勢、均線、期間統計；相關新聞（自動標「偏多／偏空／中性」）；**我的提醒**（價格到線就寄 Email） |
| **報價試算** | 左右兩欄；料價自動帶入最新行情；可手動輸入其他材料（會記住）；情境模擬滑桿；複製報價文字 |
| **報價紀錄** | 專門存放報價：搜尋、材質／時間篩選、刪除單筆、一鍵清除舊資料、匯出 CSV、「和現在比」 |
| **Email（Apps Script）** | 價格提醒信、報價盯盤信、每週一早上的 HTML 週報、NotebookLM 行情簡報 |

### 判斷怎麼做的

- **今天該做什麼**（`advice.py`）：純規則，門檻在檔頭——單日漲跌 ≥ 1.5%、7 天累計 ≥ 3%、近一年區間位置 ≥ 90% 或 ≤ 10%、資料燈號有黃紅。只說明行情，不是買賣建議。
- **漲跌原因拆解**：台幣價 ＝ 國際價（美元）× 匯率，用日線「收盤對收盤」拆成兩塊。和首頁即時價的漲跌幅來源不同，數字會有落差，頁面上有註明。
- **AI 解讀與新聞分類**（`insight.py`）：只用 **Groq**（免費）；**沒金鑰、失敗、格式不對、或解讀裡出現我們沒給的數字，一律退回規則式**，頁面照常產出，並標示來源是「AI」還是「自動」。不使用任何付費服務。
- **報價盯盤**：拿你存的報價和現在料價比，料價漲超過 3% 就提醒重報（首頁＋Email）。

## 檔案結構

| 檔案 | 說明 |
|------|------|
| `.github/workflows/metals.yml` | 行情排程（每天 10:00、22:00）＋ 先跑測試 ＋ commit 產物 ＋ 部署 Pages |
| `run_metals.py` | 入口：取價 → 健康檢查 → 新聞 → AI 解讀 → 產生所有頁面與 `signals.json` |
| `metals.py` | 取 LME 銅鋁價與匯率 → 讀寫 `data/prices.json`／`daily.json` |
| `advice.py` | 今天該做什麼、價格拆解、各種統計 |
| `insight.py` | 新聞分類與每日白話解讀（Groq，失敗退規則式） |
| `datahealth.py` | 資料來源健康燈號（新鮮度、價差、凍結、匯率…） |
| `ai_json.py` | Groq 呼叫與 JSON 解析；`config.py` 設定模型與額度 |
| `scripts/probe_free_models.py` | 手動檢查 Groq 金鑰與額度是否可用（`probe-ai.yml`，唯讀） |
| `dashboard.py` | 產生 `docs/` 底下所有 HTML 頁面 |
| `docs/assets/app.js`、`style.css` | 前端互動與樣式 |
| `google-apps-script.gs` | 登入、報價與收藏同步到試算表的後端 |
| `price-alerts.gs` | 價格提醒、報價盯盤、每週摘要信 |
| `notebooklm-export.gs` | 每天把行情寫成 Google 文件，給 NotebookLM 當來源 |
| `backup.gs` | 每天備份試算表、每月還原演練 |
| `tests/` | 全部自動測試（Node 與 Python） |

> 供應商雷達與客戶開發雷達已於 2026-11 整個移除（程式、排程、資料、設定）。需要的話可從 git 歷史找回，最後一個含雷達的版本是 `main` 的 `47d8bef`。

## 部署（GitHub Actions + Pages）

1. **推專案上 GitHub**。
2. **設定 Secrets**（Repo → Settings → Secrets and variables → Actions）：

   | Secret 名稱 | 用途 | 是否必填 |
   |---|---|---|
   | `GROQ_API_KEY` | AI 行情解讀與新聞分類（免費額度） | 選填 |

   **不填也能跑**：解讀會用規則式整理，其他功能不受影響。
3. **開啟網頁**：Settings → Pages → Source: Deploy from a branch → `main` / `docs`。網址：`https://<帳號>.github.io/<repo 名>/`
4. **測試**：Actions → 「銅鋁監控」→ Run workflow。日誌找 `[insight] 今日解讀來源：ai`（或 `rule`，代表退回規則式）。

> 注意：「銅鋁監控」會 commit 並部署到 `main`。要在不影響線上網站的情況下試改動，請用分支，不要在分支上手動觸發它。

## Google 設定（報價同步、價格提醒需要）

報價、收藏預設只存在**本機瀏覽器**。要團隊共用、多裝置同步，改存到公司自己的 Google 試算表（約 15 分鐘，個人 Gmail 也可以，只要「基本身分」權限）：

1. 用公司 Google 帳號新建一個空白**試算表**。
2. 擴充功能 → Apps Script → 貼上 `google-apps-script.gs` 全部內容。
3. 到 [Google Cloud Console](https://console.cloud.google.com/) 建專案 → OAuth 同意畫面（外部，範圍不用加，測試使用者加入會用的人）→ 憑證 → OAuth 用戶端 ID（網頁應用程式，已授權 JavaScript 來源填 `https://<帳號>.github.io`）→ 複製用戶端 ID。
4. 回 Apps Script 填 `CLIENT_ID`、`ALLOWED_EMAILS`。
5. 部署 → 新增部署 → 網頁應用程式，執行身分「我」、存取「任何人」→ 複製網址。
6. 編輯 `docs/config.js` 填 `GOOGLE_CLIENT_ID`、`APPS_SCRIPT_URL`，commit。

登入後，報價紀錄存進試算表「報價紀錄」分頁，價格提醒存進「價格提醒」分頁。報價有「客戶／備註」欄（第 9 欄），舊試算表會自動補欄。

### 價格提醒、報價盯盤、週報（`price-alerts.gs`）

貼進**同一個** Apps Script 專案（新增一個指令碼檔）：

1. 執行 `checkPriceAlerts` 一次並授權（需要寄信權限）。
2. 執行 `installAlertTriggers` → 每天 11 點與 23 點左右自動檢查。
3. （選用）執行 `installWeeklyDigestTrigger` → 每週一早上寄 HTML 週報（解讀、30 天走勢、新聞）給有設提醒的人；要多寄給別人，在「專案設定 → 指令碼屬性」新增 `WEEKLY_EMAILS`（email，逗號分隔）。
4. 報價盯盤不用另外安裝，`checkPriceAlerts` 會順便檢查：存過的報價料價漲超過 3%，就寄信給存報價的人，每筆只通知一次。

資料紅燈時不寄信（資料不可信，通知只會誤導）。一般 Google 帳號每天約可寄 100 封。

### NotebookLM（選填）

貼 `notebooklm-export.gs`，執行 `updateNotebookDoc` → 取得文件連結 → `installDailyTrigger`。它每天把銅鋁行情寫成「九上科技 原料行情每日簡報」，加進 NotebookLM 當來源即可問答。筆記本網址填進 `docs/config.js` 的 `NOTEBOOK_URL`，首頁會有直達方塊。

### 備份（選填但建議）

貼 `backup.gs` → 執行 `installBackupTrigger`：每天複製整份試算表（留 30 份）、列數大減警示、每月還原演練、`restoreSheet` 單張救回。

## 變更控制與資料健康

- 程式有改先跑全部測試（`metals.yml` 的 test job，失敗不部署；排程觸發時失敗不擋更新但會標紅；其他分支與 PR 由 `tests.yml` 跑）。
- `datahealth.py` 每次更新檢查 11 項：新鮮度、連續抓不到、單日異常、兩來源價差、價格凍結、匯率差距。首頁燈號、Actions 紅色註解都來自這裡；頁面太久沒更新時，瀏覽器也會自己警示。

## 客製方式

- 提醒門檻：`advice.py` 檔頭（可在 `config.py` 以 `ADVICE_DAY_PCT`、`ADVICE_WEEK_PCT`、`ADVICE_HIGH_POS`、`ADVICE_LOW_POS` 覆蓋）。
- 關注區間：`config.py` 的 `METALS`。
- 報價盯盤門檻：`app.js` 的 `initWatch`（`TH`）與 `price-alerts.gs` 的 `QW_TH`，目前都是 3%。

## 合規提醒

行情來自 Westmetall（LME 結算價）與 Yahoo 匯率，僅供內部參考。AI 解讀只說明行情，不構成投資或報價建議。程式碼不含任何個資或金鑰，金鑰只放在 GitHub Secrets 與 Apps Script 屬性。
