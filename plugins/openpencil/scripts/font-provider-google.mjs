import { fetchPublicBytes } from './community-network.mjs';
import { sameFontFamily, MAX_FONT_BYTES } from './font-file.mjs';

const RAW = 'https://raw.githubusercontent.com/google/fonts';
const COMMIT = 'https://api.github.com/repos/google/fonts/commits/main';
const FONT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_,.\[\] -]*\.(?:ttf|otf)$/i;
const GENERIC = /^(?:serif|sans[- ]serif|monospace|cursive|fantasy|system[- ]ui|ui[- ](?:serif|sans[- ]serif|monospace|rounded)|inherit|initial|unset|default|arial|helvetica(?: neue)?|times(?: new roman)?|courier(?: new)?|sf(?: pro(?: display| text| rounded)?)?|san francisco|segoe ui|aptos|calibri|verdana|tahoma|georgia)$/i;
export function googleFamilySlug(family) {
  if (typeof family !== 'string' || !family.trim() || family.length > 200 || GENERIC.test(family.trim())) return null;
  // Family names are not filenames; reject punctuation rather than invent an alias.
  if (!/^[\p{L}\p{N} _-]+$/u.test(family)) return null;
  const slug = family.normalize('NFKC').replace(/[ _-]/g, '').toLowerCase();
  return /^[a-z0-9]+$/.test(slug) ? slug : null;
}
function tokens(text) {
  if (Buffer.byteLength(text) > 512 * 1024) throw Error('Font metadata is too large.');
  const result = [], expression = /\s+|#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|-?\d+(?:\.\d+)?|[{}:\[\],]/gy;
  let offset = 0;
  while (offset < text.length) {
    expression.lastIndex = offset; const match = expression.exec(text);
    if (!match) throw Error('Invalid Google Fonts metadata syntax.');
    offset = expression.lastIndex;
    if (!/^\s|^#|^\/\//.test(match[0])) result.push(match[0]);
    if (result.length > 50000) throw Error('Too many font metadata fields.');
  }
  return result;
}
export function parseFontMetadata(text, expectedFamily) {
  const input = tokens(text); let cursor = 0;
  function message(depth = 0) {
    if (depth > 12) throw Error('Font metadata nesting is too deep.');
    const fields = Object.create(null);
    while (cursor < input.length && input[cursor] !== '}') {
      const key = input[cursor++];
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Invalid font metadata field.');
      if (input[cursor] === ':') cursor++;
      let value;
      if (input[cursor] === '{') { cursor++; value = message(depth + 1); if (input[cursor++] !== '}') throw Error('Unclosed font metadata message.'); }
      else {
        const raw = input[cursor++];
        if (!raw || ['}', '{', ':', '[', ']', ','].includes(raw)) throw Error('Invalid font metadata value.');
        try { value = raw.startsWith('"') ? JSON.parse(raw) : /^-?\d/.test(raw) ? Number(raw) : raw; }
        catch { throw Error('Invalid font metadata string.'); }
      }
      (fields[key] ||= []).push(value);
      if ([','].includes(input[cursor])) cursor++;
    }
    return fields;
  }
  const fields = message();
  if (cursor !== input.length || fields.name?.length !== 1 || !sameFontFamily(fields.name[0], expectedFamily)) throw Error('Google Fonts metadata family mismatch.');
  const fonts = (fields.fonts || []).map(entry => {
    const family = entry.name?.[0], filename = entry.filename?.[0], style = entry.style?.[0], weight = entry.weight?.[0];
    if (typeof family !== 'string' || !sameFontFamily(family, expectedFamily) || typeof filename !== 'string' || filename.length > 240 || !FONT_FILENAME.test(filename) || filename.includes('..') || !['normal', 'italic'].includes(style) || !Number.isInteger(weight) || weight < 1 || weight > 1000) throw Error('Unsafe or inconsistent Google Fonts face metadata.');
    return { family, filename, style, weight };
  });
  if (!fonts.length || fonts.length > 128) throw Error('Invalid Google Fonts face count.');
  const axes = (fields.axes || []).map(axis => ({ tag: axis.tag?.[0], min: axis.min_value?.[0], max: axis.max_value?.[0] }));
  for (const axis of axes) if (!/^[A-Za-z0-9]{4}$/.test(axis.tag) || !Number.isFinite(axis.min) || !Number.isFinite(axis.max) || axis.min > axis.max) throw Error('Invalid Google Fonts axis metadata.');
  return { family: fields.name[0], fonts, axes };
}
export class GoogleFontProvider {
  constructor({ fetchBytes = fetchPublicBytes } = {}) { this.fetchBytes = fetchBytes; }
  async getCommit() {
    const result = await this.fetchBytes(COMMIT, { limit: 1024 * 1024, accept:'application/vnd.github+json' });
    let data; try { data = JSON.parse(result.bytes.toString('utf8')); } catch { throw Error('Invalid Google Fonts revision response.'); }
    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw Error('Invalid Google Fonts revision.');
    return data.sha;
  }
  async resolveFamily(family, { commit } = {}) {
    const slug = googleFamilySlug(family);
    if (!slug) return { status: 'unavailable', error: 'This generic, system or unsupported family has no exact Google Fonts source.' };
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('A pinned Google Fonts revision is required.');
    for (const directory of ['ofl', 'apache', 'ufl']) {
      const base = `${RAW}/${commit}/${directory}/${slug}`;
      let downloaded;
      try { downloaded = await this.fetchBytes(`${base}/METADATA.pb`, { limit: 512 * 1024 }); }
      catch (error) { if (/HTTP 404\b/.test(error.message)) continue; throw error; }
      const metadata = parseFontMetadata(downloaded.bytes.toString('utf8'), family);
      const licenseFilename = directory === 'ofl' ? 'OFL.txt' : directory === 'apache' ? 'LICENSE.txt' : 'UFL.txt';
      let license;
      try { license = await this.fetchBytes(`${base}/${licenseFilename}`, { limit: 256 * 1024 }); }
      catch (error) {
        if (directory !== 'apache' || !/HTTP 404\b/.test(error.message)) throw error;
        license = await this.fetchBytes(`${RAW}/${commit}/apache/LICENSE.txt`, { limit: 256 * 1024 });
      }
      const text = license.bytes.toString('utf8');
      const spdx = directory === 'ofl' ? 'OFL-1.1' : directory === 'apache' ? 'Apache-2.0' : 'Ubuntu-font-1.0';
      const verified = directory === 'ofl' ? /SIL OPEN FONT LICENSE\s*(?:Version\s*)?1\.1/i.test(text) : directory === 'apache' ? /Apache License[\s\S]*Version 2\.0/i.test(text) : /UBUNTU FONT LICEN[CS]E[\s\S]*1\.0/i.test(text);
      return {
        status: 'available', family: metadata.family, sourceCommit: commit,
        metadata: { sourceUrl: `${base}/METADATA.pb`, text: downloaded.bytes.toString('utf8'), axes: metadata.axes },
        license: { spdx, text, sourceUrl: license.url || `${base}/${licenseFilename}`, status: verified ? 'verified' : 'unknown' },
        fonts: metadata.fonts.map(font => ({ ...font, sourceUrl: `${base}/${encodeURIComponent(font.filename)}` })),
      };
    }
    return { status: 'unavailable', sourceCommit: commit, error: 'No exact family exists in the official Google Fonts catalog at the pinned revision.' };
  }
  async download(face) {
    // Only a pinned official raw GitHub font can be fetched, even with a corrupt cache.
    if (!/^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[a-f0-9]{40}\/(?:ofl|apache|ufl)\/[a-z0-9]+\/[^/]+\.(?:ttf|otf)$/i.test(face.sourceUrl)) throw Error('Unsafe font download source.');
    const url = new URL(face.sourceUrl);
    let filename;
    try { filename = decodeURIComponent(url.pathname.split('/').at(-1)); } catch { throw Error('Unsafe font filename encoding.'); }
    if (url.search || url.hash || !FONT_FILENAME.test(filename) || filename.includes('..')) throw Error('Unsafe font download filename.');
    return this.fetchBytes(face.sourceUrl, { limit: MAX_FONT_BYTES });
  }
}
