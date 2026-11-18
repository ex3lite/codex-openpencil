import { resolve } from 'node:path';
import { configureRuntime } from '../plugins/openpencil/scripts/runtime-install.mjs';

const forPlugin = process.argv.length === 4 && process.argv[3] === '--for-plugin';
if (!forPlugin && process.argv.length !== 3) throw new Error('Usage: npm run configure-runtime -- /absolute/runtime/root [--for-plugin]');
const runtime = await configureRuntime(resolve(process.argv[2]), undefined, {}, { forPlugin });
console.log(`Verified and configured Rust OpenPencil ${runtime.version} (${process.platform}-${process.arch}).`);
