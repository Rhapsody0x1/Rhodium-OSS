# Antigravity 插件

这篇回答：怎么把 `agy` 接到 Rhodium，以及怎么不用账号和密钥验证插件。

前置阅读：[插件开发指南](../../docs/plugin-guide.md)、[Antigravity 插件规格](../../docs/spec/plugins.md#92-antigravity-插件agy)

## 使用真实 CLI

1. 在仓库根目录运行 `bun install --frozen-lockfile`。安装支持 `agy acp` 的 Antigravity CLI，并由你自己在终端完成登录。插件不代登录。
2. 在本机的 Rhodium 配置里登记插件。`path` 相对于 `config.toml`，也可以用绝对路径。

   ```toml
   [plugins.agy]
   path = "./plugins/agy"
   ```

   Windows 上 `agy.exe` 必须可从 `PATH` 找到。若不在 `PATH`，在 `[programs]` 下把 `agy` 设为 `agy.exe` 的绝对路径。插件不执行 `.cmd` 等脚本包装器。

3. 在看板新建 Antigravity 槽位，把消息发给槽位。需要中断时用 `/stop`。插件用 ACP 创建或续接会话，不读取 Antigravity 的对话文件。这里没有导入旧对话的功能。

插件沿用 CLI 的权限规则，将 ACP 请求送到看板或 IM。它不会替用户选择永久允许。只在隔离环境中，才可以设置 `[plugins.agy.config]` 的 `skipPermissions = "true"`；此时槽位关闭审批才会跳过权限请求。运行中的回合不切换审批模式。

ACP 字符串问答和单选表单受支持。URL 表单、其他字段类型、插话和模型切换未接入。

## 零密钥验证

从仓库根目录运行：

```sh
bun --config=bunfig.ci.toml test ./plugins/agy/agy.test.ts
bun scripts/plugin-conformance.ts --manifest plugins/agy/plugin.json --config '{"fixture":"builtin"}'
```

`fixture` 必须显式指定，避免真实 CLI 出错时被样例掩盖。打包后的契约命令也需要这个参数。`fixtures/` 是基于公开 ACP 契约编写的合成数据，不是真实会话录制。

要在看板或假 IM 里演示，按[本地调试步骤](../../docs/plugin-guide.md#43-用-rh-dev---fake-和看板本地调试)启动隔离实例。把插件 `path` 指向仓库里的 `plugins/agy`，然后在隔离配置中加上：

```toml
[plugins.agy.config]
fixture = "builtin"
```

1. 向 Antigravity 槽位发 `inspect fixture`，可见 `List files` 工具结果和流式回复。
2. 发 `[permission]`，选允许或拒绝；再发一次，用 `/stop` 撤回未回答的审批。
3. 发 `[question]`，选择 `Violet`；样例会回复 `Answer: violet`。

## 选型验证

本机用 Antigravity CLI 1.5.14 做了不登录的管道探测。`stream-json` 的工单示例被 CLI 报为参数错误，调整参数后未收到无凭据输出。`agy acp` 在 stdio 上明确协商到 ACP v1，因此采用 ACP。真实模型回合需由用户在隔离实例中发起；离线测试不调用模型。
