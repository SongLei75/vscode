# BoardSession 与 Copilot Chat

本扩展将 Copilot Chat 的终端操作切换到 `@carizon/board-session` 提供的持久板端 SSH 会话。核心包的 `BoardManager` 管理多块板、租期和相互独立的 SSH 会话；`BoardSession` 负责单会话的 X.509、wolfSSH、PTY、输入输出以及任意 0～N 台跳板。扩展负责参数采集、Hover、通知和 Chat 工具适配。同一块板可以由多个 Chat 使用，每个 Chat 都有独立的 SSH shell。

## 使用

在 Chat 输入栏中点击语音转文字按钮旁的插头按钮。首次连接在 Chat 内逐项填写，按 Enter 或 Next 继续，按 Escape 或 Cancel 取消。输入仅用于扩展操作，不会发送给聊天模型或写入聊天记录；密码使用遮罩字段。隐藏 Chat 或切换 Chat 会清理当前输入流程。

第一步仍选择 **Direct / Baton / JumpServer**；Direct 和 JumpServer 都映射到新的 static Provider，Baton 映射到 baton Provider。板卡管理统一由 npm 包的 BoardManager 完成。

- **Direct**：依次填写板端 host、user、port；host 和 user 留空时分别使用 `192.168.2.62` 和 `root`，port 留空时使用 `22`。板端 X.509 复合 PEM 由 `boardsession.identityFile` 设置提供，不在连接向导中询问；设置为空时使用核心 npm 包内的 `prebuilds/debug.key`。同一扩展 host 中的所有 Chat 共用该 identity。
- **Baton**：先调用 Manager 验证当前内存中的 token；如需重新登录，在 Chat 内填写用户名和密码。登录后查询 Provider 的可预约板卡列表，再通过 Manager 添加板卡。预约、连接参数解析、续约及释放均由 npm 包负责。新版包的 token 只在 Provider 内存保存，不再支持旧版 SecretStorage 的跨宿主重启自动登录；密码不持久化。服务地址仍取自环境变量或 BenchOps 配置。
- **JumpServer**：先填写板端 host、user、port（默认值同 Direct），再按连接顺序填写至少一个跳板的 **host → user → port → password**。第一个跳板 host 不能为空；之后的 host 留空即可结束。跳板 user、port、password 留空时分别使用 `root`、`22`、`123456`。所有手动端口必须为 1～65535 的整数。

所有选择控件都在 Chat 内，支持键盘与取消；板卡列表过长时可滚动。Baton 的 API、时长选项、HIL/container 预约语义和 SSH 映射只存在于核心 npm 包。

连接成功后插头显示激活色，Copilot 可使用：

| 工具 | 作用 |
| --- | --- |
| `board_terminal_run` | 在持久板端 shell 中执行命令；超时返回 `completed: false`，命令继续运行 |
| `board_terminal_send` | 向同一板端 shell 发送输入，默认追加换行 |
| `board_terminal_output` | 读取并消费未读输出 |
| `board_terminal_kill` | 关闭板端 SSH 会话 |

将鼠标停留在连接按钮上即可管理板子：Hover 顶部的 **添加开发板** 沿用上述 Direct、Baton 和 JumpServer 流程。点击板名连接对应板子；再次点击当前 Chat 已连接的板名会关闭该 Chat 的 SSH 并恢复本机工具。切换到另一块板时，扩展先建立新连接，成功后再关闭该 Chat 在旧板上的 SSH。普通断开和切板不会移除板记录或主动释放 Baton 预约。添加成功后自动连接；SSH 失败时已登记的板记录保留，可以重试或释放。√ 和加粗表示当前 Chat 已连接的板子；每块板的名称和 **释放** 操作显示在同一行。

**释放** 对所有板都可用：确认后关闭该板的全部 SSH 会话，再调用资源的释放回调（Baton 板会释放预约），成功后删除记录。释放失败时记录会保留，供用户重试；释放中的资源不可新建连接。

