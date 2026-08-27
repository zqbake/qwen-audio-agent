# Desktop 原生输入验证

本文严格区分“自动化原生输入证据”和“已安装 App 的真实交互结论”。原生
输入属于 Qwen Audio Agent Desktop，但安装 InputMethodKit bundle 会改变
macOS 输入源状态；未经机器所有者明确授权，不得执行人工矩阵。

## 当前状态

- Phase 0 自动化基础能力：已实现并在本机验证。
- Desktop 生命周期与 IME→Bridge→Gateway 自动化链：已使用注入式文件系统/
  输入源适配器、fake transcript 和真实 ad-hoc 签名 IME/Bridge peer 往返验证。
- 隐藏 palette 的用户级安装/修复、注册、启用、选择、校验和失败回滚：自动化
  已覆盖。当前 macOS 26.5.1 arm64 真机上，per-user Debug/ad-hoc 与 Apple
  Development 签名探针均显示 register/enable 返回成功但状态仍 disabled，select
  返回 `paramErr`（`-50`）；事务已回滚且普通键盘 source 不变。历史系统级复制
  曾触发 macOS `SecurityAgent` 并在输入凭据前取消、清理；该路径现已延后。下一步
  唯一阻断门禁是下文 Developer ID/公证产物的 per-user release probe。
- 跨应用 InputMethodKit 真实交互：已用 fake transcript 验证 TextEdit 与
  Safari textarea/contenteditable/password；Terminal 和更广应用矩阵仍未完成。
- 物理麦克风与 TCC 授权链路：未运行。
- 基于 Accessibility 的可选 Voice Send：未实现、未授权。
- Developer ID 签名、公证与 Release Gatekeeper：未运行。

当前下一阻断项是下文可重复的 per-user Release Gate 0。正式签名路径未由一手
证据否定前，系统级探针保持延后，不得用它跳过 Gate 0。

已安装路径通过仍不等于发布验收。物理麦克风、真实 provider、Terminal、更广
目标应用、Developer ID 签名和公证仍是后续门禁。自动化生命周期测试不会复制、
注册、启用或选择输入源。

Qwen Input 是 `ComponentInvisibleInSystemUI` palette。用户明确确认安装/修复后，
Desktop 仅使用公开 TIS API 一次性注册、启用、选择并校验该 palette。它不显示在
普通输入菜单中，并与当前键盘输入源并存；会话只读检查 palette 就绪状态，绝不
选择或恢复 ABC、拼音等普通键盘布局。

## Phase 0 自动化门禁

在 macOS 仓库根目录运行：

```sh
npm run native-input:test
node --test desktop/test/native-input-*.test.mjs
npm test
npm run lint
npm run build
npm run test:desktop-smoke
git diff --check
```

原生测试覆盖：

- 协议版本、序号、代次、目标、重放和 64 KiB 上限；
- UTF-16 自有 marked/final 范围，包括 emoji 和组合字符；
- 替换/删除只能作用于最近一次本会话已确认文本；
- Secure Event Input 与可见状态门禁的 fail-closed 行为；
- InputMethodKit 客户端调用，以及物理按键不被吞掉；
- 精确进程身份、同用户检查、0700 运行目录和 0600 Unix socket；
- 隐藏 palette 只读就绪门禁，且会话级普通键盘零变更；
- Desktop 持有 Bridge、环境变量白名单、紧急停止和有界退出；
- 用真实构建出的 Bridge 进程验证 fake partial/final/pause/resume/cancel、
  畸形帧拒绝、EOF 清理和零运行文件残留。
- status/install/repair/uninstall 请求关联，symlink/owner/签名/版本拒绝，原子替换
  回滚，公开 TIS register/enable/select/verify 顺序，以及卸载时只对 Qwen 先
  disable 再移到废纸篓；
- 真实签名 IME peer 注册目标、轮询一次相关 operation、通过 Bridge 返回结果并清理
  临时 socket；renderer 测试覆盖 ownership/suspend、空草稿 Gateway 启动、终态迟到
  消息拒绝与原生失败取消。

打包门禁还要求：

```sh
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

两个原生产物都必须同时包含 `arm64` 与 `x86_64`。本地构建使用 ad-hoc
签名，只能证明构建和完整性，不能代替正式签名、公证与 Gatekeeper 验收。

## 阻断性的 per-user Release Gate 0

只在干净 macOS **标准用户**测试账户执行；完成发行的 Qwen Audio Agent App
须已复制到 `/Applications`。App、Bridge 与内嵌输入法必须来自同一个
Developer ID Application 身份并启用 hardened runtime；App 必须有有效 stapled
公证票据且通过 Gatekeeper。ad-hoc 和 Apple Development 签名会在任何系统状态
变化前被拒绝。

探针不接受 provider key，也不提供非交互批准参数：

```sh
git rev-parse HEAD
npm ci
npm --silent run native-input:gate0:release -- \
  --app "/Applications/Qwen Audio Agent.app"
