# 插件目录

这篇回答：`plugins/` 目录放什么、核心怎么加载里面的插件，以及从哪里开始写插件。

前置阅读：[插件开发指南](../docs/plugin-guide.md)

- 这个目录放组员开发的插件，一个插件占一个子目录（例如 `plugins/dsh/`、`plugins/agy/`、`plugins/weixin/`）。
- Rhodium 启动时会自动扫描配置文件旁边的 `plugins/` 目录，只加载这一层包含 `plugin.json` 的普通子目录。
- 像本文件这样的普通文件、`.` 开头的目录和符号链接都会被跳过，不会被当成插件。
- 开发步骤、清单字段、本地调试、契约检查器和提 PR 流程请看 [插件开发指南](../docs/plugin-guide.md)。