Baton 预约由 BoardManager 自动管理；默认在到期前约 10 分钟开始续约，由 Provider 决定续约时长。默认空闲 10 分钟后，仅带有释放能力的资源自动回收；Static 板卡不会自动释放。过期、释放失败和续约失败会反映到通知和 Hover；扩展关闭时尽力释放剩余管理资源，但宿主退出可能中断异步操作。重启后内存板卡记录不会恢复。

连接意外断开、`board_terminal_kill` 关闭会话、资源释放或过期后，当前 Chat 仍保持板端模式，本机终端工具继续被禁用，避免操作静默落回本机。可通过连接按钮重新连接；需要恢复本机工具时，显式执行 `boardsession.deactivate`。连接仍正常时，也可在 Hover 中点击当前板名断开并恢复本机工具。取消正在执行的板端工具会关闭该 Chat 捕获的 SSH 会话；取消连接流程时，已开始的 SSH 建链会在返回后关闭，当前建链结束前不能重试。

板端模式和工具开关按 Chat 会话分别维护，不是整个 VS Code 窗口共享的状态。板端模式下启用 `board_terminal_*`，并禁用 `run_in_terminal`、`send_to_terminal`、`get_terminal_output`、`kill_terminal`、`terminal_selection`、`terminal_last_command` 和 `vscode_get_terminal_confirmation`。工具服务会在准备和执行前检查会话状态，包括等待用户确认期间发生的模式切换。仅禁用某个扩展工具不会解除本机终端工具的限制。

## 平台与身份配置

核心 npm 包目前支持 **Linux x64 和 Windows x64、Node.js 22+ / Node-API v8**；没有 macOS 或其他架构的原生运行产物，也不参与 Web 扩展构建。扩展运行在 workspace extension host，身份文件路径按该 host 可访问的文件系统解析。扩展不支持 virtual workspace 或 untrusted workspace。

`boardsession.identityFile` 指向一份包含板端私钥和 X.509 证书的复合 PEM。配置后，该扩展 host 中的所有 Chat 使用同一身份；留空时使用核心 npm 包内置的 `prebuilds/debug.key`。内置私钥仅用于内部调试，含该私钥的产物不得公开分发。

## 定向构建

从 `coder/` 仓库根目录通过 Makefile 安装依赖并编译扩展。依赖从 `extensions/boardsession/.npmrc` 配置的私有 npm registry 获取：

```sh
# 安装扩展依赖
make command="npm --prefix extensions/boardsession ci"
# 编译扩展并收集核心包运行时文件
make command="npm --prefix extensions/boardsession run compile"
```

`@carizon/board-session` 作为普通 npm 依赖安装，扩展按包名导入，不引用核心源码或相对 `dist` 路径。定向编译会把生产依赖树放入扩展的 `dist/node_modules/`，其中包含核心包的 worker、原生模块、平台运行时文件、许可证和调试 PEM；不需要在全局构建脚本中维护 `ssh2` 的传递依赖名单。核心包本身的构建、打包和发布在 `board/` 工程中进行。

## 工程接入范围

- `chat/input/actions` 将 Chat 输入栏 action menu 暴露给扩展；action context 只携带会话 URI。
- `_workbench.chat.showInput` / `showPick` / `closeInput` 提供 Chat 内的临时输入控件；切换会话、隐藏 Chat 或取消时会清理控件。
- `_workbench.chat.registerActionHover(actionId, providerCommand, allowedCommands)` / `unregisterActionHover(actionId, providerCommand)` 提供通用动态 Hover。provider 接收 `{ sessionResource }` 并返回 Markdown 内容；主框架只信任注册时允许的命令，不启用 HTML。
- Chat 工具服务提供会话级工具开关和执行前检查；BoardSession 的工具 ID、连接状态及本机终端屏蔽策略均由扩展管理，不在通用工具服务中写入板端业务规则。
- 工程构建只增加扩展编译入口、依赖目录和 native 扩展收集配置；核心包作为私有 registry 上的普通依赖安装。
