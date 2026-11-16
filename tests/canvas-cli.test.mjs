import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const script = fileURLToPath(new URL('../scripts/canvas.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });

test('canvas CLI requires an explicit absolute project before runtime startup', () => {
  const absolute = resolve('explicit-project');
  for (const args of [[], ['--file', resolve('design.op')], ['--project-root'],
    ['--project-root', 'relative-project'], ['--project-root', absolute, '--file', 'relative.op'],
    ['--project-root', absolute, '--project-root', absolute], ['--unknown', absolute]]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /Usage: npm run canvas -- --project-root/);
    assert.ok(!result.stdout.includes('ready'));
  }
});

test('canvas CLI documents the project root without opening a runtime', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--project-root \/absolute\/project/);
});
