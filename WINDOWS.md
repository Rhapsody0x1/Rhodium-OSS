这篇回答：Windows 预览如何运行无头 agent 和自建 agent 终端，哪些行为已由原生测试验证。

前置阅读：[架构 §4、§5、§10](docs/architecture.md)、[托管进程的职责](docs/adr/0003-holder-in-rust.md)。

## 可行性

建议先打通无界面的独立托管进程。控制面和真实 CLI 以同一 Windows 用户运行。更新控制面时，托管进程继续收集输出；新版依靠现有 hold/1 协议补读并核对输入。SQLite、IM 和驱动协议可以复用。先用假 agent 验证进程和协议，再用真实登录验收。

| 现有依赖 | Windows 上的处理 | 粗估人日 |
|---|---|---:|
| systemd-run、就绪通知、独立单元 | 直接启动 rh-hold.exe，等端点就绪，按库记录重连。测试结束控制面、输出回放和 PID 不变。父 Job 清理子树时需要换独立启动入口。 | 3–6 |
| Unix socket、文件锁、权限位 | 本地命名管道；只允许本人和系统访问。会话锁沿用 Rust 文件锁。配置、令牌、日志放在用户私有 ACL 下。 | 3–5 |
| /proc、cgroup、SIGTERM | 先关闭内存压力监控和 systemd 诊断。关闭 stdin 后再结束本槽进程树；身份不明不能重新开同一会话。 | 2–4 |
| PTY、Herdr | 无头协议走 stdio。自建 agent 终端由 Herdr 承载，网页用 terminal session control。切回时按主进程 PID 和创建时间确认旧实例已退出。 | 完整 TUI 另估 5–12 |
| 路径和分发 | Windows 盘符、临时目录、用户目录与 PATH 按本机解析，编译 Bun exe 内嵌网页。用户级安装和按版本目录更新另验。 | 2–4 |

