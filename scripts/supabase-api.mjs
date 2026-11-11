const required = value => {
  if (!value) throw new Error("Supabase 尚未完成設定。");
  return value;
};

function configuration() {
  return {
    url: required(process.env.SUPABASE_URL),
    publishableKey: required(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
    secretKey: process.env.SUPABASE_SECRET_KEY || ''
  };
}

function requestHeaders(token) {
  const { publishableKey, secretKey } = configuration();
  const serviceRequest = Boolean(secretKey && token === secretKey);
  const apiKey = serviceRequest ? secretKey : publishableKey;
  return {
    apikey: apiKey,
    ...(token && !String(token).startsWith('sb_secret_') ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function request(path, token, { method = "GET", body, prefer } = {}) {
  const { url } = configuration();
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...requestHeaders(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(response.status === 401 ? "登入已過期，請重新登入。" : `資料庫操作失敗（${response.status}）。`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

export async function authenticate(token) {
  const { secretKey } = configuration();
  if (secretKey && token === secretKey && process.env.SUPABASE_ADMIN_USER_ID) {
    return { id: process.env.SUPABASE_ADMIN_USER_ID, email: 'local-test-user' };
  }
  if (!token) {
    const error = new Error("請先登入。");
    error.status = 401;
    throw error;
  }
  return request("/auth/v1/user", token);
}

async function membership(token, userId) {
  const rows = await request(`/rest/v1/organization_members?select=organization_id,role&user_id=eq.${encodeURIComponent(userId)}&limit=1`, token);
  if (!rows[0]) {
    const error = new Error("此帳號尚未加入提案工作團隊。");
    error.status = 403;
    throw error;
  }
  return rows[0];
}

const inQuery = ids => ids.length ? `in.(${ids.join(",")})` : "is.null";

export async function loadWorkspace(token) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  const organizationId = member.organization_id;
  const projects = await request(`/rest/v1/projects?select=*&organization_id=eq.${organizationId}&order=due_date.asc.nullslast`, token);
  const ids = projects.map(project => project.id);
  const [tasks, analyses, materials, attachments] = await Promise.all([
    request(`/rest/v1/project_tasks?select=*&project_id=${inQuery(ids)}&order=created_at.asc`, token),
    request(`/rest/v1/project_analyses?select=*&project_id=${inQuery(ids)}&order=version.desc`, token),
    request(`/rest/v1/reusable_materials?select=*&organization_id=eq.${organizationId}&order=updated_at.desc`, token),
    request(`/rest/v1/attachments?select=*&project_id=${inQuery(ids)}&order=created_at.desc`, token)
  ]);
  const latestAnalysis = new Map();
  const assessmentHistory = new Map();
  for (const analysis of analyses) {
    if (String(analysis.prompt_version || '').startsWith('content-sufficiency-')) {
      const result = analysis.result || {};
      const entry = {
        id: analysis.id,
        version: Number(result.assessmentVersion) || Number(analysis.version),
        contentType: result.contentType === 'presentation' ? 'presentation' : 'proposal',
        score: Number(result.assessment?.overallScore ?? result.overallScore) || 0,
        rating: result.assessment?.rating || result.rating || '',
        summary: result.assessment?.summary || result.summary || '',
        generatedAt: result.assessment?.generatedAt || result.generatedAt || analysis.created_at,
        fileIds: result.fileIds || [],
        fileNames: result.fileNames || [],
        sourceText: result.sourceText || '',
        structureSnapshot: result.structureSnapshot || [],
        assessment: result.assessment || result
      };
      if (!assessmentHistory.has(analysis.project_id)) assessmentHistory.set(analysis.project_id, []);
      assessmentHistory.get(analysis.project_id).push(entry);
    } else if (!latestAnalysis.has(analysis.project_id)) latestAnalysis.set(analysis.project_id, analysis.result);
  }
  const attachmentView = file => ({
    id: file.id,
    name: file.file_name,
    type: file.content_type || "application/octet-stream",
    size: Number(file.byte_size) || 0,
    uploadedAt: file.created_at,
    storagePath: file.storage_path
  });
  return {
    user: { id: user.id, email: user.email, role: member.role },
    organizationId,
    cases: projects.map(project => ({
      ...(project.metadata || {}),
      id: project.legacy_id || project.id,
      name: project.name,
      client: project.client,
      type: project.project_type,
      status: project.status,
      stage: project.stage,
      owner: project.owner_name,
      due: project.due_date || "",
      sourceText: project.source_text || "",
      analysis: latestAnalysis.get(project.id) || null,
      requirementFiles: attachments.filter(file => file.project_id === project.id && !file.storage_path.includes('/draft/') && !file.storage_path.includes('/presentation/')).map(attachmentView),
      draftFiles: attachments.filter(file => file.project_id === project.id && file.storage_path.includes('/draft/')).map(attachmentView),
      presentationFiles: attachments.filter(file => file.project_id === project.id && file.storage_path.includes('/presentation/')).map(attachmentView),
      assessmentHistory: assessmentHistory.get(project.id) || [],
      tasks: tasks.filter(task => task.project_id === project.id).map(task => [task.title, task.completed])
    })),
    library: materials.map(item => ({
      id: item.legacy_id || item.id,
      title: item.title,
      category: item.category,
      applicable: item.applicable,
      summary: item.summary,
      content: item.content,
      tags: item.tags || [],
      usage: item.usage_count || 0,
      updated: String(item.updated_at || item.created_at).slice(0, 10),
      attachments: []
    }))
  };
}

const mimeByExtension = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png"
};

const MAX_STORED_FILE_BYTES = 250 * 1024 * 1024;
const MAX_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

async function projectFileContext(token, payload) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  if (!['admin', 'editor'].includes(member.role)) {
    const error = new Error("目前帳號只有檢視權限。");
    error.status = 403;
    throw error;
  }
  const projects = await request(`/rest/v1/projects?select=id,legacy_id&organization_id=eq.${member.organization_id}`, token);
  const project = projects.find(item => item.id === payload?.projectId || item.legacy_id === String(payload?.projectId || ''));
  if (!project) {
    const error = new Error("找不到指定案件。");
    error.status = 404;
    throw error;
  }
  const fileName = String(payload?.fileName || '').trim().slice(0, 180);
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!fileName || !mimeByExtension[extension]) {
    const error = new Error("不支援此檔案格式。請上傳 PDF、Word、PowerPoint、Excel、CSV、文字檔、JPG 或 PNG。");
    error.status = 400;
    throw error;
  }
  const purpose = ['draft', 'presentation'].includes(payload?.purpose) ? payload.purpose : 'requirement';
  return { user, member, project, fileName, extension, mimeType: mimeByExtension[extension], purpose };
}

async function uploadStorageObject(token, storagePath, contentType, body, upsert = false) {
  const { url } = configuration();
  const response = await fetch(`${url}/storage/v1/object/project-files/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { ...requestHeaders(token), 'Content-Type': contentType, 'x-upsert': String(upsert) },
    body
  });
  if (!response.ok) {
    const error = new Error("檔案無法上傳至 Supabase Storage。");
    error.status = response.status;
    throw error;
  }
}

export async function saveProjectFilePart(token, payload) {
  const context = await projectFileContext(token, payload);
  const uploadId = String(payload?.uploadId || '');
  const partIndex = Number(payload?.partIndex);
  const partCount = Number(payload?.partCount);
  const totalBytes = Number(payload?.totalBytes);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId) || !Number.isInteger(partIndex) || !Number.isInteger(partCount) || partIndex < 0 || partIndex >= partCount || partCount > 32 || totalBytes < 1 || totalBytes > MAX_STORED_FILE_BYTES) {
    const error = new Error("大型檔案分段資訊無效。");
    error.status = 400;
    throw error;
  }
  const bytes = Buffer.from(String(payload?.base64 || ''), 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_PART_BYTES) {
    const error = new Error("每個上傳分段不可超過 8 MB。");
    error.status = 400;
    throw error;
  }
  const storagePath = `${context.member.organization_id}/${context.project.id}/.uploads/${uploadId}/part-${String(partIndex).padStart(4, '0')}`;
  await uploadStorageObject(token, storagePath, 'application/octet-stream', bytes, true);
  return { partIndex, uploadedBytes: bytes.length };
}

export async function completeProjectFileUpload(token, payload) {
  const context = await projectFileContext(token, payload);
  const uploadId = String(payload?.uploadId || '');
  const partSizes = Array.isArray(payload?.partSizes) ? payload.partSizes.map(Number) : [];
  const totalBytes = Number(payload?.totalBytes);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId) || !partSizes.length || partSizes.length > 32 || partSizes.some(size => !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_PART_BYTES) || partSizes.reduce((sum, size) => sum + size, 0) !== totalBytes || totalBytes > MAX_STORED_FILE_BYTES) {
    const error = new Error("大型檔案完成資訊無效。");
    error.status = 400;
    throw error;
  }
  const safeName = context.fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `document.${context.extension}`;
  const partPaths = partSizes.map((_, index) => `${context.member.organization_id}/${context.project.id}/.uploads/${uploadId}/part-${String(index).padStart(4, '0')}`);
  const storagePath = `${context.member.organization_id}/${context.project.id}/${context.purpose}/${uploadId}-${safeName}.manifest.json`;
  const manifest = Buffer.from(JSON.stringify({ version: 1, fileName: context.fileName, contentType: context.mimeType, byteSize: totalBytes, partPaths, partSizes }), 'utf8');
  await uploadStorageObject(token, storagePath, 'application/json', manifest, true);
  const [record] = await request('/rest/v1/attachments', token, {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      project_id: context.project.id,
      organization_id: context.member.organization_id,
      storage_path: storagePath,
      file_name: context.fileName,
      content_type: context.mimeType,
      byte_size: totalBytes,
      uploaded_by: context.user.id
    }
  });
  return { file: { id: record.id, name: record.file_name, type: record.content_type, size: Number(record.byte_size), uploadedAt: record.created_at, storagePath: record.storage_path, purpose: context.purpose } };
}

export async function cancelProjectFileUpload(token, payload) {
  const context = await projectFileContext(token, payload);
  const uploadId = String(payload?.uploadId || '');
  const partCount = Number(payload?.partCount);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId) || !Number.isInteger(partCount) || partCount < 1 || partCount > 32) {
    const error = new Error("大型檔案取消資訊無效。");
    error.status = 400;
    throw error;
  }
  const { url } = configuration();
  await Promise.all(Array.from({ length: partCount }, async (_, index) => {
    const storagePath = `${context.member.organization_id}/${context.project.id}/.uploads/${uploadId}/part-${String(index).padStart(4, '0')}`;
    await fetch(`${url}/storage/v1/object/project-files/${storagePath.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: requestHeaders(token) });
  }));
  return { cancelled: true };
}

