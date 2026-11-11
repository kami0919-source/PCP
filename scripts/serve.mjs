import { analyzeDocument, analyzeDocuments, analyzeText, assessDraft } from "./ai.mjs";
import { authenticate, cancelProjectFileUpload, completeProjectFileUpload, loadProjectFilesForAnalysis, loadWorkspace, saveAssessmentRun, saveProjectFile, saveProjectFilePart, saveWorkspace } from "./supabase-api.mjs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const publicDirectory = path.join(projectDirectory, "dist");
try { process.loadEnvFile(path.join(projectDirectory, ".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const host = process.env.HOST || (process.env.AUTH_BYPASS === 'true' ? "127.0.0.1" : "0.0.0.0");
const port = Number(process.env.PORT || 4174);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

let aiBusy = false;
function json(response, status, data) { response.writeHead(status, {"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}); response.end(JSON.stringify(data)); }
const databaseConfigured = () => Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY));
const bearerToken = request => String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
const isLoopback = request => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
const passwordlessLocal = request => process.env.AUTH_BYPASS === 'true' && isLoopback(request);
const authBypass = request => passwordlessLocal(request) && Boolean(process.env.SUPABASE_SECRET_KEY && process.env.SUPABASE_ADMIN_USER_ID);
const dataToken = request => authBypass(request) ? process.env.SUPABASE_SECRET_KEY : bearerToken(request);
async function readJson(request, response, maxBytes = 250000) {
  if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, {error:'需要 JSON 格式。'}); return null; }
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if(size > maxBytes) { json(response,413,{error:'資料或檔案過大，請縮小後重試。'}); return null; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(response,400,{error:'無效的 JSON。'}); return null; }
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
    if (url.pathname.startsWith('/api/')) {
      const expectedOrigin = process.env.APP_ORIGIN || `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expectedOrigin) return json(response, 403, {error:'不允許此來源。'});
      if (url.pathname === '/api/health' && request.method === 'GET') return json(response, 200, {
        status: 'ok',
        databaseConfigured: databaseConfigured(),
        aiConfigured: Boolean(process.env.OPENAI_API_KEY)
      });
      if (url.pathname === '/api/config' && request.method === 'GET') return json(response, 200, {
        databaseConfigured: databaseConfigured(),
        passwordlessLocal: passwordlessLocal(request),
        authBypass: authBypass(request),
        supabaseUrl: databaseConfigured() ? process.env.SUPABASE_URL : '',
        supabasePublishableKey: databaseConfigured() ? (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY) : ''
      });
      if (url.pathname === '/api/workspace' && request.method === 'GET') {
        try { return json(response, 200, await loadWorkspace(dataToken(request))); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/workspace' && request.method === 'PUT') {
        const body = await readJson(request, response); if (!body) return;
        try { return json(response, 200, await saveWorkspace(dataToken(request), body)); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/project-files' && request.method === 'POST') {
        const body = await readJson(request, response, 70 * 1024 * 1024); if (!body) return;
        try { return json(response, 201, await saveProjectFile(dataToken(request), body)); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/project-files/part' && request.method === 'POST') {
        const body = await readJson(request, response, 12 * 1024 * 1024); if (!body) return;
        try { return json(response, 201, await saveProjectFilePart(dataToken(request), body)); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/project-files/complete' && request.method === 'POST') {
        const body = await readJson(request, response, 1000000); if (!body) return;
        try { return json(response, 201, await completeProjectFileUpload(dataToken(request), body)); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/project-files/cancel' && request.method === 'POST') {
        const body = await readJson(request, response, 1000000); if (!body) return;
        try { return json(response, 200, await cancelProjectFileUpload(dataToken(request), body)); }
        catch (error) { return json(response, error.status || 500, {error:error.message}); }
      }
      if (url.pathname === '/api/ai/status' && request.method === 'GET') return json(response, 200, {configured:!!process.env.OPENAI_API_KEY});
      const isAnalysisRoute = url.pathname === '/api/ai/analyze';
      const isDraftRoute = url.pathname === '/api/ai/assess-draft';
      if ((!isAnalysisRoute && !isDraftRoute) || request.method !== 'POST') return json(response, 404, {error:'找不到 API。'});
      if (databaseConfigured()) {
        try { await authenticate(dataToken(request)); }
        catch (error) { return json(response, error.status || 401, {error:error.message}); }
      }
      if (aiBusy) return json(response,429,{error:'另一筆分析正在進行，請稍後再試。'});
      aiBusy = true;
      const analysisController = new AbortController();
      const abortAnalysis = () => {
        if (!analysisController.signal.aborted) analysisController.abort(new DOMException('使用者已終止分析。', 'AbortError'));
      };
      const abortOnClosedResponse = () => { if (!response.writableEnded) abortAnalysis(); };
      request.once('aborted', abortAnalysis);
      response.once('close', abortOnClosedResponse);
      try {
        const body = await readJson(request, response, 140 * 1024 * 1024); if (!body) return;
        const storedFiles = body?.storedFileIds?.length
          ? await loadProjectFilesForAnalysis(dataToken(request), body?.projectId, body.storedFileIds)
          : [];
        const files = [...storedFiles, ...(Array.isArray(body?.files) ? body.files : [])];
        if (isDraftRoute) {
          const contentType = body?.contentType === 'presentation' ? 'presentation' : 'proposal';
          const assessment = await assessDraft({ text: body?.text, files, context: body?.context || {}, contentType }, { signal: analysisController.signal });
          const run = databaseConfigured() ? await saveAssessmentRun(dataToken(request), {
            projectId: body?.projectId,
            contentType,
            assessment,
            fileIds: body?.storedFileIds || [],
            fileNames: files.map(file => file.name),
            sourceText: body?.text || '',
            structureSnapshot: contentType === 'presentation' ? body?.context?.slides : body?.context?.outline
          }) : null;
          return json(response,200,{assessment,run});
        }
        const analysis = files.length
          ? await analyzeDocuments({ text: body?.text, files }, { signal: analysisController.signal })
          : body?.file
            ? await analyzeDocument({ text: body?.text, file: body.file }, { signal: analysisController.signal })
            : await analyzeText(body?.text, { signal: analysisController.signal });
        return json(response,200,{analysis});
      } catch(error) {
        if (response.destroyed || analysisController.signal.aborted) return;
        return json(response,400,{error: error.name === 'TimeoutError' ? '單批 AI 分析超過 10 分鐘。大型文件可能需要縮小或拆分後重試；已上傳的文件仍會保留。' : error.name === 'AbortError' ? 'AI 分析已終止。' : error.message === 'fetch failed' ? '無法連線至 AI 服務，請檢查網路。' : error.message});
      }
      finally {
        request.off('aborted', abortAnalysis);
        response.off('close', abortOnClosedResponse);
        aiBusy = false;
      }
    }
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const requestedPath = path.resolve(publicDirectory, `.${pathname}`);

    if (requestedPath !== publicDirectory && !requestedPath.startsWith(`${publicDirectory}${path.sep}`)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(requestedPath);
    if (!fileStat.isFile()) throw new Error("Not a file");

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[path.extname(requestedPath).toLowerCase()] || "application/octet-stream"
    });
    createReadStream(requestedPath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  }
});

server.listen(port, host, () => {
  console.log(`提案導航台已啟動：http://${host}:${port}/`);
  console.log("按 Control + C 可停止服務。");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