```

唯一交互提示会说明 macOS 可能把输入法同意作为首次 setup 的系统门禁。只有准备
好由本人处理 macOS 自有弹窗时才输入 `RUN`。探针绝不自动点击弹窗，不调用私有
TIS、Accessibility、CGEvent 或 AppleScript，不申请 TCC，也不读取 provider 凭据。

该命令是一个失败关闭的单一阶段机：

1. 校验 macOS、交互式标准用户、精确 Developer ID 身份、hardened runtime、
   深度签名、公证 staple 与 Gatekeeper；
2. 记录干净基线：用户/系统 Qwen bundle、Qwen TIS source、Qwen 进程/socket、
   TextEdit 运行实例均为零，并保存普通键盘 source ID；
3. 通过发行 Bridge lifecycle 只把内嵌输入法复制到
   `~/Library/Input Methods`，再用公开 TIS 执行
   `register → enable → select`；
4. 由 fresh 公共 TIS 进程要求 hidden palette 恰好一个且
   `enabled=true / selected=true`，普通键盘 ID 必须逐字不变；
5. 在真实 TextEdit 打开一个探针自有纯文本文档，等待真实 IMK target，通过
   Bridge 发送固定、非敏感 fake partial/final，并要求最终文档字节精确等于固定
   final 文本；
6. 任一已变更阶段之后都进入 `finally` 清理：取消会话、只 disable Qwen、卸载
   用户 bundle、必要时恢复基线键盘、只停止 Qwen/探针进程、只删除本轮新增 Qwen
   废纸篓项及经验证的 runtime/temp 路径，最后用 fresh 进程完整复核基线。

输出是逐行 JSON，只含固定 `stage`、`status`、`reason` 码；不会输出工具 stderr、
路径、签名主体、fake 文本、环境或协议内容。清理不完整永远以
`cleanup_incomplete` 作为最终失败；系统状态开始变化后收到 `SIGINT`/`SIGTERM`
也会进入同一受限清理路径。

Gate 0 只有在发行校验、hidden-palette fresh 状态、普通键盘不变量、真实 TextEdit
partial/final 与最终清理在同一次执行中全部通过时才通过。本地 Debug/ad-hoc 或
Apple Development 结果永远不能替代它。若通过，立即停止，不需要特权/系统级
lifecycle；若失败，只保留固定阶段码与清理证据，正式失败未经复核前不得引入 root
helper。

## 延后的跨机系统级 hidden-palette 探针

这是可回滚的 OS 可行性探针，不是 Desktop 的 Install/Repair 事务；当前产品
生命周期仍安装到 `~/Library/Input Methods`。必须使用没有既有 Qwen input
source、系统级/用户级 Qwen bundle 的测试账户或机器，否则无法证明只清理本轮
状态。

本节仅保留为历史恢复证据。**在上述 per-user Release Gate 0 使用 Developer ID、
公证构建得到一手失败并完成复核前，不得执行。** 本节不授权加入 `SMAppService`、
root helper、密码处理或自动化授权。

从用户 fork 的独立交付分支 checkout，并在完全不注入 provider key 的情况下
构建：

```sh
git clone --branch zq-77-cross-machine-test-20260826 --single-branch \
  https://github.com/zqbake/qwen-audio-agent.git qwen-audio-agent-zq77
cd qwen-audio-agent-zq77
git rev-parse HEAD
npm ci
npm run native-input:test
npm test
npm run lint
npm run build
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

逐阶段可直接复制的基线记录、Qwen 零既有状态断言、公开 TIS
`register → enable → select → fresh verify` Swift 命令、普通键盘恢复与清理
断言，以配套英文文档
`docs/desktop/native-input-testing.md#cross-machine-system-level-palette-probe`
为唯一可执行源，避免两套长脚本漂移。执行时按以下顺序，不得跳步：

1. 在同一 shell 保存 `BASELINE_KEYBOARD`、系统 bundle 路径和当前用户
   `qwen-ni-<uid>` runtime 路径；断言两处 Qwen bundle 不存在且 Qwen TIS
   count=0。
2. 运行文档中的 `open -R "$BUILT_QWEN_BUNDLE"` 与
   `open '/Library/Input Methods'`。只复制已完成 codesign 校验的
   `Qwen Input.app`；管理员密码只由用户本人在 `SecurityAgent` 中输入，
   不得进入 Terminal、history、文件或自动化。
3. 若出现麦克风、Accessibility、Input Monitoring、Full Disk Access 或任何
   非该单文件复制的权限提示，立即停止并进入回滚。
4. 确认系统 bundle 存在且签名仍有效后，分别启动四个 fresh Swift 进程执行
   register、enable、select、verify。三个 mutation 返回值必须都是 `0`；
   最终必须是 `count=1 / enabled=true / selected=true`，且普通键盘逐字等于
   `BASELINE_KEYBOARD`。
