# 微信官方 Bot 插件

这篇回答如何安装、绑定和离线验证微信 IM 插件。

前置阅读：[插件开发指南](../../docs/plugin-guide.md)、[插件化规格 §9.3](../../docs/spec/plugins.md#93-微信官方-bot-插件weixin)。

## 绑定 Bot

从仓库运行时，将 `plugins/weixin` 放在 Rhodium 扫描的插件目录中，或按开发指南在 `[plugins.weixin]` 设置 `path`。插件启动命令需要 Bun。也可以在插件目录运行 `bun run build`，复制 `dist/weixin.js`、`plugin.json` 和 `icon.svg` 到部署目录，并把清单的入口改为 `dist/weixin.js`（保留 `dist/` 目录时）。

在终端运行 `rh bot my-weixin weixin <工作区/槽位>`，用微信扫码，按手机和终端提示确认。然后在微信私聊 Bot 发送配对码。运行 `rh pair my-weixin --list` 查看配对结果。

插件按腾讯 `openclaw-weixin` 的 `ffc7ae16` 自绑定协议收发私聊。微信消息走纯文本，选项和审批由 Rhodium 渲染。出站消息依赖微信入站消息附带的会话令牌。缺少令牌时请先在微信里向 Bot 发一条消息。

## 零 Key 验证

在仓库根目录运行：

```sh
bun --config=bunfig.ci.toml test ./plugins/weixin/weixin.test.ts
bun plugins/weixin/conformance.ts
```

契约脚本启动仅监听回环地址的模拟服务，向仓库契约检查器传入 `--manifest plugins/weixin/plugin.json` 和模拟配置，结束时关闭服务。

要在 Linux 的 `systemd --user` 会话中跑完整演示，先按开发指南构建 Rhodium 和 holder，再运行：

```sh
bun plugins/weixin/demo.ts
```

脚本以全新配置启动隔离实例，从 `rh pair` 取码，经模拟微信注入配对码，检查主窗口、编号选择、允许与拒绝、重启后恢复游标和主动回推。临时工作区和进程由脚本清理。

也可在隔离环境中用 `bun plugins/weixin/mock-weixin-server.ts 18080` 启动模拟服务。将 Bot 的 `token` 设为 `mock-weixin-token`，`baseUrl` 设为 `http://127.0.0.1:18080`，`cdnBaseUrl` 设为 `http://127.0.0.1:18080/c2c`。向 `POST /mock/inbound` 提交 JSON 数组，例如 `[{"id":1,"text":"<配对码>"}]`，每条消息使用不同 ID。默认模拟发送者为 `conf-user-1`。通过 `GET /mock/sent` 查看 Bot 发出的消息。用向导时，将服务地址写进 `[plugins.weixin.config]`，模拟验证码为 `123456`。
