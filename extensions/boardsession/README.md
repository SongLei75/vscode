# BoardSession 与 Copilot Chat

本扩展将 Copilot Chat 的终端操作切换到 `@carizon/board-session` 提供的持久板端 SSH 会话。核心包的 `BoardManager` 管理多块板、租期和相互独立的 SSH 会话；`BoardSession` 负责单会话的 X.509、wolfSSH、PTY、输入输出以及任意 0～N 台跳板。扩展负责管理面板、通知和 Chat 工具适配。同一块板可以由多个 Chat 使用，每个 Chat 都有独立的 SSH shell。

## 使用

点击 Chat 输入栏中的开发板连接按钮，在**编辑区**打开“CarizonBoards”面板，面板与发起操作的 Chat 绑定，其他 Chat 的 SSH 独立。无需再在 Chat 输入框内逐项操作，也不会把登录、SSH 密码写进 Chat 记录。

面板根据 `manager.getProviders()` 获取来源，打开时调用各 Provider 的 `manager.login(id)`。需要用户名密码时在对应分组内填写，调用 `manager.login(id, {username,password})`；未登录时不展示该 Provider 的板卡，也不阻塞其他来源或手动添加。没有登录/发现方法的 Provider 通过 Manager 的 no-op/空列表语义处理。标签页可见期间，每秒通过 `manager.listAvailableBoards(id)` 更新已登录来源的候选列表；多个面板共享同一轮查询，慢请求不会重叠。隐藏或关闭最后一个可见管理面板后停止轮询，重新显示时立即查询。当前包括 `static` 和 `baton`：

- **Baton**：登录后直接列出可预约板卡。点击候选板卡调用 `addBoard('baton',{boardId})` 预约并连接；点击已管理板卡名称则连接该板，仅单独的“释放”按钮触发释放确认。候选板与已预约记录按 Provider/候选 ID 关联，避免同名板卡混淆。Baton 认证 token 仅由 npm Provider 在内存中管理，扩展不持久化密码，重启后可能需要重新登录；HTTP API、预约、续约、释放逻辑都在包内。
- **Static**：没有平台登录和可预约目录，在 Provider 分组下方提供“＋ 添加开发板”表单和已添加板卡，不显示独立的 Static 标题或同步状态。默认 host `192.168.2.62`、user `root`、port `22`；不需要跳板时无需展开。可展开 JumpServer 设置，按顺序添加 0～N 级跳板，每级填写 host/user/port/password，默认 user=`root`、port=`22`、password=`123456`。静态板使用 `addBoard('static', {board,jumps})` 登记，单独的“删除”按钮移除记录，不涉及 Baton 预约。

每个 Chat 绑定一块板，不同 Chat 可以使用同一块板，各自拥有独立 SSH。添加成功后自动尝试在当前 Chat 建立 SSH；如果 SSH 失败，Manager 记录仍保留，用户可以再次连接或释放。点击当前已连接板保持连接；切换板卡先建立新 SSH，成功后关闭该 Chat 原来的连接，失败则保留旧连接。释放由 `manager.removeBoard(id)` 关闭该板的所有 SSH 会话；普通断开只关闭当前 Chat 的 `BoardSession`。

连接期间可点击 Chat 连接按钮或面板中的“取消连接”。已开始的 SSH 建链会在返回后清理，结束前不能重复连接，已登记的板记录保留。后台状态更新会保留正在填写的登录、静态板和跳板表单。

连接成功后插头显示激活色，Copilot 可使用：

| 工具 | 作用 |
| --- | --- |
| `board_terminal_run` | 在持久板端 shell 中执行命令；超时返回 `completed: false`，命令继续运行 |
| `board_terminal_send` | 向同一板端 shell 发送输入，默认追加换行 |
| `board_terminal_output` | 读取并消费未读输出 |
| `board_terminal_kill` | 关闭板端 SSH 会话 |

Baton 板卡生命周期由 `BoardManager` 在包内自动管理；扩展仅响应板卡可用状态变化。释放失败时 Manager 保留记录并提供重试机会。扩展关闭时尽力释放剩余资源，但宿主退出可能中断异步操作。

板端 SSH 意外断开、Tool Kill、释放或到期后，当前 Chat **仍保持板端工具隔离模式**，不会自动启用本机终端。`boardsession.deactivate` 命令仍可显式恢复本机工具，管理面板不再提供切回本机按钮。工具调用取消会关闭对应的 SSH，而不影响其他 Chat 对同一板的会话。

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

- `chat/input/actions` 只提供带 Chat Session URI 的连接按钮入口；VSCode 主框架保留每个 Chat 的状态和 Tool Call 执行前隔离检查。
- `BoardManagementUi` 在扩展宿主处理管理状态和操作；Workbench 原生 Editor Pane 负责编辑区布局与表单，通过 VS Code 内部命令通信，不使用 Webview，认证数据不进入 Chat History。
- `BoardConnection` 负责 Chat 到 SSH Session 的绑定及本机/板端工具切换；npm `BoardManager` 负责 Provider 注册、候选板发现、添加/预约、续约、释放。
- 原 Chat 内逐项输入控件已移除。完整编译和端到端测试时可以参考 `coder/test/env.md` 和 `coder/test/board/README.md` 的模拟 Baton 与 GCP PKIX-SSH 测试环境。
