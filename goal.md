# BoardSession 多板管理与生命周期目标

> 本文定义下一阶段 BoardSession 的目标方案与修改边界，不代表当前代码已经实现。
>
> 实施原则：**最小化修改、职责边界清晰、非必要不侵入 VS Code 主框架、先完成功能、不做过度设计、不编写单元测试。**

## 1. 目标

当前 Direct / Baton / JumpServer 已经统一归一到：

~~~ts
BoardSession.open({ board, jumps })
~~~

下一阶段需要解决的是“长期管理多块板”，而不是再增加一种 SSH 实现。需要支持：

- 同时保留 A/B 多块可管理板并来回切换。
- Direct 板暂时断开后仍保留配置，之后可重新连接。
- Baton 板显示剩余预约时间、续约、主动释放。
- Baton 板到期后自动从本地 BoardManager 清理并通知。
- 当前没有可管理板时，点击现有 BoardSession 主按钮直接进入 Add Board。
- 仍然只维护一个活动 SSH Session，不为每块板长期保留后台 SSH。

核心必须区分三件事：

~~~text
ManagedBoard
    = 当前可管理的一块板

BoardSession
    = 当前真实存在的一条 SSH Session

Current Board
    = 主按钮和下一次连接当前指向的 ManagedBoard
~~~

三者不能继续混成一个 active 布尔状态。

---

## 2. ManagedBoard 保持纯数据

公开结构保持最小：

~~~ts
interface ManagedBoard {
    id: string;
    name: string;
    connection: OpenOptions;

    // null = 无租期，例如 Direct / JumpServer
    // number = 绝对过期时间，例如 Baton reservation.end_at
    expiresAt: number | null;
}
~~~

明确不增加：

~~~text
source
type
originLabel
renewable
remainingTime
~~~

理由：

- UI 不需要知道来源是 Direct、Baton 还是未来其他平台。
- 是否显示剩余时间只需判断 expiresAt 是否为 null。
- remainingTime 必须动态计算，不应保存一份不断过期的状态。
- 是否支持续约由内部生命周期能力决定，不再维护重复的 renewable 字段。
- 避免未来新增平台后到处扩展 source/type 分支。

剩余时间：

~~~ts
remainingMs =
    board.expiresAt === null
        ? null
        : board.expiresAt - Date.now();
~~~

不使用 -1 表示永久，避免和“已经过期的负值”混淆。

---

## 3. 生命周期能力由 BoardManager 内部保存

ManagedBoard 不保存函数。

BoardManager 内部额外保存：

~~~ts
interface BoardLifecycle {
    renew?: (minutes: number) => Promise<number>;
    release?: () => Promise<void>;
}
~~~

renew 返回新的绝对 expiresAt。

### Direct / JumpServer

~~~text
expiresAt = null
lifecycle = {}
~~~

主动删除时：

1. 关闭当前 SSH（如果这块板正在连接）。
2. 从 BoardManager 删除记录。

不注册一个空 release callback。

### Baton

~~~text
expiresAt = reservation.end_at

lifecycle = {
    renew,
    release
}
~~~

主动删除时：

1. 关闭当前 SSH（如果正在连接）。
2. 调用 Baton release API。
3. 删除 ManagedBoard。

续约时：

1. 调用 Baton renew API。
2. 更新 expiresAt。

下一阶段只因为明确需求重新增加 Baton 的：

~~~text
renew reservation
release reservation
~~~

仍然不搬回旧实现中的：

~~~text
listReservations
sub 命令体系
完整 reservation 管理
历史 reservation 管理
其他无关 Baton 管理能力
~~~

---

## 4. BoardManager 必须属于核心 npm

多板生命周期、当前板、SSH Session 管理属于：

~~~text
extensions/boardsession/board-session/
@carizon/board-session
~~~

而不是 OSS VS Code extension。

原因是官方 VS Code 插件、OSS VS Code、第三方 IDE 都需要共享同一套生命周期能力。

BoardSession 类继续只负责单条 SSH Session，不把多板管理塞进现有 Session 类。

推荐新增职责单一的：

~~~text
board-session/src/manager.ts
~~~

首版 API 语义控制在：

~~~ts
class BoardManager {
    refresh(): Promise<BoardSnapshot>;

    addBoard(
        board: ManagedBoard,
        lifecycle?: BoardLifecycle,
    ): void;

    removeBoard(id: string): Promise<void>;

