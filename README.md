# 人資找才 × 銅鋁監控 自動化系統

雙功能雲端自動化，共用一組 Playwright + Claude + Discord。
**部署方式：GitHub Actions + GitHub Pages（免費、不綁卡、關機也照跑）**。
（仍保留 Modal 版 `main.py`，兩種擇一即可。）

| 功能 | 資料來源 | 流程 | 排程（台灣時間） | 輸出 |
|------|----------|------|------------------|------|
| **A 人才搜尋** | 104 人才庫（企業帳號登入） | Playwright 登入+爬 → Claude AI 評分 → 篩 8 分以上 | 每天 08:00 | Discord 推薦清單 |
| **B 銅鋁監控** | 鉅亨網 銅/鋁報價 | Playwright 爬價 → Volume 存歷史 → 判斷突破區間 | 每天 10:00、22:00 | HTML 儀表板 + 突破時 Discord 告警 |

## 檔案結構

| 檔案 | 說明 |
|------|------|
| `.github/workflows/talent.yml` | 功能 A 排程（每天台灣 08:00） |
| `.github/workflows/metals.yml` | 功能 B 排程（每天台灣 10:00、22:00）＋ commit 歷史/儀表板 |
| `run_talent.py` / `run_metals.py` | GitHub Actions 入口腳本 |
| `config.py` | **主要客製處**：`TALENT_PROFILE` 人才條件、104 搜尋參數、`METALS` 關注區間 |
| `browser.py` | Playwright 真實 Chrome + stealth + 104 登入暖機 + 帶 Cookie 呼叫後端 API |
| `talent.py` | 功能 A：爬候選人 → Claude 評分 → 組推薦清單 |
| `metals.py` | 功能 B：爬鉅亨網 → 讀寫 `data/prices.json` 歷史 → 突破判斷 |
| `dashboard.py` | 銅鋁 HTML 儀表板（狀態燈、迷你走勢、頂部摘要） |
| `notify.py` | Discord Webhook 推送（embed 卡片） |
| `docs/index.html` | 儀表板輸出（GitHub Pages 來源，每次功能 B 執行後更新） |
| `main.py` | （選用）Modal 版進入點，與 GitHub Actions 擇一 |

## 部署（GitHub Actions + Pages）

### 1. 推專案上 GitHub
建一個 repo（設 **Private** 即可），把整個資料夾推上去。

### 2. 設定 Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**，逐一新增：

| Secret 名稱 | 用途 | 是否必填 |
|-------------|------|----------|
| `DISCORD_WEBHOOK_URL` | Discord 推送（頻道 → 整合 → Webhook → 複製網址） | 兩功能都要 |
| `ANTHROPIC_API_KEY` | 功能 A Claude 評分（platform.claude.com 申請） | 功能 A |
| `LOGIN_104_ACCOUNT` | 104 企業帳號 | 功能 A |
| `LOGIN_104_PASSWORD` | 104 企業密碼 | 功能 A |

> 只填 `DISCORD_WEBHOOK_URL` → **功能 B 銅鋁監控可先完整運作**；功能 A 待補齊 Anthropic 與 104 憑證。
> 評分模型預設 `claude-opus-4-8`；省成本可在 `config.py` 改 `AI_MODEL = "claude-haiku-4-5"`。

### 3. 開啟儀表板網頁（GitHub Pages）
Repo → **Settings → Pages → Source: Deploy from a branch → 選 `main` / `docs`**。
網址：`https://<你的帳號>.github.io/<repo 名>/`（功能 B 每次執行後自動更新）。

### 4. 測試 / 排程
- **手動測試**：Repo → **Actions → 選 workflow → Run workflow**（先測「銅鋁監控」最快看到結果）。
- **自動排程**：workflow 已設 cron，之後每天自動跑；GitHub Actions 在雲端執行，**電腦關機也照跑**。

## 本地驗證（無需憑證）
```bash
python main.py --mock          # 產生 dashboard_preview.html，用瀏覽器開來看版型
```
> ⚠️ GitHub Actions 是機房 IP，功能 A 爬 104 可能較易被 Cloudflare 擋；功能 B 爬公開報價通常沒問題。真的被擋時功能 A 才需改在住宅 IP（本機）跑。

## 客製方式（對應指南第 10 頁「關鍵原則」）
- **改人才條件**：編輯 `config.py` 的 `TALENT_PROFILE`（六欄），不需改程式。
- **改關注區間**：編輯 `config.py` 的 `METALS` 的 `watch_low` / `watch_high`。
- 換目標網站 + 換 config = 全新的自動追蹤系統，架構不用改。

## ⚠️ 待補實作（`# TODO(verify)`）
以下需對照實際頁面用 DevTools 觀察後補上，程式已標註 `# TODO(verify)`：
- `browser.py`：104 企業登入頁網址、帳密欄位與送出按鈕選擇器。
- `talent.py`：104 人才搜尋後端 API 端點、查詢參數、回傳 JSON 欄位。
- `metals.py` / `config.py`：鉅亨網銅/鋁實際報價頁或 API 網址與 DOM 結構。

## 合規提醒
104 為登入牆後的付費服務、受個資法規範。本專案為自有企業帳號的內部自動化用途，
請自行控管爬取頻率與候選人資料的留存與使用，符合個資法與 104 服務條款。
