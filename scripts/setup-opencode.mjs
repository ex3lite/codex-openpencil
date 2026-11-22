import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRuntime } from '../plugins/openpencil/scripts/runtime-install.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('OpenBrush requires Node.js 22 or later.');
  const version = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
  if (!/\bv?2\./.test(version)) throw new Error('This installer requires OpenCode 2.x.');
  const catalog = JSON.parse(await readFile(new URL('../plugins/openpencil/openbrush-runtime-catalog.json', import.meta.url)));
  if (!catalog.platforms[`${process.platform}-${process.arch}`]) {
    throw new Error(`Published OpenBrush platforms: ${Object.keys(catalog.platforms).join(', ')}. This machine is ${process.platform}-${process.arch}.`);
  }
  const state = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'openbrush-opencode');
  const runtime = await installRuntime({ catalog, state });
  const bridge = fileURLToPath(new URL('./opencode-bridge.mjs', import.meta.url));
  execFileSync('opencode', ['mcp', 'add', 'openbrush', '--global', '--env', 'OPENPENCIL_EDITOR_RUNTIME_DIR=' + runtime.root,
    '--', process.execPath, bridge], { stdio: 'inherit' });
  console.log('OpenBrush is registered. Run opencode mcp list from your project to check the connection.');
} catch (error) {
  console.error(`OpenBrush: ${error.message}`);
  process.exitCode = 1;
}