    renewBoard(
        id: string,
        minutes: number,
    ): Promise<void>;

    setCurrentBoard(id: string): Promise<void>;

    getCurrentBoard(): ManagedBoard | undefined;

    connectCurrent(): Promise<BoardSession>;

    disconnectCurrent(): Promise<void>;

    get connected(): boolean;
}
~~~

具体命名可以微调，但不要扩展成完整资源调度框架。

内部首版只需要：

~~~text
boards
currentBoardId
activeSession
~~~

保持：

~~~text
activeSession != null
=> activeSession 属于 currentBoardId
~~~

同一时间只维护一个真实 SSH Session。

---

## 5. refresh 与过期清理

因为查询时会自动清理过期板，不使用语义上纯读的 list()，统一使用：

~~~ts
manager.refresh()
~~~

返回：

~~~ts
interface BoardSnapshot {
    boards: Array<{
        id: string;
        name: string;
        expiresAt: number | null;
        remainingMs: number | null;
        current: boolean;
        connected: boolean;
    }>;

    removedExpired: Array<{
        id: string;
        name: string;
    }>;
}
~~~

行为：

~~~text
expiresAt == null
    -> 保留

expiresAt > now
    -> 保留，动态计算 remainingMs

expiresAt <= now
    -> 如果正在连接则关闭 SSH
    -> 删除 ManagedBoard
    -> 加入 removedExpired
~~~

自然过期与主动删除必须区分：

~~~text
removeBoard()
    -> 主动删除
    -> lifecycle.release() if present

refresh() 发现已自然过期
    -> 只清理本地状态
    -> 不再调用 release
~~~

Core npm 不弹 UI，只返回 removedExpired。

OSS extension 再提示：

~~~text
已删除一条过期的板子记录：CCAR
~~~

---

## 6. 切换板卡不做资源锁

本阶段不实现：

~~~text
Conversation lock
Agent request lock
pending tool transaction
跨 toolcall 切板保护
~~~

建议用户在一次 Agent 工作完成后切换板卡。

如果用户在同一轮 LLM 工作中强行切换：

~~~text
上一条 toolcall 可能在 A
下一条 toolcall 可能在 B
~~~

由用户自行承担上下文与执行目标不一致的风险。

### setCurrentBoard 行为

未连接时：

~~~text
current = A
setCurrentBoard(B)
-> current = B
~~~

A 正在连接，用户选择 B：

~~~text
close A SSH
current = B
open B SSH
board_terminal_* 保持激活
~~~

用户再次点击当前同一块板：

~~~text
return OK
不重复断开/重连
~~~

切板过程中不得静默落回本机 terminal。

---

## 7. 主按钮最终语义

继续复用当前唯一 BoardSession 主按钮，不新增第二个常驻管理按钮。

### 当前有板但未连接

~~~text
connectCurrent()
-> 切换到 board_terminal_*
~~~

### 当前已经连接

~~~text
恢复原生 terminal tools
disconnectCurrent()
~~~

SSH 关闭，但 ManagedBoard 与 currentBoardId 保留。

不再维持“退出 Board mode 但 SSH 长期保留”的中间态。

### 当前没有板

~~~text
Add Board
-> addBoard()
-> 新板成为 current
-> connectCurrent()
-> board_terminal_*
~~~

第一次使用仍然只需要点击现有主按钮。

---

## 8. Add Board

继续沿用已有三个入口：

~~~text
Direct
Baton
JumpServer
~~~

### Direct

extension 收集 Board host/user/port/X.509 identity，生成：

~~~text
connection = { board, jumps: [] }
expiresAt = null
lifecycle = {}
~~~

### JumpServer

extension 收集 Board + 1-N jumps + X.509 identity：

~~~text
connection = { board, jumps }
expiresAt = null
lifecycle = {}
~~~

### Baton

继续复用当前最小流程：

~~~text
validate token / login
listAvailableBoards
listDurations
reserve
resolveConnection
~~~

然后加入：

~~~text
connection = Baton 解析后的 OpenOptions
expiresAt = reservation end time
lifecycle.renew = Baton renew API
lifecycle.release = Baton release API
~~~

Baton HTTP 请求和 reservation -> SSH 参数映射继续只存在于核心 npm。

---

## 9. 使用现有主按钮 Hover 管理板子

期望复用当前唯一主按钮。

当前 OSS VS Code 中按钮属于：

~~~text
MenuWorkbenchToolBar
-> MenuItemAction
-> MenuEntryActionViewItem
~~~

