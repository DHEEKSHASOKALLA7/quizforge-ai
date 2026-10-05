const zlib = require('zlib');
const path = require('path');

function unzipEntries(buf) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buf.lastIndexOf(sig);
  if (eocd < 0) throw new Error('Invalid ZIP document');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = {};
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const dataStart = off + 30 + nlen + xlen;
    const compressed = buf.slice(dataStart, dataStart + csize);
    if (method === 0) out[name] = compressed;
    else if (method === 8) out[name] = zlib.inflateRawSync(compressed);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/<w:tab\s*\/?>/gi, '\t')
    .replace(/<a:tab\s*\/?>/gi, '\t')
    .replace(/<w:br\s*\/?>/gi, '\n')
    .replace(/<a:br\s*\/?>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<\/a:p>/gi, '\n')
    .replace(/<\/a:t>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\u00a0/g, ' ');
}

function extractOffice(buf, ext) {
  const entries = unzipEntries(buf);
  if (ext === '.docx') {
    const xml = entries['word/document.xml'];
    if (!xml) throw new Error('Could not read the DOCX document body');
    return { text: decodeXml(xml.toString('utf8')), kind: 'DOCX', sourcePrefix: 'Document' };
  }
  if (ext === '.pptx') {
    const slides = Object.keys(entries).filter(k => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
    if (!slides.length) throw new Error('Could not read any PPTX slides');
    const text = slides.map((name, i) => `\f[Slide ${i + 1}]\n${decodeXml(entries[name].toString('utf8'))}`).join('\n');
    return { text, kind: 'PPTX', sourcePrefix: 'Slide' };
  }
  throw new Error('Unsupported Office document');
}

function pdfLiteral(s) {
  let out = '', esc = false, oct = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (oct) {
      if (/[0-7]/.test(c) && oct.length < 3) { oct += c; if (oct.length === 3) { out += String.fromCharCode(parseInt(oct, 8)); oct = ''; } continue; }
      out += String.fromCharCode(parseInt(oct, 8)); oct = '';
    }
    if (esc) {
      esc = false;
      const map = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', '(':'(', ')':')', '\\':'\\' };
      if (/[0-7]/.test(c)) { oct = c; continue; }
      out += map[c] ?? c; continue;
    }
    if (c === '\\') { esc = true; continue; }
    out += c;
  }
  if (oct) out += String.fromCharCode(parseInt(oct, 8));
  return out;
}

function ascii85Decode(str) {
  let s = String(str).replace(/\s/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  if (s.endsWith('~>')) s = s.slice(0, -2);
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0,0,0,0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      let n = 0; for (const v of group) n = n * 85 + v;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); group = [];
    }
  }
  if (group.length) {
    const len = group.length; while (group.length < 5) group.push(84);
    let n = 0; for (const v of group) n = n * 85 + v;
    const bytes = [(n >>> 24)&255,(n >>> 16)&255,(n >>> 8)&255,n&255];
    out.push(...bytes.slice(0, len - 1));
  }
  return Buffer.from(out);
}

function pdfTextFromStream(buf) {
  let text = '';
  const ascii = buf.toString('latin1');
  const streamRe = /([\s\S]{0,500})stream\r?\n([\s\S]*?)\s*endstream/g;
  let m;
  while ((m = streamRe.exec(ascii))) {
    const dict = m[1];
    let raw = Buffer.from(m[2], 'latin1');
    try {
      if (/ASCII85Decode/.test(dict)) raw = ascii85Decode(raw.toString('latin1'));
      if (/FlateDecode/.test(dict)) raw = zlib.inflateSync(raw);
    } catch { try { raw = zlib.inflateRawSync(raw); } catch { continue; } }
    const src = raw.toString('latin1');
    const parts = [];
    const re = /\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>\s*(?=[Tt]j|TJ)/g;
    let x;
    while ((x = re.exec(src))) {
      if (x[0][0] === '(') parts.push(pdfLiteral(x[0].slice(1, -1)));
      else parts.push(Buffer.from(x[1].replace(/\s/g, ''), 'hex').toString('latin1'));
    }
    if (parts.length) text += parts.join(' ') + '\n';
  }
  return text;
}

function extractPdf(buf) {
  const text = pdfTextFromStream(buf).replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) throw new Error('Could not extract readable text from this PDF. If it is scanned/image-only, OCR is required.');
  return { text, kind: 'PDF', sourcePrefix: 'PDF section' };
}

function cleanText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function extract({ filename, base64, text }) {
  const name = String(filename || 'document.txt');
  const ext = path.extname(name).toLowerCase();
  if (text != null) return { text: cleanText(text), kind: 'TEXT', sourcePrefix: 'Text section', filename: name };
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('Uploaded file is empty');
  let result;
  if (['.txt','.md','.csv','.json','.html','.htm','.xml','.log','.js','.ts','.py','.java','.cpp','.c','.h','.sql'].includes(ext)) {
    result = { text: buf.toString('utf8'), kind: 'TEXT', sourcePrefix: 'Text section' };
  } else if (ext === '.docx' || ext === '.pptx') result = extractOffice(buf, ext);
  else if (ext === '.pdf') result = extractPdf(buf);
  else throw new Error(`Unsupported file type: ${ext || 'unknown'}. Use PDF, DOCX, PPTX, TXT, MD, CSV, JSON, HTML or source-code files.`);
  result.text = cleanText(result.text);
  result.filename = name;
  return result;
}

async function pdfPages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    let out = '', lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) out = out.trimEnd() + '\n';
      out += it.str + (it.hasEOL ? '\n' : ' '); lastY = y;
    }
    pages.push(out.replace(/[ \t]*\n+/g, '\n').trim());
  }
  return pages;
}
// Async entry point: PDFs go through pdf.js (page-accurate, handles embedded fonts); everything else uses extract().
async function extractAsync(o) {
  const name = String(o.filename || ''), ext = path.extname(name).toLowerCase();
  if (ext !== '.pdf' || !o.base64) return extract(o);
  const buf = Buffer.from(String(o.base64), 'base64');
  if (!buf.length) throw new Error('Uploaded file is empty');
  let pages = [];
  try { pages = await pdfPages(buf); } catch (e) { console.error('pdf.js failed, using built-in reader:', e.message); }
  const text = cleanText(pages.join('\f'));
  if (text.replace(/\s/g, '').length >= 80) return { text, kind: 'PDF', sourcePrefix: 'Page', filename: name };
  try { return extract(o); } catch { throw new Error('This PDF has no selectable text (it looks scanned or image-only). Run OCR on it first, or export it as text/DOCX.'); }
}

module.exports = { extract, extractAsync, unzipEntries, cleanText };
