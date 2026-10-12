import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32')throw new Error('Please build this Windows installer on Windows.');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const env={...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'};
delete env.ELECTRON_RUN_AS_NODE;
function run(args){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
  child.once('error',reject);
  child.once('exit',code=>code===0?resolve():reject(new Error(`Build step exited with code ${code}`)));
});}

await run(['scripts/package.mjs','--installer-stage']);
const stage=path.join(root,'dist','installer-stage','Tide-Companion-win32-x64');
await stat(path.join(stage,'resources','app.asar'));
await run(['node_modules/electron-builder/out/cli/cli.js','--win','nsis','--x64','--prepackaged',stage,'--config','electron-builder.json','--publish','never']);
const installer=path.join(root,'dist','installers',`潮汐-Setup-${pkg.version}-x64.exe`);
const digest=createHash('sha256');
for await(const chunk of createReadStream(installer))digest.update(chunk);
const hash=digest.digest('hex');
await writeFile(`${installer}.sha256`,`${hash}  ${path.basename(installer)}\r\n`);
console.log(JSON.stringify({installer,bytes:(await stat(installer)).size,sha256:hash}));
