# BoardSession 与 VS Code / Copilot Chat 集成目标

> 本文记录项目目标、模块边界与实施约束，不代表当前代码已经实现或验证全部要求。以后审查和修改以此为准，避免为解决局部问题扩大 VS Code 原生代码改动范围。

## 1. 总体目标与最小侵入原则

BoardSession 的目标不是只服务当前 OSS VS Code，而是提供一套可被官方 VS Code 扩展、OSS VS Code、第三方 IDE 等宿主复用的板卡获取与 SSH 会话能力。

尽量不修改 VS Code 官方原生代码。优先以独立的 `@carizon/board-session` npm 包和宿主扩展适配层实现功能，使以后同步上游分支时的冲突、重做量和额外依赖最小。只有扩展 API 确实无法满足、且有明确必要时，才允许增加小而集中的原生改动。

VS Code 主框架只允许因以下三类需求产生必要改动：

1. **Chat 按钮 UI 与通用交互桥接**：在 Copilot Chat 输入栏提供 BoardSession 入口，并允许扩展在 Chat 内收集用户输入。
2. **BoardSession npm 包 / 扩展构建接入**：让完整 VS Code 构建能正确构建、安装并打包 BoardSession 及 native 运行产物。
3. **terminal tool call 切换与执行保护**：Board 模式激活时用 `board_terminal_*` 替换本机 terminal 工具，并保证本机工具不能误执行；退出 Board 模式后恢复原生 terminal 工具。

除这三类之外，板卡业务逻辑、Baton 平台逻辑、SSH 参数解析、预约、认证、默认值、连接状态等都不得进入 VS Code 通用主框架。

## 2. 模块职责

### 2.1 核心 npm 包：`@carizon/board-session`

目录当前为：

```text
extensions/boardsession/board-session/
```

npm 包负责两层能力：

1. **资源 / 连接方式层**
   - 声明当前支持的业务连接方式。
   - Direct：调用方直接提供板端信息。
   - Baton：负责 Baton 认证相关 API、板卡查询、预约、预约结果解析，并把 Baton 返回的数据解析成 BoardSession 可使用的连接参数。
   - JumpServer：调用方显式提供板端与 1～N 个 jump server，用于复杂环境和开发调试。

2. **统一 SSH Session 层**
   - 利用 ssh2 建立 0～N 个跳板的 TCP forwarding。
   - 最终使用本地 wolfSSH / X.509 与板端建立持久 SSH Session。
   - 提供统一的 `open / exec / send / read / close` 能力。

**三种模式只决定“连接参数如何获得”，不能演化成三套 SSH Session 实现。**

最终都必须归一成：

```ts
interface OpenOptions {
  board: BoardAddress;
  jumps?: JumpAddress[];
}
```

并复用现有：

```ts
BoardSession.open({ board, jumps })
```

现有 0～N 跳 transport、wolfSSH native addon、persistent shell、命令完成检测等实现作为回归基线，不因 Baton 接入而重写。

### 2.2 IDE / VS Code 扩展适配层

当前目录为：

```text
extensions/boardsession/
```

扩展只负责：

- 用户点击 BoardSession 按钮后的 UI 流程。
- 从 npm 包查询支持的连接方式。
- 根据用户选择展示对应输入/选择界面。
- 将用户输入传给 npm 包。
- 保存 IDE 自己需要保存的 UI 状态或 token（如果最终采用宿主存储）。
- 管理 Board 模式 active / connected / connecting 状态。
- 注册 `board_terminal_*` tools。
- 在建立 Session 后调用统一的 BoardSession Session API。

扩展**不得复制 Baton HTTP API、预约算法、Baton 返回值到 SSH 参数的映射逻辑**。这些属于 npm 包，使官方 VS Code、OSS VS Code 和第三方 IDE 能共享同一能力。

### 2.3 VS Code 主框架

只提供前述三类通用机制：

- Chat 输入栏按钮位置与通用 Chat 内输入能力。
- BoardSession 扩展 / npm 包的必要构建入口。
- Language Model Tools 的通用 replacement / fail-closed 机制。

主框架内不得出现 `baton`、板卡型号、预约时长、`123456`、板子 IP 等 BoardSession 业务判断。

## 3. 连接方式模型

