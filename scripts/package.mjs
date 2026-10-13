import { packager } from '@electron/packager';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource }=createRequire(require.resolve('@electron/packager'))('resedit');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
// A separate staging folder lets installer builds leave the running portable copy alone.
const outputRoot=path.join(root,'dist',...(process.argv.includes('--installer-stage')?['installer-stage']:[]));
const output=await packager({
  dir:root,name:'Tide-Companion',platform:'win32',arch:'x64',electronVersion:pkg.devDependencies.electron,
  out:outputRoot,overwrite:true,asar:true,prune:false,icon:path.join(root,'assets/app.ico'),
  appVersion:pkg.version,appCopyright:'潮汐',
  // A temporary whitespace value satisfies Packager's required-author inference;
  // the CompanyName key is removed from the finished PE resource below.
  win32metadata:{CompanyName:' ',FileDescription:'潮汐',ProductName:'潮汐'},
  ignore:[/^\/node_modules(?:\/|$)/,/^\/(?:dist|tests|docs|scripts|screenshots|build|\.vscode)(?:\/|$)/,/^\/\./,/^\/(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|electron-builder\.json)$/,/^\/assets\/vendor\/live2dcubismcore\.min\.js$/]
});
for(const directory of output){
  // Windows reads taskbar relaunch icons outside the ASAR. A content-based name
  // lets changed artwork receive a fresh shell cache entry during upgrades.
  const taskbarIcon=await readFile(path.join(root,'assets/app.ico'));
  const iconName=`tide-app-${createHash('sha256').update(taskbarIcon).digest('hex').slice(0,12)}.ico`;
  await writeFile(path.join(directory,'resources',iconName),taskbarIcon);
  // Packager treats empty metadata strings as "keep Electron's original value".
  // Remove the company field explicitly instead of shipping a runtime vendor.
  const exePath=path.join(directory,'Tide-Companion.exe');
  const executable=NtExecutable.from(await readFile(exePath));
  const resources=NtExecutableResource.from(executable);
  for(const version of Resource.VersionInfo.fromEntries(resources.entries)){
    for(const language of version.getAllLanguagesForStringValues())version.removeStringValue(language,'CompanyName');
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  await writeFile(exePath,Buffer.from(executable.generate()));
  await writeFile(path.join(directory,'使用说明.txt'),`潮汐 v${pkg.version}\r\n\r\n双击 Tide-Companion.exe 启动。保留整个文件夹，不要单独移动 exe。\r\n无需 Node.js、VS Code 或浏览器。完整说明见 README.md。\r\n\r\n初次打开确认 MTF / FTM 和模型体重，之后记住上次选择。\r\n左上角切换 MTF 粉色 / FTM 蓝色。\r\nMTF：E2 粉线 + CPA 紫线；FTM：T 蓝线，可展开 E2 粉线。\r\n按住鼠标右键拖动图中标线读取对应时间。\r\n记录时先选给药方式，再选药物；品牌为小字提示。\r\n\r\n长按头顶鱼鳍约半秒，看到提起动作后拖动；松手放下。双击身体打开手账。\r\n左下手账按钮点一下打开，再点一下收起。\r\n长按身体轻蹭、按住滑动抚摸；星星按钮查看余额。\r\n闲置后会自然睡醒，心情会改变陪伴风格。已有提醒计划时，实际用药在预定时刻前后2小时内可得星，无需先弹提醒，可稍后新增补记；已存记录或编辑不追发，同一次预定用药不重复奖励。普通按发星日每天最多2颗，间隔至少48小时按完整天计算、单次最多7颗。星星本机长期保存，无手动加星入口。可从手账拖1颗星星喂给鲨鱼换取1经验，最高10级。五种外观共享等级、经验和每天一次产星机会；2级起待机产1~3颗，随等级提高上限至10颗。\r\n全屏自动隐藏，操作图标闲置后隐藏。\r\n设置中的语言默认跟随系统；可切换英语、简体中文、繁體中文、日本語、한국어或西班牙语，重启后保留。可在设置改名、切换五款鲨鱼、减少动画。随机待机动作与手账同步，Live2D入口暂时隐藏。\r\n\r\n关闭管理面板仍留在托盘，彻底退出后提醒停止。\r\n数据继续保存在 %APPDATA%\\小浪桌宠，更新保留旧记录。\r\n\r\n参考浓度来自资料与简化模型，不是实时检测或治疗目标。\r\nCPA只估计药物本身，不推算对T的抑制。\r\n证据不足的药物支持记录但不输出虚构总浓度。\r\nEV舌下已支持参考模拟与化验幅度校准；模型和来源见 docs/MODELS-v4.md。\r\n`,'utf8');
  await writeFile(path.join(directory,'README.md'),(await readFile(path.join(root,'README.md'),'utf8')).replaceAll('dist/Tide-Companion-win32-x64/Tide-Companion.exe','Tide-Companion.exe'),'utf8');
  await mkdir(path.join(directory,'docs'),{recursive:true});
  for(const name of ['MODELS.md','MODELS-v2.md','MODELS-v3.md','MODELS-v4.md','GAHT-reference.md','LIVE2D.md','LIVE2D-runtime.md','pet-behavior.md'])
    await writeFile(path.join(directory,'docs',name),await readFile(path.join(root,'docs',name),'utf8'),'utf8');
}
console.log(output.join('\n'));
