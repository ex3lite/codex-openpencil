import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectFont, MAX_FONT_BYTES } from '../plugins/openpencil/scripts/font-file.mjs';
import { FontLibrary } from '../plugins/openpencil/scripts/font-library.mjs';
import { GoogleFontProvider, parseFontMetadata } from '../plugins/openpencil/scripts/font-provider-google.mjs';

// Minimal binary SFNT fixtures exercise the actual cmap/name/fvar readers, without host fonts.
function fixtureFont({ family = 'Inter', weight = 400, style = 'normal', points = [65, 0x410, 0x44f, 0x1f680], variable = true, format = 12 } = {}) {
  const nameString = Buffer.from([...family].flatMap(char => { const c = char.charCodeAt(0); return [c >> 8, c & 255]; }));
  const name = Buffer.alloc(18 + nameString.length); name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6); name.writeUInt16BE(1, 8); name.writeUInt16BE(0x409, 10); name.writeUInt16BE(16, 12); name.writeUInt16BE(nameString.length, 14); nameString.copy(name, 18);
  const os2 = Buffer.alloc(64); os2.writeUInt16BE(weight, 4); os2.writeUInt16BE(style === 'italic' ? 1 : 0, 62);
  const maxp = Buffer.alloc(6); maxp.writeUInt32BE(0x10000); maxp.writeUInt16BE(1000, 4);
  const sorted = [...new Set(points)].sort((a, b) => a - b);
  let sub;
  if (format === 12) {
    sub = Buffer.alloc(16 + sorted.length * 12); sub.writeUInt16BE(12); sub.writeUInt32BE(sub.length, 4); sub.writeUInt32BE(sorted.length, 12);
    sorted.forEach((cp, i) => { const p = 16 + i * 12; sub.writeUInt32BE(cp, p); sub.writeUInt32BE(cp, p + 4); sub.writeUInt32BE(i + 1, p + 8); });
  } else {
    const values = sorted.filter(cp => cp <= 65534).concat(65535), n = values.length;
    sub = Buffer.alloc(16 + n * 8); sub.writeUInt16BE(4); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(n * 2, 6);
    values.forEach((cp, i) => { sub.writeUInt16BE(cp, 14 + i * 2); sub.writeUInt16BE(cp, 16 + n * 2 + i * 2); sub.writeUInt16BE((i + 1 - cp) & 65535, 16 + n * 4 + i * 2); });
  }
  const cmap = Buffer.alloc(12 + sub.length); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(format === 12 ? 10 : 1, 6); cmap.writeUInt32BE(12, 8); sub.copy(cmap, 12);
  const tables = { name, 'OS/2': os2, maxp, cmap };
  if (variable) { const fvar = Buffer.alloc(36); fvar.writeUInt32BE(0x10000); fvar.writeUInt16BE(16, 4); fvar.writeUInt16BE(1, 8); fvar.writeUInt16BE(20, 10); fvar.write('wght', 16); fvar.writeInt32BE(100 * 65536, 20); fvar.writeInt32BE(weight * 65536, 24); fvar.writeInt32BE(900 * 65536, 28); tables.fvar = fvar; }
  const header = Buffer.alloc(12 + Object.keys(tables).length * 16); header.writeUInt32BE(0x10000); header.writeUInt16BE(Object.keys(tables).length, 4);
  let offset = header.length;
  Object.entries(tables).forEach(([tag, table], i) => { const p = 12 + i * 16; header.write(tag, p); header.writeUInt32BE(offset, p + 8); header.writeUInt32BE(table.length, p + 12); offset += table.length; });
  return Buffer.concat([header, ...Object.values(tables)]);
}
const commit = 'a'.repeat(40);
const metadata = (family = 'Inter', filename = 'Inter[wght].ttf') => `name: "${family}"\nfonts { name: "${family}" style: "normal" weight: 400 filename: "${filename}" }\naxes { tag: "wght" min_value: 100 max_value: 900 }\nsubsets: "cyrillic"`;
const licenseText = 'Copyright Example. SIL OPEN FONT LICENSE Version 1.1';
function network({ points, wrongFamily, italic = false, unknown = false, license = licenseText } = {}) {
  const calls = [];
  const fetchBytes = async url => {
    calls.push(url);
    if (url === 'https://api.github.com/repos/google/fonts/commits/main') return { bytes: Buffer.from(JSON.stringify({ sha: commit })), url };
    if (unknown) throw Error('Public asset download failed: HTTP 404.');
    if (url.endsWith('/METADATA.pb')) return { bytes: Buffer.from(metadata() + (italic ? '\nfonts {name: "Inter" style: "italic" weight: 400 filename: "Inter-Italic[wght].ttf"}' : '')), url };
    if (url.endsWith('/OFL.txt')) return { bytes: Buffer.from(license), url };
    if (url.endsWith('.ttf')) return { bytes: fixtureFont({ points, family: wrongFamily || 'Inter', style: url.includes('Italic') ? 'italic' : 'normal' }), url };
    throw Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchBytes };
}
async function directory(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'font-library-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const request = [{ family: 'Inter', weights: [400, 700], styles: ['normal'], codepoints: [65, 0x410, 0x44f] }];

test('SFNT validates intrinsic family, variable weights and actual Cyrillic/non-BMP glyphs', () => {
  const face = inspectFont(fixtureFont(), { family: 'Inter' }).faces[0];
  assert.equal(face.family, 'Inter'); assert.equal(face.weightMin, 100); assert.equal(face.weightMax, 900);
  assert.ok(face.supportsCodepoint(0x410)); assert.ok(face.supportsCodepoint(0x1f680)); assert.equal(face.supportsCodepoint(0x411), false);
  assert.throws(() => inspectFont(fixtureFont({ family: 'Other' }), { family: 'Inter' }), /intrinsic family/);
  const format4 = inspectFont(fixtureFont({ format: 4 })).faces[0]; assert.ok(format4.supportsCodepoint(0x44f)); assert.equal(format4.supportsCodepoint(0x1f680), false);
});
test('font parser rejects malformed table bounds, cmap ranges, oversize files and missing glyph IDs', () => {
  const invalid = fixtureFont(); invalid.writeUInt32BE(0xfffffff0, 20); assert.throws(() => inspectFont(invalid), /bounds/);
  assert.throws(() => inspectFont(Buffer.alloc(MAX_FONT_BYTES + 1)), /size limit/);
  const zeroGlyph = fixtureFont(), cmapOffset = zeroGlyph.readUInt32BE(12 + 3 * 16 + 8); zeroGlyph.writeUInt32BE(0, cmapOffset + 12 + 24);
  assert.equal(inspectFont(zeroGlyph).faces[0].supportsCodepoint(65), false);
  const broken = fixtureFont(); broken.writeUInt32BE(0xffffffff, cmapOffset + 12 + 12); assert.throws(() => inspectFont(broken), /cmap12/);
});
test('TTC uses absolute table offsets and validates every intrinsic family', () => {
  const sfnt = fixtureFont(), header = Buffer.alloc(16); header.write('ttcf'); header.writeUInt32BE(0x10000, 4); header.writeUInt32BE(1, 8); header.writeUInt32BE(16, 12);
  for (let i = 0; i < sfnt.readUInt16BE(4); i++) { const p = 12 + i * 16 + 8; sfnt.writeUInt32BE(sfnt.readUInt32BE(p) + 16, p); }
  assert.equal(inspectFont(Buffer.concat([header, sfnt]), { family: 'Inter' }).faces[0].index, 0);
});
test('metadata rejects traversal, aliases and prototype field abuse', () => {
  assert.equal(parseFontMetadata(metadata(), 'Inter').fonts[0].filename, 'Inter[wght].ttf');
  assert.throws(() => parseFontMetadata(metadata('Other'), 'Inter'), /mismatch/);
  assert.throws(() => parseFontMetadata(metadata('Inter', '../Inter.ttf'), 'Inter'), /Unsafe/);
  assert.throws(() => parseFontMetadata(metadata() + '\nconstructor: "x"', 'Inter'), /metadata/);
});
test('global cache pins source revision, saves evidence, supports Cyrillic and works offline', async t => {
  const dir = await directory(t), net = network();
  const first = await new FontLibrary({ directory: dir, fetchBytes: net.fetchBytes }).ensure(request);
  assert.equal(first.ready, 1); assert.equal(first.families[0].faces.length, 1); assert.deepEqual(first.families[0].missingCodepoints, []);
  const face = first.families[0].faces[0]; assert.equal(face.sourceCommit, commit); assert.equal(face.license.spdx, 'OFL-1.1'); assert.ok(Buffer.isBuffer(await readFile(face.path)));
  assert.equal(net.calls.filter(url => url.endsWith('.ttf')).length, 1); assert.ok(net.calls.slice(1).every(url => url.includes(commit)));
  assert.equal((await readdir(join(dir, 'licenses'))).length, 1); assert.equal((await readdir(join(dir, 'metadata'))).length, 1);
  const second = await new FontLibrary({ directory: dir, fetchBytes: () => { throw Error('Offline'); } }).ensure(request, { autonomous: false });
  assert.equal(second.ready, 1); assert.equal(second.families[0].faces[0].sha256, face.sha256);
});
test('Cyrillic subset claims cannot hide missing cmap coverage or italic/weight omissions', async t => {
  const dir = await directory(t), net = network({ points: [65, 0x410] });
  const result = await new FontLibrary({ directory: dir, fetchBytes: net.fetchBytes }).ensure(request);
  assert.equal(result.partial, 1); assert.deepEqual(result.families[0].missingCodepoints, [0x44f]);
  assert.deepEqual(result.families[0].missingFaces, [], 'A missing glyph does not make available style/weight pairs disappear.');
  const styles = await new FontLibrary({ directory: await directory(t), fetchBytes: network({ italic: true }).fetchBytes }).ensure([{ ...request[0], styles: ['normal', 'italic'] }]);
  assert.equal(styles.ready, 1); assert.deepEqual(styles.families[0].faces.map(f => f.style).sort(), ['italic', 'normal']);
});
test('claimed variable axes cannot turn a static regular font into a bold face', async t => {
  const net = network();
  const fetchBytes = async (url, options) => url.endsWith('.ttf') ? { bytes: fixtureFont({ variable: false }), url } : net.fetchBytes(url, options);
  const result = await new FontLibrary({ directory: await directory(t), fetchBytes }).ensure(request);
  assert.equal(result.partial, 1);
  assert.deepEqual(result.families[0].missingFaces, [{ style: 'normal', weight: 700 }]);
  assert.equal(result.families[0].faces[0].weightMin, 400);
  const onlyBold = await new FontLibrary({ directory: await directory(t), fetchBytes }).ensure([{ ...request[0], weights: [700] }]);
  assert.equal(onlyBold.ready, 0); assert.equal(onlyBold.partial, 1);
  assert.deepEqual(onlyBold.families[0].missingFaces, [{ style: 'normal', weight: 700 }]);
  assert.equal(onlyBold.families[0].faces[0].weight, 400);
});
test('metadata weight discrepancies retain intrinsic weights and report nearest faces without claiming exact readiness', async t => {
  const net = network(), dir = await directory(t);
  const fetchBytes = async (url, options) => url.endsWith('.ttf') ? { bytes: fixtureFont({ variable: false, weight: 275 }), url } :
    url.endsWith('/METADATA.pb') ? { bytes: Buffer.from(metadata().replace('weight: 400', 'weight: 200').replace('axes { tag: "wght" min_value: 100 max_value: 900 }', '')), url } : net.fetchBytes(url, options);
  const requirements = [{ ...request[0], weights: [200] }];
  const library = new FontLibrary({ directory: dir, fetchBytes });
  const result = await library.ensure(requirements), family = result.families[0];
  assert.equal(result.partial, 1); assert.equal(result.ready, 0);
  assert.equal(family.faces[0].weight, 275); assert.equal(family.faces[0].weightMin, 275); assert.equal(family.faces[0].sourceWeight, 200);
  assert.deepEqual(family.missingFaces, [{ style: 'normal', weight: 200 }]);
  assert.deepEqual(family.missingCodepoints, [], 'An absent exact weight must not become a false glyph deficit.');
  assert.deepEqual(family.nearestFaces.map(({ style, requestedWeight, availableWeight }) => ({ style, requestedWeight, availableWeight })), [{ style: 'normal', requestedWeight: 200, availableWeight: 275 }]);
  assert.equal(family.weightMismatches[0].intrinsicWeight, 275); assert.equal(family.weightMismatches[0].sourceWeight, 200);
  const offline = await new FontLibrary({ directory: dir, fetchBytes: () => { throw Error('Offline'); } }).ensure(requirements, { autonomous: false });
  assert.equal(offline.partial, 1); assert.equal(offline.families[0].nearestFaces[0].availableWeight, 275);
});
test('transient font download failure retries on the next ensure without deleting cache', async t => {
  const net = network(), dir = await directory(t); let failed = false, fontRequests = 0;
  const fetchBytes = async (url, options) => {
    if (url.endsWith('.ttf')) { fontRequests++; if (!failed) { failed = true; throw Error('Public asset download failed: HTTP 503.'); } }
    return net.fetchBytes(url, options);
  };
  const first = await new FontLibrary({ directory: dir, fetchBytes }).ensure(request);
  assert.equal(first.unavailable, 1); assert.match(first.families[0].error, /503/);
  const second = await new FontLibrary({ directory: dir, fetchBytes }).ensure(request);
  assert.equal(second.ready, 1); assert.equal(fontRequests, 2);
});
test('a shared family cache returns only the faces currently needed, not every previously downloaded weight',async t=>{
  const net=network(),dir=await directory(t);let downloads=0;
  const fetchBytes=async(url,options)=>{
    if(url.endsWith('/METADATA.pb'))return {url,bytes:Buffer.from('name:"Inter"\nfonts{name:"Inter" style:"normal" weight:400 filename:"Inter-Regular.ttf"}\nfonts{name:"Inter" style:"normal" weight:700 filename:"Inter-Bold.ttf"}')};
    if(url.endsWith('.ttf')){downloads++;return {url,bytes:fixtureFont({variable:false,weight:url.includes('Bold')?700:400})};}
    return net.fetchBytes(url,options);
  };
  const library=new FontLibrary({directory:dir,fetchBytes});
  assert.equal((await library.ensure([{...request[0],weights:[400,700]}])).families[0].faces.length,2);
  const second=await library.ensure([{...request[0],weights:[400]}]);
  assert.deepEqual(second.families[0].faces.map(f=>f.weight),[400]);assert.equal(downloads,2);
});
test('unknown results and rejected files are cached; system fonts are never guessed', async t => {
  const net = network({ unknown: true }), dir = await directory(t), library = new FontLibrary({ directory: dir, fetchBytes: net.fetchBytes });
  assert.equal((await library.ensure(request)).unavailable, 1); const count = net.calls.length;
  assert.equal((await library.ensure(request)).unavailable, 1); assert.equal(net.calls.length, count);
  assert.equal((await library.ensure([{ family: 'Arial', codepoints: [65] }])).unavailable, 1); assert.equal(net.calls.length, count);
  const wrong = network({ wrongFamily: 'Other' }), other = new FontLibrary({ directory: await directory(t), fetchBytes: wrong.fetchBytes });
  assert.equal((await other.ensure(request)).unavailable, 1); const failedCount = wrong.calls.length;
  assert.equal((await other.ensure(request)).unavailable, 1); assert.equal(wrong.calls.length, failedCount);
});
test('license policy, explicit acquisition disable and cache tampering fail visibly', async t => {
  const net = network({ license: 'unknown license' }), library = new FontLibrary({ directory: await directory(t), fetchBytes: net.fetchBytes });
  assert.equal((await library.ensure(request)).unavailable, 1); assert.equal(net.calls.filter(url => url.endsWith('.ttf')).length, 0);
  assert.equal((await library.ensure(request, { verifyLicenses: false })).ready, 1);
  const fresh = network(), dir = await directory(t), cached = new FontLibrary({ directory: dir, fetchBytes: fresh.fetchBytes });
  assert.equal((await cached.ensure(request, { autonomous: false })).disabled, 1); assert.equal(fresh.calls.length, 0);
  const result = await cached.ensure(request); await writeFile(result.families[0].faces[0].path, 'tampered');
  const corrupted = await cached.ensure(request, { autonomous: false }); assert.equal(corrupted.disabled, 1); assert.match(corrupted.families[0].error, /checksum/);
  const repaired = await cached.ensure(request); assert.equal(repaired.ready, 1);
  const listed = await cached.list(); assert.equal(listed.total, 1); assert.equal(listed.families[0].family, 'Inter'); assert.equal(listed.families[0].availableFaces, 1); assert.equal(JSON.stringify(listed).includes('path'), false);
  await assert.rejects(cached.ensure(Array.from({ length: 65 }, () => request[0])), /at most 64/);
});
test('GitHub revision lookup explicitly requests the supported JSON media type', async () => {
  const calls = [];
  const provider = new GoogleFontProvider({ fetchBytes: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.accept, 'application/vnd.github+json');
    return { bytes: Buffer.from(JSON.stringify({ sha: commit })), url };
  } });
  assert.equal(await provider.getCommit(), commit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/google/fonts/commits/main');
});
test('transient revision failure can recover on the next ensure without deleting the cache', async t => {
  const net = network(), dir = await directory(t); let failed = false;
  const fetchBytes = async (url, options) => {
    if (!failed && url.endsWith('/commits/main')) { failed = true; throw Error('Public asset download failed: HTTP 503.'); }
    return net.fetchBytes(url, options);
  };
  const first = await new FontLibrary({ directory: dir, fetchBytes }).ensure(request);
  assert.equal(first.unavailable, 1); assert.match(first.families[0].error, /503/);
  const second = await new FontLibrary({ directory: dir, fetchBytes }).ensure(request);
  assert.equal(second.ready, 1); assert.equal(second.families[0].faces.length, 1);
});
test('transient metadata failure retries acquisition while retaining the pinned revision', async t => {
  const net = network(), dir = await directory(t); let failed = false;
  const fetchBytes = async (url, options) => {
    if (!failed && url.endsWith('/METADATA.pb')) { failed = true; throw Error('Public asset download failed: HTTP 503.'); }
    return net.fetchBytes(url, options);
  };
  const library = new FontLibrary({ directory: dir, fetchBytes });
  const first = await library.ensure(request); assert.equal(first.unavailable, 1); assert.match(first.families[0].error, /503/);
  const second = await library.ensure(request); assert.equal(second.ready, 1);
  assert.equal(net.calls.filter(url => url.endsWith('/commits/main')).length, 1);
  assert.equal(second.families[0].faces[0].sourceCommit, commit);
});
test('provider validates commit and refuses nonofficial download sources', async () => {
  const provider = new GoogleFontProvider({ fetchBytes: async () => ({ bytes: Buffer.from('{"sha":"main"}') }) });
  await assert.rejects(provider.download({ sourceUrl: `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/inter/%2e%2e%2fInter.ttf` }), /Unsafe/);
  await assert.rejects(provider.download({ sourceUrl: `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/inter/Inter.ttf?download.ttf` }), /Unsafe/);
  await assert.rejects(provider.getCommit(), /revision/); await assert.rejects(provider.download({ sourceUrl: 'https://example.com/font.ttf' }), /Unsafe/);
});
