/* 網站設定 — 交接給客戶時由客戶自行填寫（用客戶自己的 Google 帳號/專案）。
 * 程式碼不含任何個資；這裡的 ID 都是「公開可見」的（瀏覽器本就會用到），非機密。
 * 設定步驟見 repo 的 README「Google 設定」與 google-apps-script.gs。
 *
 * 全部留空 → 「我的名單/收藏/報價」存在本機瀏覽器（單機、可用但不同步、不需登入）。
 * 填好之後 → 改用 Google 登入 + 公司 Google 試算表（團隊共用、多裝置同步）。
 */
window.APP_CONFIG = {
  // ① Google 登入用的 OAuth Web 用戶端 ID（Google Cloud → 憑證 → OAuth 用戶端）
  GOOGLE_CLIENT_ID: "",
  // ② Apps Script Web App 部署網址（讀寫試算表/Drive 的後端）
  APPS_SCRIPT_URL: "",
  // ③（選填）擁有試算表的 Google 帳號 email（顯示用）
  OWNER_EMAIL: ""
};
