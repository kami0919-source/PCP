import assert from 'node:assert/strict';
import test from 'node:test';
import { completeProjectFileUpload, loadProjectFilesForAnalysis, saveAssessmentRun, saveProjectFilePart } from './supabase-api.mjs';

test('stores each proposal assessment as the next independent history version', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  let inserted;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/auth/v1/user') return new Response(JSON.stringify({ id: 'user-1', email: 'test@example.com' }));
    if (path === '/rest/v1/organization_members') return new Response(JSON.stringify([{ organization_id: 'org-1', role: 'editor' }]));
    if (path === '/rest/v1/projects') return new Response(JSON.stringify([{ id: 'project-uuid', legacy_id: 'P-1' }]));
    if (path === '/rest/v1/project_analyses' && (options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify([
        { version: 3, prompt_version: 'project-feasibility-v3', result: {} },
        { version: 2, prompt_version: 'content-sufficiency-presentation-v1', result: { assessmentVersion: 1 } },
        { version: 1, prompt_version: 'content-sufficiency-proposal-v1', result: { assessmentVersion: 1 } }
      ]));
    }
    if (path === '/rest/v1/project_analyses' && options.method === 'POST') {
      inserted = JSON.parse(options.body);
      return new Response(JSON.stringify([{ id: 'analysis-4', created_at: '2026-10-11T00:00:00.000Z' }]));
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  try {
    const run = await saveAssessmentRun('token', {
      projectId: 'P-1',
      contentType: 'proposal',
      assessment: { overallScore: 86, rating: '充足', generatedAt: '2026-10-11T01:00:00.000Z', provider: 'openai', model: 'test-model' },
      fileIds: ['file-1'],
      fileNames: ['proposal-v2.docx'],
      sourceText: '第二版計畫書',
      structureSnapshot: [{ title: '執行規劃' }]
    });

    assert.equal(inserted.version, 4);
    assert.equal(inserted.prompt_version, 'content-sufficiency-proposal-v1');
    assert.equal(inserted.result.assessmentVersion, 2);
    assert.deepEqual(inserted.result.fileNames, ['proposal-v2.docx']);
    assert.equal(run.version, 2);
    assert.equal(run.score, 86);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stores and reconstructs a chunked large project file', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-key';
  const originalFetch = globalThis.fetch;
  const objects = new Map();
  let attachment;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    if (path === '/auth/v1/user') return new Response(JSON.stringify({ id: 'user-1', email: 'test@example.com' }));
    if (path === '/rest/v1/organization_members') return new Response(JSON.stringify([{ organization_id: 'org-1', role: 'editor' }]));
    if (path === '/rest/v1/projects') return new Response(JSON.stringify([{ id: 'project-uuid', legacy_id: 'P-1' }]));
    if (path === '/rest/v1/attachments' && options.method === 'POST') {
      const row = JSON.parse(options.body);
      attachment = { id: 'file-1', file_name: row.file_name, content_type: row.content_type, byte_size: row.byte_size, storage_path: row.storage_path, created_at: '2026-10-20T00:00:00.000Z' };
      return new Response(JSON.stringify([attachment]));
    }
    if (path === '/rest/v1/attachments') return new Response(JSON.stringify([attachment]));
    const prefix = '/storage/v1/object/project-files/';
    if (path.startsWith(prefix) && options.method === 'POST') {
      objects.set(path.slice(prefix.length), Buffer.from(options.body));
      return new Response('', { status: 200 });
    }
    if (path.startsWith(prefix) && (!options.method || options.method === 'GET')) {
      const body = objects.get(path.slice(prefix.length));
      return body ? new Response(body) : new Response('', { status: 404 });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };
  try {
    const uploadId = '12345678-1234-4234-8234-123456789abc';
    const parts = [Buffer.from('large-'), Buffer.from('document')];
    for (const [partIndex, part] of parts.entries()) await saveProjectFilePart('token', { projectId: 'P-1', purpose: 'requirement', fileName: 'large.pdf', uploadId, partIndex, partCount: parts.length, totalBytes: 14, base64: part.toString('base64') });
    const completed = await completeProjectFileUpload('token', { projectId: 'P-1', purpose: 'requirement', fileName: 'large.pdf', uploadId, totalBytes: 14, partSizes: parts.map(part => part.length) });
    assert.equal(completed.file.size, 14);
    const loaded = await loadProjectFilesForAnalysis('token', 'P-1', ['file-1']);
    assert.equal(Buffer.from(loaded[0].base64, 'base64').toString(), 'large-document');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
