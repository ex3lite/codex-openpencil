import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProjectCatalog, resolveProjectRoot } from '../plugins/openpencil/scripts/project-catalog.mjs';
import { atomicSave } from '../plugins/openpencil/scripts/editor-session.mjs';

const document = name => Buffer.from(JSON.stringify({ version: '0.8.5', children: [{ id: 'one', type: 'text', name }] }));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error.code === expected;
async function projects(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'openpencil-projects-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const a = join(base, 'project'), b = join(base, 'project-other');
  await mkdir(a); await mkdir(b);
  return { base, a, b };
}

async function fixture(t) {
  const paths = await projects(t);
  const catalog = await ProjectCatalog.open({ projectRoot: paths.a });
  return { ...paths, catalog };
}

test('cwd alone never establishes a project, including the current directory', async t => {
  const { a } = await projects(t);
  await assert.rejects(resolveProjectRoot({ cwd: a }), code('PROJECT_ROOT_REQUIRED'));
  await assert.rejects(ProjectCatalog.open(), code('PROJECT_ROOT_REQUIRED'));
  await assert.rejects(resolveProjectRoot({ projectRoot: '.' }), code('PROJECT_ROOT_REQUIRED'));
});

test('MCP roots are canonical, deduplicated and ambiguous roots require explicit selection', async t => {
  const { base, a, b } = await projects(t);
  await symlink(a, join(base, 'alias'), 'dir');
  const roots = [{ uri: pathToFileURL(a).href }, { uri: pathToFileURL(b).href }];
  await assert.rejects(resolveProjectRoot({ roots }), code('PROJECT_ROOT_AMBIGUOUS'));
  await assert.rejects(resolveProjectRoot({ roots, cwd: base }), code('PROJECT_ROOT_AMBIGUOUS'));
  assert.equal((await resolveProjectRoot({ roots, cwd: a })).projectRoot, a);
  assert.equal((await resolveProjectRoot({ roots, projectRoot: b })).projectRoot, b);
  const aliasRoots = [{ uri: pathToFileURL(a).href }, { uri: pathToFileURL(join(base, 'alias')).href }];
  assert.equal((await resolveProjectRoot({ roots: aliasRoots })).projectRoot, a);
  assert.equal((await resolveProjectRoot({ projectRoot: a })).projectId,
    (await resolveProjectRoot({ projectRoot: join(base, 'alias') })).projectId);
  await assert.rejects(resolveProjectRoot({ roots: [{ uri: 'https://example.com/project' }] }), code('INVALID_PROJECT_ROOTS'));
});

test('host roots resolve automatically without using plugin cwd or overriding explicit context', async t => {
  const { a, b } = await projects(t);
  let calls = 0;
  const resolveRoots = async () => { calls++; return [{ uri: pathToFileURL(a).href }]; };
  assert.equal((await resolveProjectRoot({ resolveRoots, cwd: b })).projectRoot, a);
  assert.equal(calls, 1);
  assert.equal((await resolveProjectRoot({ resolveRoots, projectRoot: b })).projectRoot, b);
  assert.equal(calls, 1);
  assert.equal((await resolveProjectRoot({ resolveRoots, roots: [{ uri: pathToFileURL(b).href }] })).projectRoot, b);
  assert.equal(calls, 1);
  for (const roots of [undefined, []]) {
    await assert.rejects(resolveProjectRoot({ resolveRoots: async () => roots, cwd: b }), code('PROJECT_ROOT_REQUIRED'));
  }
});

test('overlapping MCP roots cannot be silently selected from cwd', async t => {
  const { base, a } = await projects(t);
  await assert.rejects(resolveProjectRoot({ roots: [base, a].map(path => ({ uri: pathToFileURL(path).href })), cwd: a }), code('PROJECT_ROOT_AMBIGUOUS'));
});

