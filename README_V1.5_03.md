# Annual Stocktaking V1.5 – Inventory Result Query and Upload

## Base
Built from the user-provided Annual_Stocktaking-main(3).zip (V1.4 barcode frontend).
Existing login, inventory lookup, barcode scanner, legacy TXT upload, employee administration,
and inventory master replacement features are retained.

## New in V1.5
- New "盤點結果查詢" tab for all signed-in active employees.
- Developer-only controls for query availability and Excel replacement upload.
- Excel import reads the exact "盈虧清冊" worksheet.
- Validates the 21 source headers A-U (allows only blank extra trailing header cells).
- Imports A-L and N-T (19 fields); skips M 盈虧金額 and U ABS.
- Validates six quantity fields as integers; blank values are sent as null.
- Validates Year as PostgreSQL smallint.
- Shows a 10-row preview and requires confirmation before calling replace_inventory_result.
- Query uses search_inventory_result with Material/Bin partial search and 50-row pagination.
- Shows latest successful upload metadata.

## Required database objects
This frontend expects these RPCs and table policies to be deployed:
- search_inventory_result(text, text, integer)
- set_inventory_result_query_enabled(boolean)
- get_inventory_result_upload_status()
- replace_inventory_result(text, jsonb)
- authenticated SELECT on system_settings for active employees.

## Deploy
1. Review config.js and keep the existing Supabase URL and public anon/publishable key.
2. Upload/replace index.html, app.js, styles.css, config.js in the existing Vercel/GitHub project.
3. Deploy to Vercel.
4. Test with DEVELOPER first, then ADMIN and USER.

No service_role key is included in frontend files.