普通 extension action 的 tooltip 当前只能提供静态字符串，extension 没有公开入口接管动态、可点击 Hover。

但 VS Code 内部已有：

~~~text
actionViewItemProvider
MenuEntryActionViewItem
ManagedHover
IManagedHoverContent
~~~

并且 Managed Hover 已支持 Markdown / actions / HTMLElement 等动态交互内容。

因此主框架不需要重做按钮系统，只需要增加一个**最小、通用的 chat toolbar action hover provider 桥**。

### Hover 打开时

主框架只负责：

~~~text
检测某 action 是否注册了 hover provider
-> 调 provider command
-> 展示 provider 返回的通用 hover 内容
~~~

BoardSession extension 的 provider 内部：

~~~text
manager.refresh()
-> 根据 snapshot 生成 Hover
~~~

### 没有板子

只显示：

~~~text
+ 添加板子
~~~

### 有板子

示意：

~~~text
● ACAR
  [删除]

CCAR · 剩余 1小时23分钟
  [续约] [删除]

CAR-TEST
  [删除]

+ 添加板子
~~~

要求：

- 当前正在连接的板名有简单、明显的 active 效果。
- expiresAt == null 时不显示剩余时间，也不显示续约。
- expiresAt != null 时显示动态剩余时间和续约入口。
- 所有板都可以删除。
- 不显示 Direct/Baton/JumpServer 来源。

### 点击板名

~~~text
extension
-> manager.setCurrentBoard(id)
~~~

点击当前板直接 return OK。

点击另一块板时，BoardManager 按第 6 节完成 SSH 切换；extension 保持 board_terminal_* 激活。

### Hover 操作

Hover 中的操作由 extension command 实现：

~~~text
选择板子
续约
删除
添加板子
~~~

主框架不实现任何 BoardSession 业务 callback。

---

## 10. 主框架 Hover 桥的边界

新增能力必须是通用机制，语义类似：

~~~text
register chat toolbar action hover provider
~~~

主框架最多只知道：

~~~text
action id
provider command
dynamic hover content
allowed hover actions / commands
~~~

主框架代码不得出现：

~~~text
BoardSession
BoardManager
ManagedBoard
Baton
renew
release
expiresAt
SSH
board IP
jump password
~~~

优先复用现有 Managed Hover 的 Markdown / command links / actions。

不要新增：

~~~text
BoardRow
BoardButton
BoardListWidget
Board-specific Hover schema
~~~

不要为了 BoardSession 再造一套 UI DSL。

---

## 11. 三层职责边界

### 11.1 Core npm

目录：

~~~text
extensions/boardsession/board-session/
~~~

负责：

**BoardSession**

~~~text
open
exec
send
read
close
~~~

不重写现有 transport、wolfSSH、native addon、persistent shell。

**BoardManager**

~~~text
ManagedBoard registry
current board
single active SSH Session
refresh expiration
add/remove/renew
switch
connect/disconnect
~~~

**BatonClient**

保留现有：

~~~text
validate token
login
list available boards
duration options
reserve
resolve connection
~~~

只新增明确需要的：

~~~text
renew reservation
release reservation
~~~

### 11.2 OSS VS Code extension

目录：

~~~text
extensions/boardsession/
~~~

负责：

- 主按钮 click。
- 主按钮 Hover provider。
- Hover 展示与 callback。
- Add Board 的 Direct/Baton/JumpServer 用户输入。
- Renew 时长选择。
- Remove 用户操作。
- 到期/临近到期通知。
- 调用核心 npm BoardManager。
- 根据 manager 连接状态切换 board_terminal_* / 原生 terminal tools。

extension 不负责：

- Baton HTTP API。
- Baton reservation 到 SSH 参数映射。
- ManagedBoard 生命周期状态机。
- SSH 实现。
- 过期判定规则本身。

### 11.3 VS Code 主框架

继续只允许三类必要通用能力：

1. BoardSession npm/extension 构建接入。
2. languageModelTools.replaces 等通用 terminal replacement。
3. Chat UI bridge。

现有 Chat bridge：

~~~text
showInput
showPick
~~~

本阶段预计唯一新增：

~~~text
generic chat toolbar dynamic hover provider
~~~

如果某功能可以留在 npm 或 extension，就不得因为实现方便继续向主框架扩散。

---

## 12. 到期检查和提醒

OSS extension 可以每分钟：

~~~ts
manager.refresh()
~~~

