import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRuntime, sha256 } from '../plugins/openpencil/scripts/editor-runtime.mjs';
const runtime=await resolveRuntime(process.argv[2]);
const temp=await mkdtemp(join(tmpdir(),'op-codex-build-'));
try {
 const entry=join(temp,'entry.js');
 await writeFile(entry,`import init,{mount_ck} from ${JSON.stringify(join(runtime.webBundle,'op_host_web.js'))}; globalThis.OpenPencilEngine={init,mount:mount_ck};`);
 const output=resolve('plugins/openpencil/ui/native-engine.js');
 const result=spawnSync('bun',['build',entry,'--target=browser','--format=iife','--minify','--outfile',output],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||result.stdout);
 const bundled=await readFile(output,'utf8');
 await writeFile(output,bundled.replaceAll('import.meta.url',"new URL('/pkg/op_host_web.js',location.href).href"));
 const source=await readFile(join(runtime.webBundle,'op_host_web.js'));
 await writeFile(output+'.json',JSON.stringify({entrySha256:sha256(source),engineSha256:sha256(await readFile(join(runtime.webBundle,'op_host_web_bg.wasm'))),runtimeVersion:runtime.version,generatedWith:'bun build',sourceRepository:'https://github.com/ex3lite/openpencil'},null,2)+'\n');
 console.log(result.stdout);console.log('Built the original Rust/WASM editor glue. No alternate scene graph.');
} finally {await rm(temp,{recursive:true,force:true});}
