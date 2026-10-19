# 0.3.0 本机自用范围收尾

2026-10-19，Asia/Shanghai。按用户《收尾执行说明》执行。本机自用范围接受，`localScopeAccepted:true`，`fullPrdAccepted:false`。当前没有未关闭的必需运行风险。未公开发布、未正式安装到用户环境、未提交或推送 Git。

## 修改与验证

只调整三个运行模块：`coordinator.mjs` 在素材/播放失败及空选择时撤销 Bridge 外观；设置保存按调用顺序串行，所有待保存请求完成前不运行 tick；停止时先恢复界面，再清理全部自有后端，清理失败明确报告。`isolated-player.mjs` 检测已退出的宿主并进入失败恢复，停止超时保留 worker、pipe 和 runtime。`independent-application.mjs` 不再把终止等待超时当成成功，保留待退出 worker 与 session/runtime，确认停止后才删除资源，后续停止可重试。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 素材缺失/无法加载 | 通过；实际移走自绘素材后恢复 Codex | 实窗报告 `missing-material` |
| 播放端启动失败 | 通过；隔离宿主不存在，恢复 Codex并删除私有 runtime | `player-start-failure` |
| 播放端异常退出 | 通过；终止本次创建的宿主，生产捕获路径报告失败并恢复 | `player-crash` |
| 主动停止/退出、重新启用 | 通过；五场景均校验Bridge节点/runtime撤销、原样式恢复、输入标记插入并清空；可再次启用 | `user-stop`、`bridge-exit`及复启记录 |
| PID 被复用后可能误杀 | 已排除；实例锁只调用 `process.kill(pid, 0)` 查询，不据此终止或清理进程。存活陈旧PID会保守拒绝第二实例。native清理使用持有的句柄/Job及身份校验 | `tests/closeout.test.mjs` 的PID复用夹具、`src/main.mjs` acquire及保留的历史身份审计 |
| 停止超时后过早删资源 | 确认并修复；两类宿主超时均报错并保留资源/身份，确认退出后重试才能清理；协调器先恢复外观且尝试其余后端 | 新不可终止worker、停止重试与多后端清理测试 |
| 保存/重载/监听竞争 | 确认并修复重叠保存；最新请求最后落盘，待保存期间保持guard；旧代次/旧观察器不能提交或复活来源 | 新串行保存测试；既有A/B/C、Restore竞态、旧watcher/扫描及文档生命周期测试 |

最终源码 **186/186测试通过**，无取消/跳过；JavaScript语法通过。日志：`.local-evidence/closeout-20261019/all-tests-final.log`、`syntax-final.log`。实窗报告：`.local-evidence/closeout-ui-3253e4267cc7977f/result.json`，同目录保存启用前、有效彩色来源和各恢复截图；已查看截图，恢复后无残留黑屏/透明空洞。输入检查只作用于新建测试窗口的新聊天输入框，不发消息、不开既有会话。新浏览器profile仍会显示应用加载的全局项目/会话侧栏，截图仅保存在私有证据目录，不打包。

实窗环境：Codex26.1013.4894.0 / WE2.8.0.42、单物理显示器。原Codex/WE进程保留，用户设置逐字节不变、桌面选择/音量/参数不变，测试worker/runtime全部回收。未修改系统偏好、未正式安装或持久调整环境。首轮 `.local-evidence/closeout-ui-5a7d997624867ff3/result.json` 的隐藏渐变初始化断言失败保留；后续仍检查全部原style属性及可见表面样式，忽略opacity=0的不可见颜色计算。中间补验保留，最终补验增加非黑有效来源门槛。

## 产物与历史保护

当前源码在工作区；更新产物位于 `dist/CodexWallpaperBridge-0.3.0-source.zip`、`dist/CodexWallpaperBridge-0.3.0-win-x64.zip`，可运行目录 `dist/app-0.3.0`。安装包/卸载程序保留，各归档/程序附SHA256文件。最终内容清单/哈希、源码包构建、隔离卸载和工作区变更清单见 `.local-evidence/closeout-20261019/final-validation.json` 及引用报告。

八个native产物及其源码未改变，打包前核对SHA后复用历史已验构建。本次JavaScript由新测试/语法/实窗验证，不沿用旧耐久报告证明新源码。旧0.3.0包/校验文件保存于 `dist/candidates/0.3.0-before-closeout-20261019`；`.local-evidence/final-validation-0.3.0.json`不改写。原有未提交状态/哈希/tracked补丁在 `.local-evidence/closeout-20261019/*before*`；本次涉及的原untracked源文件已与保留旧源码包核对逐字节匹配。0.2.4和全部历史失败/验证记录保留。

## 未完成部分及处理

**本次必需收尾没有未关闭阻塞项。** 下列不再列为本次待办，也不宣称通过：

| 未完成或未验证内容 | 当前处理 |
| --- | --- |
| 多物理显示器、跨屏DPI、热插拔 | 用户已取消专项验收；仅接受当前单屏效果 |
| 全天耐久、长期零泄漏 | 已移出门槛；历史约62分钟记录不外推新源码或全天 |
| 冻结最后帧、保持旧壁纸、复杂错误覆盖层 | 已移出范围；失败恢复Codex原貌 |
| 完整Codex输入到后端回传、键盘/拖拽/修饰键及原PRD其他扩展 | 后续功能范围；现有受限鼠标能力保留，完整PRD不标完成 |
| 更多Application/WE/Codex版本、任意GPU/项目/文件系统兼容 | 未验证；Application限审核Sheep；Scene跨卷受可写父目录/硬链接能力限制 |
| 全部作者参数/接口、系统文件选择器、已有对话全部视觉布局 | 尚未全面验证；定向证据不扩展为全面证明 |

**可选发布事项单独保留：** 正式安装/日常启动配置、Git提交/标签/推送、公开Release、Windows代码签名/公共更新托管、干净账号/其他机器安装，以及未来升级功能和测试绑定 `dist/app-0.3.0` 路径的改进。用户本次明确不执行，均不阻塞本机交付。

参考材料提及的“当前工作总结”原截图未随本次提供；已直接核对最终JSON、引用证据和源码，不补写未见截图内容。
