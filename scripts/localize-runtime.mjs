import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveRuntime, sha256 } from '../plugins/openpencil/scripts/editor-runtime.mjs';

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('Usage: node scripts/localize-runtime.mjs BASE_RUNTIME ENGINE_CHECKOUT NEW_RUNTIME');
const [base, source, destination] = args.map(path => resolve(path));
const outside = relative(base, destination);
if (!isAbsolute(outside) && outside !== '..' && !outside.startsWith(`..${sep}`)) {
  throw new Error('The localized runtime must be separate from the original runtime.');
}
await resolveRuntime(base);
const manifest = JSON.parse(await readFile(join(base, 'openpencil-runtime.json'), 'utf8'));
if (manifest.openPencilRevision !== 'd155cd08c09cdb79f4c0a2c733dc5f9376765abd') {
  throw new Error('Use the stable 0.8.5 / d155cd0 base runtime that matches this fork.');
}
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', source, 'diff', '--exit-code', '--quiet']);
execFileSync('git', ['-C', source, 'diff', '--cached', '--exit-code', '--quiet']);
const web = join(source, 'crates/op-host-web/pkg');
for (const name of ['op_host_web.js', 'op_host_web_bg.wasm', 'assets/i18n/ru.json']) {
  await readFile(join(web, name));
}
await mkdir(destination); // Refuse to overwrite an existing runtime.
await cp(base, destination, { recursive: true });
const target = join(destination, 'bin/web-bundle');
await cp(web, target, { recursive: true,
  filter: path => !/\.(d\.ts|opt\.wasm)$/.test(path) });
const notice = await readFile(join(destination, 'NOTICE'), 'utf8');
await writeFile(join(destination, 'NOTICE'), `${notice}\nRussian web localization: https://github.com/ex3lite/openpencil\nWeb source: ${revision}; daemon and CanvasKit preserved from the verified base runtime.\n`);
manifest.localization = { locale: 'ru', webSourceRevision: revision,
  repository: 'https://github.com/ex3lite/openpencil', baseRevision: manifest.openPencilRevision };
manifest.files = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Runtime payload cannot contain symlinks.');
    if (entry.isDirectory()) await collect(path);
    else if (entry.name !== 'openpencil-runtime.json') {
      manifest.files[relative(destination, path).split(sep).join('/')] = sha256(await readFile(path));
    }
  }
}
await collect(destination);
await writeFile(join(destination, 'openpencil-runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
await resolveRuntime(destination);
console.log(`Verified Russian runtime: ${Object.keys(manifest.files).length} files; web source ${revision}.`);
