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
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminUserId = process.env.SUPABASE_ADMIN_USER_ID;
const organizationName = process.env.SUPABASE_ORGANIZATION_NAME || "提案工作團隊";
if (!baseUrl || !serviceKey || !adminUserId) {
  throw new Error("請先設定 SUPABASE_URL、SUPABASE_SECRET_KEY、SUPABASE_ADMIN_USER_ID。");
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
  if (!response.ok) throw new Error(`${table} 設定失敗（${response.status}）：${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

const existing = await rest("organizations", {
  query: `?name=eq.${encodeURIComponent(organizationName)}&select=id,name&limit=1`
});
const organization = existing[0] || (await rest("organizations", {
  method: "POST",
  body: { name: organizationName }
}))[0];

await rest("organization_members", {
  method: "POST",
  query: "?on_conflict=organization_id,user_id",
  body: { organization_id: organization.id, user_id: adminUserId, role: "admin" }
});

console.log(`Supabase 初始化完成：${organization.name}`);
console.log(`請將以下內容填入 .env：SUPABASE_ORGANIZATION_ID=${organization.id}`);