test('catalogs persist stable document IDs and never list another project', async t => {
  const { a, b, catalog } = await fixture(t);
  const firstPath = join(a, 'first.op');
  await writeFile(firstPath, document('first'));
  const first = await catalog.registerDocument({ filePath: firstPath });
  assert.equal(first.name, 'first.op');
  assert.equal(first.path, firstPath);
  assert.equal(first.relativePath, 'first.op');
  assert.equal((await catalog.registerDocument({ filePath: firstPath })).id, first.id);
  const reopened = await ProjectCatalog.open({ projectRoot: a });
  assert.equal((await reopened.getDocument(first.id)).id, first.id);
  const other = await ProjectCatalog.open({ projectRoot: b });
  assert.deepEqual((await other.listDocuments()).documents, []);
  await assert.rejects(other.getDocument(first.id), code('DOCUMENT_NOT_FOUND'));
  assert.notEqual(catalog.projectId, other.projectId);
  const disk = JSON.parse(await readFile(catalog.catalogPath, 'utf8'));
  assert.equal(disk.documents[0].relativePath, 'first.op');
  assert.equal(disk.projectRoot, a);
});

test('sibling prefix, dot traversal and external symlinks cannot open or save a design', async t => {
  const { a, b, catalog } = await fixture(t);
  const foreign = join(b, 'foreign.op');
  await writeFile(foreign, document('foreign'));
  await symlink(b, join(a, 'external'), 'dir');
  await symlink(foreign, join(a, 'external.op'));
  for (const path of [foreign, join(a, '..', basename(b), 'foreign.op'), join(a, 'external', 'foreign.op'), join(a, 'external.op')]) {
    await assert.rejects(catalog.registerDocument({ filePath: path }), code('DOCUMENT_OUTSIDE_PROJECT'));
  }
  for (const path of [join(b, 'new.op'), join(a, 'external', 'nested', 'new.op')]) {
    await assert.rejects(catalog.validateSavePath(path), code('DOCUMENT_OUTSIDE_PROJECT'));
  }
  assert.deepEqual((await catalog.listDocuments()).documents, []);
  assert.deepEqual(await readFile(foreign), document('foreign'));
});

test('a symlink within the project resolves to one canonical document identity', async t => {
  const { a, catalog } = await fixture(t);
  const path = join(a, 'design.op'), alias = join(a, 'alias.op');
  await writeFile(path, document('same')); await symlink(path, alias);
  const first = await catalog.registerDocument({ filePath: alias });
  assert.equal(first.path, path);
  assert.equal((await catalog.registerDocument({ filePath: path })).id, first.id);
  assert.equal((await catalog.listDocuments()).documents.length, 1);
});

test('a registered path replaced by an external symlink is blocked on listing and reopen', async t => {
  const { a, b, catalog } = await fixture(t);
  const path = join(a, 'design.op'), foreign = join(b, 'foreign.op');
  await writeFile(path, document('own')); await writeFile(foreign, document('foreign'));
  const entry = await catalog.registerDocument({ filePath: path });
  await rm(path); await symlink(foreign, path);
  assert.equal((await catalog.getDocument(entry.id)).status, 'blocked');
  await assert.rejects(catalog.reopenDocument(entry.id), code('DOCUMENT_OUTSIDE_PROJECT'));
});

test('cross-project import creates an independent copy and never overwrites a destination', async t => {
  const { a, b, catalog } = await fixture(t);
  const source = join(b, 'design.op'), target = join(a, 'imported.op');
  await writeFile(source, document('original'));
  const imported = await catalog.importDocument({ sourcePath: source, filePath: target, name: 'Imported design' });
  assert.equal(imported.name, 'Imported design');
  assert.equal(imported.path, target);
  assert.deepEqual(await readFile(target), await readFile(source));
  await writeFile(target, document('edited copy'));
  assert.deepEqual(await readFile(source), document('original'));
  await assert.rejects(catalog.importDocument({ sourcePath: source, filePath: target }), code('DOCUMENT_ALREADY_REGISTERED'));
  const existing = join(a, 'existing.op'); await writeFile(existing, document('keep'));
  await assert.rejects(catalog.importDocument({ sourcePath: source, filePath: existing }), code('IMPORT_DESTINATION_EXISTS'));
  assert.deepEqual(await readFile(existing), document('keep'));
  await assert.rejects(catalog.importDocument({ sourcePath: target, filePath: target }), code('IMPORT_REQUIRES_COPY'));
});

