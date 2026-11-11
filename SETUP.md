# 正式環境設定

正式架構使用 Render 執行網站與 Node.js API，Supabase 提供 PostgreSQL、登入與附件儲存，OpenAI 提供計畫分析。

## 需要由帳號擁有者完成

1. 建立 Supabase 專案，區域選 `Southeast Asia (Singapore)`。
2. 在 Supabase SQL Editor 執行 `supabase/schema.sql`。
3. 在 Supabase Authentication 建立最多三位使用者。第一位使用者建立後，將其 UUID 填入本機 `.env` 的 `SUPABASE_ADMIN_USER_ID`；不需把密碼交給開發者。
4. 建立 OpenAI Platform 專案與專案 API key，設定使用額度提醒及上限。
5. 建立 Git 儲存庫並推送本專案，再由 Render 連接該儲存庫。
6. 在 Render 建立 Blueprint 或 Web Service，區域選 Singapore，加入 `render.yaml` 列出的環境變數。

所有私密金鑰只放在本機 `.env` 或 Render 的環境變數介面，不要放入 Git、畫面截圖或聊天訊息。

## 本機環境變數

複製 `.env.example` 為 `.env`，填入：

- `SUPABASE_URL`：Supabase Project URL。
- `SUPABASE_PUBLISHABLE_KEY`：可提供給前端使用的 publishable key。
- `SUPABASE_SECRET_KEY`：只供後端與資料移轉使用；不可放入前端或 Git。
- `AUTH_BYPASS=true`：僅供本機 `127.0.0.1` 驗測，略過登入並以管理帳號讀寫；正式部署維持 `false`。
- `SUPABASE_ADMIN_USER_ID`：第一位管理員在 Supabase Authentication 顯示的 UUID。
- `SUPABASE_ORGANIZATION_ID`：執行 `npm run supabase:bootstrap` 後顯示的 UUID。
- `OPENAI_API_KEY`：只供後端呼叫 AI。
- `APP_ORIGIN`：本機使用 `http://127.0.0.1:4174`；部署後改為正式 HTTPS 網址。

## 尚待設定後執行

完成 Supabase 設定後，先執行 `npm run supabase:bootstrap` 建立初始組織，再加入其餘成員、執行舊備份匯入，最後將前端由 localStorage 切換到登入後的 API。
