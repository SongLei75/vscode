# BoardSession 与 Copilot Chat

本扩展将 Copilot Chat 的终端操作切换到 `@carizon/board-session` 提供的持久板端 SSH 会话。核心包负责 X.509、wolfSSH、PTY、输入输出以及任意 0～N 台跳板；扩展只负责参数采集、状态和工具适配。

## 使用

在 Chat 输入栏中点击语音转文字按钮旁的插头按钮。首次连接在 Chat 内逐项填写，Enter 或 Next 继续，Escape 或 Cancel 取消。输入不会写入聊天记录，密码使用遮罩字段。

板端依次填写 host、user、port、X.509 复合 PEM 路径，全部可以留空。默认值为 `192.168.2.62`、`root`、`22` 和安装后的核心 npm 包内 `prebuilds/client-identity.pem`。

随后按实际连接顺序逐台填写跳板的 **host → user → port → password**。host 留空直接结束跳板列表，支持直连；其余字段留空分别使用 `root`、`22`、`123456`。端口必须为 1～65535 的整数。

连接成功后插头显示激活色，Copilot 可使用：

| 工具 | 作用 |
| --- | --- |
| `board_terminal_run` | 在持久板端 shell 中执行命令；超时返回 `completed: false`，命令继续运行 |
| `board_terminal_send` | 向同一板端 shell 发送输入，默认追加换行 |
| `board_terminal_output` | 读取并消费未读输出 |
| `board_terminal_kill` | 关闭板端 SSH 会话 |

再次点击激活的按钮，退出板端模式并恢复本机工具；SSH 会话保留，下次激活直接复用。命令面板中的 **BoardSession: Disconnect Board Terminal** 会关闭连接并退出板端模式。

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
- 内部 `_workbench.chat.showInput` / `closeInput` 命令提供 Chat 内的临时输入控件，切换会话、隐藏 Chat 或取消时清理控件。连接顺序、默认值及密码处理仍由本扩展决定。
- `languageModelTools.replaces` 声明当前工具的 `when` 条件成立时必须隐藏且禁止执行的工具 ID。通用工具服务不包含 BoardSession 名称、连接状态或终端业务规则。
- 工程构建仅增加扩展入口、native 分类和安装前的核心打包步骤。

## 验证

工作台类型检查、扩展类型检查、构建脚本类型检查，以及现有 `LanguageModelToolsService` 测试中的 replacement cases 覆盖工具切换和确认期间的竞争条件。实际 UI 检查覆盖按钮位置、字段顺序、默认值、非法端口重试、密码遮罩和取消。适配层还通过受控核心 API 验证多跳参数、连接复用、工具调用、断线和取消后关闭晚到连接。

受当前环境内存限制，未执行完整 VS Code 工程构建；只执行扩展定向构建和相关检查。

此次交付按约定不验证实板交互链路，以需求与代码审查、定向构建、工具服务测试、适配层检查和产物检查作为验收范围。实板直连和多跳尚未验证；后续有可达的板子及跳板路线时，可用核心包原有 `scripts/functional.mjs` 验证实际 SSH。