export async function saveProjectFile(token, payload) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  if (!['admin', 'editor'].includes(member.role)) {
    const error = new Error("目前帳號只有檢視權限。");
    error.status = 403;
    throw error;
  }
  const projects = await request(`/rest/v1/projects?select=id,legacy_id&organization_id=eq.${member.organization_id}`, token);
  const project = projects.find(item => item.id === payload?.projectId || item.legacy_id === String(payload?.projectId || ''));
  if (!project) {
    const error = new Error("找不到指定案件。");
    error.status = 404;
    throw error;
  }
  const fileName = String(payload?.fileName || '').trim().slice(0, 180);
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!fileName || !mimeByExtension[extension]) {
    const error = new Error("不支援此檔案格式。請上傳 PDF、Word、PowerPoint、Excel、CSV、文字檔、JPG 或 PNG。");
    error.status = 400;
    throw error;
  }
  let bytes;
  try { bytes = Buffer.from(String(payload?.base64 || ''), 'base64'); }
  catch { bytes = Buffer.alloc(0); }
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) {
    const error = new Error("檔案不可超過 50 MB。");
    error.status = 400;
    throw error;
  }
  const mimeType = mimeByExtension[extension];
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `document.${extension}`;
  const purpose = ['draft', 'presentation'].includes(payload?.purpose) ? payload.purpose : 'requirement';
  const storagePath = `${member.organization_id}/${project.id}/${purpose}/${randomUUID()}-${safeName}`;
  const { url } = configuration();
  const storageResponse = await fetch(`${url}/storage/v1/object/project-files/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      ...requestHeaders(token),
      'Content-Type': mimeType,
      'x-upsert': 'false'
    },
    body: bytes
  });
  if (!storageResponse.ok) {
    const error = new Error("檔案無法上傳至 Supabase Storage。");
    error.status = storageResponse.status;
    throw error;
  }
  const [record] = await request('/rest/v1/attachments', token, {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      project_id: project.id,
      organization_id: member.organization_id,
      storage_path: storagePath,
      file_name: fileName,
      content_type: mimeType,
      byte_size: bytes.length,
      uploaded_by: user.id
    }
  });
  return {
    file: {
      id: record.id,
      name: record.file_name,
      type: record.content_type,
      size: Number(record.byte_size) || bytes.length,
      uploadedAt: record.created_at,
      storagePath: record.storage_path,
      purpose
    }
  };
}

export async function loadProjectFilesForAnalysis(token, projectId, fileIds) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 10) {
    const error = new Error("請選擇 1 至 10 份已上傳文件。");
    error.status = 400;
    throw error;
  }
  const projects = await request(`/rest/v1/projects?select=id,legacy_id&organization_id=eq.${member.organization_id}`, token);
  const project = projects.find(item => item.id === projectId || item.legacy_id === String(projectId || ''));
  if (!project) {
    const error = new Error("找不到指定案件。");
    error.status = 404;
    throw error;
  }
  const rows = await request(`/rest/v1/attachments?select=id,file_name,content_type,byte_size,storage_path&project_id=eq.${project.id}`, token);
  const selected = fileIds.map(id => rows.find(row => row.id === id)).filter(Boolean);
  if (selected.length !== fileIds.length) {
    const error = new Error("部分附件不存在或不屬於此案件，請重新整理後再試。");
    error.status = 403;
    throw error;
  }
  if (selected.reduce((sum, file) => sum + (Number(file.byte_size) || 0), 0) > MAX_STORED_FILE_BYTES) {
    const error = new Error("單次分析所選文件合計不可超過 250 MB。");
    error.status = 400;
    throw error;
  }
  const { url } = configuration();
  return Promise.all(selected.map(async file => {
    const response = await fetch(`${url}/storage/v1/object/project-files/${file.storage_path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: requestHeaders(token)
    });
    if (!response.ok) {
      const error = new Error(`無法讀取已上傳文件：${file.file_name}`);
      error.status = response.status;
      throw error;
    }
    let bytes = Buffer.from(await response.arrayBuffer());
    if (file.storage_path.endsWith('.manifest.json')) {
      let manifest;
      try { manifest = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error(`大型檔案索引損毀：${file.file_name}`); }
      if (!Array.isArray(manifest.partPaths) || !manifest.partPaths.length || manifest.partPaths.length > 32 || Number(manifest.byteSize) > MAX_STORED_FILE_BYTES) throw new Error(`大型檔案索引無效：${file.file_name}`);
      const parts = [];
      for (const partPath of manifest.partPaths) {
        const partResponse = await fetch(`${url}/storage/v1/object/project-files/${String(partPath).split('/').map(encodeURIComponent).join('/')}`, { headers: requestHeaders(token) });
        if (!partResponse.ok) throw new Error(`大型檔案分段遺失：${file.file_name}`);
        parts.push(Buffer.from(await partResponse.arrayBuffer()));
      }
      bytes = Buffer.concat(parts);
      if (bytes.length !== Number(manifest.byteSize)) throw new Error(`大型檔案大小不一致：${file.file_name}`);
    }
    if (!bytes.length || bytes.length > MAX_STORED_FILE_BYTES) throw new Error(`已上傳文件無效或超過 250 MB：${file.file_name}`);
    return { name: file.file_name, mimeType: file.content_type, base64: bytes.toString('base64') };
  }));
}

