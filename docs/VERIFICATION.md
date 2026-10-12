# 验证记录

日期：2026-10-11；环境：Windows x64、Node.js 24.19.0、Electron 44.7.0。

- `node --test tests/*.test.js`：34 项通过。覆盖数值解析边界、单位转换、个人幅度拟合、模型/历史变更失效、混途径拒绝、提醒恢复/去重、状态导入校验、原子写入与恢复、保存失败提示及快捷方式配置。
- `node tests/desktop-smoke.mjs`：通过。在临时隔离目录启动真实 Electron 双窗口，操作计划/实际使用/化验/模型表单，验证贴片字段、个人校准、混途径提示、演示数据隔离、本机落盘、互动事件和关闭后留在托盘。
- `node scripts/package.mjs`：Windows x64 可执行程序打包成功。
- `node tests/package-smoke.mjs`：打包产物启动通过，主面板与透明桌宠均存在，开始菜单快捷方式指向正式 exe，AppUserModelId 为 `org.transpet.desktop`。
- 已查看仪表板与透明小鲨鱼截图；截图保存在 `screenshots/`。没有向正式个人数据写入任何合成用药或化验记录。

验证不包含临床有效性、真实血药预测精度或长期提醒运行可靠性。系统通知提交已验证，最终横幅仍由 Windows 通知权限、勿扰模式等系统设置决定。
