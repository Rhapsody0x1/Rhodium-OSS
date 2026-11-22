# 离线回放样例(零 Key 演示)

`sample.jsonl` 是 dsh SDK JSON-RPC 的离线回放样例:插件的 `config.fixture` 指向它时,
插件不拉起真实 `dsh`,由假对端(`../fixture-peer.ts`)按样例回放,完整走一遍
启动、回合、工具调用、审批、提问、中断恢复、压缩与关闭。未安装 `dsh`、
没有 DeepSeek API Key 时,契约检查与 CI 演示都只用这份样例。

## 样例格式

- 每行一帧,UTF-8,`\n` 结尾;首行是元数据(无 `dir` 字段),必须写明录制用的 dsh 版本。
- `{"dir":"out",...}`:插件当时发给 dsh 的请求(记录帧)。`session/prompt` 的记录帧带
  `match`(当次提示的最后一个文本块),回放按它对帧。
- `{"dir":"in",...}`:dsh 写出的帧——响应(`result` / `error`,记录 `method` 供对帧)、
  通知(`session.status`、`session.event` 等)或 dsh 发来的服务端请求(带 `id`)。

## 怎么重录(升级 dsh 或首次真实录制时)

1. 用自己的账号和便宜模型跑一次真实会话,覆盖这些动作:普通问答、工具调用、
   触发一次审批、触发一次 `ask_user_question`、中途 `/stop` 打断、恢复后继续、`/compact`、退出。
2. 录下 `dsh --profile sdk` 在 stdout 上写出的每一帧,以及插件发出的每个请求,
   按上面的格式整理进 `sample.jsonl`,并在首行写明录制用的 dsh 版本。
3. 清理样例:去掉任何 Key、令牌、真实用户名或个人路径(合规红线 §9.5)。
4. 在**同一个 PR** 里:更新 `../dsh-protocol.ts` 的 `LOCKED_DSH_VERSION` 为实测版本,
   并确认 `bun scripts/plugin-conformance.ts --manifest plugins/dsh/plugin.json
   --config '{"fixture":"./fixtures/sample.jsonl"}'` 全过。

## 与会话 ID 的约定

样例里的会话 ID 固定为 `conf-session-1`(契约检查器与插件单元测试都用它初始化槽位);
子 agent 的子会话用 `sub-agent-9`,用于验证插件只认本槽位会话的推送。
