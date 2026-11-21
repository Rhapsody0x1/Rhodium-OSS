这篇回答：macOS 预览怎样使用自建 agent 终端，无头模式和开机运行分别通过了哪些真机测试。

前置阅读：[安装、采样与卸载步骤](release/macos-preview/TESTING.md)、[托管与恢复架构](docs/architecture.md)。

## 自建 agent 终端

分别用本人已登录的 Claude Code、Codex、pi 在测试工作区创建无头槽位，pi 使用自己的提供商。先发送一个只用于本次测试的随机标记，等回合结束，再点网页“切到终端”或调用 `rh tui 工作区/槽位`。确认 Rhodium 的运行用户能访问 `[herdr].session` 指定的会话（默认 `default`）。从网页终端询问第一条标记，再输入第二条；在第二个页面验证接管。分别用 CLI 正常退出、经确认 `rh release 工作区/槽位` 切回无头，下一条消息应能复述刚才的标记。按 agent 记录失败步骤、槽位模式和脱敏错误。外部 Claude pane 可从看板或 rh import 接管。pi pane 仅在凭据检查确认四项均为空或缺失时才可接管；Codex 仍从磁盘导入。

Claude 的 Herdr SessionStart hook 上报会话身份；配置了 vim 时，自动输入等到空的 INSERT 提示符再投递。pi 的 Herdr 扩展上报会话与状态；需要检验环境时，通过合成哨兵仅记录是否仍在，不输出凭据。手册列出专用测试账户或独立配置中 `herdr integration install claude` 与 `herdr integration install pi` 的用途和操作。[测试手册](release/macos-preview/TESTING.md)

回切沿用 Linux 的主进程判据：按 PID 和创建时间确认原 agent 主进程退出，同时核对会话占用、交接同一把对话锁。脱离终端且未占用该会话的后台服务可以继续运行。macOS 15.6.1 的隔离实验确实观察到另起 POSIX 会话的子进程在 pane 关闭后仍存活。Herdr 0.9.5 和真实看板 WebSocket 已用假程序验证画面、输入、尺寸、双页接管及关闭；测试使用独立 HOME 和命名会话，未访问真实 agent 登录。登录前的钥匙串、TCC 及网络另见下表。

## 2026-11-19 测试记录

Apple Silicon、macOS 15.6.1，未用 macOS GitHub Runner。这次早期无头实验的 Mac 包代码提交为 `f9dbcaa411a3`，Windows 包为 `16583bc4912c`。两者之间只改了 Mac 的测试脚本、手册和凭据来源采样。Mac 上使用测试专用 HOME、临时工作区和假 Claude；在执行前比对了分发包的 SHA256SUMS，实际运行程序与包内二进制字节相同。

| 条件 | 操作及证据 | 结论 |
|---|---|---|
| 普通用户手动启动 | 访问编译进程序的网页，Unix socket 上 rh ls 成功，无本人身份的急停被拒。假 agent 已消费消息后杀控制面，离线期间完成回复；控制面重启后同一 PID 处理第二条，再停止槽位。 | 通过，未重复启动 agent。 |
| system 域，桌面已登录 | 注册测试 LaunchDaemon，通过 launchctl status 获取 PID，并用 ps 核对 UID 等于测试用户且非 root。假回合中 SIGKILL 控制面，launchd 再次启动它，原 agent 接第二条消息。 | 通过；没有用 LaunchAgent。 |
| 同一次系统启动内 holder 异常退出 | 真机上用当前 boot ID、未知 ID、另一 boot ID 三种独立标记调用 holder 的 probe。前两者保留防双开的标记，已确认换 boot 的情况清掉。 | 判定通过；此项没有真的重启电脑。 |
| DNS / 网络 | UTC 11:51:34、11:51:44 的 system 域样本均为 console=logged-in，访问 Anthropic HTTPS 均返回 403。 | 两次均到达 HTTP 层；未验证模型账号可用或未登录时的网络。 |
| 开机停留在登录窗口 | 本轮没有注销、重启或取到 loginwindow 样本。 | 待用户安排。锁屏和用户已登录时运行的 system 服务均不能替代这一项。 |
| 真实订阅与钥匙串 | 未复制日常凭据，也未在测试 profile 完成真实订阅登录；未访问日常登录钥匙串项目。 | 未测。服务使用本人 HOME；比较同一用户登录前后的观测，再用测试 Bot 发真实回合。只有隔离的自动测试才另设 HOME。 |
| TCC、真实 IM | 没有请求读取受保护的个人文稿，没有使用真实 Bot token。 | 未测。受保护目录应使用用户指定的无敏感内容 canary；普通测试目录读写正常不能推出 TCC 已放行。 |

预览自带 macos-observe。它在程序启动时及约 60 秒后将控制台状态、UTC 时间、boot 标记和 HTTPS 结果写在测试目录。可选的 auth 和 TCC 探针须由用户显式启用。SSH 隧道未上线时无需远程访问，待登录后按时间与同一 boot 核对结果。FileVault 尚未解锁、操作系统本身尚未引导的情况需单列。

system 域烟测结束后，已执行卸载并核实 test label 未加载、/Library/LaunchDaemons 下测试 plist 不存在。测试所用的临时授权仅适用于固定 helper 的 install/uninstall/status。root 拥有的 helper 和对应 sudoers 文件由其安装者管理。
