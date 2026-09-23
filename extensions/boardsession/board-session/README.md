# BoardSession

> **开发原则：不要过度设计，模块职责边界清晰，不要假设额外的情况，非必要不增加额外代码，按照终版方案进行开发。**

`@carizon/board-session` 是一个独立的 Node.js npm 包。其唯一目标是：**无论目标板子可直接访问，还是需要经过 1～N 个 SSH 跳板，都向调用方提供同一个持久的板端 X.509 SSH Session。**

本文前六节定义实现契约；当前实现、构建和功能测试方法见后文。

## 1. 职责与连接模型

调用方提供板子的地址与可选跳板列表。BoardSession 负责建链、板端 SSH 认证、命令执行、终端输入输出和关闭。调用方不需要关心跳数对应不同的连接实现。

```text
0 跳：Node.js ─────────────────────────────── Board:22
1 跳：Node.js ─ SSH(A) ────────────────────── Board:22
N 跳：Node.js ─ SSH(A) ─ SSH(B) ─ … ─ SSH(N) ─ Board:22
                                                 │
                                   同一份本地 wolfSSH 客户端
                                   完成最终板端 SSH/X.509 会话
```

- `jumps: []` 就是直连；1～N 跳重复同一转发算法，不设计按跳数区分的接口或类。
- 中间节点只提供 SSH 的 TCP forwarding；不要求安装 wolfssh、npm 或板端证书。
- **最终设备的 SSH 握手始终发生在运行本 npm 包的环境**，不在最后一跳执行 wolfssh 命令。
- 每个 BoardSession 对应一个板端持久 shell；多条命令复用该会话。
- npm 包不负责获取跳板账号、发现板子、管理业务权限，也不引入其他客户端场景。

## 2. 公开 API

### 统一维护一份板端复合 PEM

所有板子使用同一份 X.509 复合 PEM，**它属于整个 npm 包的配置，而不是单块板子的连接参数**。

```ts
import { BoardSession } from '@carizon/board-session';

// 首次配置或更换证书时调用一次；npm 管理保存位置和后续读取。
await BoardSession.setIdentity(compositePem);
```

- `compositePem` 为包含所需私钥和证书的 PEM 内容（`Buffer | string`）。
- npm 在当前用户的数据目录维护**一份**复合 PEM 文件；后续连接自动复用，调用方不需要逐板传文件路径。
- 未配置证书时，`open()` 明确报错；重新调用 `setIdentity()` 即替换这份证书，新连接使用新内容。
- 本方案不设计每板证书仓库、证书下载服务或额外的证书管理器；本地集成快照例外：按内部调试要求在 npm 包中附带 debug/client-identity.pem；不要向外部发布或把它当作生产证书分发方式。

### 连接板子

```ts
const session = await BoardSession.open({
  board: {
    host: '192.168.10.20',
    port: 22,
    username: 'root',
  },
  jumps: [
    {
      host: 'jump-a.example',
      port: 22,
      username: 'alice',
      privateKeyFile: '/path/jump-a-key',
    },
    {
      host: '10.10.0.2',
      port: 22,
      username: 'bob',
      privateKeyFile: '/path/jump-b-key',
    },
  ],
});

try {
  const result = await session.exec('uname -a');
  const output = session.read();
  const reply = await session.send('input', true);
} finally {
  await session.close();
}
```

`jumps` 省略时默认为 `[]`；端口省略时默认为 `22`。数组按真实连接顺序填写。板端用户名和地址属于单次连接参数，复合 PEM 不属于单次连接参数。

每一跳使用其独立的 SSH 认证（privateKeyFile 或 password），与板端的复合 PEM 互不混用。内置扩展默认使用跳板密码 123456。不要求调用方提供转发端口、SSH 命令或内部 socket。

### 会话方法

