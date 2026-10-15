# 技术参考分析与可行性结论

需求依据为用户的 PRD v1.0。检测报告共九页和上游代码只作为技术参考，未据此删减四类壁纸、全界面、多窗口或恢复等需求。

## 上游分析

固定参考版本为 CCDawn/Codex-Dynamic-Skin@5a0e74043b63ed9518ab37cdcf6865340a57006c。

| 参考代码 | 观察 | 本项目选择 |
| --- | --- | --- |
| windows/scripts/injector.mjs | CDP 目标过滤、分块媒体传输、窗口就绪处理 | 受限 CDP 与独立窗口管理；生产视频改为原始 File 直接解码 |
| runtime/renderer-inject.js | Blob 视频、可释放播放器、隐藏暂停 | 自写可移除背景运行时，保留旧画面至新画面可用 |
| tools/selectors.json / compat/profile.json | 版本化选择器 | 独立版本/结构双检查；仅精确实测版本标记 Verified |
| WallpaperEngineReferenceCatalog.cs | 文件引用及路径约束 | 不采用手动目录导入；当前来源由 WE 决定 |
| SceneStreamHost.cs | 独立 SceneViewer 与磁盘 mp4 流 | 未引入该侧车；直接读取现有 Scene 精确渲染面，避免资产/帧落盘 |
| Windows 管理脚本 | 托盘、打包、自启动和恢复 | 独立薄原生壳；不改官方文件、主题 schema 或登录数据 |

保留 MIT 选择器来源、Node 完整许可及 MinHook/BSD/HDE 许可。未引入 GPL SceneViewer 侧车。上游功能声明未替代实测证据。

## 报告与实机差异

报告的 Codex 包为 26.1007.2314.0；本机实测为 26.1007.9446.0。ChatGPT.exe 的 155.0.8059.40 是运行时版本，分别记录，不混作产品版本。

官方主题 schema 不提供本产品所需的视频背景。实际 Codex 的媒体 CSP 也拒绝普通本地 HTTP 视频。本实现不改 CSP：CDP 只绑定自有离屏 file input，File-backed Blob 由原生媒体栈直接解码。已验证文件选择事件不会进入 Codex 文档。

早期 WE CLI 空输出来自控制台传输方式；ConPTY 后已能查询权威当前来源。仍保留指定用户/显示器配置后备和 30 秒重试退避，不扫描壁纸库。

桌面子窗口 WGC/PrintWindow 的失败保留为真实实验，未据此捕获整个桌面。Scene 采用精确 HWND 的 D3D11 共享内存，补齐 FP16 转 SDR 后实际样本通过。Web 使用私有静音浏览器；Application 使用 WE 管理的现有窗口。四类型在双真实 Codex 窗口中均已自动切换并显示动态画面。

## 关键决策

| ID | 决策 |
| --- | --- |
| D-01 | ConPTY 当前来源；选中配置后备；当前项目事件唤醒加 3 秒轮询，发现进程 5 秒 |
| D-02 | 四类型生产路径和限制见 NON_VIDEO_PROTOTYPE.md；不把元数据或静态图当动态支持 |
| D-03 | 自有 CSS/canvas 覆盖侧栏、主区、输入区；退出移除，崩溃租约自动清理 |
| D-04 | 默认 Monitor0，所有窗口共用单一来源；不做独立壁纸库 |
| D-05 | Windows 11 x64 build 26200、Codex 26.1007.9446.0、WE 2.8.0.42 为当前实测组合 |
| D-06 | 不透明度 60%、亮度 100%，平衡模式 60 FPS；视频保持原文件/原尺寸；实际测量见 ACCEPTANCE.md |
| D-07 | Ed25519 + HTTPS 同源 + SHA-256；激活/健康检查/失败回滚已接通；公开发行源由所有者决定 |
| D-08 | 全部普通功能 asInvoker，不提权；没有需 UAC 的高级操作 |
| D-09 | 首次背景/自启关闭，中文设置，居中 Cover，原生 Windows 标题栏不属于内部画布 |
| D-10 | .NET Framework 薄壳 + 随包 Node；完整源码/构建脚本保留，未公开发布 |

项目级兼容性与应用级兼容性分别判断。未测 HDR、任意 Unity/多进程应用和依赖特殊 WE API 的 Web 项目不能宣称通用支持。完整验收的剩余条件见 REQUIREMENTS.md 和 ACCEPTANCE.md。

参考：[上游固定版本](https://github.com/CCDawn/Codex-Dynamic-Skin/tree/5a0e74043b63ed9518ab37cdcf6865340a57006c)、[WE CLI](https://help.wallpaperengine.io/en/functionality/cli.html)、[WGC HWND](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)。
