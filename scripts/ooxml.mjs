import { inflateRawSync } from 'node:zlib';

const xmlDecode = value => String(value || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到有效的 Office 壓縮檔結構。');
  const entries = new Map();
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Office 檔案索引損毀。');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, compressed);
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlTexts(xml) {
  return [...String(xml).matchAll(/<(?:[\w-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?t>/g)].map(match => xmlDecode(match[1]));
}

export function extractXlsxText(base64, maxLength = 100000) {
  const entries = unzip(Buffer.from(base64, 'base64'));
  const shared = entries.has('xl/sharedStrings.xml') ? xmlTexts(entries.get('xl/sharedStrings.xml').toString('utf8')) : [];
  const sheetNames = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lines = [];
  for (const [sheetIndex, name] of sheetNames.entries()) {
    lines.push(`工作表 ${sheetIndex + 1}`);
    const xml = entries.get(name).toString('utf8');
    for (const rowMatch of xml.matchAll(/<row\b[^>]*r="?(\d+)"?[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const ref = /\br="([^"]+)"/.exec(attrs)?.[1] || '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || '';
        let value = '';
        if (type === 'inlineStr') value = xmlTexts(body).join('');
        else {
          value = xmlDecode(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] || '');
          if (type === 's' && value !== '') value = shared[Number(value)] ?? value;
        }
        const formula = xmlDecode(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1] || '');
        if (value || formula) cells.push(`${ref || '?'}=${value || `公式:${formula}`}`);
      }
      if (cells.length) lines.push(`第 ${rowMatch[1]} 列｜${cells.join('｜')}`);
      if (lines.join('\n').length >= maxLength) return lines.join('\n').slice(0, maxLength);
    }
  }
  return lines.join('\n').slice(0, maxLength);
}

export function extractDocxText(base64, maxLength = 100000) {
  const entries = unzip(Buffer.from(base64, 'base64'));
  const document = entries.get('word/document.xml');
  if (!document) throw new Error('找不到 Word 文件內容。');
  const lines = [];
  for (const [index, match] of [...document.toString('utf8').matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].entries()) {
    const text = xmlTexts(match[1]).join('').trim();
    if (text) lines.push(`段落 ${index + 1}｜${text}`);
    if (lines.join('\n').length >= maxLength) break;
  }
  return lines.join('\n').slice(0, maxLength);
}

export function extractDocxTables(base64) {
  const entries = unzip(Buffer.from(base64, 'base64'));
  const document = entries.get('word/document.xml');
  if (!document) throw new Error('找不到 Word 文件內容。');
  const tables = [];
  for (const tableMatch of document.toString('utf8').matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)) {
    const rows = [];
    for (const rowMatch of tableMatch[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
      const cells = [...rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
        .map(cellMatch => xmlTexts(cellMatch[1]).join('').trim());
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

export function extractPptxText(base64, maxLength = 100000) {
  const entries = unzip(Buffer.from(base64, 'base64'));
  const names = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lines = [];
  for (const [index, name] of names.entries()) {
    const texts = xmlTexts(entries.get(name).toString('utf8')).map(text => text.trim()).filter(Boolean);
    if (texts.length) lines.push(`投影片 ${index + 1}｜${texts.join('｜')}`);
    if (lines.join('\n').length >= maxLength) break;
  }
  return lines.join('\n').slice(0, maxLength);
}