| 接口 | 语义 |
| --- | --- |
| `BoardSession.setIdentity(pem)` | 为 npm 配置/更新共用的板端复合 PEM。 |
| `BoardSession.open({ board, jumps? })` | 建立 0～N 跳连接并完成板端 X.509 SSH 登录及 shell 就绪，成功才返回实例。 |
| `session.exec(command, timeoutMs?)` | 在持久 shell 中执行一条命令，返回 `{ text, completed, exitCode? }`。 |
| `session.read()` | 返回尚未被前次调用消费的终端输出：`{ text }`。 |
| `session.send(text, appendNewline?)` | 发送交互输入，按需追加回车，返回当前输出：`{ text }`。 |
| `session.close()` | 关闭会话及整条转发链，可重复调用。 |
| `session.isClosed` | 只读会话状态。 |

仅暴露上述必要能力。游标、监听端口、转发 stream、原生指针及逐跳连接由 npm 内部维护。

## 3. 0～N 跳如何实现

npm 使用 `ssh2` 建立跳板链。SSH `direct-tcpip` 传的是**到下一目标的原始 TCP 数据**，中间无需启动 wolfssh。

```text
首跳：Node.js ─ TCP ─ SSH(A)

下一跳：SSH(A).forwardOut(B:22) ─ Duplex ─ SSH(B).connect({ sock })

继续：SSH(B).forwardOut(C:22) ─ Duplex ─ SSH(C).connect({ sock })

最终：SSH(N).forwardOut(Board:22) ─ Duplex ─ 板端 TCP 字节流
```

内部只需要一段按 `jumps` 顺序迭代的逻辑。0 跳直接访问板端，不创建 ssh2 跳板连接。每个后续节点的地址由**上一跳可访问的网络**决定。

跳板必须允许 SSH TCP forwarding；如果不允许，建链失败，不回退成在跳板上执行 netcat、socat 或其他命令。

## 4. wolfSSH 如何接收最终 TCP 连接

`ssh2.forwardOut()` 得到的是 JS Duplex stream，而本地 wolfSSH 动态库接收操作系统 socket；两者不能直接强制转换。

**第一版只在最终接入 wolfSSH 时处理这一次接口差异：**

- **0 跳**：原生模块直接建立到 `board.host:port` 的 TCP socket，然后创建 wolfSSH 会话。
- **1～N 跳**：npm 在 `127.0.0.1:0` 创建一个内部临时监听端口；原生模块连接该端口，npm 将接收到的 loopback socket 与最后一个 `forwardOut(board.host, board.port)` stream 双向连接。

```text
ssh2(A) -> … -> ssh2(N) -> forwardOut(Board:22)
                                  ||
                           内部双向 TCP 桥接
                                  ||
                        127.0.0.1:临时端口
                                  |
                         wolfSSH 原生 socket
                                  |
                         板端 X.509 SSH Session
```

- **不是每跳一个本地端口**；整个会话最多只有最终接入原生模块所需的这一个内部临时监听。
- 桥接后不再需要监听器，但已建立的 socket/forwardOut stream 必须保持到会话结束。
- 内部端口不固定、不暴露给调用方，也不对外网卡监听。
- 桥接只转发原始 TCP 数据，不代替 wolfSSH 做 SSH 握手、认证或终端处理。
- 只实现必要的双向转发、断开处理与清理；暂不引入自定义 wolfSSH I/O callback 来替换这条简单路径。

## 5. wolfSSH 能力依赖与模块边界

BoardSession **消费** wolfSSH/wolfSSL 提供的客户端动态库能力：接入 TCP socket、使用复合 PEM 进行 X.509 SSH 认证、建立持久终端会话、收发 SSH 通道数据以及关闭会话。

```text
@carizon/board-session
  JS/TS                  0～N 跳建链、必要的 TCP 桥接、统一会话 API
  native (Node-API)      调用 wolfSSH 动态库，处理板端会话和终端 I/O
  wolfSSH / wolfSSL      最终板子的 SSH/X.509 协议能力
```