用户点击 BoardSession UI 入口后，第一步不是立即询问 Host，而是由宿主向 npm 包查询当前支持的业务连接方式。

目标接口语义类似：

```ts
type ConnectionMode = 'direct' | 'baton' | 'jumpserver';

getConnectionModes(): readonly ConnectionMode[];
```

具体命名可在实现时保持简单，但必须满足：

- UI 不自己写死“当前一定支持哪几种模式”。
- npm 包可以明确返回当前构建支持的模式。
- 当前目标模式为：
  1. Direct
  2. Baton
  3. JumpServer
- 模式顺序应优先面向普通用户：Direct、Baton、JumpServer。
- JumpServer 属于高级 / 调试入口，不是 Baton 的实现方式，也不是普通用户的主要流程。

建议 UI 文案：

```text
连接方式
1. Direct        直接连接板卡
2. Baton         从 Baton 预订并连接板卡
3. JumpServer    手工指定板卡和跳板（高级）
```

## 4. Direct 模式

Direct 表示目标板卡从当前运行 BoardSession 的环境可直接访问，不使用任何 jump server。

选择 Direct 后，只收集当前已有的板端参数：

1. Board IP / Host
2. Board User
3. Board Port
4. X.509 PEM File

默认值继续保持：

- host：`192.168.2.62`
- user：`root`
- port：`22`
- X.509 PEM：npm 包内附带的 internal debug identity；实际路径按 npm 打包后的可解析位置处理。

要求：

- 保留当前参数检查。
- 保留当前输入顺序。
- 用户留空时继续使用默认值。
- **Direct 模式结束板端参数输入后立即连接。**
- Direct 模式不得继续询问 Jump 1 / Jump 2 等信息。
- 最终解析结果等价于：

```ts
{
  board: { host, username, port },
  jumps: []
}
```

## 5. Baton 模式

### 5.1 用户语义

Baton 模式面向正常业务用户。

用户关心的是：

- 我要使用哪类 / 哪块板卡，例如 ACAR、CCAR 或平台当前提供的其他板卡。
- 我要预约多久。

用户不应关心：

- Baton 分配到哪台 server。
- server 的 IP。
- SSH host port。
- jump server 用户名和密码。
- 板卡内网 IP 如何组合成最终 SSH 链路。

这些都由 `@carizon/board-session` 的 Baton 能力根据平台返回值处理。

### 5.2 Baton 用户流程

选择 Baton 后，宿主 UI 按以下逻辑工作：

```text
选择 Baton
   ↓
查询是否已有可用 token
   ↓
有 token → npm 校验 token
   ↓
无 token / token 失效
   ↓
要求用户输入 Baton/BenchOps 用户名、密码
   ↓
npm 登录并返回 token / 用户信息
   ↓
查询可预约板卡
   ↓
UI 展示板卡列表，用户选择
   ↓
UI 展示可选预约时长，用户选择
   ↓
npm 提交预约
   ↓
npm 解析 Baton 返回的 server / board / port 信息
   ↓
npm 生成统一 { board, jumps }
   ↓
现有 BoardSession.open()
   ↓
返回持久板端 Session
```

Baton 模式**不再要求用户手工填写 Board Host、Board User、Board Port、Jump Host、Jump Password 等 SSH 网络参数**。

### 5.3 旧 Baton 实现作为迁移参考

旧的 `board-reservation-vscode-only.ts` 已验证过以下业务结构，迁移时应优先复用其 API 语义，而不是重新猜测 Baton 协议：

认证：

```text
POST /api/system/sso/login
jwt_token
```

token 校验：

```text
GET /api/boardops/v1/sys-dict?type=board_type
```

可预约板卡：

```text
POST /api/boardops/v1/board/reservable/me/query
```

预约：

```text
POST /api/boardops/v1/reservation
```

SSH host port：

```text
GET /api/boardops/v1/board/{boardBid}/default-host-port
```

当前旧代码中已有的关键数据包括：

```ts
Board {
  b_id
  device_code
  type
  type_name?
  project_code?
  vehicle_model?
  hardware_platform?
  server: {
    b_id
    ip_addr
  }
  sub_boards?: [{
    b_id
    ip_addr
  }]
}

CachedReservation {
  reservationBid
  boardBid
  deviceCode
  startAt
  endAt
  durationMinutes
  sshHost
  sshPort
  sshUsername
  sshPassword
  subBoardIp?
}
```

