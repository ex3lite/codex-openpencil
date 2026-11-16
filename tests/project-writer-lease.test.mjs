import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCatalog } from '../plugins/openpencil/scripts/project-catalog.mjs';
import { acquireProjectWriter } from '../plugins/openpencil/scripts/project-writer-lease.mjs';

const code = expected => error => error.code === expected;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-writer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await ProjectCatalog.open({ projectRoot: root });
  const document = await catalog.registerDocument();
  return { root, catalog, document, path: join(root, '.openpencil', 'writers', document.id + '.json') };
}

test('writer claims are private and a second owner is refused until release', async t => {
  const f = await fixture(t), first = await acquireProjectWriter(f.catalog, f.document.id);
  const stat = await lstat(f.path);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  await assert.rejects(acquireProjectWriter(f.catalog, f.document.id), code('PROJECT_DOCUMENT_IN_USE'));
  await first.assertOwned(); await first.release(); await first.release();
  const second = await acquireProjectWriter(f.catalog, f.document.id); await second.release();
});

test('release cannot remove a different owner token or a newly reacquired claim', async t => {
  const f = await fixture(t), first = await acquireProjectWriter(f.catalog, f.document.id);
  await rm(f.path);
  const second = await acquireProjectWriter(f.catalog, f.document.id);
  const replacement = await readFile(f.path);
  await assert.rejects(first.assertOwned(), code('PROJECT_WRITER_CHANGED'));
  await assert.rejects(first.release(), code('PROJECT_WRITER_CHANGED'));
  assert.deepEqual(await readFile(f.path), replacement);
  await second.release();
});

test('writer state cannot be redirected through a project metadata symlink', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.catalog.directory, 'writers'), 'dir');
  await assert.rejects(acquireProjectWriter(f.catalog, f.document.id), code('UNSAFE_PROJECT_WRITER'));
  await assert.rejects(readFile(join(outside, f.document.id + '.json')), code('ENOENT'));
});

test('release refuses a symlink replacing its claim and preserves the target', async t => {
  const f = await fixture(t), first = await acquireProjectWriter(f.catalog, f.document.id);
  const outside = join(f.root, 'foreign.json'); await writeFile(outside, 'preserve');
  await rm(f.path); await symlink(outside, f.path);
  await assert.rejects(first.release(), code('UNSAFE_PROJECT_WRITER'));
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
  assert.equal((await lstat(f.path)).isSymbolicLink(), true);
});

test('a definitely stopped process is reported conservatively without deleting its claim', async t => {
  const f = await fixture(t), exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(exited, 'exit');
  await mkdir(join(f.catalog.directory, 'writers'), { mode: 0o700 });
  const claim = { schemaVersion:1, projectRoot:f.root, projectId:f.catalog.projectId, documentId:f.document.id,
    pid:exited.pid, hostname:hostname(), token:randomBytes(32).toString('base64url') };
  const bytes = Buffer.from(JSON.stringify(claim)); await writeFile(f.path, bytes, { mode:0o600 });
  await assert.rejects(acquireProjectWriter(f.catalog, f.document.id), code('PROJECT_WRITER_STALE'));
  assert.deepEqual(await readFile(f.path), bytes);
});

test('independent Node processes share the same document exclusion and orderly close permits reopen', async t => {
  const f = await fixture(t);
  const catalogUrl = new URL('../plugins/openpencil/scripts/project-catalog.mjs', import.meta.url).href;
  const leaseUrl = new URL('../plugins/openpencil/scripts/project-writer-lease.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {ProjectCatalog} from ${JSON.stringify(catalogUrl)};
    import {acquireProjectWriter} from ${JSON.stringify(leaseUrl)};
    const c=await ProjectCatalog.open({projectRoot:${JSON.stringify(f.root)}});
    const lease=await acquireProjectWriter(c,${JSON.stringify(f.document.id)});
    process.stdout.write('ready'); process.stdin.resume();
    process.stdin.on('end',async()=>{await lease.release();});
  `], { stdio:['pipe','pipe','pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [ready] = await once(child.stdout, 'data'); assert.equal(ready.toString(), 'ready');
  await assert.rejects(acquireProjectWriter(f.catalog, f.document.id), code('PROJECT_DOCUMENT_IN_USE'));
  const stopped = once(child, 'exit'); child.stdin.end(); await stopped;
  const reopened = await acquireProjectWriter(f.catalog, f.document.id); await reopened.release();
});
