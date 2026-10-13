# 九上科技 · 智慧儀表板（原料監控 × 供應鏈雷達）

三個雲端代理人，共用一組 Playwright + 分層備援 AI + Discord。
**部署方式：GitHub Actions + GitHub Pages（免費、不綁卡、關機也照跑）**

| 功能 | 資料來源 | 流程 | 排程（台灣時間） | 輸出 |
|------|----------|------|------------------|------|
| **B 原料監控** | Westmetall（LME 官方銅鋁結算價）＋ Yahoo 匯率 | httpx 取價 → 換算台幣 → 存時間序列 → 判斷突破 | 每天 10:00、22:00 | 首頁／原料頁／報價試算 ＋ 突破時 Discord |
| **C 供應商雷達** | 104 公司搜尋 ＋ 財政部營業稅籍開放資料 | Playwright 擷取 ＋ 串流過濾 → 合併去重 → 分類評分 → AI 建議 | 每月 1 號 09:00 | `docs/suppliers.html` ＋ Discord |
| **D 客戶開發雷達** | 同上（僅換設定檔關鍵字） | 同上 | 每月 1 號 10:00 | `docs/customers.html` ＋ Discord |

> **2026-10-11 起，供應商雷達（C）與客戶開發雷達（D）已從儀表板移除**：頁面與選單拿掉、每月排程暫停（`suppliers.yml`／`customers.yml` 保留手動觸發），程式與 `data/` 名單保留；要恢復就把兩個 workflow 的 `schedule` 取消註解並在 `dashboard._nav` 加回選單。

> 供應商雷達與客戶開發雷達**共用同一份感知程式碼**，差別只在 `config.py` 的關鍵字與排序權重——這是本專案的設計主張。

## 檔案結構

| 檔案 | 說明 |
|------|------|
| `.github/workflows/{metals,suppliers,customers}.yml` | 三個代理人的排程 ＋ commit 產物 |
| `run_metals.py` / `run_suppliers.py` / `run_customers.py` | GitHub Actions 入口腳本 |
| `config.py` | **主要客製處**：企業 Profile、搜尋關鍵字、分類詞庫、評分權重、關注區間 |
| `metals.py` | 取 LME 銅鋁價與匯率 → 讀寫 `data/prices.json`／`daily.json` |
| `suppliers.py` / `customers.py` | 上下游名單：擷取 → 合併 → 分類評分 → 保留規則 |
| `jobs.py` | 104 公開職缺爬取層（供應鏈用：從職缺反推廠商設備能力） |
| `browser.py` | Playwright 真實 Chrome ＋ 指紋偽裝套件（過 Cloudflare） |
| `ai.py` | **判斷端分層備援**：免費模型 → 付費模型 → 內建備援 |
| `prompts.py` | 各代理人的結構化提示詞 |
| `dashboard.py` | 產生 `docs/` 底下所有 HTML 頁面 |
| `notify.py` | Discord Webhook 推送（embed 卡片） |
| `scripts/compare_factory_source.py` | 資料源比較（唯讀，不影響正式流程） |

## 部署（GitHub Actions + Pages）

### 1. 推專案上 GitHub
建一個 repo，把整個資料夾推上去。

### 2. 設定 Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret 名稱 | 用途 | 是否必填 |
|-------------|------|----------|
| `DISCORD_WEBHOOK_URL` | Discord 推送（頻道 → 整合 → Webhook） | 選填 |
| `GROQ_API_KEY` | 判斷端**第一層**（免費額度） | 選填 |
| `ANTHROPIC_API_KEY` | 判斷端**第二層**（付費，品質較佳） | 選填 |

> **三個都不填也能跑。** 判斷端會落入第三層內建備援，名單、統計與儀表板照常產出——
> 這是本專案的韌性設計：外部 AI 服務不可用時，系統不中斷。

### 3. 開啟儀表板網頁（GitHub Pages）
Repo → **Settings → Pages → Source: Deploy from a branch → 選 `main` / `docs`**。
網址：`https://<你的帳號>.github.io/<repo 名>/`

### 4. 測試 / 排程
- **手動測試**：Repo → **Actions → 選 workflow → Run workflow**（先測「銅鋁監控」最快看到結果）。
- **自動排程**：workflow 已設 cron，電腦關機也照跑。