test('saved document binding remains inside its project and rejects duplicate ownership', async t => {
  const { a, b, catalog } = await fixture(t);
  const untitled = await catalog.registerDocument();
  assert.equal(untitled.status, 'untitled');
  const saved = join(a, 'saved.op'), other = join(a, 'other.op'), foreign = join(b, 'foreign.op');
  for (const path of [saved, other, foreign]) await writeFile(path, document('file'));
  const bound = await catalog.bindDocument({ documentId: untitled.id, filePath: saved });
  assert.equal(bound.id, untitled.id); assert.equal(bound.path, saved);
  const second = await catalog.registerDocument({ filePath: other });
  await assert.rejects(catalog.bindDocument({ documentId: second.id, filePath: saved }), code('DOCUMENT_ALREADY_REGISTERED'));
  await assert.rejects(catalog.bindDocument({ documentId: second.id, filePath: foreign }), code('DOCUMENT_OUTSIDE_PROJECT'));
});

test('project recovery survives a new catalog instance and preserves an offline conflict baseline', async t => {
  const { a, catalog } = await fixture(t);
  const path = join(a, 'design.op'); const original = document('original'), edited = document('unsaved');
  await writeFile(path, original);
  const entry = await catalog.registerDocument({ filePath: path });
  const stored = await catalog.writeRecovery({ documentId: entry.id, bytes: edited, sourceHash: digest(original) });
  assert.equal(stored.canRecover, true);
  assert.ok(stored.recoveryPath.startsWith(join(a, '.openpencil', 'recovery')));
  await writeFile(path, document('external edit while offline'));
  const again = await ProjectCatalog.open({ projectRoot: a });
  const reopened = await again.reopenDocument(entry.id);
  assert.equal(reopened.recovered, true); assert.equal(reopened.sourcePath, path);
  assert.equal(reopened.baseline, digest(original));
  assert.deepEqual(await readFile(reopened.filePath), edited);
  await assert.rejects(atomicSave(reopened.sourcePath, edited, reopened.baseline), /changed outside/);
  assert.deepEqual(await readFile(path), document('external edit while offline'));
  const sourceOnly = await again.reopenDocument(entry.id, { preferRecovery: false });
  assert.equal(sourceOnly.recovered, false); assert.equal(sourceOnly.filePath, path);
});

test('untitled drafts reopen only by their project-owned document ID', async t => {
  const { base, b, catalog } = await fixture(t);
  const entry = await catalog.registerDocument({ name: 'Draft' });
  await assert.rejects(catalog.reopenDocument(entry.id), code('DOCUMENT_HAS_NO_RECOVERY'));
  const runtimeDraft = join(base, 'runtime-recovery.op');
  await writeFile(runtimeDraft, document('draft'));
  await catalog.recordRecovery({ documentId: entry.id, recoveryPath: runtimeDraft });
  const reopened = await catalog.reopenDocument(entry.id);
  assert.equal(reopened.sourcePath, null); assert.equal(reopened.baseline, null);
  assert.deepEqual(await readFile(reopened.filePath), document('draft'));
  const foreign = await ProjectCatalog.open({ projectRoot: b });
  assert.deepEqual((await foreign.listDocuments()).documents, []);
  await assert.rejects(foreign.reopenDocument(entry.id), code('DOCUMENT_NOT_FOUND'));
});

test('missing source remains visible and can recover without taking an unrelated file', async t => {
  const { a, catalog } = await fixture(t);
  const path = join(a, 'missing.op'); await writeFile(path, document('source'));
  const entry = await catalog.registerDocument({ filePath: path });
  await catalog.writeRecovery({ documentId: entry.id, bytes: document('recovery'), sourceHash: digest(document('source')) });
  await rm(path);
  assert.equal((await catalog.getDocument(entry.id)).status, 'missing');
  assert.equal((await catalog.reopenDocument(entry.id)).recovered, true);
  await assert.rejects(catalog.reopenDocument(entry.id, { preferRecovery: false }), code('ENOENT'));
});

test('catalog and recovery symlinks cannot redirect persistent state outside the project', async t => {
  const { a, b } = await projects(t);
  await symlink(b, join(a, '.openpencil'), 'dir');
  await assert.rejects(ProjectCatalog.open({ projectRoot: a }), code('UNSAFE_CATALOG_PATH'));
  await assert.rejects(readFile(join(b, 'catalog.json')), code('ENOENT'));
});

