# 物料庫架位查詢 APP V1.2（功能分頁版）

## 本次修改
- 將功能拆分為三個獨立分頁：
  1. 物料庫架位查詢
  2. 盤點結果上傳
  3. 人員資料管理
- USER 僅顯示物料庫架位查詢。
- ADMIN 顯示物料庫架位查詢、盤點結果上傳。
- DEVELOPER 顯示全部三個分頁。
- 桌面版使用頁面上方分頁列；手機版使用底部固定分頁列。
- 保留既有登入、Supabase RPC、Edge Function 呼叫及既有人員管理操作程式。
- 未修改資料庫 SQL、Edge Function 或 Supabase 連線設定。

## 部署方式
1. 備份目前 GitHub Repository 的前端檔案。
2. 將本 ZIP 內四個檔案覆蓋 Repository 根目錄同名檔案：
   - index.html
   - app.js
   - styles.css
   - config.js
3. 確認 `config.js` 的 Supabase URL 與公開 anon/publishable key 保持正確。
4. Commit / Push 至目前 Vercel 連線的 GitHub branch。
5. 等待 Vercel Production Deployment 成功。
6. 使用既有瀏覽器工作階段開啟 APP 驗收；不要清除網站資料或重建匿名 Auth session。

## 驗收項目
- USER：只顯示「物料庫架位查詢」。
- ADMIN：顯示「物料庫架位查詢」、「盤點結果上傳」。
- DEVELOPER：顯示三個分頁。
- 切換分頁只顯示該功能內容。
- DEVELOPER 人員清單、新增、修改、啟用/停用、PIN 初始化/重設操作正常。
- 登出後回到登入畫面；程式刻意保留 Anonymous Auth session，不呼叫 signOut()。

## 安全注意
`config.js` 僅包含前端可公開的 Supabase URL 與 anon/publishable key。不得放入 service_role/secret key。
