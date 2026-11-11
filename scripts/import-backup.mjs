import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(projectDirectory, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const backupPath = args.find(arg => !arg.startsWith("--"));

if (!backupPath) {
  console.error("用法：node scripts/import-backup.mjs <backup.json> [--commit]");
  process.exit(1);
}

const backup = JSON.parse(await readFile(path.resolve(backupPath), "utf8"));
if (backup.format !== "proposal-ops-backup" || backup.schemaVersion !== 1) {
  throw new Error("不是支援的提案導航台備份格式。");
}

const cases = JSON.parse(backup.localStorage?.proposalCases || "[]");
const materials = JSON.parse(backup.localStorage?.proposalLibrary || "[]");
const attachments = backup.indexedDB?.proposalOpsFiles?.attachments || [];
console.log(`備份檢查完成：${cases.length} 件案件、${materials.length} 份素材、${attachments.length} 個附件。`);

if (!commit) {
  console.log("這是預覽模式，尚未寫入資料庫。加入 --commit 才會正式匯入。");
  process.exit(0);
}

const baseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const organizationId = process.env.SUPABASE_ORGANIZATION_ID;
if (!baseUrl || !serviceKey || !organizationId) {
  throw new Error("正式匯入前須設定 SUPABASE_URL、SUPABASE_SECRET_KEY、SUPABASE_ORGANIZATION_ID。");
}

async function rest(table, { method = "GET", query = "", body } = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: serviceKey,
      ...(serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${serviceKey}` } : {}),
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "resolution=merge-duplicates,return=representation" : "return=representation"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${table} 匯入失敗（${response.status}）：${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

for (const item of cases) {
  const [project] = await rest("projects", {
    method: "POST",
    query: "?on_conflict=organization_id,legacy_id",
    body: {
      organization_id: organizationId,
      legacy_id: item.id,
      name: item.name,
      client: item.client || "",
      project_type: item.type || "",
      status: item.status || "提案中",
      stage: item.stage || "需求整理",
      owner_name: item.owner || "",
      due_date: item.due || null,
      source_text: item.sourceText || "",
      metadata: {
        outline: item.outline || [],
        plan: item.plan || null,
        criteria: item.criteria || [],
        slides: item.slides || [],
        reused: item.reused || []
      }
    }
  });

  if (item.sourceText) {
    await rest("project_sources", {
      method: "POST",
      body: { project_id: project.id, title: "舊系統匯入內容", source_type: "text", content: item.sourceText, version: 1 }
    });
  }
  if (item.analysis) {
    await rest("project_analyses", {
      method: "POST",
      query: "?on_conflict=project_id,version",
      body: { project_id: project.id, version: 1, provider: item.analysis.provider || "legacy-rules", model: item.analysis.model || "none", result: item.analysis, prompt_version: "legacy-import" }
    });
  }
  const taskRows = (item.tasks || []).map(task => ({ project_id: project.id, title: String(task[0] || ""), completed: Boolean(task[1]) })).filter(task => task.title);
  if (taskRows.length) await rest("project_tasks", { method: "POST", body: taskRows });
}

for (const item of materials) {
  await rest("reusable_materials", {
    method: "POST",
    query: "?on_conflict=organization_id,legacy_id",
    body: {
      organization_id: organizationId,
      legacy_id: item.id,
      title: item.title,
      category: item.category || "",
      applicable: item.applicable || "",
      summary: item.summary || "",
      content: item.content || "",
      tags: item.tags || [],
      usage_count: Number(item.usage) || 0
    }
  });
}

console.log("案件、分析、待辦與共用素材已匯入。附件會在檔案儲存串接階段處理。");
