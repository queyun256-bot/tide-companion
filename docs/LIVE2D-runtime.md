# Live2D 本地运行时

0.9.1 的 `src/skin-features.js` 延续 0.9.0 的设置，将 Live2D 功能暂时关闭。渲染和模型存储实现保留，但不加载运行库或渲染模型；旧选择暂时显示内置鲨鱼。本文以下说明保留运行时的来源与历史实现，当前产品入口隐藏。

**Git 仓库不包含专有的 `assets/vendor/live2dcubismcore.min.js`，也不包含 `tests/fixtures/` 下的 Haru 模型。** 这两类文件已被忽略，开发机原有文件不会被删除。0.9.1 使用内置鲨鱼，正常启动、开发和常规 `npm test` 均无需 Core 或 Haru。许可文件与 `SHA256.json` 中的版本散列保留作为历史来源记录，不表示仓库提供对应的专有运行库。

历史渲染实现使用真实 Cubism 模型，不把模型转换为静态图片；它只加载本地运行库，不从 CDN 加载脚本，也不上传用户模型。如需研究或恢复此实现，应先从 [Live2D 官方](https://docs.live2d.com/en/cubism-sdk-manual/cubism-core/) 单独取得 Core、确认适用许可，再将文件放入上述本地路径。模型目录须保留 `.model3.json` 引用的 `.moc3`、纹理、动作、表情和物理文件；当前版本没有模型导入界面。

## 固定组件及出处

| 文件 | 组件 | 来源与许可 |
| --- | --- | --- |
| `assets/vendor/pixi.min.js` | PixiJS 6.5.10 | [PixiJS](https://github.com/pixijs/pixijs)，MIT |
| `assets/vendor/pixi-csp.min.js` | @pixi/unsafe-eval 6.5.10 | PixiJS 官方 CSP 兼容实现，MIT；名称虽含 unsafe-eval，但作用是使用静态实现以避免动态生成代码 |
| `assets/vendor/cubism4.min.js` | pixi-live2d-display 0.4.0 | [项目源码](https://github.com/guansss/pixi-live2d-display)，MIT；内部 Cubism Framework 同时适用 Live2D Open Software License |
| `assets/vendor/live2dcubismcore.min.js`（不随 Git 分发） | Cubism Core 官方 05 分支（5.2） | [官方固定资源地址](https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js)，Live2D Proprietary Software License；须单独取得 |

下载日期：2026-10-12（用户时区 Asia/Shanghai）。原始版权声明保留，许可文本保存在 `assets/vendor/`。第三方文件适用各自许可，不适用项目源码许可证。

当前用于本机开发和验证。Live2D [SDK 授权说明](https://www.live2d.com/en/sdk/license/) 允许先行开发验证；可导入任意用户模型的软件属于其许可定义中的 Expandable Application。**公开分享、发布或分发含 Core 的应用前，需要确认并取得适用的 Live2D 出版授权；不能将个人/小规模企业的一般豁免自动用于这种应用。** 参见 [Proprietary Agreement 1.5、2、5 节](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。本地保存 Core 不表示获得无限制分发许可。

## 支持范围

- `.model3.json` 的 Cubism 3/4 兼容资源；部分 Cubism 5 模型可由当前 Core 读取，但插件不保证支持 Cubism 5 新增渲染效果。Cubism 2 `.model.json` 不支持。
- 模型自身包含的 Idle、触摸动作与表情；缺少某类动作时回退到模型已有动作，不伪造模型的绑定参数。
- 鼠标注视、30 FPS 更新、缩放与热切换。打盹或减少动画时暂停更新；窗口不可见时暂停更新。
- 运行失败、资源缺失和显卡上下文丢失时退回内置鲨鱼，不影响用药提醒或记录。
- 不播放模型声音，不允许模型导入脚本、网页、WASM 或远程引用。资源由主进程 `tide-skin:` 白名单协议提供。
- CSP 只为 Core 的内嵌 WebAssembly 开启 `wasm-unsafe-eval`，不允许普通 `unsafe-eval`。模型内容不能改变 CSP。

## 验证模型

`tests/fixtures/Haru/Haru.model3.json` 及引用资源在本机验证时取自 [Live2D 官方 CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop/Samples/Resources/Haru)，仅用于隔离测试，不随 Git 上传、不自动放进用户皮肤库，也不打包进发行版。该样例的版权归 Live2D，适用 [Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) 与 [sample model terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)。

运行专项测试前，须自行从上述官方来源取得有权使用的 Haru 素材，完整放入 `tests/fixtures/Haru/`，并保留官方 `LICENSE.md` 和所有被模型引用的文件；不要将这些素材加入 Git。当前专项测试只验证关闭 Live2D 后的导入存储与回退行为，不需要加载 Core。

官方样例与测试截图版权说明：This content uses sample data owned and copyrighted by Live2D Inc.

运行 `node tests/live2d-renderer-smoke.mjs` 验证隐藏入口、停止运行库加载、旧模型选择与文件保留，以及切换内置鲨鱼。测试使用临时 userData，用户健康记录保持隔离。