旧流程预约成功后目前得到 / 推导的 SSH 数据为：

- `sshHost = selected.server.ip_addr`
- `sshPort = Baton default-host-port 中 name=ssh 的 host port，默认 22`
- `sshUsername = root`
- `sshPassword = 123456`
- `subBoardIp = selected.sub_boards[0].ip_addr`

这些信息足以作为 Baton provider 生成现有 BoardSession `OpenOptions` 的输入。具体 HIL / container 网络差异继续由 Baton provider 根据平台返回数据统一解析，IDE 层不得复制这套映射。

### 5.4 预约时长

旧实现当前使用：

- 1 小时：60 分钟
- 2 小时：120 分钟
- 4 小时：240 分钟
- 8 小时：480 分钟
- 24 小时：1440 分钟

时长选项应由 npm 的 Baton 能力对外提供，宿主 UI 只负责展示和返回用户选择，避免不同 IDE 各维护一份业务常量。

### 5.5 Baton API 在 npm 包中的边界

Baton HTTP/API 实现迁入 `@carizon/board-session`，但不能让 npm 包依赖 VS Code API。

npm 包需要提供 UI 无关的能力，语义至少覆盖：

```ts
BatonClient.validateToken(token)
BatonClient.login(username, password)
BatonClient.listAvailableBoards(token)
BatonClient.listDurations()
BatonClient.reserve(token, boardId, duration)
```

具体类名 / 方法名可以在实现时压缩，但职责必须留在 npm 包。

token 的**校验和使用**属于 npm；token 的**持久化位置**不能写死成 VS Code `SecretStorage`。

最小实现优先允许宿主传入已有 token，并由宿主决定如何持久化：

```text
VS Code      → SecretStorage / extension storage
第三方 IDE   → 自己的 credential store
CLI / test   → 环境变量或调用方内存
```

这样 npm 包保持宿主无关。

配置来源可迁移旧实现的约定：

- `BENCHOPS_API_URL`
- `BATON_AUTH_URL`
- `~/.benchops/config.json`
- 默认 BoardOps URL：`https://board.carizon.work`
- 默认 Auth URL：`https://auth.carizon.work`

### 5.6 Baton 与 SSH 层的衔接

Baton provider 的最终产物必须是现有连接模型，而不是让 transport 认识 Baton。

语义上：

```text
Baton reservation
   ↓
ResolvedBoardConnection
   ↓
{
  board: {...},
  jumps: [...]
}
   ↓
BoardSession.open()
```

通常 Baton 当前业务会解析成：

```text
IDE / Node
   ↓
Baton 返回的 server（1 个 jump server）
   ↓
板卡内网 IP
```

但底层仍沿用现有 0～N jump 模型，不把 Baton 写死成“永远只能一跳”。

## 6. JumpServer 模式

JumpServer 是显式手工配置模式，用于：

- 开发调试。
- 非 Baton 管理的复杂网络。
- 未来需要手工测试 1～N 跳的场景。

选择 JumpServer 后：

1. 先输入板端信息：
   - Board Host
   - Board User
   - Board Port
   - X.509 PEM
2. 然后按真实连接顺序输入 1～N 个 jump server：
   - Jump Host
   - Jump User
   - Jump Port
   - Jump Password / Private Key（按当前支持能力）
3. Jump Host 留空表示结束 jump 列表并开始连接。

当前默认值继续保持：

- Board host：`192.168.2.62`
- Board user：`root`
- Board port：`22`
- Jump user：`root`
- Jump port：`22`
- Jump password：`123456`

该模式保留当前已有的 0～N jump 参数能力，但 UI 至少要求 1 个 jump 才符合“JumpServer 模式”语义；如果用户不需要 jump，应选择 Direct。

最终仍调用：

```ts
BoardSession.open({
  board,
  jumps,
})
```

## 7. UI 与 npm 的职责分离

### UI / IDE 应负责

- 显示 BoardSession 入口按钮。
- 调用 npm 查询 connection modes。
- 显示模式选择。
- Direct / JumpServer：显示输入框并收集手工参数。
- Baton：在 npm 返回需要登录时询问用户名密码。
- Baton：展示 npm 返回的可预约板卡列表。
- Baton：展示 npm 返回的预约时长列表。
- 显示连接 / 预约进度、错误与取消状态。
- 将最终 Session 接到 IDE 的 terminal tool adapter。