- wolfSSH 不负责逐跳建链或调用方的连接参数。
- ssh2 只用于跳板 SSH 和 TCP forwarding，不参与最终板端 X.509 SSH 认证。
- BoardSession 以 native addon 调用库接口，不启动 `wolfssh` 可执行文件，也不要求任何跳板安装 wolfSSH。
- npm 交付物携带与运行平台匹配的 addon 及所需动态库，不依赖全局安装或手工设置库搜索路径。
- 一份复合 PEM 由 npm 配置和保存，供所有板端会话使用。

## 6. 会话行为约束

- 一个板端会话保留一个持久 shell；多次 `exec()` 复用该会话，不重复建链。同一 shell 不允许并发 `exec()` 相互串台。
- 持久 shell 内单条命令的退出码不能直接等同于 SSH channel 结束时的退出码；`exec()` 必须能区分命令输出、完成和退出码。
- `exec()` 超时不代表远端命令已经停止；在状态未确定时不能盲目执行下一条命令。
- `read()` 只返回尚未消费的输出；`send()` 的等待不等同于远端命令完成。
- 任一跳失败即关闭整个会话并释放已建立的原生会话、桥接、channel 和跳板连接；`close()` 幂等。
- 不设计连接池、自动重连、文件传输、额外命令前缀、按跳数分类的会话类型或其他尚无需求的扩展。

## 7. 当前实现与构建

源码现在是仓库根目录下的独立 npm 包，不再包含 VS Code 插件或跳板端客户端。

| 文件 | 职责 |
| --- | --- |
| `src/identity.ts` | 校验并原子替换用户数据目录中的共用 PEM，目录 `0700`、文件 `0600`。 |
| `src/transport.ts` | 迭代建立 ssh2 跳板连接，维护最终一处 loopback 桥接及资源清理。 |
| `src/session.ts` | 公开 API、shell 就绪、命令完成标记、输出消费、超时及关闭状态。 |
| `src/native-worker.ts` | 在独立 Worker 中调度 addon 的非阻塞握手和终端 I/O。 |
| `native/addon.cc` | 调用 wolfSSH/wolfSSL 动态库，拥有板端 socket、认证材料和 SSH 会话。 |

当前构建和验证平台为 **Linux x64 / Node.js 22+**；产物使用 Node-API v8。其他 Linux 架构需要在对应平台重新构建，Windows/macOS 尚未实现。发布包只携带构建平台的 addon、动态库及编译后的 JS/类型定义，不在安装时编译，也不包含真实证书或私钥。

开发构建需要 C++17、CMake 3.21+、Node.js headers，以及提供 X.509 能力的 wolfSSL 和 wolfSSH。这里消费外部库，不在本仓库维护它们的协议实现。native 构建默认使用本仓库的 `build/wolfssh` 和 `build/wolfssl`；其他安装位置可通过环境变量指定：

```bash
npm ci

# 两个安装都必须提供匹配的头文件和动态库。
export WOLFSSH_ROOT=/path/to/wolfssh-install
export WOLFSSL_ROOT=/path/to/wolfssl-install
export WOLFSSL_SOURCE=/path/to/wolfssl-source
export WOLFSSH_SOURCE=/path/to/wolfssh-source

# 从外部源码构建用于无本地 TTY 的 Node.js 进程的 wolfSSH 动态库。
npm run build:deps
npm run build
npm pack
```

`build:deps` 只在本仓库的 `build/` 中操作，启用 `WOLFSSH_CERTS`、终端支持及 `NO_TERMIOS`，不修改外部源码。**`NO_TERMIOS` 是必要条件**：远端仍申请 PTY，但终端模式不从 Node.js 进程的 stdin 读取，避免服务进程没有本地 TTY 时的库错误。已有符合这些条件的安装可用 `WOLFSSH_ROOT=/path/to/wolfssh-install` 跳过 `build:deps`。`NODE_INCLUDE_DIR` 可指定包含 `node_api.h` 的目录。

