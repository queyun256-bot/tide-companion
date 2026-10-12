// Read-only Win32 hit testing at arbitrary coordinates. No OS cursor is moved,
// no clicks are injected, and neither screen.getCursorScreenPoint nor native
// input functions are mocked. All windows/data belong to this isolated run.
import {_electron as electron} from 'playwright-core';
import {mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const userData=await mkdtemp(path.join(tmpdir(),'tide-pet-input-native-'));
const env={...process.env,TIDE_TEST_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
let app;
function inspect(info,points){
  const command=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type @'
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]public struct TidePoint{public int X;public int Y;public TidePoint(int x,int y){X=x;Y=y;}}
[StructLayout(LayoutKind.Sequential)]public struct TideRect{public int Left,Top,Right,Bottom;}
[StructLayout(LayoutKind.Sequential)]public struct TideGui{public int cbSize;public uint flags;public IntPtr hwndActive,hwndFocus,hwndCapture,hwndMenuOwner,hwndMoveSize,hwndCaret;public TideRect rcCaret;}
public static class TideHit{
[DllImport("user32.dll")]public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr hwnd,out TideRect rect);
[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(TidePoint point);
[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
[DllImport("user32.dll")]public static extern bool GetGUIThreadInfo(uint threadId,ref TideGui info);
}
'@
[void][TideHit]::SetThreadDpiAwarenessContext([IntPtr](-4))
$pet=[IntPtr]${info.petHandle}
$rect=New-Object TideRect
[void][TideHit]::GetWindowRect($pet,[ref]$rect)
$style=[TideHit]::GetWindowLongPtr($pet,-20).ToInt64()
$gui=New-Object TideGui;$gui.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($gui);[uint32]$proc=0;$thread=[TideHit]::GetWindowThreadProcessId($pet,[ref]$proc);[void][TideHit]::GetGUIThreadInfo($thread,[ref]$gui)
$points=ConvertFrom-Json @'
${JSON.stringify(points)}
'@
$hits=@($points | ForEach-Object { $x=$rect.Left+[int][Math]::Round($_.x*($rect.Right-$rect.Left)/${info.cssWidth});$y=$rect.Top+[int][Math]::Round($_.y*($rect.Bottom-$rect.Top)/${info.cssHeight});$h=[TideHit]::WindowFromPoint([TidePoint]::new($x,$y));@{name=$_.name;x=$x;y=$y;root=[TideHit]::GetAncestor($h,2).ToInt64();handle=$h.ToInt64()} })
@{ignore=($style -band 0x20) -ne 0;layered=($style -band 0x80000) -ne 0;capture=$gui.hwndCapture.ToInt64();moveSize=$gui.hwndMoveSize.ToInt64();physicalRect=@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top};hits=$hits}|ConvertTo-Json -Compress -Depth 5`;
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}).trim());
}
try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'tests/launch-smoke.cjs')],env,timeout:30000});
  let pet,dashboard;
  for(let n=0;n<100;n++){pet=app.windows().find(w=>w.url().endsWith('/pet.html'));dashboard=app.windows().find(w=>w.url().endsWith('/index.html'));if(pet&&dashboard)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(pet&&dashboard);await pet.locator('#builtin-pet svg').waitFor();
  await pet.evaluate(async()=>{const s=await window.petAPI.loadState();s.settings.autoHideFullscreen=false;s.settings.reducedMotion=true;s.settings.notifications=false;await window.petAPI.saveState(s);});
  const info=await app.evaluate(async({BrowserWindow,screen})=>{
    const pet=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html'));
    for(const w of BrowserWindow.getAllWindows()){w.webContents.setBackgroundThrottling(false);w.hide();}
    const area=screen.getPrimaryDisplay().workArea,cursor=screen.getCursorScreenPoint();
    const bounds={x:area.x+(cursor.x<area.x+area.width/2?area.width-380:60),y:area.y+60,width:320,height:370};
    const under=new BrowserWindow({...bounds,show:false,frame:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#344754',webPreferences:{sandbox:true}});
    await under.loadURL('data:text/html,<title>isolated hit-test target</title><body style="background:%23344754">isolated input target</body>');
    under.setAlwaysOnTop(true,'screen-saver');under.showInactive();
    pet.setBounds(bounds);pet.setAlwaysOnTop(true,'screen-saver');pet.showInactive();pet.moveTop();
    globalThis.__tideHitUnder=under;
    const hwnd=w=>Number(w.getNativeWindowHandle().readBigUInt64LE());
    return {petHandle:hwnd(pet),underHandle:hwnd(under),cssWidth:320,cssHeight:370,bounds,cursorBefore:cursor};
  });
  await pet.waitForTimeout(180);
  const points=[{name:'outer-blank',x:3,y:3},{name:'body',x:160,y:170},{name:'button-corner-blank',x:20,y:80}];
  // Exercise the shipped SVG hit policy and preload/main IPC, then read the
  // actual native target. These renderer events do not move the OS cursor.
  await pet.evaluate(()=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:160,clientY:170,buttons:0})));
  await pet.waitForTimeout(60);
  const baseline=inspect(info,points);
  assert.equal(baseline.ignore,false);assert.equal(baseline.hits.find(hit=>hit.name==='body').root,info.petHandle);
  await pet.evaluate(()=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:20,clientY:80,buttons:0})));
  await pet.waitForTimeout(60);
  const ignored=inspect(info,points);
  assert.equal(ignored.ignore,true);assert.ok(ignored.hits.every(hit=>hit.root===info.underHandle),JSON.stringify({info,ignored}));
  await pet.evaluate(()=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:160,clientY:170,buttons:0})));
  await pet.waitForTimeout(60);
  const restored=inspect(info,points);
  assert.equal(restored.ignore,false);assert.equal(restored.hits.find(hit=>hit.name==='body').root,info.petHandle);
  const cursorAfter=await app.evaluate(({screen})=>screen.getCursorScreenPoint());
  console.log(JSON.stringify({ok:true,baseline,ignored,restored,info,cursorAfter,isolatedData:userData,notes:'production hover policy and native hit-read probe; renderer hover is synthetic; no OS cursor movement or click injection'}));
}finally{if(app)await app.close();}
