# 插件开发指南

这篇回答：组员怎么从零写出一个 agent 插件或 IM 插件，怎么在本地构建和调试，怎么过契约检查器和测试，怎么准备零 Key 演示素材，以及怎么提 PR 和做组内审查。

前置阅读：[术语表](../GLOSSARY.md)、[ADR-0015 插件以独立进程运行](adr/0015-out-of-process-plugins.md)、[插件化规格](spec/plugins.md)

插件以独立进程运行，通过标准输入输出上的按行 JSON [插件协议](spec/plugins.md#3-插件-api-与协议契约)与 Rhodium 核心通信。整套扩展工作都在 `plugins/<id>/` 里完成，不需要修改 `src/` 下的任何核心源码。

---

## 1. 起步：从示例复制到 `plugins/<id>/`

仓库自带两个基于契约包实现的示例插件：

- `examples/plugins/echo-agent/`：agent 插件示例，涵盖回合、工具调用、提问与去重、打断、命令、图标和对话导入。
- `examples/plugins/local-im/`：IM 插件示例，涵盖后台轮询、私聊地址归一、游标推进、失败与结局不明、图标和建 Bot 向导。

在仓库根目录选对应的示例复制到 `plugins/<id>/`（下面以 `my-agent` 和 `my-im` 为例，实际替换成你的插件 ID，如 `dsh`、`agy`、`weixin`）：

Linux / macOS：

```sh
mkdir -p plugins
cp -r examples/plugins/echo-agent plugins/my-agent
# 或复制 IM 示例：
cp -r examples/plugins/local-im plugins/my-im
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force plugins | Out-Null
Copy-Item -Recurse examples\plugins\echo-agent plugins\my-agent
# 或复制 IM 示例：
Copy-Item -Recurse examples\plugins\local-im plugins\my-im
```

复制后先修改 `plugins/<id>/plugin.json`：

- 把 `id` 改成子目录名。自动扫描要求子目录名和清单里的 `id` 完全一致。
- 改掉 `name`、`statusName`（agent）或 `label`（IM）、`program`（仅 agent）和 `version`。
- 删掉不需要的示例文件（例如不需要对话导入时删掉 `conversations/`）。

---

## 2. `plugin.json` 清单字段说明

每个插件目录根下必须有一个 `plugin.json`（[插件清单](../GLOSSARY.md)）。核心启动时先静态校验它，通过后才注册插件。

### 通用字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifestVersion` | 是 | 固定整数 `1`。 |
| `kind` | 是 | `"agent"` 或 `"im"`。 |
| `id` | 是 | 匹配 `^[a-z][a-z0-9_-]{0,31}$`，不能使用保留名。自动扫描时须与插件子目录名一致；用 `[plugins.<id>].path` 显式登记时须与配置键 `<id>` 一致（目录名可以不同）。 |
| `name` | 是 | 给用户看的展示名，例如 `"DeepSeek Harness"`、`"微信官方 Bot"`。 |
| `version` | 是 | SemVer 版本号，例如 `"0.1.0"`。 |
| `minRhodium` | 是 | 最低核心版本（SemVer），当前核心为 `"1.5.0"`。 |
| `protocol` | 是 | agent 填 `"rh-agent/1"`，IM 填 `"rh-im/1"`。 |
| `command` | 是 | 启动参数数组，至少 1 项。相对文件一律用 `${PLUGIN_DIR}/...` 引用插件目录。 |
| `commandByPlatform` | 否 | 按 `process.platform`（如 `"win32"`、`"linux"`、`"darwin"`）覆盖 `command`。 |
| `requiredConfig` | 否 | 必须提供的配置键名数组；缺失时插件启动前即报错隔离。 |
| `optionalConfig` | 否 | 可选配置键名数组（例如离线样例路径 `fixture`、模拟服务地址 `baseUrl`）。 |
| `icon` | 否 | 插件目录内的 `.svg` 或 `.png` 相对路径，例如 `"icon.svg"`。 |

关于 `command` 与 `${PLUGIN_DIR}`：

- agent 插件启动时的工作目录（`cwd`）是槽位目录，不是插件目录，且可能含空格。
- 核心会把 `${PLUGIN_DIR}` 展开成插件目录的规范绝对路径，再直接以参数数组拉起进程，不经过 shell 拼接。
- 进程环境里同时注入了 `RHODIUM_PLUGIN_DIR`，方便代码读取插件目录内的样例或资源。

关于 `icon`（详见[插件化规格 §4.6](spec/plugins.md#46-插件图标)）：

- 必须是插件目录内的相对路径，扩展名为 `.svg` 或 `.png`，普通文件，大小不超过 256KB。
- 不能通过 `..` 或符号链接跳出插件目录。
- 看板通过 `<img>` 显示图标，从不内联 SVG。图标不合格时插件照常加载，只是丢掉图标并由 `rh doctor` 记一条警告。

### Agent 插件专属字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `statusName` | 是 | `/status` 与看板显示的名称（不能写 `label`）。 |
| `program` | 是 | 默认下游可执行程序名（如 `"dsh"`、`"agy"`），可被 `config.toml` 的 `[programs]` 覆盖。核心启动槽位前只查 `command[0]`，不拦 `program`，离线回放时不需要安装真实 CLI。 |
| `capabilities` | 是 | 静态能力声明：`liveApproval`（运行中切换审批）、`steer`（回合中插话）、`commands`（支持的通用命令子集，如 `["compact"]`）、`models`（可选模型列表）。 |
| `import` | 否 | 设为 `true` 时，插件支持[一次性查询](../GLOSSARY.md)导入本机对话（[规格 §3.5](spec/plugins.md#35-agent-插件对话导入一次性查询)）。缺省为 `false`。 |

### IM 插件专属字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `label` | 是 | 来源行与看板使用的平台名称（不能写 `statusName`）。 |
| `capabilities` | 是 | 静态能力表（运行时以 `init` 返回值为准）：必填 `progress`（`"append"` 或 `"edit"`）、`buttons`（`boolean \| "markdown"`）、`sendLimit`（`{ kind: "rate", perChatPerSecond: 正数 }`，禁止 `"qq_quota"`）、`menu`（`{ scope: "global" \| "per_chat", maxItems: 非负整数, row?: ... }`）、`maxTextLength`（正整数）、`maxFileBytes`（`{ image, file }`）、`markdown`（必须显式填对象或 `null`，不能省略）。 |
| `wizard` | 否 | 设为 `true` 时，插件支持网页看板「新建 Bot」和终端 `rh bot <名字> <插件ID>`（[规格 §3.6](spec/plugins.md#36-im-插件建-bot-向导rh-bot-名字-插件平台)）。缺省为 `false`。 |

### 保留内置名称

以下 10 个 ID 留给内置组件，核心加载时会同时避开 agent 与 IM 两组保留名的并集，**任何插件**都不能使用：

- Agent 保留名：`claude`、`pi`、`codex`、`herdr`
- IM 保留名：`qq`、`telegram`、`feishu`、`fake`、`me`、`web`

---

## 3. 用契约包实现插件

TypeScript / JavaScript 插件直接导入仓库内置的 `@rhodium-oss/plugin-sdk`（位于 `packages/plugin-sdk/`，零运行期外部依赖）。插件严禁导入 `src/` 下的任何核心内部文件。如果用 Python、Go、Rust 等其他语言编写，直接按[插件化规格 §3.2、§3.3](spec/plugins.md#3-插件-api-与协议契约)在 stdin/stdout 上读写按行 JSON 即可。

### 3.1 Agent 插件：`AgentPlugin` 与 `runAgentPlugin`

下面只摘录关键方法展示接口用法（省略部分用 `// ...` 标出）。完整可运行实现请直接以 `examples/plugins/echo-agent/index.ts` 为准；从示例目录整份复制后保留原文件再增量修改，即可通过全部 8 组契约检查：

```ts
import {
  PluginFatalError,
  runAgentPlugin,
  type AgentContext,
  type AgentInitParams,
  type AgentPlugin,
  type AgentQueryParams,
  type AgentReadyInfo,
  type AgentSendParams,
  type AskAnswer,
  type CommandResult,
  type ImportBlock,
  type ImportConversation,
} from "@rhodium-oss/plugin-sdk";

export class EchoAgentPlugin implements AgentPlugin {
  private sessionId: string | null = null;
  private activeTurn = false;
  private pendingAsks = new Map<string, (answer: AskAnswer | null) => void>();

  async init(params: AgentInitParams, _ctx: AgentContext): Promise<AgentReadyInfo> {
    this.sessionId = "new" in params.session ? params.session.new : params.session.resume;
    // ... 若需延迟上报会话 ID，可先返回 session: null
    return {
      session: this.sessionId,
      capabilities: { liveApproval: false, steer: false, commands: ["status", "model"] },
      version: "0.1.0",
    };
  }

  async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
    this.activeTurn = true;
    try {
      ctx.taken(msg.id);
      ctx.turnStart(msg.id);

      // ... 离线失败样例（如示例中收到 "/fail" 时抛 PluginFatalError）

      const toolId = `echo-tool-${msg.id}`;
      ctx.toolStart(toolId, "echo", { text: msg.text });

      if (msg.text.includes("[ask]")) {
        const requestId = `ask-${msg.id}`;
        ctx.ask({ requestId, kind: "permission", tool: "echo", input: { text: msg.text }, toolUse: toolId });
        const ans = await new Promise<AskAnswer | null>((resolve) => {
          this.pendingAsks.set(requestId, resolve);
        });
        if (ans === null) return;
        const allowed = ans.kind === "permission" && ans.allow;
        ctx.item({
          kind: "tool",
          id: toolId,
          name: "echo",
          input: { text: msg.text },
          result: { text: allowed ? "allowed" : "denied", error: !allowed },
        });
      } else {
        // ... 普通工具调用完成，发 ctx.item({ kind: "tool", ... })
      }

      const reply = `Echo: ${msg.text}`;
      ctx.textDelta(reply);
      ctx.item({ kind: "message", text: reply });
      this.activeTurn = false;
      ctx.turnEnd({ reply, ...(this.sessionId ? { session: this.sessionId } : {}) });
    } finally {
      this.activeTurn = false;
    }
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const waiter = this.pendingAsks.get(requestId);
    if (!waiter) throw new Error(`Unknown ask requestId: ${requestId}`);
    this.pendingAsks.delete(requestId);
    waiter(answer);
  }

  async interrupt(ctx: AgentContext): Promise<void> {
    const hadPending = this.pendingAsks.size > 0;
    for (const [reqId, resolveWaiter] of this.pendingAsks) {
      this.pendingAsks.delete(reqId);
      ctx.askCancel(reqId);
      resolveWaiter(null);
    }
    if (this.activeTurn || hadPending) {
      this.activeTurn = false;
      ctx.turnEnd();
    }
  }

  async command(name: string): Promise<CommandResult> {
    // ... 按 capabilities.commands 实现对应命令（示例实现了 "status" 与 "model"）
    if (name === "status") return { command: "status", model: "echo-model", context: { usedTokens: 0, maxTokens: 4096 } };
    throw new Error(`Unsupported command: ${name}`);
  }

  // 清单声明 "import": true 时实现这两个方法（完整样本读取见 examples/plugins/echo-agent/index.ts）
  async listConversations(_params: AgentQueryParams): Promise<ImportConversation[]> { /* ... */ return []; }
  async readConversation(_session: string, _params: AgentQueryParams): Promise<ImportBlock[]> { /* ... */ return []; }

  async close(): Promise<void> {
    // ... 清理 pendingAsks 并终止下游子进程
  }
}

if (import.meta.main) {
  runAgentPlugin(new EchoAgentPlugin());
}
```

写 Agent 插件时注意：

- **不要往 `stdout` 打日志**：`stdout` 只能走协议 JSON 行，调试日志一律调用 `ctx.log(...)` 或写 `process.stderr`。
- **SDK 已替你处理的事项**：按行读写 JSONL、校验 `proto === 1`、非阻塞分派控制消息（`send()` 等待期间照常收到 `answer`/`interrupt`/`close`）、按 `requestId` 去重并在 `answer()` 成功后发出 `ask_resolved`、首帧是 `query` 时直接路由到 `listConversations`/`readConversation` 而不调 `init`、以及 `close`/EOF/`SIGTERM` 下只调一次 `close()`。
- **`PluginFatalError` 按阶段分流**：
  - `init()` 阶段抛出 `PluginFatalError`（或未捕获异常）：SDK 发出 `fatal`（`retryable` 取错误字段，默认 `false`）并以非零码退出。
  - 运行期 `send()` / `interrupt()` / `approval()` 抛出 `PluginFatalError`：SDK 发出 `error`（`recoverable: false`），调用一次 `close()` 后以非零码退出。
  - 运行期 `send()` 抛出普通 `Error`：SDK 发出 `error`（`recoverable: true`），若当前是 `mode: "turn"` 且尚未发 `turn_end`，SDK 会补发 `turn_end` 让槽位回到空闲。
- **迟到会话 ID**：如果下游在启动时还没有会话 ID，`init()` 先返回 `session: null`，拿到 ID 后在 `turn_start`、`ctx.session(id)` 或 `ctx.turnEnd({ reply, session: id })` 里补报。
- **清理下游子进程**：在 `close()` 里关停你拉起的外部 CLI，避免测试和 macOS 上残留子进程。

### 3.2 IM 插件：`ImPlugin` 与 `runImPlugin`

下面同样只摘录关键方法（省略部分用 `// ...` 标出，例如按能力声明实现的 `edit`、`dropButtons`、`answerPress`、`fetchAttachment`、`setMenu`）。完整可运行实现以 `examples/plugins/local-im/index.ts` 为准：

```ts
import {
  PluginSendFailedError,
  runImPlugin,
  type Capabilities,
  type ImContext,
  type ImInitParams,
  type ImPlugin,
  type ImWizardContext,
  type ImWizardDone,
  type ImWizardParams,
  type OutboundMessageWire,
  type SendResult,
} from "@rhodium-oss/plugin-sdk";
import manifest from "./plugin.json";

class LocalImPlugin implements ImPlugin {
  private endpoint?: URL;
  private stop = new AbortController();

  async init(params: ImInitParams, ctx: ImContext): Promise<Capabilities> {
    if (params.config.endpoint) {
      this.endpoint = new URL(params.config.endpoint);
      void this.poll(ctx); // 后台轮询，绝不阻塞 init()
    } else {
      ctx.connected(true);
    }
    return manifest.capabilities as Capabilities;
  }

  private async poll(ctx: ImContext): Promise<void> {
    let online = false;
    while (!this.stop.signal.aborted) {
      try {
        const cursor = (await ctx.keptGet("sync_buf")) ?? "";
        const batch = await (await fetch(new URL("/updates?cursor=" + encodeURIComponent(cursor), this.endpoint), {
          signal: this.stop.signal,
        })).json();
        if (!online) ctx.connected(true);
        online = true;
        for (const { channel, ...message } of batch.messages) {
          await ctx.keptSet("dm:" + message.sender, channel);
          // 必须 await 等核心落库回执，私聊固定 chat === sender
          await ctx.inbound({ ...message, chat: message.sender });
        }
        // 整批 inbound 全部拿到回执后，再推进批次游标
        if (batch.nextCursor !== cursor) await ctx.keptSet("sync_buf", batch.nextCursor);
        if (!batch.messages.length) await Bun.sleep(100);
      } catch (err) {
        if (this.stop.signal.aborted) return;
        online = false;
        ctx.connected(false, (err as Error).message);
        await Bun.sleep(1000);
      }
    }
  }

  async send(chat: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult> {
    // 明确拒收或缺少上下文：抛 PluginSendFailedError 或返回 { status: "failed", error }
    if (message.text.includes("[simulate-fail]")) {
      throw new PluginSendFailedError("Simulated platform refusal", { refused: true });
    }
    // ... 按 ctx.keptGet("dm:" + chat) 还原通道，网络异常交由 SDK 映射为 unknown
    return { status: "sent", messageId: "local-1" };
  }

  // ... 若 capabilities 声明了 edit / buttons / menu 等能力，须实现对应的 edit / dropButtons / answerPress / setMenu 方法

  // 清单声明 "wizard": true 时实现该方法（规格 §3.6）
  async wizard(params: ImWizardParams, ctx: ImWizardContext): Promise<ImWizardDone> {
    ctx.qr("local-im://bind/" + params.botName, "用本地平台扫码");
    ctx.link("http://localhost/bind/" + params.botName, "或打开链接");
    ctx.waiting("等待本地平台确认");
    const token = await ctx.input("本地平台的 token", { secret: true });
    return { config: { token }, text: "Local IM Bot 已绑定" };
  }

  async shutdown(): Promise<void> {
    this.stop.abort();
  }
}

if (import.meta.main) runImPlugin(new LocalImPlugin());
```

写 IM 插件时注意：

- **`init()` 不要阻塞**：启动后台轮询后尽快返回 `Capabilities`，连上平台后再发 `ctx.connected(true)`。
- **私聊地址归一**：上报私聊消息时，`chat` 和 `sender` 都填平台用户 ID；把私聊房间 ID 或会话令牌先存进 `ctx.keptSet(...)`，出站时用 `ctx.keptGet(...)` 还原。
- **批次游标顺序**：先逐条 `await ctx.inbound(...)` 拿到核心落库回执，整批都成功后才调 `ctx.keptSet("sync_buf", nextCursor)`。
- **分清 `failed` 与 `unknown`**：确认消息没发出或被平台拒收时返回 `failed`（或抛 `PluginSendFailedError`）；网络中断、超时、回执丢失时返回 `unknown`（或让未捕获异常交由 SDK 映射为 `unknown`），核心绝不重发。
- **建 Bot 向导限制**：`wizard()` 返回的 `config` 键只能来自清单的 `requiredConfig` 和 `optionalConfig`，不能包含 `platform`、`target`、`owner`。

---

## 4. 构建与本地调试（Linux 和 Windows）

### 4.1 构建 Rhodium 核心

先准备环境：Git、Bun 1.4.4 和稳定版 Rust（带 `rustfmt`）；Windows 上还需要 MSVC 构建工具。

在仓库根目录安装依赖并构建：

Linux / macOS：

```sh
bun install --frozen-lockfile
bash scripts/build.sh dist
```

Windows（PowerShell）：

```powershell
bun install --frozen-lockfile
.\scripts\windows-build.ps1
```

构建完成后，`dist/` 下会有成对的 `rhodium` 和 `rh-hold`（Windows 上是 `rhodium.exe` 和 `rh-hold.exe`）。只改自己插件代码时，**不需要重新构建核心**。

### 4.2 独立构建插件与自动扫描

核心启动时会自动扫描 **`config.toml` 所在目录下的 `plugins/`** 这一层子目录（详见[插件化规格 §4.5](spec/plugins.md#45-插件目录扫描)）：

- 含 `plugin.json` 的普通子目录自动加载，不需要在 `config.toml` 里写 `[plugins.<id>]`。
- 跳过 `.` 开头的子目录、不含 `plugin.json` 的目录、普通文件（如 `plugins/README.md`）以及符号链接（Windows 含目录联接）。
- 需要传静态配置、禁用扫到的插件，或从别的路径显式加载时，在 `config.toml` 里写 `[plugins.<id>]`：

```toml
# 给自动扫到的插件传配置（不写 path 就沿用 plugins/<id>/）
[plugins.dsh.config]
fixture = "./fixtures/sample.jsonl"

# 禁用某个扫到的插件
[plugins.old-plugin]
enabled = false

# 从别处显式登记插件（支持绝对路径或相对 config.toml 的路径）
[plugins.my-agent]
path = "/path/to/Rhodium-OSS/plugins/my-agent"
```

注意依赖解析与独立打包：

- 在仓库内的 `plugins/<id>/` 里直接运行 `.ts` 源码时，Bun 会向上找到仓库根目录的 `node_modules/@rhodium-oss/plugin-sdk`。
- 如果要把插件复制到仓库外的任意 `<配置目录>/plugins/<id>/` 单独交付或测试自动扫描，用 `bun build` 把契约包一并打进单文件：

```sh
bun build plugins/<id>/index.ts --outfile plugins/<id>/dist/index.js --target bun
```

- 打包后把 `plugin.json` 的 `command` 改成 `["bun", "run", "${PLUGIN_DIR}/dist/index.js"]`（Windows 如需指定可执行名，可在 `commandByPlatform.win32` 写 `["bun.exe", "run", "${PLUGIN_DIR}/dist/index.js"]`）。
- **打包后用 `RHODIUM_PLUGIN_DIR` 找随包资源**：`examples/plugins/echo-agent/index.ts` 原版用 `import.meta.dir` 定位 `conversations/`，直接打包到 `dist/index.js` 后 `import.meta.dir` 会变成 `<插件目录>/dist`，导致第 8 组导入检查找不到 `conv_a1`。打包前把源码里的基准目录改成 `RHODIUM_PLUGIN_DIR`（复制出独立目录时一并带上 `conversations/`、`fixtures/`、`icon.svg`、`conformance.json`）：

```ts
const pluginDir = process.env.RHODIUM_PLUGIN_DIR || import.meta.dir;
const folder = params.config.conversations || join(pluginDir, "conversations");
// 相对目录同样按 pluginDir 解析：
// dir: isAbsolute(s.dir) ? s.dir : resolve(pluginDir, s.dir)
```

- 打包并改完 `plugin.json` 后，立刻对**打包后的清单**跑一遍契约检查器，确认包含导入/向导在内的全部检查都通过：

```sh
bun scripts/plugin-conformance.ts --manifest plugins/<id>/plugin.json
```

### 4.3 用 `rh dev --fake` 和看板本地调试

为避免碰正式配置和本机已登录的真实 CLI（`claude`、`codex`、`pi`、`herdr`），按 `demo/run.ts` 的做法把 `[programs]`、Herdr 会话和用户目录全部隔离到临时目录。

#### 第 1 步：准备隔离配置

先记下两个绝对路径：`<临时目录>`（全新空目录，例如 Linux `/tmp/rhodium-test-dev`、Windows `C:\Users\<你>\AppData\Local\Temp\rhodium-test-dev`）和 `<仓库目录>`。下面配置把 `[bots.dev].target` 设成 `dev/try`，与后面新建的插件槽位同名，这样从终端假 IM 发出的消息会直接进入刚建的插件槽位。

**Linux / macOS（`<临时目录>/config.toml`）：**

```toml
stateDir = "<临时目录>/state"
socketDir = "<临时目录>/run"
# 普通 Linux 走路线 D（systemd）且仓库路径含空格或中文时，改为 "<临时目录>/rh-hold"
holdBin = "<仓库目录>/dist/rh-hold"
unitPrefix = "rhodium-test-dev-"

[programs]
claude = "<临时目录>/unavailable"
codex = "<临时目录>/unavailable"
pi = "<临时目录>/unavailable"
herdr = "<临时目录>/unavailable"

[herdr]
session = "rhodium-test"

[board]
bind = "127.0.0.1"
port = 7800
auth = "none"

[bots.dev]
platform = "fake"
like = "qq"
socket = "127.0.0.1:17801"
owner = "dev-owner"
target = "dev/try"
```

**Windows（`<临时目录>\config.toml`，绝对路径用 TOML 单引号避免反斜杠转义）：**

```toml
stateDir = '<临时目录>\state'
socketDir = '<临时目录>\run'
holdBin = '<仓库目录>\dist\rh-hold.exe'
unitPrefix = "rhodium-test-dev-"

[programs]
claude = '<临时目录>\unavailable.exe'
codex = '<临时目录>\unavailable.exe'
pi = '<临时目录>\unavailable.exe'
herdr = '<临时目录>\unavailable.exe'

[herdr]
session = "rhodium-test"

[board]
bind = "127.0.0.1"
port = 7800
auth = "none"

[bots.dev]
platform = "fake"
like = "qq"
socket = "127.0.0.1:17801"
owner = "dev-owner"
target = "dev/try"
```

接入正在开发的插件有两种方式：

- **直接调试仓库里的源码**：在上面这份 `config.toml` 末尾加 `[plugins.<id>]` 和 `path = "<仓库目录>/plugins/<id>"`（Windows 用单引号）。
  - 改完 **IM 插件**代码后，重启 `rh dev` 即可加载新版。
  - 改完 **agent 插件**代码后，如果测试槽位已经跑过一轮，`rh dev` 退出不会停掉托管进程，只重启 `rh dev` 会重新接上旧进程；先在看板里**停掉**这个测试槽位的进程，再向同一槽位发消息拉起新版。
- **验证自动扫描与独立产物**：按 4.2 节打包插件（改用 `RHODIUM_PLUGIN_DIR` 定位资源）后，把整个插件目录放进 `<临时目录>/plugins/<id>/`，`config.toml` 里不写 `[plugins.<id>]`，重启后直接被自动扫到。之后每次改代码，都要先重新 `bun build` 并更新 `<临时目录>/plugins/<id>/` 里的产物，再按上面同样的方法停掉测试槽位（agent）或重启 `rh dev`（IM）。

#### 第 2 步：设好文件权限并启动隔离实例

下面四条启动命令都会清掉 `CODEX_HOME` 和 `CLAUDE_CONFIG_DIR`（避免平时设过这两个环境变量时，看板浏览目录或导入弹窗读到正式会话记录）。

**路线 A：Linux（detached 模式，免 systemd，适合所有无 systemd 环境与 CI 复现）**

Linux 必须**同时**设置 `NODE_ENV=test` 和 `RHODIUM_TEST_DETACHED=1` 才走 detached 托管模式；同时把 `HOME` 和 `XDG_RUNTIME_DIR` 指向临时目录并清掉 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`：

```sh
ROOT=/tmp/rhodium-test-dev
mkdir -p "$ROOT/run" && chmod 700 "$ROOT/run"
chmod 600 "$ROOT/config.toml"
env -u CODEX_HOME -u CLAUDE_CONFIG_DIR \
  HOME="$ROOT" XDG_RUNTIME_DIR="$ROOT/run" NODE_ENV=test RHODIUM_TEST_DETACHED=1 \
  ./dist/rhodium rh dev --fake --config "$ROOT/config.toml"
```

**路线 B：Windows（PowerShell）**

Windows 启动时会强制校验 `config.toml` 的 NTFS 权限（普通新建文件若继承了其他账号的访问权会被直接拒绝），先设成仅本人可访问；**不要**提前手动建 `run` 目录，留给守护进程启动时自动按本人私有 ACL 创建。然后在单独开的调试 PowerShell 窗口里把用户目录环境变量指向临时目录、清掉 `CODEX_HOME` 和 `CLAUDE_CONFIG_DIR` 后启动：

```powershell
$root = Join-Path $env:TEMP "rhodium-test-dev"
# 把刚写好的 config.toml 设成本人私有 ACL（去掉继承，只保留当前用户完全控制）
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls "$root\config.toml" /inheritance:r /grant:r "*${me}:(F)" | Out-Null

# 仅在当前调试窗口隔离用户目录与对话目录，避免探测本机登录态和正式会话
Remove-Item Env:CODEX_HOME, Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
$env:HOME = $root
$env:USERPROFILE = $root
$env:APPDATA = $root
$env:LOCALAPPDATA = $root
.\dist\rhodium.exe rh dev --fake --config "$root\config.toml"
```

**路线 C：macOS**

macOS 与 Windows 同为独立托管进程模式，只需设权限、隔离 `HOME` 并清掉覆盖变量：

```sh
ROOT=/tmp/rhodium-test-dev
mkdir -p "$ROOT/run" && chmod 700 "$ROOT/run"
chmod 600 "$ROOT/config.toml"
env -u CODEX_HOME -u CLAUDE_CONFIG_DIR HOME="$ROOT" \
  ./dist/rhodium rh dev --fake --config "$ROOT/config.toml"
```

**路线 D：普通 Linux（有 systemd 用户会话，需要实测交互终端 `rh bot` 向导时用）**

systemd 模式下，托管程序 `holdBin` 以及 `stateDir`、`socketDir`、`lockDir` 的路径都不能带空格、中文或其他会被 systemd 展开的字符（只允许 `/[\w/.,+:@-]*`）。如果仓库本身在带空格或中文的目录里，先把 `dist/rh-hold` 复制到 `/tmp/rhodium-test-dev/rh-hold`，并把 `config.toml` 里的 `holdBin` 改为 `"/tmp/rhodium-test-dev/rh-hold"`。

不设 `NODE_ENV=test` 和 `RHODIUM_TEST_DETACHED=1`，保留当前用户的 `XDG_RUNTIME_DIR` 以便 `systemd-run --user` 工作，同时隔离 `HOME`、清掉 `CODEX_HOME` 与 `CLAUDE_CONFIG_DIR`，并用 `unitPrefix = "rhodium-test-dev-"` 隔离单元：

```sh
ROOT=/tmp/rhodium-test-dev
mkdir -p "$ROOT/run" && chmod 700 "$ROOT/run"
cp ./dist/rh-hold "$ROOT/rh-hold"
chmod 600 "$ROOT/config.toml"
env -u CODEX_HOME -u CLAUDE_CONFIG_DIR HOME="$ROOT" \
  ./dist/rhodium rh dev --fake --config "$ROOT/config.toml"
```

调试结束后如果启过插件槽位，清掉测试托管单元：`systemctl --user stop 'rhodium-test-dev-*'; systemctl --user reset-failed 'rhodium-test-dev-*'`。

#### 第 3 步：按平台使用调试入口

各平台下能用的入口不同——Windows、macOS 以及 Linux detached 模式（`NODE_ENV=test RHODIUM_TEST_DETACHED=1`）里，守护进程会把所有本地 CLI 请求的 `tty` 置为 `false`，所以本地 `rh` 只放行 `rh doctor`、`rh ls` 等只读命令，**`rh bot` 会报“只有用户本人能用”**（且 `rh bot` 的不回显密码输入依赖 `stty`，原生 PowerShell 不具备），新配置未设 `mainChat` 时 `rh ws` / `rh new` 也无法直接执行。请按平台选择对应入口：

1. **Windows / macOS / Linux detached 模式（推荐通用路径）**：
   - **建工作区、建插件槽位、试导入和对话**：打开浏览器访问看板 `http://127.0.0.1:7800`，先建工作区 `dev`（目录填 `<临时目录>`），再建槽位 `dev/try` 并选中你的 agent 插件，查看插件图标与加载状态，直接在对话页发消息或打开导入弹窗验证。
   - **终端假 IM 联调**：建好 `dev/try` 后，回到 `rh dev --fake` 终端输入文字并回车，消息会按 `[bots.dev].target = "dev/try"` 直达刚建的插件槽位并打印回复。Linux/macOS 按 `Ctrl-D`、Windows 按 `Ctrl-Z` 再回车退出。
   - **只读诊断（另开终端）**：
     ```sh
     # Linux / macOS
     ROOT=/tmp/rhodium-test-dev
     HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh doctor
     HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh ls
     ```
     ```powershell
     # Windows (PowerShell)
     $root = Join-Path $env:TEMP "rhodium-test-dev"
     $env:HOME = $root; $env:USERPROFILE = $root; $env:APPDATA = $root; $env:LOCALAPPDATA = $root
     $env:RHODIUM_SOCKET = "$root\run\rh.sock"
     .\dist\rhodium.exe rh doctor
     .\dist\rhodium.exe rh ls
     ```
   - **验证 IM 插件建 Bot 向导**：在这三种模式下不通过本地 `rh bot` 跑向导，直接用第 5 节的契约检查器（第 8 组）和插件集成测试验证向导流程。
2. **普通 Linux（路线 D，带 systemd 用户会话，在真实交互终端运行）**：
   - 除看板与假 IM 外，还可以在另一个真实交互终端里直接建工作区、建槽位并运行 `rh bot` 向导。注意新配置没有 `mainChat`，首次跑 `rh bot` 必须把已有目标槽位写在最后：

```sh
ROOT=/tmp/rhodium-test-dev
HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh doctor
HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh ws dev "$ROOT"
HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh new dev/try --agent my-agent
# 声明了 wizard: true 的 IM 插件（须写明已有目标槽位 dev/try）：
HOME="$ROOT" RHODIUM_SOCKET="$ROOT/run/rh.sock" ./dist/rhodium rh bot my-bot my-im dev/try
```

也可以先跑仓库自带的零 Key 演示脚本看一遍完整流程：

```sh
bun demo/run.ts --pause
# 无需人工按键的全自动模式：
bun demo/run.ts --port 0
```

调试出错时，看下面三处：

- **守护进程与脱敏错误**：`<临时目录>/state/dev.log` 记录守护进程日志，以及核心对 IM 插件记录的脱敏连接/协议错误。
- **Agent 插件 `stderr`**：`<临时目录>/state/hold/<对话ID>/err.log`。
- **IM 插件 `stderr`**：为防平台凭据进日志，核心的 IM 适配器会直接消费并丢弃插件的 `stderr`，不会写入 `dev.log`。需要看 IM 插件自己的 `stderr` 调试输出时，请直接独立运行离线插件（例如 `bun run plugins/<id>/index.ts` 并喂测试 JSON-RPC 帧），或在插件单元测试里给 `runImPlugin(plugin, { stderr })` 传入内存流收集。

---

## 5. 跑契约检查器（7 组全过）

仓库自带语言无关的黑盒契约检查器 `scripts/plugin-conformance.ts`。所有插件必须全部通过。

### 5.1 命令

```sh
# 检查插件（--config 传入离线配置 JSON，可选）
bun scripts/plugin-conformance.ts --manifest plugins/<id>/plugin.json
bun scripts/plugin-conformance.ts --manifest plugins/<id>/plugin.json --config '{"fixture":"./fixtures/sample.jsonl"}' --timeout 10000

# 顺手校验示例插件是否通过
bun scripts/plugin-conformance.ts --manifest examples/plugins/echo-agent/plugin.json
bun scripts/plugin-conformance.ts --manifest examples/plugins/local-im/plugin.json
```

### 5.2 检查矩阵

**Agent 插件（7 组必过；声明 `"import": true` 时加测第 8 组）：**

1. `ok 1`：清单字段、图标、静态合规（非保留名、不指向 `claude`）与 `requiredConfig`。
2. `ok 2`：子进程环境变量清洗（不含敏感凭据）。
3. `ok 3`：`init` 握手并在时限内回传合法 `ready`。
4. `ok 4`：正常单回合（`taken`、`turn_start`、正文与 `turn_end`）。
5. `ok 5`：重复 `answer` 去重（仅向下游交付一次且在 `ask_resolved` 前完成）；未配 `askText` 时测不支持命令返回 `ok: false`。
6. `ok 6`：进行中回合 `interrupt` 中断、`close` 优雅退出且无残留子进程。
7. `ok 7`：畸形 JSON、超 64MB 超长行、以及模拟运行失败（或错误协议版本）报错规范。
8. `ok 8`（仅 `"import": true`）：一次性查询 `list`（`dir: null`）与 `read`（配了 `importSession` 时），检查 ID 字符集、块结构和退出。

**IM 插件（7 组必过；声明 `"wizard": true` 时加测第 8 组）：**

1. `ok 1`：清单字段、图标、静态合规与 `requiredConfig`。
2. `ok 2`：环境清洗、`init` 握手能力表校验与 `connected(up: true)`。
3. `ok 3`：正常文本、按 `maxTextLength` 切分边界和协商后的 Markdown（含 `markdown: null`）。
4. `ok 4`：仅按声明的能力调用 `edit`、`drop_buttons`、`set_menu`、`set_row`。
5. `ok 5`：`kept_set` / `kept_get` 跨重启读写闭环（通道映射、游标或上下文令牌）。
6. `ok 6`：明确发送失败或缺少上下文时返回 `{ status: "failed", error }` 且进程不退出。
7. `ok 7`：`shutdown` 回执与无残留子进程退出。
8. `ok 8`（仅 `"wizard": true`）：向导首步时限、步骤与 `wizard_input` 交互、完成字段校验、以及中途 `shutdown` 退出。

### 5.3 配套的 `conformance.json`

在 `plugin.json` 旁边放一个 `conformance.json`，告诉检查器怎样在离线模式下触发审批、中断、失败、导入或向导输入：

Agent 示例（参考 `examples/plugins/echo-agent/conformance.json`）：

```json
{
  "normalText": "hello conformance",
  "askText": "[ask]",
  "deliveredText": "allowed",
  "interruptText": "[ask]",
  "failureText": "/fail",
  "importSession": "conv_a1"
}
```

- `askText` 与 `deliveredText` 成对使用：检查器发 `askText` 触发一次 `permission` 提问，连续发两次相同的 `answer`，并核对只出现一次结果为 `deliveredText` 的工具项且早于 `ask_resolved`。
- `interruptText`：必须触发一个不会立刻结束的回合，以便检查器发送 `interrupt`。
- `importSession`：声明 `import: true` 时提供一段存在的样例对话 ID。

IM 示例（与 `examples/plugins/local-im/conformance.json` 一致）：

```json
{
  "localPlatform": true,
  "kept": { "dm:conf-user-1": "dm-99", "sync_buf": "1" },
  "failureText": "[simulate-fail]",
  "wizardInputs": { "本地平台的 token": "conf-token" }
}
```

- `localPlatform: true`：仅用于内置 `local-im` 示例协议。未通过 `--config` 指定 `endpoint` 时，检查器会自起一个本地回环平台并投递样例入站消息，触发示例写入 `dm:conf-user-1` 与 `sync_buf`。
- 写你自己的 IM 插件（例如 `weixin`）时，去掉 `localPlatform`，先拉起插件自带的本地模拟服务（如 `mock-weixin-server`），再通过 `--config` 传入地址和占位凭据（或在插件自己的测试脚本里自动起停它）：

```sh
bun scripts/plugin-conformance.ts --manifest plugins/weixin/plugin.json \
  --config '{"baseUrl":"http://127.0.0.1:18080","token":"mock-weixin-token"}'
```

- `kept`：要求插件写入并在重启后读回的持久化键值对（纯无状态平台才填 `"stateless": true`）。
- `chat` / `failureChat` / `failureText`：指定测试用户 ID 及触发明确 `{ status: "failed", error }` 拒收的输入。
- `wizardInputs`：按 `wizard_input` 的 `label` 映射测试输入值，供 `"wizard": true` 的插件跑第 8 项。

---

## 6. 做离线样例或模拟服务器（零 Key 演示）

课程 CI 和助教验收机器上没有外部 API Key，也没有真实 IM 账号。你的插件必须提供可离线重复运行的模式，不联网也能跑通完整演示。

### Agent 插件：离线回放样例

1. 在 `plugin.json` 的 `optionalConfig` 里声明一个样例路径键（例如 `"fixture"`）。
2. 用自己的账号和便宜模型跑一次真实下游 CLI，录下关键帧（握手、普通回合、工具调用、审批或提问、中断、错误、关闭），保存成小文件放进 `plugins/<id>/fixtures/`。
3. 清理样例：去掉任何 Key、令牌、真实用户名或个人路径，在样例里注明录制时用的下游 CLI 版本。
4. 插件在收到 `init.config.fixture` 时不拉起真实 CLI，改为从该样例回放消息，同时仍然真实执行插件自己的协议翻译、事件组装和审批状态机。
5. 如果声明了 `"import": true`，再放一份脱敏后的样例对话目录，供 `listConversations` 和 `readConversation` 测试。

### IM 插件：本地模拟服务器

1. 在 `plugins/<id>/` 里写一个零外部依赖的本地 HTTP 模拟服务（使用 `Bun.serve` 监听 `127.0.0.1:<port>`）。
2. 在 `plugin.json` 的 `optionalConfig` 里声明服务地址键（如 `baseUrl`、`cdnBaseUrl` 或 `endpoint`），运行和向导都支持切换到这个本地地址。
3. 模拟服务按目标平台的真实协议路径和校验规则实现：
   - 登录扫码 / 向导状态流转（等待、验证码、已扫码、已确认、过期等）；
   - 入站批量拉取（能一次返回多条消息和下一批游标，用来验证中断续拉不丢不重）；
   - 出站发送与媒体上传下载；
   - 故障注入：明确拒收（验证 `failed`）和“服务端已收到但断开连接/丢回执”（验证 `unknown` 不重发）。

---

## 7. 怎么写测试

插件自己的测试放在 `plugins/<id>/` 内（例如 `plugins/<id>/test/` 或 `plugins/<id>/*.test.ts`），不要修改 `src/`。

测试至少覆盖三类行为：

- **正常路径**：握手、正常问答或收发消息、工具调用、私聊地址归一、对话导入或向导主流程。
- **边界与失败**：缺配置、下游报错或崩溃、重复 `answer`、回合中 `interrupt`、缺上下文拒发（`failed`）、网络断连/丢回执（`unknown`）、同批入站中途崩溃不丢不重。
- **接入与契约**：清单校验、离线样例下的 `plugin-conformance.ts` 全项通过、以及退出后无残留子进程。

本地运行命令（使用 `--config=bunfig.ci.toml` 在 Linux、Windows、macOS 上都不依赖本机 systemd）：

```sh
# 跑插件自己的单测与集成测试
bun --config=bunfig.ci.toml test plugins/<id>/

# 跑契约检查器
bun scripts/plugin-conformance.ts --manifest plugins/<id>/plugin.json

# 跑全仓库 TypeScript 类型检查
bun run typecheck
```

合入主干前，把插件的测试和契约检查步骤补进 `.github/workflows/ci.yml` 的 `linux-check` 与 `windows-check`，让 CI 自动验证。

---

## 8. 开 PR 与组内审查

### 8.1 分支与提交

1. 先拉取最新主干并开分支：

   ```sh
   git fetch origin
   git checkout -b feat/plugin-<id> origin/main
   ```

2. 提交信息用英文（例如 `Add dsh agent plugin with offline replay fixture`），不带任何 AI 署名（不写 `Co-Authored-By:` 等）。
3. 核对没有改核心源码：

   ```sh
   git diff origin/main -- src/
   ```

### 8.2 开 PR（中文标题与正文）

把分支推到远端后开向 `main` 的 PR，标题和正文用中文，正文第一行关联工单 `Part of #<工单号>`（正文同样不带 AI 生成署名）：

```sh
git push -u origin feat/plugin-<id>
gh pr create -R Rhapsody0x1/Rhodium-OSS --base main --head feat/plugin-<id> --title "新增 <插件名> 插件" --body-file pr-body.md
```

PR 正文里附上以下证据：

- 改动范围：目录位置、核心源码改动核对结果（`git diff origin/main -- src/` 为空）。
- 协议与离线路径说明：对接了下游什么接口、离线样例或模拟服务器怎么跑。
- 契约检查器输出：7 组（声明 `import`/`wizard` 为 8 组）全部 `ok` 和最终 `PASS`。
- 单元测试与本地调试结果：测试命令、通过数量、以及零 Key 演示观察到的结果。
- CI 状态：GitHub Actions 的 `linux-check` 和 `windows-check` 均通过。

### 8.3 另一位组员怎么审（课程必查证据）

课程要求每位成员既提交有实质内容的代码/测试 PR，也真实审查至少一位其他成员的 PR。审查记录留在 GitHub PR 评论里：

- **不能只回 “LGTM”**，也不能把 AI 自动生成的文本原样冒充本人审查。
- **审查人做什么**：拉取分支本地跑一遍契约检查器和插件测试，对照规格和合规红线逐项检查程序行为、边界情况、失败处理、离线样例和测试覆盖；写下具体、可核对的审查意见（标明“必须修”或“建议修”）。
- **作者做什么**：逐条回复每条意见的处理结果——改了的写明修复提交的 commit SHA，不改的写明依据。
- **复核与合并**：作者改完推送后，审查人核对新提交并回复复核结论（例如“复核通过，可以合并”），CI 全绿后再合并。

---

## 9. 不能碰的红线

写代码、写样例、录素材和跑测试时，以下红线一条都不能破：

1. **不得拉起或包装 `claude`**：`plugin.json` 的 `id`、`program`、`command`、`commandByPlatform` 以及插件进程子树里，一律禁止出现或调用 `claude` / `claude.exe` / `claude.cmd`，不得以插件形式包装 Claude Code。
2. **不得传 `--bare`**：`--bare` 会破坏用户订阅登录，任何地方都不要传。
3. **不得使用 Claude 订阅凭据**：插件和 `pi` 不得读取或复用 `~/.claude` 下的登录态或 Anthropic 凭据。核心拉起插件前会清洗 `ANTHROPIC_*`、`CLAUDE*`（Windows 按大小写不敏感匹配），`rh doctor` 也会巡检插件进程子树。
4. **只有用户本人能触发 agent**：IM 插件只管平台身份认证并原样上报发送者 ID，配对和主人校验（`owners.includes(sender)`）由核心集中执行，绝不绕过核心触发 agent。
5. **仓库里不放任何密钥或隐私**：真实 API Key、Bot Token、cookie、微信号、个人路径和私人聊天记录一律不进源码、样例、配置或提交历史。
6. **不改核心源码，不碰用户正在运行的实例**：插件只写在 `plugins/<id>/`；调试必须按 4.3 节覆盖 `[programs]`、`[herdr] session = "rhodium-test"` 和 `HOME`/`USERPROFILE`（并清掉 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`，加上 `rhodium-test-*` 前缀），防止 `rh doctor`、看板或内置槽位探测本机 `~/.claude`、`~/.codex`、`~/.pi`、`~/.config`、正式会话记录、正式 Rhodium 实例或用户的 Herdr 会话。

---

## 10. 三个插件的入口指引

具体协议字段、边界条件和验收细节全部以[插件化规格 §9](spec/plugins.md#9-三个组员插件的接入要求)为准，这里只列每个插件的起步要点：

### 10.1 DeepSeek Harness 插件（`dsh`）

- **目录与参考**：放在 `plugins/dsh/`，从 `examples/plugins/echo-agent` 起步；完整要求见[插件化规格 §9.1](spec/plugins.md#91-deepseek-harness-插件dsh)。
- **接入方式**：常驻进程拉起 `dsh --profile sdk`（等价 `dsh sdk`），在 stdio 上讲 dsh 原生 SDK JSON-RPC 协议。
- **关键注意**：
  - `session.event` 和 `session.status` 只认 `sessionId` 等于本槽位会话的推送；`approval/request` 和 `user-question/ask` 不过滤。
  - 新会话在首次 `session/prompt` 前把 `init.systemPromptFile` 内容拼在开头，拿到返回后再补报 `session`。
  - `interrupt` 通过停止当前 dsh 进程、发 `turn_end`、下一条消息前重启并 `session/resume` 实现。
  - 本期不声明 `import`；锁定一个实测过的 dsh 版本并在真实模式校验 `dsh --version`；提供离线回放 `fixture` 跑零 Key 演示。

### 10.2 Antigravity 插件（`agy`）

- **目录与参考**：放在 `plugins/agy/`，从 `examples/plugins/echo-agent` 起步；完整要求见[插件化规格 §9.2](spec/plugins.md#92-antigravity-插件agy)。
- **接入方式**：开工先实测非 TTY 管道下 `agy -p --input-format stream-json --output-format stream-json` 是否稳定；稳定则优先走 `stream-json`（与 `dsh` 的 JSON-RPC 形成协议对比），卡死或吞输出再切换 `agy acp`。
- **关键注意**：
  - 新建对话时 `agy` 可能迟到返回会话 ID，`init()` 可先返回 `session: null`，后续再补报 `session`。
  - 可声明 `"import": true`，只读 `~/.gemini/antigravity-cli/brain/<ID>/.system_generated/logs/transcript.jsonl` 列出和读取对话，严禁写入 `brain/` 或读写未公开的 SQLite 库。
  - 锁定实测版本并准备离线回放样例与导入样例目录；绝不拉起 `claude`，不碰用户正在用的 Herdr 会话。

### 10.3 微信官方 Bot IM 插件（`weixin`）

- **目录与参考**：放在 `plugins/weixin/`，从 `examples/plugins/local-im` 起步；完整要求见[插件化规格 §9.3](spec/plugins.md#93-微信官方-bot-插件weixin)。
- **接入方式**：对齐腾讯官方 `Tencent/openclaw-weixin` 自绑定协议（`3.x.x`，`POST /ilink/bot/get_bot_qrcode?bot_type=3`、`get_qrcode_status`、`getupdates`、`sendmessage`、`getuploadurl`），不沿用旧版 `GET` 取码接口。
- **关键注意**：
  - 声明 `"wizard": true`，扫码绑定走终端 `rh bot my-weixin weixin`，插件不自带独立登录命令，也不自己写 `config.toml`；`init()` 绝不阻塞等扫码。
  - 微信不支持改消息、按钮、菜单和 Markdown，能力表如实声明 `progress: "append"`、`buttons: false`、`menu.maxItems: 0`、`markdown: null`，核心会自动降级成纯文本编号和中文审批提示。
  - 批次拉取先存 `ctx:<userId>`、逐条 `await ctx.inbound(...)` 拿回执，整批确认后再推进 `sync_buf`；缺 `context_token` 本地拒发（`failed`），网络超时或丢回执返回 `unknown`。
  - 在 `plugins/weixin/` 内置零依赖本地 `mock-weixin-server`，支撑契约测试和零 Key 演示（含未预填 `owner` 的首次 `rh pair` 配对流程）。