export async function saveAssessmentRun(token, payload) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  if (!['admin', 'editor'].includes(member.role)) {
    const error = new Error("目前帳號只有檢視權限。");
    error.status = 403;
    throw error;
  }
  const projects = await request(`/rest/v1/projects?select=id,legacy_id&organization_id=eq.${member.organization_id}`, token);
  const project = projects.find(item => item.id === payload?.projectId || item.legacy_id === String(payload?.projectId || ''));
  if (!project) {
    const error = new Error("找不到指定案件。");
    error.status = 404;
    throw error;
  }
  const contentType = payload?.contentType === 'presentation' ? 'presentation' : 'proposal';
  const promptVersion = `content-sufficiency-${contentType}-v1`;
  let record;
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await request(`/rest/v1/project_analyses?select=version,prompt_version,result&project_id=eq.${project.id}&order=version.desc`, token);
    const version = (Number(rows[0]?.version) || 0) + 1;
    const assessmentVersion = rows.filter(row => row.prompt_version === promptVersion).length + 1;
    result = {
      contentType,
      assessmentVersion,
      assessment: payload.assessment,
      fileIds: Array.isArray(payload.fileIds) ? payload.fileIds : [],
      fileNames: Array.isArray(payload.fileNames) ? payload.fileNames : [],
      sourceText: String(payload.sourceText || '').slice(0, 100000),
      structureSnapshot: Array.isArray(payload.structureSnapshot) ? payload.structureSnapshot : []
    };
    try {
      [record] = await request('/rest/v1/project_analyses', token, {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          project_id: project.id,
          version,
          provider: payload.assessment?.provider || 'openai',
          model: payload.assessment?.model || process.env.OPENAI_MODEL || 'unknown',
          status: 'draft',
          result,
          prompt_version: promptVersion,
          created_by: user.id
        }
      });
      break;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  return {
    id: record.id,
    version: result.assessmentVersion,
    contentType,
    score: Number(payload.assessment?.overallScore) || 0,
    rating: payload.assessment?.rating || '',
    summary: payload.assessment?.summary || '',
    generatedAt: payload.assessment?.generatedAt || record.created_at,
    fileIds: result.fileIds,
    fileNames: result.fileNames,
    sourceText: result.sourceText,
    structureSnapshot: result.structureSnapshot,
    assessment: payload.assessment
  };
}

