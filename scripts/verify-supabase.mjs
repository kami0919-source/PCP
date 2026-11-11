import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(projectDirectory, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const baseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const organizationId = process.env.SUPABASE_ORGANIZATION_ID;
if (!baseUrl || !secretKey || !organizationId) throw new Error("Supabase 驗證設定不完整。");

const headers = {
  apikey: secretKey,
  ...(secretKey.startsWith("eyJ") ? { Authorization: `Bearer ${secretKey}` } : {})
};

async function count(table, query) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=*&${query}`, { headers });
  if (!response.ok) throw new Error(`${table} 驗證失敗（${response.status}）：${await response.text()}`);
  return (await response.json()).length;
}

const organizationQuery = `organization_id=eq.${encodeURIComponent(organizationId)}`;
const projects = await count("projects", organizationQuery);
const materials = await count("reusable_materials", organizationQuery);
const members = await count("organization_members", organizationQuery);
const projectRowsResponse = await fetch(`${baseUrl}/rest/v1/projects?select=id&${organizationQuery}`, { headers });
if (!projectRowsResponse.ok) throw new Error(`案件 ID 驗證失敗：${await projectRowsResponse.text()}`);
const projectIds = (await projectRowsResponse.json()).map(row => row.id);
const inFilter = projectIds.length ? `project_id=in.(${projectIds.join(",")})` : "project_id=is.null";
const analyses = await count("project_analyses", inFilter);
const tasks = await count("project_tasks", inFilter);
const sources = await count("project_sources", inFilter);

const bucketResponse = await fetch(`${baseUrl}/storage/v1/bucket/project-files`, { headers });
if (!bucketResponse.ok) throw new Error(`附件空間驗證失敗（${bucketResponse.status}）：${await bucketResponse.text()}`);

console.log(JSON.stringify({ organizations: 1, members, projects, sources, analyses, tasks, reusableMaterials: materials, storageBucket: "project-files" }, null, 2));
