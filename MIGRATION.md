# 提案導航台：Windows 移轉至 Mac

## 專案位置

Windows 原始專案：

`C:\Users\kamichen\Documents\Codex\2026-09-16\ai-ai-esg-ai-ai-1-2`

## 移機前

1. 啟動系統並按右上角「資料備份」。
2. 按「下載完整備份 JSON」。
3. 將下載的 JSON 放進要搬移的專案資料夾之外或安全備份媒體。
4. 複製本專案資料夾到 Mac。

備份 JSON 包含全部 localStorage 資料與素材附件，包括案件、需求分析、評分矩陣、提案書架構、簡報架構、KPI、風險、時程、待辦及共用素材。

## 必須保留

- `dist/`：完整前端程式。
- `scripts/`：跨平台本機伺服器。
- `package.json`：Node.js 版本與啟動指令。
- `MIGRATION.md`：本移機說明。
- 匯出的 `proposal-ops-backup-*.json`：實際使用資料與附件，請另行安全保存。

## 建議保留

- `.openai/hosting.json`：既有 Sites 專案識別與設定；未來若需延續發布流程會用到。
- `.git/`：若要保留 Git 版本歷史。
- `outputs/`：若其中已有需要保存的交付成果。

## 不必搬移，可重新產生

- `node_modules/`：可在 Mac 執行 `npm install` 重新產生；本專案目前沒有第三方套件。
- `work/`：舊的打包檔與暫存資料。
- `.sites-runtime/`：本機執行環境資訊。
- `.DS_Store`、`npm-debug.log*`：作業系統或工具暫存檔。
- `work/*.tar.gz`：舊版部署封裝，可由原始檔重新建立。

## Mac 執行方式

建議安裝 Node.js 20 LTS 或更新的 LTS 版本。本專案要求 Node.js 20 以上，不依賴第三方 npm 套件。

```bash
cd /你放置專案的路徑/ai-ai-esg-ai-ai-1-2
node --version
npm install
npm start
```

接著開啟：`http://127.0.0.1:4174/`

若 4174 已被占用：

```bash
PORT=4175 npm start
```

## 在 Mac 還原資料

1. 使用建議的 Chrome 或 Edge 開啟 `http://127.0.0.1:4174/`。
2. 按右上角「資料備份」。
3. 在「從備份還原」選取 Windows 匯出的 JSON。
4. 確認摘要後按「還原選取備份」。
5. 確認案件數、共用素材數及附件數與 Windows 相同。

瀏覽器資料會依網址與瀏覽器分開保存。Mac 上請固定使用相同網址 `http://127.0.0.1:4174/`，不要交替使用 `localhost`，以免看起來像資料消失。

## AI 計畫摘要

1. 在專案根目錄的 `.env` 填入 `OPENAI_API_KEY=你的金鑰`，不要放進網頁或備份 JSON。可依 `.env.example` 設定模型。
2. 使用 Node.js 20.12 或更新版本，重啟 `npm start`。
3. 開啟案件的「提案工作區 → 需求與 RFP」，貼入 10 至 50,000 字文字，按「AI 產生計畫摘要」。
4. 摘要、核心需求、建議評選重點與缺漏會儲存在目前瀏覽器，可複製摘要。只有貼入的原文送至 OpenAI。

API 使用需有有效金鑰與額度。尚未配置時會顯示提示，不會以假資料替代 AI 回覆。舊分析標示為規則草稿；提案架構及 KPI 等其他頁面仍為原有範本功能。

驗證：`node --test scripts/ai.test.mjs`。API 格式參考：https://developers.openai.com/api/docs/guides/structured-outputs
