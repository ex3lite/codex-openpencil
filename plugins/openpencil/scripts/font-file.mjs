// Inspect untrusted SFNT data before it reaches the native font parser.
export const MAX_FONT_BYTES = 16 * 1024 * 1024;
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/gu, ' ').trim();
export function sameFontFamily(a, b) { return normalized(a) === normalized(b); }
function range(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw Error(`Invalid font ${label} bounds.`);
}
function unicodeName(bytes) {
  if (bytes.length % 2) throw Error('Invalid font name encoding.');
  let result = '';
  for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes.readUInt16BE(i));
  return result.replace(/\0/g, '').trim();
}
function names(table) {
  range(table, 0, 6, 'name header');
  const count = table.readUInt16BE(2), start = table.readUInt16BE(4);
  if (count > 4096) throw Error('Too many font names.');
  range(table, 6, count * 12, 'name records');
  const result = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12, platform = table.readUInt16BE(p), encoding = table.readUInt16BE(p + 2);
    const id = table.readUInt16BE(p + 6), length = table.readUInt16BE(p + 8), offset = start + table.readUInt16BE(p + 10);
    range(table, offset, length, 'name string');
    if (![1, 2, 6, 16, 17].includes(id)) continue;
    const data = table.subarray(offset, offset + length);
    const value = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding)) ? unicodeName(data) : platform === 1 && encoding === 0 && data.every(b => b < 128) ? data.toString('ascii').trim() : '';
    if (value && value.length <= 512) result.push({ id, value });
  }
  return result;
}
function cmap4(table, glyphCount) {
  range(table, 0, 16, 'cmap4 header');
  const length = table.readUInt16BE(2), count = table.readUInt16BE(6) / 2;
  if (!Number.isInteger(count) || !count || count > 32767) throw Error('Invalid cmap4 segments.');
  range(table, 0, length, 'cmap4');
  table = table.subarray(0, length);
  range(table, 14, count * 8 + 2, 'cmap4 arrays');
  const end = 14, start = 16 + count * 2, delta = 16 + count * 4, offsets = 16 + count * 6;
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const a = table.readUInt16BE(start + i * 2), b = table.readUInt16BE(end + i * 2), offset = table.readUInt16BE(offsets + i * 2);
    if (a > b || a <= previous || offset % 2) throw Error('Invalid cmap4 ordering.');
    if (offset) range(table, offsets + i * 2 + offset, (b - a + 1) * 2, 'cmap4 glyphs');
    previous = b;
  }
  return codepoint => {
    if (codepoint > 65535) return false;
    let low = 0, high = count - 1;
    while (low <= high) {
      const i = (low + high) >> 1, a = table.readUInt16BE(start + i * 2), b = table.readUInt16BE(end + i * 2);
      if (codepoint < a) high = i - 1;
      else if (codepoint > b) low = i + 1;
      else {
        const offset = table.readUInt16BE(offsets + i * 2), d = table.readInt16BE(delta + i * 2);
        let glyph = offset ? table.readUInt16BE(offsets + i * 2 + offset + (codepoint - a) * 2) : codepoint;
        if (!offset || glyph) glyph = (glyph + d) & 65535;
        return glyph > 0 && glyph < glyphCount;
      }
    }
    return false;
  };
}
function cmap12(table, glyphCount) {
  range(table, 0, 16, 'cmap12 header');
  const length = table.readUInt32BE(4), count = table.readUInt32BE(12);
  range(table, 0, length, 'cmap12');
  if (count > 1000000) throw Error('Too many cmap12 groups.');
  range(table.subarray(0, length), 16, count * 12, 'cmap12 groups');
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const p = 16 + i * 12, a = table.readUInt32BE(p), b = table.readUInt32BE(p + 4), glyph = table.readUInt32BE(p + 8);
    if (a > b || a <= previous || b > 0x10ffff || glyph + b - a > 0xffffffff) throw Error('Invalid cmap12 ordering.');
    previous = b;
  }
  return codepoint => {
    let low = 0, high = count - 1;
    while (low <= high) {
      const i = (low + high) >> 1, p = 16 + i * 12, a = table.readUInt32BE(p), b = table.readUInt32BE(p + 4);
      if (codepoint < a) high = i - 1;
      else if (codepoint > b) low = i + 1;
      else { const glyph = table.readUInt32BE(p + 8) + codepoint - a; return glyph > 0 && glyph < glyphCount; }
    }
    return false;
  };
}
function unicodeCoverage(table, glyphCount) {
  range(table, 0, 4, 'cmap header');
  const count = table.readUInt16BE(2), maps = [];
  range(table, 4, count * 8, 'cmap records');
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const p = 4 + i * 8, platform = table.readUInt16BE(p), encoding = table.readUInt16BE(p + 2), offset = table.readUInt32BE(p + 4);
    range(table, offset, 2, 'cmap subtable');
    if (!(platform === 0 || platform === 3 && [1, 10].includes(encoding)) || seen.has(offset)) continue;
    seen.add(offset);
    const format = table.readUInt16BE(offset);
    if (format === 4) maps.push(cmap4(table.subarray(offset), glyphCount));
    if (format === 12) maps.push(cmap12(table.subarray(offset), glyphCount));
  }
  if (!maps.length) throw Error('Font has no supported Unicode cmap.');
  return codepoint => Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff && maps.some(map => map(codepoint));
}
function inspectFace(bytes, offset, index, expectedFamily) {
  range(bytes, offset, 12, 'SFNT header');
  const signature = bytes.readUInt32BE(offset);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) throw Error('Unsupported SFNT font signature.');
  const count = bytes.readUInt16BE(offset + 4);
  if (!count || count > 256) throw Error('Invalid SFNT table count.');
  range(bytes, offset + 12, count * 16, 'SFNT directory');
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const p = offset + 12 + i * 16, tag = bytes.toString('ascii', p, p + 4), start = bytes.readUInt32BE(p + 8), length = bytes.readUInt32BE(p + 12);
    range(bytes, start, length, `${tag} table`);
    if (tables.has(tag)) throw Error('Duplicate SFNT table.');
    tables.set(tag, bytes.subarray(start, start + length));
  }
  for (const tag of ['name', 'cmap', 'maxp', 'OS/2']) if (!tables.has(tag)) throw Error(`Font lacks ${tag} table.`);
  const decoded = names(tables.get('name')), preferred = decoded.filter(n => n.id === 16), legacy = decoded.filter(n => n.id === 1);
  const aliases = [...new Set((preferred.length ? preferred : legacy).map(n => n.value))];
  if (!aliases.length || expectedFamily && !aliases.some(name => sameFontFamily(name, expectedFamily))) throw Error('Font intrinsic family does not match the requested family.');
  const os2 = tables.get('OS/2'), maxp = tables.get('maxp');
  range(os2, 0, 64, 'OS/2'); range(maxp, 0, 6, 'maxp');
  const weight = os2.readUInt16BE(4), glyphCount = maxp.readUInt16BE(4);
  if (weight < 1 || weight > 1000 || !glyphCount) throw Error('Invalid font weight or glyph count.');
  let weightMin = weight, weightMax = weight;
  const axes = [];
  if (tables.has('fvar')) {
    const fvar = tables.get('fvar'); range(fvar, 0, 16, 'fvar header');
    const start = fvar.readUInt16BE(4), axisCount = fvar.readUInt16BE(8), size = fvar.readUInt16BE(10);
    if (axisCount > 64 || size < 20) throw Error('Invalid fvar axes.');
    range(fvar, start, axisCount * size, 'fvar axes');
    for (let i = 0; i < axisCount; i++) {
      const p = start + i * size, tag = fvar.toString('ascii', p, p + 4), min = fvar.readInt32BE(p + 4) / 65536, value = fvar.readInt32BE(p + 8) / 65536, max = fvar.readInt32BE(p + 12) / 65536;
      if (min > value || value > max) throw Error('Invalid fvar axis range.');
      axes.push({ tag, min, default: value, max });
      if (tag === 'wght') { if (min < 1 || max > 1000) throw Error('Invalid font weight axis.'); weightMin = min; weightMax = max; }
    }
  }
  const supportsCodepoint = unicodeCoverage(tables.get('cmap'), glyphCount);
  return { index, family: expectedFamily || aliases[0], aliases, style: os2.readUInt16BE(62) & 1 ? 'italic' : 'normal', weight, weightMin, weightMax, axes, supportsCodepoint };
}
export function inspectFont(input, { family } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_FONT_BYTES || bytes.length < 12) throw Error('Font exceeds size limit or is truncated.');
  let offsets = [0];
  if (bytes.toString('ascii', 0, 4) === 'ttcf') {
    const count = bytes.readUInt32BE(8);
    if (!count || count > 64 || ![0x00010000, 0x00020000].includes(bytes.readUInt32BE(4))) throw Error('Invalid TTC header.');
    range(bytes, 12, count * 4, 'TTC offsets');
    offsets = Array.from({ length: count }, (_, i) => bytes.readUInt32BE(12 + i * 4));
  }
  return { faces: offsets.map((offset, index) => inspectFace(bytes, offset, index, family)), bytes: bytes.length };
}
