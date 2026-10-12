# Live2D 本机皮肤

0.9.0 起暂时隐藏 Live2D 的导入、选择和缩放入口，同时停止模型及运行库加载。五种内置鲨鱼继续可用；旧模型文件、保存的皮肤 ID 和缩放值不被改写，原模型选择暂时显示为浅海蓝鲨鱼。下面保留历史使用及存储说明，当前版本不开放这些入口。

潮汐 0.2 支持为桌面伙伴导入 Cubism 3/4 的 `.model3.json` 模型。部分 Cubism 5 模型也可载入，但新渲染特性不保证兼容。默认伙伴叫「鲨鲨」，旧版本的自定义名字继续保留。内置鲨鱼始终可以切回。

## 导入与切换

1. 在本机解压模型，保留模型原有目录结构。导入选择器需要选择 `角色名.model3.json`，不是 `.moc3`、压缩包或网页。
2. 在「陪伴与设置」的皮肤管理中选择「导入 Live2D」。只会复制该模型明确引用的资源，不会复制所选文件夹内的其他文件。
3. 导入完成后选择该皮肤即可切换。缩放范围为 0.5–2 倍。
4. 删除皮肤只移除应用中的副本，原模型目录不变。删除当前皮肤会先切回内置鲨鲨。

模型须有可用的 `.moc3` 和至少一张 PNG、JPEG 或 WebP 纹理。支持物理、姿势、表情、动作、用户数据和显示信息 JSON；动作附带的声音不导入、不播放。模型二进制通过基础格式检查后仍可能因版本或数据不兼容而无法渲染；界面会提示并显示内置伙伴，健康记录和提醒不受影响。

可导入自己创作或具有使用授权的模型。模型作者的授权与署名条件仍然适用。应用所带运行库及其许可证位于 `assets/vendor/`；导入功能不会下载运行库、模型或其他远程资源。

## 本机保存与备份

应用继续使用 0.1 版的用户数据目录 `%APPDATA%\小浪桌宠`，默认名字改变不会移动或清空原记录。皮肤单独保存在：

```text
%APPDATA%\小浪桌宠\skins\<随机 UUID>\
    manifest.json
    角色名.model3.json
    角色.moc3
    textures\...
    motions\...
```

`manifest.json` 记录复制文件的相对路径、大小、类型与 SHA-256。皮肤数据不进入健康 JSON 备份；导入健康备份会保留本机当前皮肤与缩放，不会把备份中的路径用于读取本机文件。迁移旧版本时会额外保存 `state.before-v0.2-migration-*.json` 原始快照，之后的日常备份轮换不会覆盖它。

关闭陪伴面板后，托盘仍管理桌宠与提醒。Windows 前台窗口进入全屏时默认临时隐藏桌宠，退出全屏恢复用户原先的显示偏好；这不会暂停提醒，也不会改动记录。

## 导入边界

- 仅跟随 `FileReferences` 中的 Moc、Textures、Physics、Pose、UserData、DisplayInfo、Expressions 与 Motions；动作和表情中的 File 引用也会逐一检查。
- 不接受脚本、网页、WASM、SVG、可执行程序、音频、绝对路径、网络链接、目录穿越、符号链接或 Windows 目录联接。辅助 JSON 不能再扩展资源图。未知 `FileReferences` 类型会被拒绝。
- 允许最多 30 个皮肤；每个模型最多 512 个引用文件、64 张纹理、300 MB 总大小，单文件最多 64 MB，JSON 最多 4 MB。单张纹理边长不超过 16384，像素总量不超过 64 Mi。
- 只复制校验通过的引用文件。复制使用临时目录并在完成后一次登记；导入失败会清除应用内的临时副本，不改原文件。
- 模型通过 `tide-skin://<UUID>/<路径>` 提供给渲染器。协议只能读取独立清单内的文件，每次读取核对路径、普通文件状态与散列；不提供目录列表、健康数据或任意本机文件。
- 协议按静态数据处理，使用 `nosniff` 和资源类型；它不绕过 CSP。渲染器只能运行应用自带的本地运行库，用户模型不能提供脚本。应用内 HTTP、HTTPS、WebSocket 请求继续被阻断。
- 皮肤清单损坏或文件丢失时不删除证据，启动时回到内置伙伴。更改已导入资源后需重新导入；原清单的散列不会自动信任修改后的文件。

## 开发接口

`window.petAPI` 提供：

```js
await petAPI.listSkins();
// { activeSkin, skinScale, skins: [{ id, name, modelUrl, importedAt }] }
// 内置条目 id='builtin'、modelUrl=null。

await petAPI.importSkin();
// 系统文件选择器；取消返回 null，成功返回皮肤条目，不自动切换。

await petAPI.selectSkin(id, scale); // scale 可省略，返回更新后的 state。
await petAPI.removeSkin(id);       // 返回新的 listSkins 结果。
petAPI.onState(state => { /* activeSkin/skinScale 的变化 */ });
```

`saveState` 保护主进程当前的皮肤选择与缩放，避免其他操作携带的旧状态覆盖正在切换的皮肤。修改皮肤应调用 `selectSkin`。健康状态仍保持 `schemaVersion: 1`，新增字段采用兼容默认值；模式、群体参考基线与个人拟合基线分别保存。

`pet.html` 的 CSP 对 `connect-src` 和 `img-src` 放行 `tide-skin:`；运行库所需的 WebAssembly 编译使用 `'wasm-unsafe-eval'`，不需要普通脚本的 `'unsafe-eval'`。协议 URL 不接受查询参数或片段，因此不要附加缓存破坏参数。渲染器在状态切换后通过 `listSkins` 取得可信 `modelUrl`，不要直接拼接本机文件路径。

执行 `node --test tests/skins.test.js tests/reminders.test.js` 可检验资源白名单、路径边界、符号链接、完整性、重启、删除、旧数据迁移与提醒行为；这些测试不启动桌面 GUI。实际模型显示与全屏切换另由桌面端到端检查验证。