Hover 打开时也立即 refresh。

临近到期，例如小于 10 分钟：

~~~text
CCAR 将在 9 分钟后到期
~~~

由 extension 提示。

同一过期周期不要每分钟重复通知。

是否提醒过属于 extension UI 状态，不放进核心 npm。

已经过期：

~~~text
Core:
refresh()
-> close SSH if needed
-> remove board
-> removedExpired

Extension:
-> 提示“已删除一条过期的板子记录：CCAR”
~~~

最后一块板消失后：

~~~text
current = null
~~~

下一次点击主按钮自动进入 Add Board。

---

## 13. 本阶段明确不做

为了保持实现克制：

- 不编写单元测试。
- 不实现 Agent/Conversation 级切板锁。
- 不实现跨 toolcall 事务。
- 不实现自动续约。
- 不同时保持多块板的后台 SSH Session。
- 不增加 source/type/originLabel/renewable 等重复状态字段。
- 不搬回旧 Baton 完整 list/sub/history 管理体系。
- 不增加第二个常驻管理按钮。
- 不新增 BoardSession 专用主框架 Widget。
- 不为了未来假想平台提前抽象完整 provider framework。
- 首版不解决 IDE 重启后的 ManagedBoard 自动恢复；后续确有需求再单独设计持久化与恢复。

---

## 14. 预计修改范围

### Core npm

主要：

~~~text
extensions/boardsession/board-session/src/manager.ts
extensions/boardsession/board-session/src/baton.ts
extensions/boardsession/board-session/src/index.ts
~~~

原则：

- 不改 native addon。
- 不改 wolfSSH。
- 不重写现有 transport。
- 不重写 persistent shell。

### OSS extension

主要：

~~~text
extensions/boardsession/src/boardConnection.ts
extensions/boardsession/src/extension.ts
~~~

如果 boardConnection.ts 明显膨胀，可以新增一个职责单一的 UI adapter 文件，例如：

~~~text
boardManagementUi.ts
~~~

但不要提前拆出大量 service/class。

### VS Code 主框架

只允许围绕现有 Chat toolbar 加通用 dynamic hover provider。

优先集中在现有：

~~~text
chatInputPart / action view item / managed hover
~~~

附近。

主框架 diff 必须保持通用。

---

## 15. 实施顺序

1. Core npm 新增 ManagedBoard + BoardManager。
2. 实现 refresh / expiration / add / remove / renew / current / connect / disconnect。
3. BatonClient 只补 renew/release。
4. 将现有 extension 单板状态改为调用 BoardManager。
5. 调整主按钮三个 click 语义。
6. 主框架增加最小通用 dynamic hover provider。
7. extension 实现 Hover 内容与 action callback。
8. 加入每分钟 refresh 和到期通知。
9. 使用现有本地 Baton demo 与真实/模拟 SSH 链路做人工交互验收。
10. 清理测试环境；本地 demo 可保留，但非业务验收资产不提交。

---

## 16. 人工验收目标

不以“能编译”代替功能验收，也不编写单元测试。

### Direct

~~~text
Add Direct
-> current
-> 主按钮 connect
-> board_terminal_*
-> Hover 可见
-> 删除
~~~

### Baton

~~~text
Add Baton
-> 预约
-> expiresAt
-> connect
-> Hover 剩余时间
-> renew
-> expiresAt 更新
-> release/remove
~~~

### 多板切换

~~~text
A + B

A connected
-> Hover 点 B
-> A SSH close
-> B SSH open
-> board tools 保持 active

再点 A
-> 切回 A
~~~

### 过期

~~~text
Baton 到期
-> refresh 自动删除
-> 如果正在连接则关闭 SSH
-> extension 提示已删除过期记录
~~~

### 无板状态

~~~text
最后一块板被删除/过期
-> current = null
-> 点击主按钮
-> 自动进入 Add Board
-> 添加成功后自动连接
~~~

### Tool replacement

切板过程中不得静默落回本机 terminal。

只有用户点击主按钮退出 BoardSession 时，才恢复原生 terminal tools。

---

## 17. 最终约束

> Core npm 管板卡资源、生命周期和 SSH Session。
>
> OSS extension 管 UI、Hover 和用户 callback。
>
> VS Code 主框架只提供最小、通用、可复用的构建 / tool replacement / Chat UI 桥。

任何功能只要能留在 npm 或 extension，就不得继续向 VS Code 主框架扩散。