### npm 包应负责

- 支持哪些 connection modes。
- Direct / JumpServer 参数类型和最终统一连接。
- Baton API URL / HTTP 请求。
- token 有效性检查。
- Baton 登录。
- 可用板卡查询。
- 创建预约并解析本次 SSH 连接所需数据。
- Baton 数据到 `OpenOptions` 的映射。
- 0～N jump TCP forwarding。
- wolfSSH/X.509 Session。
- persistent shell 与终端 I/O。

### VS Code 主框架不得负责

- Baton 登录。
- Baton token。
- Baton REST API。
- 板卡类型。
- 预约时长。
- `123456` 默认密码。
- Board / Jump 的具体输入顺序。
- Baton 返回值到 SSH 参数的映射。

## 8. Copilot Chat UI 流程

当前继续采用已确定的方案 B：保留一个小而通用的 Chat 内输入桥接，不为了 BoardSession 参数采集引入 Chat Participant / 协作者模式。

点击按钮后的目标流程变为：

```text
点击 BoardSession
   ↓
npm.getConnectionModes()
   ↓
Chat 内选择：
Direct / Baton / JumpServer
   │
   ├─ Direct
   │    ↓
   │   Host → User → Port → PEM
   │    ↓
   │   connect
   │
   ├─ Baton
   │    ↓
   │   token 校验 / 登录
   │    ↓
   │   选择板卡
   │    ↓
   │   选择预约时长
   │    ↓
   │   reserve + resolve + connect
   │
   └─ JumpServer
        ↓
       Board Host → User → Port → PEM
        ↓
       Jump 1 Host → User → Port → Auth
        ↓
       Jump N ...
        ↓
       connect
```

为支持 Baton 的列表选择，现有通用 Chat bridge 除文本输入外需要增加**通用单选能力**，但不得加入 Baton 专用 UI：

```ts
_workbench.chat.showInput(...)
_workbench.chat.showPick(...)
```

或等价的统一 prompt API。

主框架只接收通用：

- id
- title
- choices
- placeholder
- password

并返回选中项 / 文本；不理解 Board、Baton 或预约时长。

## 9. terminal tool call 切换

这一部分保持当前目标不变。

未激活 Board 模式：

```text
Copilot Agent
   ↓
原生 terminal tools
   ↓
运行 VS Code 的本机
```

Board 模式激活：

```text
Copilot Agent
   ↓
board_terminal_*
   ↓
当前 BoardSession
   ↓
目标板卡
```

要求：

- 模型正常工具发现接口中，被 `replaces` 覆盖的本地 terminal tool 不再提供。
- 即使旧请求或其他路径直接调用被替换的原生 terminal tool，执行前也必须 fail closed。
- 再次点击按钮退出 Board 模式后恢复本机 terminal tools。
- 模式切换不能改变或复制 Baton / SSH 业务逻辑。

## 10. Session 与 Reservation 生命周期

Board 模式、SSH Session 和 Baton Reservation 是三个不同状态，不应混为一个布尔值。

### Board 模式

表示 Copilot terminal tool 当前指向板子还是本机。

### SSH Session

表示当前是否有可复用的 BoardSession 持久连接。

当前允许：

```text
Board mode active
   ↓ 点击按钮
Board mode inactive
SSH session 暂时仍可保留
   ↓ 再点击
复用已有 session
```

### Baton Reservation

表示平台上的预约资源生命周期。

退出 Board mode 或关闭 SSH Session 都不调用额外的 Baton 预约管理 API。

本次不实现 Baton 预约列表、续期、释放或历史管理；旧代码中这些能力仅作为预约流程的参考，不迁移到 npm。

## 11. 构建与 npm 包独立性

完整 VS Code 工程构建时，应先将核心 npm 包独立构建并打包；IDE 扩展通过 npm 包公开 API 接入，不从内部 `src` / `dist` 做相对导入。

Baton 新增代码属于 npm 的纯 Node.js / TypeScript 能力，不应加入 VS Code build 业务特判。

构建目标继续满足：

- native worker / addon / wolfSSH / wolfSSL 正确打包。
- Baton provider 的 JS / 类型定义随 npm 一并提供。
- IDE 适配层不复制 npm 源码。
- Linux x64 当前作为已验证平台；其他平台按实际 native 产物逐步支持。