> GitHub Actions 是機房 IP，爬 104 可能較易被 Cloudflare 擋；取 LME 報價與政府開放資料不需瀏覽器，不受影響。

## 客製方式

- **改關注區間**：`config.py` 的 `METALS` → `watch_low` / `watch_high`
- **改找誰**：`config.py` 的 `SUPPLIER_QUERIES` / `CUSTOMER_QUERIES` 與對應的分類詞庫
- **改排序偏好**：`SUPPLIER_SCORE` / `CUSTOMER_SCORE` 的權重
- 換資料源 ＋ 換設定檔 = 新的代理人，骨幹程式碼不動。

## 合規提醒

104 公開頁面以未登入狀態擷取，系統不持有任何帳號密碼；政府開放資料依「政府資料開放授權條款」使用。
取用範圍限於企業基本資訊（統一編號、產業分類、地址、網址），不擷取任何自然人資料。

---

## 功能 7：資料庫（Google 整合）設定教學

網站的「收藏/標記/備註、報價歷史」預設存在**本機瀏覽器**（單機可用、不同步、不需登入）。
要**團隊共用、多裝置同步**，就照下面設定，改存到**你們公司自己的 Google 試算表**。
全部用你們自己的 Google 帳號，程式碼裡沒有任何人的個資。約 15 分鐘。

> 你們用個人 Gmail 也可以。登入只要「基本身分」權限，不會跳「未驗證應用」的紅色警告。

### 步驟