test('a copied or malformed catalog is rejected without resetting its documents', async t => {
  const { a, b, catalog } = await fixture(t);
  await catalog.registerDocument({ name: 'Keep me' });
  const before = await readFile(catalog.catalogPath);
  await mkdir(join(b, '.openpencil'));
  await writeFile(join(b, '.openpencil', 'catalog.json'), before);
  await assert.rejects(ProjectCatalog.open({ projectRoot: b }), code('PROJECT_CATALOG_MISMATCH'));
  await writeFile(catalog.catalogPath, '{invalid');
  await assert.rejects(ProjectCatalog.open({ projectRoot: a }), code('INVALID_CATALOG'));
  assert.equal(await readFile(catalog.catalogPath, 'utf8'), '{invalid');
  await writeFile(catalog.catalogPath, before);
  assert.equal((await catalog.listDocuments()).documents[0].name, 'Keep me');
});

test('catalog traversal, recovery metadata tampering and stale locks fail closed', async t => {
  const { catalog } = await fixture(t);
  const entry = await catalog.registerDocument();
  const manifest = JSON.parse(await readFile(catalog.catalogPath, 'utf8'));
  manifest.documents[0].relativePath = '../other/design.op';
  await writeFile(catalog.catalogPath, JSON.stringify(manifest));
  await assert.rejects(catalog.listDocuments(), code('INVALID_CATALOG'));
  manifest.documents[0].relativePath = null;
  manifest.documents[0].recovery = { relativePath: '../secret.op', sourceHash: null, updatedAt: new Date().toISOString() };
  await writeFile(catalog.catalogPath, JSON.stringify(manifest));
  await assert.rejects(catalog.reopenDocument(entry.id), code('INVALID_CATALOG'));
  manifest.documents[0].recovery = null;
  await writeFile(catalog.catalogPath, JSON.stringify(manifest));
  await writeFile(join(catalog.directory, 'catalog.lock'), 'stale lock');
  await assert.rejects(catalog.registerDocument(), code('CATALOG_BUSY'));
  assert.equal((await catalog.listDocuments()).documents.length, 1);
});

test('invalid imported and recovery documents never enter the catalog', async t => {
  const { a, b, catalog } = await fixture(t);
  const invalid = join(b, 'invalid.op'); await writeFile(invalid, '{"secret":"not a design"}');
  await assert.rejects(catalog.importDocument({ sourcePath: invalid, filePath: join(a, 'copy.op') }), code('INVALID_DOCUMENT'));
  await assert.rejects(readFile(join(a, 'copy.op')), code('ENOENT'));
  const entry = await catalog.registerDocument();
  await assert.rejects(catalog.writeRecovery({ documentId: entry.id, bytes: 'bad' }), code('INVALID_DOCUMENT'));
  await assert.rejects(catalog.writeRecovery({ documentId: entry.id, bytes: document('valid'), sourceHash: 'bogus' }), code('INVALID_SOURCE_HASH'));
  assert.equal((await catalog.getDocument(entry.id)).canRecover, false);
});

test('a stored canonical path cannot drift to another document through an internal symlink', async t => {
  const { a, catalog } = await fixture(t);
  const original = join(a, 'original.op'), other = join(a, 'other.op');
  await writeFile(original, document('original')); await writeFile(other, document('other'));
  const entry = await catalog.registerDocument({ filePath: original });
  await rm(original); await symlink(other, original);
  assert.equal((await catalog.getDocument(entry.id)).status, 'blocked');
  await assert.rejects(catalog.reopenDocument(entry.id), code('DOCUMENT_PATH_CHANGED'));
});

test('missing save destinations cannot traverse dangling directory symlinks', async t => {
  const { a, b, catalog } = await fixture(t);
  await symlink(join(b, 'not-created'), join(a, 'dangling'), 'dir');
  await assert.rejects(catalog.validateSavePath(join(a, 'dangling', 'new.op')), code('UNRESOLVED_SYMBOLIC_LINK'));
});

test('a recovery file replaced with a symlink is never exposed or reopened', async t => {
  const { b, catalog } = await fixture(t);
  const entry = await catalog.registerDocument();
  const stored = await catalog.writeRecovery({ documentId: entry.id, bytes: document('draft') });
  const outside = join(b, 'outside.op'); await writeFile(outside, document('outside'));
  await rm(stored.recoveryPath); await symlink(outside, stored.recoveryPath);
  assert.equal((await catalog.getDocument(entry.id)).canRecover, false);
  await assert.rejects(catalog.reopenDocument(entry.id), code('INVALID_DOCUMENT'));
  assert.deepEqual(await readFile(outside), document('outside'));
});
