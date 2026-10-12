const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// A single hidden helper reports changes only. It exits when its parent exits.
exports.watchFullscreen = function watchFullscreen(onChange,onError=()=>{}) {
  if(process.platform!=='win32')return ()=>{};
  const script=`$OwnerPid = ${process.pid}\n`+fs.readFileSync(path.join(__dirname,'fullscreen-watch.ps1'),'utf8');
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let buffer='',ended=false;
  child.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines)if(line==='0'||line==='1')onChange(line==='1');});
  child.on('error',()=>onError());child.stderr.on('data',()=>{if(!ended)onError();});
  child.on('exit',()=>{if(!ended){onChange(false);onError();}});
  return ()=>{ended=true;child.kill();};
};