1. **建資料庫試算表**：用公司 Google 帳號到 Google 試算表新建一個空白試算表（名稱隨意）。
2. **貼後端程式**：該試算表 → 上方「擴充功能」→「Apps Script」→ 把 repo 的 `google-apps-script.gs` 內容**全部貼上**，覆蓋原本的。先別關。
3. **建登入用 ID（OAuth 用戶端）**：
   - 到 [Google Cloud Console](https://console.cloud.google.com/) → 建立專案（用同一個 Google 帳號）。
   - 「API 和服務」→「OAuth 同意畫面」→ User Type 選 **外部** → 填 App 名稱/你的信箱 → **範圍不用加**（只用基本身分）→「測試使用者」加入**會用這網站的人的 Gmail** → 儲存。
   - 「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型 **網頁應用程式** →「已授權的 JavaScript 來源」填你的網站網址 `https://<你的帳號>.github.io`（結尾不要斜線）→ 建立 → **複製「用戶端 ID」**（`xxxx.apps.googleusercontent.com`）。
4. **填進 Apps Script**：回到步驟 2 的 Apps Script，把最上面的
   - `CLIENT_ID` = 剛剛複製的用戶端 ID
   - `ALLOWED_EMAILS` = 允許登入的人的 email（可多個）
5. **部署 Apps Script**：右上「部署」→「新增部署」→ 類型選**網頁應用程式** → 執行身分「**我**」、誰可以存取「**任何人**」→ 部署 → 授權（第一次會要你同意）→ **複製網頁應用程式網址**。
6. **填進網站**：編輯 repo 的 `docs/config.js`：
   - `GOOGLE_CLIENT_ID` = 步驟 3 的用戶端 ID
   - `APPS_SCRIPT_URL` = 步驟 5 的網址
   - commit → 等 Pages 更新。

完成後，網站右上角會出現「使用 Google 登入」；登入後收藏/標記/報價就會存進你們的試算表，換裝置、換人登入都看得到。試算表裡會自動長出 `marks`、`quotes` 兩個分頁，你們也能直接在試算表看/改。

### ERP 設定（🏭 ERP 作業頁）

ERP（料號庫存 FIFO、進貨、報價、銷售訂單、BOM／工單、客戶商機）沿用上面同一個 Apps Script 與登入，資料寫進試算表 `ERP_` 開頭的分頁，**不碰原本的分頁**。沒做這段設定時，ERP 頁是「本機試用」，其他功能完全不受影響。

1. **先備份**：Google 試算表 →「檔案」→「建立副本」。
2. **加 ERP 檔**：Apps Script 編輯器左側「檔案」旁的 **＋ → 指令碼**，命名 `erp`，把 repo 的 `google-apps-script-erp.gs` **全部貼上**、儲存。
3. **改主檔一行**：在原本的程式碼檔（`google-apps-script.gs`）找到
   `default:         out = { error: "unknown action" };`
   換成 repo 新版的這一行（含上面那行註解）：
   `default:         out = (typeof erpDispatch_ === "function" && erpDispatch_(body.action, p, email)) || { error: "unknown action" };`
   ⚠️ **只換這一行，不要整個檔覆蓋**，否則你填好的 `CLIENT_ID`、`ALLOWED_EMAILS` 會被蓋掉。
4. **（選填）限定誰能用 ERP**：「專案設定 → 指令碼屬性」新增 `ERP_EMAILS`，值填可使用 ERP 的人的 Google 帳號（多個用半形逗號分隔）。ERP 有成本與毛利，不想讓所有人看到就設這個；沒設 = 所有能登入的人都能用。
5. **重新部署（網址不變）**：「部署 → 管理部署 → ✏️ 編輯 → 版本：**新版本** → 部署」。不要按「新增部署」，那會產生新網址。

完成後到 ERP 頁登入，上方會顯示「☁️ 公司正式資料」。若顯示「公司後端尚未加入 ERP 檔」代表第 2 或 5 步還沒完成。

同一個 ERP 檔也包含**行政工作台**（組織、員工、週班表、出勤、申請簽核、設備預約、公告）以及客服案件、服務交付、專案、備份匯入，資料都寫在 `ERP_` 開頭的分頁（例：`ERP_員工`、`ERP_班表`、`ERP_申請`）。之後更新功能時，只要重新貼上新版 `google-apps-script-erp.gs` 並「管理部署 → 新版本」即可，主檔不用再改。

開發者：ERP 規則只有一份 `docs/assets/erp-engine.js`（瀏覽器與 Apps Script 共用）。改了它或 `gas/erp-adapter.gs` 後執行 `python scripts/build_erp_gas.py` 重新產生 `google-apps-script-erp.gs`，並跑 `node --test tests/erp-engine.test.mjs`。ERP 規則移植自 [mars-tw/freedom-erp-crm](https://github.com/mars-tw/freedom-erp-crm)（MIT License, Copyright (c) 2026 mars-tw）。

### 生產排程（🗓 生產排程頁）

多站別、每站多種機型的**混合流線型排程**（站別預設：下料 → CNC 加工 → 表面處理 → 品檢包裝，可在「工廠設定」隨時改）。選單「生產排程」進入：一鍵最佳化、甘特圖、白話重點、和「現場經驗做法／EDD／ATC」的比較、效率×準時取捨圖，以及**插單、急單、外包、機台故障／保養、取消／完工、改交期／數量**的重排程（已開工的不動、盡量少改原計畫、前後對照後才採用）。

- **不用重新部署 Apps Script**：登入後設定、訂單與採用的排程存進公司試算表的 `sched` 分頁（沿用主檔的通用資料表 `tList／tImport`）；未登入則只存本機瀏覽器。
- **計算都在瀏覽器**（`sched-worker.js` 背景執行緒），訂單不會送到外部服務。
- **方法**：陳建銘（2015，清大博士論文）／Lin & Chen（2015, SIMPAT 51:100–114）的「離散事件模擬＋基因演算法＋OCBA」為核心，融合迭代貪婪（Ruiz & Stützle 2007）、NEH 插入、ATC 派工（Vepsalainen & Morton 1987）、多目標（平均週期×加權延遲）與事件驅動重排程（Peng et al. 2019；Uhlmann et al. 2022）。完整文獻在頁面「方法說明」，同一頁也會把系統算的結果和論文範例（50,000／44,000／48,000／42,000）逐項對答案。
- **檔案**：`docs/assets/sched-engine.js`（引擎，瀏覽器與 Node 測試共用）、`sched-worker.js`、`sched.js`＋`sched.css`（畫面）、`sched-data.js`（預設工廠與範例訂單）。測試：`node --test tests/sched-engine.test.mjs`。
- **風險監控與自動通知**（`docs/assets/sched-kri.js`、`sched-alerts.gs`；測試 `tests/sched-risk.test.mjs`、`sched-brief.test.mjs`、`sched-alerts.test.mjs`）：風險 → 17 個監控指標（KRI，含領先指標：未來 5 個工作日負荷、交期寬裕、平均準時機率、外包佔比）→ 黃／紅門檻 → 觸發。「風險儀表板」有熱度圖、小曲線、惡化箭頭、預計幾天後轉壞的預警、最近惡化排行（歷史每 30 分鐘記一筆，存小表 `sched_hist`）；「進度回報」每一站回報實際時間，ERP 工單完工自動帶入整張單完工；採用新排程前依燈號檢查（黃燈勾選、紅燈填原因＋二次確認）；每次採用、每次工廠設定修改都留紀錄可預覽回復（`sched_ver`）。**自動通知**：把 `sched-alerts.gs` 貼進 Apps Script 並執行 `installSchedAlertTrigger`，平日 08:00–18:59 每 30 分鐘檢查，黃燈通知負責人、紅燈加老闆、同一次檢查合併成每人一封、24 小時不重複、紅燈 30 分鐘沒人「已知悉」升級老闆；趨勢預警只放在網頁右上角通知中心（`sched_notice`、`sched_alert`、`sched_cfg`、`sched_kri` 幾張小表）。早報信要貼新版 `email-notify.gs`。設計參考 COSO 2026《GenAI 內部控制指引》的內控觀念。
- **限制**：不含物料齊套檢查、人員技能排班、各機台各自的上下班時間；燈號在有人開排程頁時才計算（早報信會在寄信當下補算「逾時沒回報」與「資料太久沒更新」）。

### 交接給客戶時

程式碼零個資。客戶只需：① 收下這個 repo（或 fork 到客戶 GitHub）② 設客戶自己的 `GROQ_API_KEY`（第一層，免費）或 `ANTHROPIC_API_KEY`（第二層，付費）——**兩者都不設也能跑**，判斷端會落入第三層規則式後備，名單與儀表板照常產出 ③ 照上面用**客戶自己的 Google 帳號**做一次設定。之後整套都在客戶名下，跟你無關。

### 日曆／Gmail

名錄每列有 📅（加到 Google 日曆提醒）、✉️（用 Gmail 寄開發信）按鈕，用「預填連結」開啟，不需任何權限設定，任何 Google 帳號都能用。

### NotebookLM 串接（選填）

`notebooklm-export.gs`（貼進同一個 Apps Script 專案）會把 ERP 現況每天寫成一份固定 Google 文件「九上科技 ERP 每日簡報」；把它加進 NotebookLM 當來源即可問答、生語音摘要。筆記本網址填進 `docs/config.js` 的 `NOTEBOOK_URL`，首頁「🧠 NotebookLM」卡片就會直達。NotebookLM 無寫入 API，第一次來源需手動加、之後按「同步」。

## 內控與治理（五項）

| 項目 | 做什麼 | 要貼／要做的事 |
|---|---|---|
| 原料資料來源監控 | `datahealth.py`：新鮮度、連續抓不到、單日異常、兩來源價差、價格凍結、匯率；首頁燈號、早報警示、Actions 紅色註解 | 貼新版 `email-notify.gs` |
| 變更控制 | 程式有改先跑全部測試（`.github/workflows/metals.yml` 的 test job，失敗不部署；其他分支與 PR 由 `tests.yml` 跑）；頁尾顯示網頁版本與後端版本，對不上警告 | 貼新版 `google-apps-script-erp.gs` |
| 備份與復原 | `backup.gs`：每天 03:00 複製整份試算表到雲端硬碟（留 30 份）、列數大減警示、每月還原演練、`restoreSheet` 單張救回 | 貼 `backup.gs` → 執行 `installBackupTrigger` |
| 權限與職能分工 | 七種職務（老闆、主管、業務、生管倉管、會計、行政、唯讀），伺服器端把關並遮掉成本；高風險操作通知老闆；每季帳號盤點；停用或離職立刻失效 | 貼新版 ERP 檔 → 執行 `accessSetup` →（選用）主檔 doPost 加 `accessGate_` 那一行 → `installAccessTrigger` |
| 營運風險儀表板 | `biz-kri.js`：14 個指標（負毛利、逾期應收、客戶集中度、缺料、盤點差異、工單成本超支、簽核卡關、設備保養、加班上限…），與排程風險同一套燈號／趨勢／通知 | 貼新版 `sched-alerts.gs`（已裝過的要重貼） |

主檔 `google-apps-script.gs` 在 `var p = body.payload || {};` 下面多了三行（`accessGate_`）。你自己的主檔有填 CLIENT_ID／ALLOWED_EMAILS，**不要整份覆蓋**，只把那三行貼進去。
