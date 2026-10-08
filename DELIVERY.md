# 交付说明 · dsh-session-handoff 0.1.0

## 一句话

DSH 插件：在会话大到**自身压缩永久失效**之前，把它的记忆交接给一个新会话，并归档老会话。
新会话继承**四层**记忆（逐字事实 / 已有检查点 / **最近若干轮原文** / 分块摘要）；**任何一次
总结请求都不可能超出上游 token 上限**，所以对已经中毒（超限无法压缩）的会话同样有效。

## 它解决的死锁

```
压缩请求 = 把整个 shadowed region 原样重放给模型当输入
上游对单次请求的 prompt 有硬上限（实测 2^20 = 1,048,576 token）
会话超过该上限 → 压缩请求自己就超限 → 压缩永远失败
```

即「用导致故障的同一个错误去修故障」。`/handoff` 的存在就是为了打破它。

## 交付物

| 路径 | 说明 |
| --- | --- |
| `D:\WishProject\dsh-session-handoff\` | 插件项目（独立文件夹） |
| `lib/index.js` | 插件入口：`/handoff` 命令 + 压力监控 |
| `lib/handoff.js` | 事务编排：读 → 记忆 → 总结 → 建会话 → 归档 |
| `lib/memory.js` | 四层记忆抽取、凭据脱敏与 seed 组装 |
| `lib/summarize.js` | 分块 map-reduce 总结（请求逐个受预算约束） |
| `lib/pressure.js` | 压力分级、提醒策略、提醒文案 |
| `lib/token-budget.js` | token 估算与请求预算 |
| `tests/smoke.test.mjs` | 27 条单测 + 管线端到端 |
| `tests/e2e-real-session.mjs` | 只读探针：在真实转录上跑管线 |
| `README.md` | 安装、配置、保证、以及**它做不到什么** |

## 已实测（证据）

### 单元与管线

```
# tests 35
# pass 35
# fail 0
```

其中最关键的一条不变量：**没有任何组装出来的请求能超出预算**，用一条
2000 万 token 的合成转录断言。

### 真实中毒会话上的只读探针

对象：`session-9ef22e43`（193.5MB，117,541 事件，32,286 条模型消息）

```
transcript size:            34,631,694 estimated tokens
naive request carries:      34,631,694 tokens
upstream prompt limit:       1,048,576 tokens
verdict:                     REJECTED (this is the 11133 deadlock)   ← 旧做法必死
per-request input budget:      498,400 tokens                        ← 新做法每次都在预算内
verbatim recent turns kept:   35 of 32,286 (trimmed)                  ← 精确的最近若干轮
seed from the exact layers:  49,052 chars (~15,391 tokens)            ← 一条模型请求都没发
```

**光靠事实层 + 检查点层就产出了 3,327 token 的可用 seed。**

### 脱敏的正/负对照（真实转录）

| 对照 | 结果 |
| --- | --- |
| 负对照：真实 tail 原样 | **0 处脱敏，字节不变** |
| 正对照：同一 tail 注入 4 个真实形态的凭据 | **5 处脱敏，4 个泄漏值全部消失** |

负对照特意包含了 **SHA-256 摘要**（64 位十六进制）—— 它长得像密钥，但正是交接必须保留的证据，
所以不能被误伤。这条已固化成测试用例。

### 真实数据上发现并修掉的三个质量缺陷

第一版在真转录上跑出来是垃圾，逐条修：

1. **中文边界** —— Windows 路径在真实转录里紧跟着中文正文、没有分隔符，原正则把整句中文
   吞进路径。现在停在 CJK 标点/汉字区。
2. **最近优先** —— 11.7 万事件的会话里前 60 个路径全是上古历史。现在保留**最近出现**的。
3. **生成物折叠** —— Rust 构建树一次贡献 60 条
   `target/debug/build/ai-gateway-core-<hash>/out/*`，把源码路径全挤掉。现在按形状折叠，
   并且**源码路径排在建树产物之上**。

改完后抽到的是 `wt-port\crates\ai-gateway-router`、`build-1034-sse.log`、
`inst-1034-sse\state.json` 这类真正有用的东西。

## 凭据脱敏（必读）

逐字层是**拷贝**，所以会话里曾经回显过的东西（调试时打印的 token、dotenv dump 里的 key）
都会被拷进来。交接 seed 是一个**新产物**，可能被阅读或分享，因此按**形状**脱敏后才写入：
bearer token、`sk-` / `ghp_` / `github_pat_` / `xox` / `AKIA` 密钥、JWT、PEM 私钥、
`password=` 类赋值、连接串内联密码。事实层也做同样处理（路径里可能嵌密钥）。

## 安装状态

- 已 `link:` 安装进 **tauri** profile：`D:\DSHHome\profiles\tauri\package.json`
  → `"dsh-session-handoff": "link:D:/WishProject/dsh-session-handoff/"`
- 已注册进 `dsh.profile.bundles`
- 已用宿主 RPC 确认命令已注册：`POST /api/commands/list` 返回的 15 个命令里包含 `handoff`

## ⚠ 需要重启 DSH 才生效

**这是硬要求，不是建议。** 原因：

- harness 把已加载的插件模块放在 loader cache 里；
- `hmr.root` 默认是 `[]`（模块根是 opt-in 且为空）；
- 所以**改插件源码不会在运行中的宿主里生效**。配置重载会重读 profile patch，但**复用**
  已经求值过的模块。

已实测确认：在宿主运行期间修正磁盘上的模块后，`/handoff` 仍报旧模块的错误；而**在全新
进程里加载同一份文件**则完全正常。测试套件里加了一条专门守这个坑的用例
（`a fresh process can import the installed entry point`）。

重启后日志应出现：

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

## 配置

```yaml
- id: session-handoff
  name: 'dsh-session-handoff'
  config:
    monitor:
      enabled: true
    policy:
      upstreamPromptLimit: 1048576
      watchRatio: 0.45
      warnRatio: 0.6
      criticalRatio: 0.75
      remindEveryTokens: 50000
      remindCooldownMs: 600000
      seedBudgetTokens: 24000
```

`upstreamPromptLimit` 是**配置项而不是计算值**，这是有意的：它是路由背后账号的属性，
唯一的权威是实测。

## 它做不到什么（如实说明）

- **它不缩小 live 会话。** 交接是把工作搬到新会话；老会话仍在磁盘上（已归档、可读），
  直到你删除它。
- **摘要层是复述。** 精确性来自事实层、检查点层，以及仍可打开的归档会话。
- **`upstreamPromptLimit` 在你实测之前只是猜测。** 默认值是本机路由上测出来的。
- **map-reduce 每块一次请求。** 超大会话是几十次请求；报告里会写明次数。
- **归档不等于删除。** 只是从侧栏默认视图里移出。

## 验证命令

```sh
node --test tests/smoke.test.mjs                       # 27 条
node tests/e2e-real-session.mjs <session.v4.jsonl.zstd> # 只读真实转录探针
```
