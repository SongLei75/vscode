# BoardSession 与 Copilot Chat

本扩展将 Copilot Chat 的终端操作切换到 `@carizon/board-session` 提供的持久板端 SSH 会话。核心包负责 X.509、wolfSSH、PTY、输入输出以及任意 0～N 台跳板；扩展只负责参数采集、状态和工具适配。

## 使用

在 Chat 输入栏中点击语音转文字按钮旁的插头按钮。首次连接在 Chat 内逐项填写，Enter 或 Next 继续，Escape 或 Cancel 取消。输入不会写入聊天记录，密码使用遮罩字段。

第一步选择 npm 包公开的连接模式：**Direct / Baton / JumpServer**。

- **Direct**：依次填写 host、user、port、X.509 复合 PEM 路径，全部可以留空。默认值为 `192.168.2.62`、`root`、`22` 和安装后的核心 npm 包内 `prebuilds/client-identity.pem`。PEM 后立即连接，不询问跳板。
- **Baton**：npm 校验已有 token；无 token 或失效时在 Chat 内输入 BenchOps 用户名和密码。随后选择板卡和预约时长，npm 完成预约、连接参数解析，再调用相同的 SSH Session API。无需输入网络参数，使用包内调试 identity。当前 OSS 扩展按 API/Auth 地址隔离保存在 extension globalState 中；npm 本身不规定 token 的持久化方式。服务地址由 npm 读取 `BENCHOPS_API_URL`、`BATON_AUTH_URL` 或 `~/.benchops/config.json`。
- **JumpServer**：先填写同样的板端字段，再按真实连接顺序填写 **host → user → port → password**。至少一跳；后续 host 留空结束。其余字段留空分别使用 `root`、`22`、`123456`。所有手动端口必须为 1～65535 的整数。

所有选择控件都在 Chat 内，支持键盘与取消；板卡列表过长时可滚动。Baton 的 API、时长选项、HIL/container 预约语义和 SSH 映射只存在于核心 npm 包。

连接成功后插头显示激活色，Copilot 可使用：

| 工具 | 作用 |
| --- | --- |
| `board_terminal_run` | 在持久板端 shell 中执行命令；超时返回 `completed: false`，命令继续运行 |
| `board_terminal_send` | 向同一板端 shell 发送输入，默认追加换行 |
| `board_terminal_output` | 读取并消费未读输出 |
| `board_terminal_kill` | 关闭板端 SSH 会话 |

再次点击激活的按钮，退出板端模式并恢复本机工具；SSH 会话保留，下次激活直接复用。Baton 只负责当前的“预约板卡并建立 SSH”流程，本扩展不实现预约列表、续期、释放或历史管理。命令面板中的 **BoardSession: Disconnect Board Terminal** 会关闭连接并退出板端模式。

远端意外断线或工具主动关闭会话后，按钮显示断线状态。本机终端工具继续被阻止，避免同一轮对话因断线静默落回本机。点击断线按钮明确退出板端模式；再点击插头可重新连接。执行中的板端工具被取消时关闭其会话；核心包没有独立的取消建链 API，因此取消建链会丢弃并关闭晚到的连接，等待当前建链结束后才允许重试。

板端模式是当前 VS Code 窗口的设置，影响该窗口的 Chat 工具集合。模型发现阶段隐藏本机终端、终端任务和 `execution_subagent`；实际工具执行前再次检查，包括等待确认期间发生的模式切换。禁用扩展工具不会使本机工具绕过这项限制。

## 构建和产物

当前仅支持 **Linux x64、Node.js 22+ / Node-API v8**。没有 Windows、macOS 或其他架构的原生运行产物；也不参与 Web 扩展构建。扩展在本机 UI extension host 运行，PEM 路径相对于本机文件系统。

内部调试复合 PEM 需要预置在 `board-session/prebuilds/client-identity.pem`。该文件被 Git 忽略，但会按内部调试需求打进 npm 包和扩展。含此私钥的产物只用于内部调试，不得公开分发。

从 VS Code 工程根目录执行：

```sh
# 核心独立构建（native + TypeScript）并产出 npm archive
npm --prefix extensions/boardsession run prepare:core

# 编译扩展：同样先构建/打包核心，再通过 npm 安装 archive
npm --prefix extensions/boardsession run compile
```

核心 archive 位于 `packages/carizon-board-session-0.1.0.tgz`。扩展以普通 npm 包名导入，依赖指向该 archive，既不导入核心源码/相对 dist，也不依赖目录软链接。完整工程安装的 `build/npm/postinstall.ts` 在解析本扩展依赖前准备 archive；之后沿用标准扩展编译和打包入口。

构建将 npm 解析的生产依赖树放到 `dist/node_modules/`，保留核心包的 worker、原生模块、匹配的 wolfSSH/wolfSSL 动态库、许可证和调试 PEM。标准 esbuild/vsce 文件收集会包含这些运行文件，排除 `board-session/` 源码、头文件和构建目录。无需在全局构建脚本中维护 `ssh2` 的传递依赖名单。

核心 native 构建使用本目录已提供的 `build/wolfssh`、`build/wolfssl` 头文件和库，支持原有 `WOLFSSH_ROOT`、`WOLFSSL_ROOT` 覆盖；没有修改 wolfSSH 源码或核心会话协议。

## 工程接入范围

- `chat/input/actions` 将已有 Chat 输入栏 action menu 暴露给扩展；序列化的 action context 只携带会话 URI。
- 内部 `_workbench.chat.showInput` / `showPick` / `closeInput` 命令提供 Chat 内的临时输入控件，切换会话、隐藏 Chat 或取消时清理控件。连接顺序、默认值及密码处理仍由本扩展决定。
- `languageModelTools.replaces` 声明当前工具的 `when` 条件成立时必须隐藏且禁止执行的工具 ID。通用工具服务不包含 BoardSession 名称、连接状态或终端业务规则。
- 工程构建仅增加扩展入口、native 分类和安装前的核心打包步骤。

## 验证

保持扩展定向构建，未执行全量 VS Code compile。现有 terminal replacement 机制和工具定义未修改。