`npm run build` 在 `prebuilds/linux-<arch>/` 放置 addon、wolfSSH/wolfSSL 动态库和库许可文本。addon 使用相对自身目录的库搜索路径；安装产物后无需设置 `LD_LIBRARY_PATH` 或全局安装 wolfSSH。实际支持的 glibc 版本取决于构建机器，应在目标运行环境兼容的构建环境中制作发布产物。

## 8. 使用细节

```ts
import { readFile } from 'node:fs/promises';
import { BoardSession } from '@carizon/board-session';

await BoardSession.setIdentity(await readFile('./client-identity.pem'));
const session = await BoardSession.open({
  board: { host: '192.168.10.20', username: 'root' },
  jumps: [],
});
try {
  console.log(await session.exec('cd /tmp; export BOARD_VALUE=hello'));
  console.log(await session.exec('printf "%s\\n" "$BOARD_VALUE"'));
} finally {
  await session.close();
}
```

- PEM 位置为 `$XDG_DATA_HOME/carizon/board-session/identity.pem`，未设置 `XDG_DATA_HOME` 时使用 `~/.local/share/carizon/board-session/identity.pem`。新连接读取当前文件；已经建立的会话不受替换影响。
- 板端需要支持 POSIX shell 的 `eval`、`printf` 和 `stty`。会话初始化关闭输入回显和 shell 提示符；命令在同一个 shell 中执行，工作目录和变量会保留。输出保留终端原始换行/控制字符，stdout 和 stderr 通过 PTY 合并。
- `exec()` 默认超时 30 秒，超时返回 `completed: false`，不发送终止信号。只有收到该命令的完成标记才能自动解除忙状态；随后输出可通过 `read()` 消费。并发或仍未确定完成的 `exec()` 会被拒绝，不排队。
- `exec()` 只返回本条命令开始/完成标记之间尚未消费的输出，不混入先前未读的终端输出；旧输出仍可 `read()`。`read()`/`send()` 消费当时的全部未读输出，因此执行期间调用它们，会减少最终 `exec().text` 中的文本，已经消费的文本不会再次返回。
- `send()` 等待输入交给原生 SSH 通道后返回当时已有输出，不等待远端响应或命令完成；`appendNewline: true` 追加 `\r`。后续响应通过 `read()` 或正在等待的 `exec()` 取得。
- `send()` 是原始终端输入。Ctrl-C、`exit`、`exec` 替换 shell 或修改 shell 的执行行为可能让完成标记不再执行；此时状态不确定的会话需要 `close()` 后重新打开，不把等待结束当作完成。
- 连接/认证失败会让 `open()` 拒绝；已打开会话断开后 `isClosed` 变为 `true`，正在等待的操作会拒绝，剩余输出仍可 `read()`，`close()` 可重复等待清理完成。
- 当前 API 没有提供服务端主机密钥或 CA 信任配置；跳板和板端**不做服务端主机身份固定/校验**。X.509 在这里用于板端对客户端的认证，不能据此声称已验证服务端身份。

## 9. 真实环境功能测试

不编写单元测试。功能脚本连接真实 SSH 服务，覆盖 PEM 配置、持久 shell、退出码、多行与 UTF-8、并发拒绝、超时恢复、交互输入、Ctrl-C 后的未确定状态、256 KiB 输出、1 MiB 输入、证书替换、远端退出、认证失败和建链失败后的清理。脚本使用临时数据目录，不覆盖用户日常配置。

```bash
BOARD_IDENTITY=./client-identity.pem \
BOARD_HOST=2600:1900:4041:46c:0:2:0:0 \
BOARD_PORT=2222 \
BOARD_USER=songlei \
BOARD_JUMPS='[{"host":"2603:c020:25:ae01:85f0:8240:1c51:a5b9","username":"ubuntu","privateKeyFile":"/absolute/path/to/id_ed25519"}]' \
npm run test:functional
```

省略 `BOARD_JUMPS` 测试直连；提供多项测试多跳。以上跳板仅接受 SSH forwarding，最终认证由运行测试包的 Node.js 进程中的本地 addon 完成。脚本不会在跳板上调用 `wolfssh`。
