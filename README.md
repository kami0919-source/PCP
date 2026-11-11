# 提案導航台

用於管理提案案件、上傳與分析 RFP、建立評分矩陣、規劃提案書與簡報架構，以及評估初稿完整度的本機網站。

## 本機啟動

需求：Node.js 20 以上。

```bash
npm install
cp .env.example .env
npm start
```

開啟 `http://127.0.0.1:4174/`。

OpenAI、Supabase 與免登入測試模式的設定方式請參考 [SETUP.md](SETUP.md)。資料庫結構位於 `supabase/schema.sql`。

## 驗證

```bash
npm test
```

私密金鑰只應存放於 `.env` 或部署平台的環境變數，不可提交至 Git。
