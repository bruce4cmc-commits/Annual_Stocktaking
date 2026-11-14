# 物料庫架位查詢 APP V1.3 更新套件

## 本版修改
- 手機查詢卡片移除 Plnt、MRPCn 英文字樣（保留欄位值）。
- 手機版儲區、儲位、盤點量、盤點人表格採緊湊欄寬及間距。
- 新增 DEVELOPER 專用「盤點清冊管理」分頁。
- 接受 Excel `.xlsx` / `.xls`，讀取「原始清冊」工作表（若不存在則讀第一張）。
- 格式檢查 16 欄標題、資料列、Year、Item、Quantity、日期；通過後才顯示覆蓋按鈕。
- 覆蓋前再次確認；資料庫 RPC 再驗證 DEVELOPER 身分，並在單一交易中刪除舊資料及寫入新資料。
- 原有登入、人員管理、盤點結果上傳功能保留。

## 清冊欄位（固定順序）
`Plnt, Location, Year, Pl.CntDte, 原始盤點單, 盤點單項目, Bin, Bin Number, Item, Material, ZC, Quantity, Material Description, Matl Group, MRPCn, 盤點人`

## 部署順序
1. 先備份正式 `public.inventory_master`。
2. Supabase SQL Editor 執行 `SQL_V1.3_Inventory_Master_Replace_Migration.sql` 一次。
3. 確認 SQL 成功後，將 `index.html`、`app.js`、`styles.css`、`config.js` 覆蓋 GitHub Repository 根目錄同名檔案。
4. Commit/Push，等待 Vercel Production 部署完成。
5. 使用原瀏覽器工作階段以 DEVELOPER 登入，確認新增「盤點清冊管理」分頁。
6. 先用測試檔檢查格式；取消覆蓋應不改資料；正式覆蓋前再確認。

## 安全及限制
- 不要在前端放置 service_role key。
- 不需要重建 Edge Function、重跑 V1.0/V1.1 SQL 或清除瀏覽器網站資料。
- `replace_inventory_master` 只允許 authenticated 呼叫且函式內檢查 `current_employee_role() = DEVELOPER`。
- PostgreSQL 函式單次呼叫具有交易性；任一筆資料轉型或寫入失敗會回滾整次操作。
- Excel 解析使用 SheetJS CDN；部署環境須允許載入 jsdelivr CDN。
- 此套件已完成靜態語法與結構檢查，尚未在正式 Supabase 執行 RPC 或真實瀏覽器完成端對端測試。