function projectRow(item, organizationId, userId) {
  const metadata = {
    outline: item.outline || [],
    plan: item.plan || null,
    criteria: item.criteria || [],
    slides: item.slides || [],
    reused: item.reused || [],
    draftText: item.draftText || "",
    draftAssessment: item.draftAssessment || null,
    selectedRequirementFileIds: item.selectedRequirementFileIds || [],
    selectedDraftFileIds: item.selectedDraftFileIds || [],
    presentationText: item.presentationText || "",
    presentationAssessment: item.presentationAssessment || null,
    selectedPresentationFileIds: item.selectedPresentationFileIds || [],
    sufficiencyMode: item.sufficiencyMode || "proposal",
    previousStage: item.previousStage || ""
  };
  return {
    organization_id: organizationId,
    legacy_id: String(item.id),
    name: String(item.name || "").trim(),
    client: String(item.client || "").trim(),
    project_type: String(item.type || "").trim(),
    status: String(item.status || "提案中"),
    stage: String(item.stage || "需求整理"),
    owner_name: String(item.owner || ""),
    due_date: item.due || null,
    source_text: String(item.sourceText || ""),
    metadata,
    created_by: userId
  };
}

export async function saveWorkspace(token, payload) {
  const user = await authenticate(token);
  const member = await membership(token, user.id);
  if (!['admin', 'editor'].includes(member.role)) {
    const error = new Error("目前帳號只有檢視權限。");
    error.status = 403;
    throw error;
  }
  if (!Array.isArray(payload?.cases) || !Array.isArray(payload?.library)) {
    const error = new Error("同步資料格式不正確。");
    error.status = 400;
    throw error;
  }
  const organizationId = member.organization_id;
  const existing = await request(`/rest/v1/projects?select=id,legacy_id&organization_id=eq.${organizationId}`, token);
  const incomingIds = new Set(payload.cases.map(item => String(item.id)));

  for (const old of existing) {
    if (!incomingIds.has(old.legacy_id || old.id)) await request(`/rest/v1/projects?id=eq.${old.id}`, token, { method: "DELETE" });
  }

  for (const item of payload.cases) {
    if (!item?.id || !String(item.name || "").trim()) continue;
    const [project] = await request("/rest/v1/projects?on_conflict=organization_id,legacy_id", token, {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: projectRow(item, organizationId, user.id)
    });
    await request(`/rest/v1/project_tasks?project_id=eq.${project.id}`, token, { method: "DELETE" });
    const taskRows = (item.tasks || []).map(task => ({ project_id: project.id, title: String(task[0] || ""), completed: Boolean(task[1]) })).filter(task => task.title);
    if (taskRows.length) await request("/rest/v1/project_tasks", token, { method: "POST", prefer: "return=minimal", body: taskRows });

    if (item.analysis?.generatedAt) {
      const current = await request(`/rest/v1/project_analyses?select=version,prompt_version,result&project_id=eq.${project.id}&order=version.desc`, token);
      const latestProjectAnalysis = current.find(row => !String(row.prompt_version || '').startsWith('content-sufficiency-'));
      if (latestProjectAnalysis?.result?.generatedAt !== item.analysis.generatedAt) {
        await request("/rest/v1/project_analyses", token, {
          method: "POST",
          prefer: "return=minimal",
          body: {
            project_id: project.id,
            version: (current[0]?.version || 0) + 1,
            provider: item.analysis.provider || "legacy-rules",
            model: item.analysis.model || "none",
            result: item.analysis,
            prompt_version: item.analysis.provider === "openai" ? "project-feasibility-v3" : "legacy",
            created_by: user.id
          }
        });
      }
    }
  }

  const existingMaterials = await request(`/rest/v1/reusable_materials?select=id,legacy_id&organization_id=eq.${organizationId}`, token);
  const incomingMaterialIds = new Set(payload.library.map(item => String(item.id)));
  for (const old of existingMaterials) {
    if (!incomingMaterialIds.has(old.legacy_id || old.id)) await request(`/rest/v1/reusable_materials?id=eq.${old.id}`, token, { method: "DELETE" });
  }
  for (const item of payload.library) {
    if (!item?.id || !String(item.title || "").trim()) continue;
    await request("/rest/v1/reusable_materials?on_conflict=organization_id,legacy_id", token, {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        organization_id: organizationId,
        legacy_id: String(item.id),
        title: String(item.title),
        category: String(item.category || ""),
        applicable: String(item.applicable || ""),
        summary: String(item.summary || ""),
        content: String(item.content || ""),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        usage_count: Math.max(0, Number(item.usage) || 0),
        created_by: user.id
      }
    });
  }
  return { saved: true, projects: payload.cases.length, materials: payload.library.length };
}
import { randomUUID } from "node:crypto";
