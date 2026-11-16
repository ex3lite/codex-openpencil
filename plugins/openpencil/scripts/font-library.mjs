import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stateRoot } from './editor-runtime.mjs';
import { atomicBytes, privateDirectory, safeBytes, withLibraryLock } from './library-storage.mjs';
import { inspectFont, MAX_FONT_BYTES } from './font-file.mjs';
import { GoogleFontProvider, googleFamilySlug } from './font-provider-google.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FAMILIES = 64, MAX_FACES = 32, MAX_REGISTERED_FACES = 64, MAX_CODEPOINTS = 8192;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
function requirementsFor(input) {
  if (!Array.isArray(input) || input.length > MAX_FAMILIES) throw Error(`Font requirements must contain at most ${MAX_FAMILIES} families.`);
  const merged = new Map();
  for (const value of input) {
    if (!value || typeof value.family !== 'string' || !value.family.trim() || value.family.length > 200) throw Error('Invalid font family requirement.');
    const family = value.family.trim(), key = family.normalize('NFKC').toLowerCase();
    const weights = value.weights ?? [400], styles = value.styles ?? ['normal'], codepoints = value.codepoints ?? [];
    if (!Array.isArray(weights) || !weights.length || weights.length > 32 || weights.some(w => !Number.isInteger(w) || w < 1 || w > 1000) ||
        !Array.isArray(styles) || !styles.length || styles.some(s => !['normal', 'italic'].includes(s)) ||
        !Array.isArray(codepoints) || codepoints.length > MAX_CODEPOINTS || codepoints.some(c => !Number.isInteger(c) || c < 0 || c > 0x10ffff || c >= 0xd800 && c <= 0xdfff)) throw Error('Invalid font weight, style or codepoint requirements.');
    const existing = merged.get(key) || { family, weights: new Set(), styles: new Set(), codepoints: new Set() };
    weights.forEach(w => existing.weights.add(w)); styles.forEach(s => existing.styles.add(s)); codepoints.forEach(c => existing.codepoints.add(c));
    if (existing.weights.size > 32 || existing.codepoints.size > MAX_CODEPOINTS) throw Error('Merged font requirements exceed their limits.');
    merged.set(key, existing);
  }
  return [...merged.values()].map(r => ({ family: r.family, weights: [...r.weights], styles: [...r.styles], codepoints: [...r.codepoints] }));
}
const matches = (face, weight, style) => face.style === style && face.weightMin <= weight && weight <= face.weightMax;
const wantedStyle = (face, requirement) => requirement.styles.includes(face.style);
function message(error) { return String(error?.message || error).slice(0, 400); }
async function readJson(path, limit = 2 * 1024 * 1024) {
  try { return JSON.parse(await safeBytes(path, limit)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export class FontLibrary {
  constructor({ directory = join(stateRoot(), 'library', 'fonts'), fetchBytes, provider, now = Date.now } = {}) {
    this.directory = resolve(directory);
    this.provider = provider || new GoogleFontProvider({ fetchBytes });
    this.now = now;
  }
  async list({ offset = 0, limit = 64 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('Invalid font library pagination.');
    let entries;
    try { entries = (await readdir(join(this.directory, 'families'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return { families: [], total: 0, offset, hasMore: false }; throw error; }
    const families = [];
    for (const entry of entries.slice(offset, offset + limit)) {
      const record = await readJson(join(this.directory, 'families', entry));
      if (!record || typeof record.family !== 'string') continue;
      families.push({ family: record.family, availableFaces: record.files?.length || 0, sourceCommit: record.source?.sourceCommit || record.sourceCommit,
        license: record.source?.license, error: record.error, checkedAt: record.checkedAt });
    }
    return { families, total: entries.length, offset, hasMore: offset + limit < entries.length };
  }
  async ensure(input, { autonomous = true, verifyLicenses = true } = {}) {
    const requirements = requirementsFor(input);
    if (!requirements.length) return { families: [], totalFamilies: 0, ready: 0, partial: 0, unavailable: 0, disabled: 0 };
    await privateDirectory(this.directory);
    for (const name of ['objects', 'families', 'licenses', 'metadata']) await privateDirectory(join(this.directory, name));
    return withLibraryLock(this.directory, async () => {
      const families = [];
      for (const requirement of requirements) {
        try { families.push(await this.ensureFamily(requirement, { autonomous, verifyLicenses })); }
        catch (error) { families.push({ family: requirement.family, status: 'unavailable', faces: [], missingCodepoints: requirement.codepoints, missingCodepointCount: requirement.codepoints.length, error: message(error) }); }
      }
      const result = { families, totalFamilies: families.length, ready: 0, partial: 0, unavailable: 0, disabled: 0 };
      for (const family of families) result[family.status]++;
      return result;
    }, '.font-lock');
  }
  async commit() {
    const path = join(this.directory, 'google-revision.json'), saved = await readJson(path, 4096);
    if (saved) {
      if (!/^[a-f0-9]{40}$/.test(saved.commit)) throw Error('Invalid cached Google Fonts revision.');
      if(Number.isFinite(saved.savedAt)&&this.now()-saved.savedAt<NEGATIVE_TTL)return saved.commit;
      try {
        const commit=await this.provider.getCommit();
        if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid Google Fonts revision.');
        await atomicBytes(path,JSON.stringify({commit,savedAt:this.now()}));return commit;
      } catch {return saved.commit;}
    }
    const commit = await this.provider.getCommit();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid Google Fonts revision.');
    await atomicBytes(path, JSON.stringify({ commit, savedAt: this.now() }));
    return commit;
  }
  async storeProvenance(source) {
    const license = { ...source.license }, metadata = source.metadata;
    if (!license || typeof license.text !== 'string' || Buffer.byteLength(license.text) > 512 * 1024 || !metadata || typeof metadata.text !== 'string') throw Error('Font source lacks bounded license and metadata evidence.');
    license.sha256 = hash(license.text);
    await atomicBytes(join(this.directory, 'licenses', `${license.sha256}.txt`), license.text);
    delete license.text;
    const metadataSha256 = hash(metadata.text);
    await atomicBytes(join(this.directory, 'metadata', `${metadataSha256}.pb`), metadata.text);
    return { ...source, license, metadata: { sourceUrl: metadata.sourceUrl, sha256: metadataSha256, axes: metadata.axes || [] } };
  }
  async validateProvenance(source, verifyLicenses) {
    if (!/^[a-f0-9]{40}$/.test(source.sourceCommit) || !/^[a-f0-9]{64}$/.test(source.license?.sha256) || !/^[a-f0-9]{64}$/.test(source.metadata?.sha256)) throw Error('Invalid cached font provenance.');
    const license = await safeBytes(join(this.directory, 'licenses', `${source.license.sha256}.txt`), 512 * 1024);
    const metadata = await safeBytes(join(this.directory, 'metadata', `${source.metadata.sha256}.pb`), 512 * 1024);
    if (hash(license) !== source.license.sha256 || hash(metadata) !== source.metadata.sha256) throw Error('Cached font provenance checksum mismatch.');
    if (verifyLicenses && source.license.status !== 'verified') throw Error('Font license could not be verified.');
  }
  async ensureFamily(requirement, options) {
    const family = requirement.family, slug = googleFamilySlug(family);
    const path = join(this.directory, 'families', `${hash(family.normalize('NFKC').toLowerCase())}.json`);
    let record = await readJson(path), source = record?.source;
    const result = { family, status: 'unavailable', faces: [], missingCodepoints: [...requirement.codepoints], missingCodepointCount: requirement.codepoints.length, missingFaces: [] };
    if (!slug) return { ...result, error: 'Generic, system, proprietary or unsupported family names require an explicit font source.' };
    if (record?.error && record.unavailable === true && this.now() - record.checkedAt < NEGATIVE_TTL) return { ...result, error: record.error };
    if (!source) {
      if (!options.autonomous) return { ...result, status: 'disabled', error: 'Automatic font acquisition is disabled.' };
      try {
        const resolved = await this.provider.resolveFamily(family, { commit: await this.commit() });
        if (resolved.status !== 'available') {
          const error = resolved.error || 'Font family is unavailable.';
          await atomicBytes(path, JSON.stringify({ family, checkedAt: this.now(), error, unavailable:true, sourceCommit: resolved.sourceCommit }));
          return { ...result, error };
        }
        source = await this.storeProvenance(resolved);
        record = { family, source, files: [], checkedAt: this.now() };
        await atomicBytes(path, JSON.stringify(record));
      } catch (error) {
        await atomicBytes(path, JSON.stringify({ family, checkedAt: this.now(), error: message(error), transient:true }));
        return { ...result, error: message(error) };
      }
    }
    await this.validateProvenance(source, options.verifyLicenses);
    if (!Array.isArray(source.fonts) || source.fonts.length > 256 || !Array.isArray(record.files) || record.files.length > MAX_FACES) throw Error('Invalid cached font face list.');
    const parsed = [], errors = [], invalidFiles = new Set();
    const addFaces = (inspection, file, filePath, size) => {
      const metadataFace = source.fonts.find(font => font.sourceUrl === file.sourceUrl);
      if (!metadataFace || !inspection.faces.some(face => face.style === metadataFace.style)) throw Error('Font intrinsic style does not match metadata.');
      for (const face of inspection.faces) if (wantedStyle(face, requirement) && face.style === metadataFace.style) {
        parsed.push({ ...face, sha256: file.sha256, path: filePath, bytes: size, sourceUrl: file.sourceUrl,
          sourceCommit: source.sourceCommit, license: source.license, sourceWeight: metadataFace.weight,
          weightMismatch: metadataFace.weight < face.weightMin || metadataFace.weight > face.weightMax });
      }
    };
    for (const file of record.files) {
      try {
        if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid font checksum.');
        const filePath = join(this.directory, 'objects', `${file.sha256}.font`), bytes = await safeBytes(filePath, MAX_FONT_BYTES);
        if (hash(bytes) !== file.sha256) throw Error('Cached font checksum mismatch.');
        const inspection = inspectFont(bytes, { family });
        addFaces(inspection, file, filePath, bytes.length);
      } catch (error) { errors.push(message(error)); invalidFiles.add(file); }
    }
    if (options.autonomous && invalidFiles.size) {
      record.files = record.files.filter(file => !invalidFiles.has(file));
      await atomicBytes(path, JSON.stringify(record));
    }
    const missingPairs = () => requirement.styles.flatMap(style => requirement.weights.filter(weight => !parsed.some(face => matches(face, weight, style))).map(weight => ({ style, weight })));
    const incompletePairs = () => requirement.styles.flatMap(style => requirement.weights.filter(weight => !parsed.some(face => matches(face, weight, style) && requirement.codepoints.every(cp => face.supportsCodepoint(cp)))).map(weight => ({ style, weight })));
    let needed = incompletePairs();
    if (needed.length && options.autonomous) {
      const variable = source.metadata.axes.some(axis => axis.tag === 'wght');
      const candidates = source.fonts.filter(font => requirement.styles.includes(font.style) && (variable || requirement.weights.includes(font.weight)) && !record.files.some(file => file.sourceUrl === font.sourceUrl));
      for (const font of candidates) {
        if (!needed.length) break;
        if (record.files.length >= MAX_FACES) { errors.push(`Font family exceeds the ${MAX_FACES}-file acquisition limit.`); break; }
        if (record.failures?.some(f => f.sourceUrl === font.sourceUrl && f.permanent===true && this.now() - f.checkedAt < NEGATIVE_TTL)) continue;
        try {
          const downloaded = await this.provider.download(font), bytes = Buffer.isBuffer(downloaded) ? downloaded : downloaded.bytes;
          const inspection = inspectFont(bytes, { family });
          if (!inspection.faces.some(face => face.style === font.style)) throw Error('Font intrinsic style does not match metadata.');
          const sha256 = hash(bytes), filePath = join(this.directory, 'objects', `${sha256}.font`);
          await atomicBytes(filePath, bytes);
          record.files.push({ sha256, sourceUrl: font.sourceUrl });
          addFaces(inspection, { sha256, sourceUrl: font.sourceUrl }, filePath, bytes.length);
          await atomicBytes(path, JSON.stringify(record));
          needed = incompletePairs();
        } catch (error) {
          errors.push(message(error));
          const detail=message(error),permanent=/^(?:Invalid font|Unsupported font|Font intrinsic|Font family)|HTTP (?:404|410)\b/.test(detail);
          record.failures = [...(record.failures || []).filter(f => f.sourceUrl !== font.sourceUrl), { sourceUrl: font.sourceUrl, checkedAt: this.now(), error:detail, permanent }].slice(-256);
          await atomicBytes(path, JSON.stringify(record));
        }
      }
    }
    const truncated = parsed.length > MAX_REGISTERED_FACES;
    if (truncated) {
      result.faceCount = parsed.length;
      result.facesTruncated = true;
      parsed.length = MAX_REGISTERED_FACES;
      errors.push(`Font family exceeds the ${MAX_REGISTERED_FACES}-face registration limit.`);
    }
    result.missingFaces = missingPairs();
    // Report glyph deficits independently from missing exact weights. If a weight is
    // unavailable, inspect the nearest intrinsic face and retain the missing pair.
    const coverageFaces = (style, weight) => {
      const exact = parsed.filter(face => matches(face, weight, style));
      if (exact.length) return exact;
      const choices = parsed.filter(face => face.style === style).map(face => ({ face,
        distance: Math.abs(weight - Math.max(face.weightMin, Math.min(face.weightMax, weight))),
      })).sort((a, b) => a.distance - b.distance || a.face.weight - b.face.weight);
      return choices.length ? [choices[0].face] : [];
    };
    const coverage = requirement.styles.flatMap(style => requirement.weights.map(weight => coverageFaces(style, weight))).filter(faces => faces.length);
    result.missingCodepoints = requirement.codepoints.filter(cp => !coverage.length || coverage.some(faces => !faces.some(face => face.supportsCodepoint(cp))));
    result.missingCodepointCount = result.missingCodepoints.length;
    const unique = new Map();
    for (const face of coverage.flat()) {
      const { supportsCodepoint, aliases, axes, ...descriptor } = face;
      unique.set(`${face.sha256}:${face.index}`, descriptor);
    }
    result.faces = [...unique.values()];
    result.weightMismatches = result.faces.filter(face => face.weightMismatch).map(face => ({
      style: face.style, sourceWeight: face.sourceWeight, intrinsicWeight: face.weight,
      weightMin: face.weightMin, weightMax: face.weightMax, sha256: face.sha256, index: face.index,
    }));
    result.nearestFaces = result.missingFaces.flatMap(({ style, weight }) => {
      const choices = result.faces.filter(face => face.style === style).map(face => ({ face,
        availableWeight: Math.max(face.weightMin, Math.min(face.weightMax, weight)),
      })).sort((a, b) => Math.abs(a.availableWeight - weight) - Math.abs(b.availableWeight - weight) || a.availableWeight - b.availableWeight);
      const nearest = choices[0];
      return nearest ? [{ style, requestedWeight: weight, availableWeight: nearest.availableWeight,
        sha256: nearest.face.sha256, index: nearest.face.index }] : [];
    });
    result.status = !truncated && !result.missingFaces.length && !result.missingCodepoints.length ? 'ready' : result.faces.length ? 'partial' : options.autonomous ? 'unavailable' : 'disabled';
    if (result.status !== 'ready') result.error = errors[0] || (!options.autonomous ? 'Automatic font acquisition is disabled; the cached faces do not satisfy this request.' : 'The available font files do not cover every requested style, weight and character.');
    return result;
  }
}