## 12. 实施计划

### Phase 1：扩展 npm 公共模型，不动 wolfSSH transport

1. 新增 connection mode 描述。
2. 保留现有 `BoardSession.open({ board, jumps })` 兼容性。
3. 新增 Baton 类型与 API client。
4. 将旧 `BoardService` 中 HTTP 相关代码迁入 npm：
   - config
   - login / token validation
   - available boards
   - reservation
   - default host ports
5. 增加 Baton reservation → `OpenOptions` 的单一映射函数；不引入预约列表、续期、释放等管理能力。
6. 不修改现有 0～N jump transport 算法，除非迁移测试证明已有接口无法承载 Baton 返回值。

### Phase 2：修改 VS Code BoardSession 扩展流程

1. 点击按钮后先读取 npm 支持的 connection modes。
2. 增加 Direct / Baton / JumpServer 选择。
3. Direct 删除 jump 输入步骤，其余保持现有默认值和校验。
4. 将当前“板端 + 0～N jump 一次性输入”重命名 / 收敛为 JumpServer 高级模式。
5. Baton 流程只处理 UI：
   - token 存取。
   - 无有效 token 时询问用户名密码。
   - 展示可预约板卡。
   - 展示预约时长。
   - 调 npm reserve/connect。
6. Session 成功后沿用现有 Board mode 与 terminal tool replacement。

### Phase 3：补齐通用 Chat 选择 UI

现有 `_workbench.chat.showInput` 继续用于文本输入。

新增最小的通用 choice/pick bridge，使模式、板卡、预约时长都能在 Chat 视图内点击选择。

要求：

- 通用 UI，不出现 BoardSession 业务字段。
- 支持取消。
- Chat 切换 / 隐藏时正确清理。
- 不引入 Chat Participant。
- 不扩展为通用表单框架，够当前 Direct/Baton/JumpServer 使用即可。

### Phase 4：真实环境验收

至少覆盖：

1. Direct：默认值 / 自定义参数 → 真实板卡或既有 GCP 模拟目标。
2. Baton：
   - 无 token → 登录。
   - 有有效 token → 不重复登录。
   - token 失效 → 重新认证。
   - 拉取可用板卡。
   - 用户选择板卡。
   - 用户选择时长。
   - 预约成功。
   - Baton 返回信息正确解析为 jump + board。
   - 通过同一 BoardSession Session 执行命令。
3. JumpServer：
   - 1 jump。
   - 2 jumps，作为高级能力回归。
4. Board mode：
   - active 时本地 terminal tools 被过滤并 fail closed。
   - inactive 时恢复本机 terminal。
5. 异常：
   - 用户取消。
   - 登录失败。
   - 无可预约板卡。
   - 预约冲突。
   - SSH 建链失败。
   - 预约成功但 SSH 失败时不得伪装成“未预约”。
   - Board mode 切换不调用额外的 Baton 预约管理 API。

## 13. 验收标准

### Direct

- 用户先选择 Direct。
- 只输入板端参数。
- 不出现 Jump 输入。
- 默认值、参数校验和连接行为与当前版本一致。

### Baton

- 用户先选择 Baton。
- 用户不输入 server IP、board IP、jump user、jump password、SSH host port。
- token 有效时直接进入板卡选择。
- token 无效时完成认证后继续。
- 板卡和预约时长由 npm 返回，UI 展示。
- 预约成功后 npm 自动解析连接参数。
- 最终仍使用同一个 `BoardSession.open()` / persistent shell。
- 用户执行 `检查分区信息` 等请求时命令实际落在预订的板子上。

### JumpServer

- 用户先选择 JumpServer。
- 保留显式 1～N jump 输入和当前默认值。
- 作为复杂场景 / 开发调试能力，不干扰普通 Direct / Baton 流程。

### 架构

- Baton API 不存在于 VS Code 主框架。
- Baton HTTP/API 逻辑不重复存在于多个 IDE 扩展。
- 三种模式最终共用现有 SSH Session 层。
- VS Code 主框架改动仍只属于 UI、Build、terminal tool replacement 三部分。
- 不因 Baton 新需求扩大 wolfSSH/native/transport 的职责。