5. 本轮到此为止，不进入 TextEdit/Safari、Accessibility、麦克风或 live
   provider。
6. 无论成功失败都执行英文文档的 rollback：只 disable Qwen；在 Finder 中只把
   系统级 Qwen bundle 移到废纸篓并由用户本人再次认证；只永久删除该测试 bundle，
   不清空整个废纸篓；恢复基线普通键盘，停止 Qwen/Bridge，校验属主与 0700 mode
   后删除当前用户 runtime 目录。
7. 最终 fresh 断言必须同时满足：普通键盘与基线逐字相同、Qwen TIS count=0、
   两处 bundle 不存在、runtime 不存在、Qwen/Bridge 进程不存在。

## 授权边界

人工验证前必须逐项取得明确授权：

1. 把版本匹配的 bundle 复制到 `~/Library/Input Methods`；
2. 允许明确的安装/修复动作通过公开 TIS API 注册、启用并选择隐藏 Qwen palette；
3. 若 macOS 弹出输入法安全提示，在最终 Allow 前停下并取得动作时确认；
4. 启动打包后的 Desktop 并请求麦克风权限；
5. 若另行测试 Voice Send，再单独请求 Accessibility 权限。

基础听写不得申请 Accessibility、Input Monitoring、Full Disk Access 或
管理员权限。人工测试只使用非敏感测试文本。

## 已安装 App 人工矩阵

下表结果来自 macOS 26.5.1 arm64、版本 1.11.0 Debug/ad-hoc 产物和非敏感
fake transcript。正式签名与未列为通过的场景仍未验证。

| 范围 | 场景与预期 | 状态 |
| --- | --- | --- |
| 安装 | 用户级安装拒绝符号链接、错误属主/签名，且不弹管理员密码 | 通过（Debug/ad-hoc） |
| 隐藏 palette | 明确安装/修复后 registered + enabled + selected，普通键盘 source ID 不变 | 阻塞：per-user 本地签名保持 disabled；需系统级或发布签名门禁 |
| TextEdit / Notes | partial 有 marked 样式，final 落在光标处，物理打字不被吞 | TextEdit 通过 |
| Safari textarea | partial/final/edit 始终锁定同一目标 | 通过 |
| Safari contenteditable | UTF-16 范围和光标移动行为确定 | 通过 |
| Safari 密码框 | secure 字段拒绝启动，零写入、零采集 | 通过 |
| Terminal | 普通提示符可插入，键盘输入始终可用 | 未运行 |
| Terminal 安全输入 | Secure Keyboard Entry 立即阻止或终止会话 | 未运行 |
| VS Code / Monaco | marked/final 兼容；不兼容时可见失败且不写错目标 | 未运行 |
| Mail / Messages | 保留原草稿和选区 | 未运行 |
| 自绘控件 | 未知/不支持控件 fail closed | 未运行 |
| 焦点切换 | 目标代次改变，移除 partial，不向新焦点写入 | 通过 |
| 键盘/鼠标打断 | 自有 partial 确定性结算或移除，并暂停采集 | 未运行 |
| 键盘输入源 | 安装和会话期间 ABC/拼音等普通键盘选择始终不变 | 生命周期变更后未运行 |
| Bridge/Desktop 崩溃 | 停止采集、移除 partial、无孤儿进程/socket，替代 Bridge 可重连 | Bridge SIGTERM 通过 |
| 麦克风拒绝/撤权 | 可见失败，provider 音频、conversation、Memory 均零副作用 | 未运行 |
| 网络/provider 失败 | 回到普通键盘，不回退主 Realtime | 未运行 |
| continuous/pause/cancel | 暂停期间上行字节为 0，取消无未提交副作用 | 未运行 |
| Memory 纠正 | 只做精确、非敏感事实替换，审计仅含元数据 | 未运行 |
| 更新/回滚 | 活跃会话先 drain、普通键盘由用户持有、版本匹配、只回滚 Qwen | 自动化事务通过；发布更新未运行 |
| 禁用/卸载 | 禁用输入源、bundle 移入废纸篓、清除运行产物 | Debug/ad-hoc 生命周期通过 |
| 孤立修复 | 无合格 Desktop/Bridge 时输入法惰性失效，且可修复 | 未运行 |
| 架构 | arm64 与 x86_64/Rosetta 均验证 | universal 二进制通过；仅 arm64 运行时通过 |

## 清理证据

获批执行后，要确认隐藏 Qwen palette 已禁用并移除、普通键盘 source ID 不变、Bridge 与
Desktop 测试进程均退出、运行 socket 不存在，并删除测试安装、profile 和
音频。对仓库、运行目录和测试日志只做凭据模式扫描，不得打印凭据值。
