// Stage a complete locally built fork; preserve the prior runtime for rollback.
import {cp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {resolveRuntime,sha256} from '../plugins/openpencil/scripts/editor-runtime.mjs';
if(process.argv.length!==5)throw Error('Usage: node scripts/stage-fork-runtime.mjs BASE_RUNTIME ENGINE_CHECKOUT NEW_RUNTIME');
const [base,engine,destination]=process.argv.slice(2).map(p=>resolve(p));
const revision=execFileSync('git',['-C',engine,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
execFileSync('git',['-C',engine,'diff','--exit-code','--quiet']);
execFileSync('git',['-C',engine,'diff','--cached','--exit-code','--quiet']);
const extension=process.platform==='win32'?'.exe':'';
const binaries=['op-host-web-server','op'].map(name=>({name:'bin/'+name+extension,source:join(engine,'target/release',name+extension)}));
for(const binary of binaries)await readFile(binary.source);
execFileSync(process.execPath,[fileURLToPath(new URL('./localize-runtime.mjs',import.meta.url)),base,engine,destination],{stdio:'inherit'});
const manifestPath=join(destination,'openpencil-runtime.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
for(const binary of binaries){await cp(binary.source,join(destination,binary.name));manifest.files[binary.name]=sha256(await readFile(binary.source));}
manifest.fork={repository:'https://github.com/ex3lite/openpencil',sourceRevision:revision,daemonRevision:revision,converterRevision:revision};
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(destination,'NOTICE'),(await readFile(join(destination,'NOTICE'),'utf8'))+`\nFull OpenBrush fork runtime: web editor, daemon and Figma converter built from ${revision}. Previous stable daemon is replaced in this isolated runtime.\n`);
manifest.files.NOTICE=sha256(await readFile(join(destination,'NOTICE')));
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
await resolveRuntime(destination);
console.log(JSON.stringify({root:destination,sourceRevision:revision,binaries:binaries.map(b=>b.name)}));