工作量为实现与隔离测试的估计。用户已于 2026-11-19 决定只在本人登录后运行，使用登录触发、失败自动重启的计划任务。用户于同日确认保留 owner-only 检查，特权操作走本人网页或已配对 IM。本机 CLI 的槽位 token 用来归属普通调用；同一 SID 和客户端报告的 tty 都不能证明是本人。Linux 继续执行原判断。Linux 的软内存限制不应擅自换成 Windows 的硬限制。[Herdr 的 Windows 限制](https://github.com/herdrdev/herdr/issues/4821)

## 第一项实验

在 Windows Runner 构建程序、检查类型，并用隔离临时目录验证有输入和延迟输出的假 agent。让第一份控制客户端退出，用第二份客户端核对是同一进程、补到同一批字节、写入编号仍在。测试不使用 IM 或模型凭据。分支上的实验结果与剩余项在下文记录。

## 在测试机上使用

构建机需要 Bun 1.4.4、Rust 和 MSVC 链接工具。Runner 用 PowerShell 7 从本分支执行 `bun install --frozen-lockfile`、`./scripts/windows-build.ps1`。生成的 dist 里有 rhodium.exe、rh-hold.exe 和 windows-task.ps1。安装脚本在该版本目录内创建 rh.exe 硬链接。将这组文件放在一个固定的用户私有版本目录。使用自己的原生 CLI 和原有登录。Runner 同时验证原生 exe 和 .cmd → Node → 控制台工具。

安装时用系统自带的 Windows PowerShell 5.1 执行 `.\windows-task.ps1 -InstallDir .`。首次会在本人的 LocalAppData 下新建私有 Rhodium 目录，缺少 config.toml 时停下提示。按[看板的访问方式](docs/adr/0013-board-exposure-is-yours.md)填写已认证的入口，或填已配置的 IM，再运行同一条命令。启动时核对配置文件本身的 NTFS ACL。新建配置、配置备份和运行目录时即设置本人私有 ACL。任务以本人身份、普通权限在登录时触发，可在电池上运行，以无窗口的 rh-hold.exe task 看守控制面。控制面启动失败或退出码非零时，看守依次等待 2、4、8、16、32 秒重试；连续运行一分钟会重置预算。正常退出、停止任务或用尽重试后结束。计划任务另设间隔一分钟、最多五次的失败重试作兜底，实测仅把子进程退出码传回时计划任务可能停在 Ready。无头 agent 和控制面各有可继承的不可见控制台。交互式 rh.exe 继续使用调用者的终端。测试定义可加 -WhatIf。

本地 CLI 可执行 `rh ls`。特权动作按网页/IM 已有的命令范围提供。用户于 2026-11-19 确认，Windows 首发暂不提供 `rh stop --all` 和 `rh trace`，以后如需支持再设计网页或 IM 入口。任务计划程序里可以查看运行状态。程序与数据分目录，旧 holder 运行时保留旧程序目录；真实登录任务换版、锁屏和网络恢复须在 Windows 桌面机验收。回复里的图片和文件可以使用槽位或系统临时目录中的本机盘符路径。UNC 和设备路径会被拒绝。Linux 内存压力监控和 systemd 日志在 Windows 上不可用。

## 自建 agent 终端

在测试工作区分别新建 Claude Code、Codex、pi 无头槽位。各 CLI 先用自己的登录发一条只含随机标记的消息。等这一回合结束，在槽位点“切到终端”或调用 `rh tui 工作区/槽位`，Rhodium 在选定的 Herdr 会话中打开 pane。用网页终端询问第一条标记，再输入第二条；第二个页面可以接管现有画面。分别测试正常退出 CLI 和确认 `rh release 工作区/槽位`，回到无头后都应能在同一会话复述上一个标记。失败时记录发生在哪次交接、是否是新会话、网页是否仍可输入。可接管运行中的 Claude pane。pi pane 仅在凭据检查确认四项均为空或缺失时才可接管；Codex 仍从磁盘导入。

Windows 的 `[programs]` 支持以下入口。填绝对路径时可用 TOML 单引号保留反斜线。路径检查在停止旧无头进程前执行。

| 槽位 | Windows 终端启动方式 |
|---|---|
| Claude Code | 原生 `claude.exe`，或官方 npm `claude.cmd`。当前 npm 包运行其原生目标；旧包由 Node 运行包声明的 JS 入口。 |
| Codex | 原生 `codex.exe`，或官方 npm `codex.cmd` 的 Node 入口。 |
| pi | 原生 `pi.exe`、标准 npm `pi.cmd`，或 pi.dev 的 `install.ps1` 生成且完整匹配官方模板的 `pi.cmd`。最后这一种按模板选 Node，运行原来的 `pi-launcher.js`，保留启动器的更新环境；Rhodium 核对运行 agent 的内层 Node 的 PID 和创建时间。 |

遇到自写或被改过的 cmd/bat，记下界面提示，在 `programs.claude`、`programs.codex` 或 `programs.pi` 中指定对应的受支持入口，再试切换。

`[herdr].session` 选择 Herdr 会话，默认 `default`。Claude 的 SessionStart hook 上报会话身份，启用 vim 后自动输入会等待空的 INSERT 提示符；pi 的 Herdr 扩展上报会话与状态，其工具不应继承 Claude/Anthropic 凭据。测试手册收录了在独立配置中使用 `herdr integration install claude` / `herdr integration install pi` 的说明和仅输出布尔结果的探针。回切依照主进程 PID、创建时间、会话占用和对话锁判断；单纯仍有其他子进程或文件处于打开状态不构成占用。[中文测试手册](release/windows-preview/TESTING-zh.md)

Herdr 0.9.5 在 Windows Server 2022 x64 上实测通过看板 WebSocket 的二进制画面、输入、终端程序回报的尺寸、双页接管和关 pane；使用的是真 Herdr 和无凭据的测试程序。网页这条链路不要求 Herdr 支持从终端执行 direct attach。[Windows Runner 原生实验](https://github.com/Rhapsody0x1/Rhodium/actions/runs/44543868578)

## 探索结果（2026-11-19）

[Windows Server 2022 x64 Runner](https://github.com/Rhapsody0x1/Rhodium/actions/runs/44502160952) 在代码提交 `96ba458` 完成原生 Bun/Rust 构建、TypeScript 检查、登录任务定义的 WhatIf 验证，17 个测试全部通过。

- 真实 rh-hold.exe 持有假 agent。客户端断开期间 agent 写入输出；下一次 hello 读到相同 PID、已确认输入编号和完整输出。
- 从临时目录启动编译后的 rhodium.exe，访问内嵌首页和 JS。隔离配置通过私有 NTFS 权限检查，加上公开读权限的夹具被拒绝。普通本地 rh 查询可用，无本人身份的急停被拒绝。
- 通过看板建槽、发消息。假 Claude 消费输入后强制结束控制面，离线期间生成回复，再从原状态目录启动控制面。槽恢复到 idle，日志里有回复；假 agent 启动记录只有一份。
- Linux 的类型检查、Rust 格式检查以及 holder、重启、CLI 权限、测试资源限制和协议回归通过，58 项通过、2 项 Windows 专用用例跳过。本次未跑全套。

后续在真实注册的 Windows 登录任务中，强杀控制面和让它自行以码 1 退出均触发看守拉起。更换程序目录后，原 holder 和假 agent 继续处理消息。测试者另已反馈无头建槽、磁盘导入、绑 Bot 和从 Bot 完成回合成功。普通用户的实际注销登录、锁屏与睡眠、三种真实 CLI 的 TUI 登录和 IME 输入仍需 Win11 桌面验收。[计划任务和换版回归](https://github.com/Rhapsody0x1/Rhodium/actions/runs/44547548305)
