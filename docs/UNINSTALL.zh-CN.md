# 卸载 Codex Wallpaper Bridge

安装版可以从 Windows“设置 → 应用 → 安装的应用”卸载，也可以使用开始菜单中的“卸载 Codex Wallpaper Bridge”，或运行安装目录内的 `Uninstall.exe`。此外，发行目录提供单独的 `CodexWallpaperBridge-Uninstall-版本号.exe`，用于卸载当前用户的安装版，无需重新下载安装包。

便携版请运行该便携目录内的 `Uninstall.exe`。它只处理当前便携目录；目录身份标记或文件清单缺失时会拒绝删除。旧版便携包没有这些卸载元数据时，请先使用新版安装包或保留目录手动处理，不能用单独发布的卸载工具替代便携入口。

卸载会先请求选中的 Bridge 正常退出，使它完成外观恢复，然后只删除 Bridge 身份标记和安装清单确认的产品文件。确认归属于 Bridge 的历史安装副本也按各自清单清理。空目录会被移除，目录内的用户新增文件保留。卸载不会关闭官方 Codex 或 Wallpaper Engine，也不会删除原始壁纸。

偏好设置、登录资料、日志和更新恢复记录保留在原数据目录中，重新安装后可继续使用。卸载过程中发现被占用、只读、重定向或异常清单时会停止；解除占用或修复安装后可以再次运行，失败时仍保留卸载清单和 Windows 卸载注册信息。

包内卸载程序会启动临时副本，以便删除正在使用的卸载入口。临时副本结束后自动清理自身。静默调用使用 `--silent`；包内入口会异步交给临时副本执行，调用者需要等待文件清理完成。

隔离验证脚本为 `powershell.exe -NoProfile -File scripts\uninstall-smoke.ps1`。它通过仅测试编译条件把安装路径、数据路径、注册表和快捷方式全部重定向到带身份标记的工作区 fixture，并跳过真实 Bridge 的退出信号。测试不会卸载用户当前安装或结束运行中的软件。结果写入 `.local-evidence/BridgeUninstallFixture-*/result.json`。

生产包验证使用 `powershell.exe -NoProfile -File scripts\package-uninstall-smoke.ps1`：先用真实更新解压助手展开当前发行 ZIP，再运行其中的真实卸载器。独立发行卸载器只通过显式 `--portable-root` 选择唯一测试目录，验证被占用保护、运行中自删、临时文件清理及用户文件保留。该脚本不会使用默认安装版卸载路径，证据写入 `.local-evidence/PackageUninstallFixture-*/result.json`。
