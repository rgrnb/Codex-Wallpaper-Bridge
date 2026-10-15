# Codex Wallpaper Bridge

按用户提供的 **PRD v1.0** 实现的 Windows 应用。检测报告与 [Codex-Dynamic-Skin](https://github.com/CCDawn/Codex-Dynamic-Skin/tree/5a0e74043b63ed9518ab37cdcf6865340a57006c) 仅用于技术参考。

**0.1.0 为当前 Windows 适配验证版。** Video、Scene、Web、Application 均已在双真实 Codex 窗口中自动切换并显示动态画面。托盘、独立设置、四种效果、三种性能模式、恢复、诊断、安装卸载和签名更新均已接通。验证范围与剩余条件见 [验收记录](docs/ACCEPTANCE.md) 和 [逐项需求](docs/REQUIREMENTS.md)，不宣称支持任意版本或任意壁纸项目。

安装、首次连接和日常设置请看 [中文使用说明](docs/USER_GUIDE.zh-CN.md)。

## 构建

需要 Windows x64、Node.js 22.15+、.NET Framework 4.8 编译器、系统 WinMetadata，以及 PATH 中可用的 MinGW-w64 GCC（支持 C11）。不需要 .NET SDK；运行安装包不需要开发环境。Web 后端需要已安装 Microsoft Edge；Video 使用 Codex 自身媒体解码器。

~~~powershell
npm test
npm run check
npm run build
.\build\CodexWallpaperBridge.exe
powershell.exe -NoProfile -File scripts/build.ps1 -Package
~~~

生成 dist 下的 Setup EXE、便携 ZIP 和各自的 SHA-256。安装器面向当前用户，提供开始菜单、可选桌面快捷方式、可选启动项和卸载入口。背景和 Windows 自启动默认关闭。开发包尚无发行者代码签名。

## 使用

1. 在 Wallpaper Engine 选择壁纸。Bridge 自动跟随一个来源显示器，默认 Monitor0；所有 Codex 窗口共用来源。
2. 启动 Bridge，通过独立设置面板查看应用与当前项目状态。
3. 若 Codex 尚无连接端口，点击“以连接模式启动 Codex”，打开独立配置的官方 Codex。原有窗口可以保留；首次可能需要正常登录。Bridge 不复制登录资料、不替换官方文件。连接模式的 Codex 在 Bridge 退出后继续运行。
4. 适配规则须通过版本和结构检查。开发验证可以明确启用候选适配器；未验收版本不会自动标记为兼容。
5. 保存效果、性能和启用状态。关闭设置后继续驻留托盘；“恢复官方外观”或“退出并恢复”移除自有背景层。

默认壁纸不透明度为 **60%**，亮度为 **100%**，平衡模式上限 **60 FPS**。Video 将原始文件交给 Codex 的原生媒体栈直接解码，保留原始分辨率和编码品质，按新视频帧绘制；不转码、不保存副本，也没有旧整文件传输的 256 MiB 上限。多个窗口不会仅因数量增加就自动降帧。

Web 在隔离静音浏览器中运行，项目脚本不进入 Codex；不支持的 WE 专属接口会明确回退。Application 只采集当前 WE 启动且与所选 EXE 一致的已有窗口。Scene 已验证 WE 2.8.0.42 的精确 D3D11 窗口及 FP16 转 SDR；HDR、其他图形接口和任意 Unity/多进程项目仍需单独验证。非视频图像后端保留原有模式预算和 JPEG 品质，本次优化没有降低它们的画质参数。

## 恢复、数据与更新

设置、轮转日志、诊断与更新记录在 %LOCALAPPDATA%/CodexWallpaperBridge。MSIX 环境可能重定向到物理 LocalCache；原子写入前会解析真实目录。诊断仅包含运行元数据，不导出聊天、登录资料、API key 或工作文件。卸载保留偏好、日志和安装目录内的用户新增文件。

适配只添加自有 CSS/canvas。正常退出立即移除；控制器崩溃后页面租约约 15 秒自动清理。没有官方文件备份回写，不会用旧文件覆盖 Codex 更新。

更新设置支持配置 HTTPS 发布源和 Ed25519 公钥。自动检查、通知、确认后下载、验签/摘要校验、激活、重启、健康检查和失败回滚均已接通。更新不读取或复制安装目录内的用户新增文件；原目录作为恢复副本保留。默认没有公共发布服务，公开发布与信任密钥由所有者决定。

## 验证与文档

~~~powershell
npm run probe
npm run test:service
npm run test:shared-video
npm run test:web
npm run test:application
npm run test:graphics
~~~

实机脚本会启动受控测试程序，详见 [开发文档](docs/DEVELOPMENT.md)。安装更新测试拒绝覆盖已有安装或偏好。原桌面子窗口 WGC 实验的失败仍保留，不能报告为通过。

另见 [架构](docs/ARCHITECTURE.md)、[技术分析](docs/FEASIBILITY.md)、[非视频接入](docs/NON_VIDEO_PROTOTYPE.md)、[第三方许可](THIRD_PARTY_NOTICES.md)。完整源码保留在工作区，未公开发布。
