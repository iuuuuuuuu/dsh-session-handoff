[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4b6bfb)](https://github.com/iuuuuuuuu/dsh-session-handoff)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-339933)](https://nodejs.org)

# dsh-session-handoff

[English](./README.md) · **简体中文**

在会话变得不可用**之前**，把它的记忆交接到一个新会话。

## 它解决的死锁

一个跑久了的 DSH 会话，最终会大到连它自己的压缩都失效。这个机制值得说清楚，因为正是它让失败变得**永久**：

- 压缩会把**整个被遮蔽区域**当作一次总结请求的输入重放一遍。
- 上游服务商对单次请求的请求长度有硬上限。
- 会话一旦越过这条线，**压缩请求自己就超限了**。
- 于是压缩以「它本该治好的那个溢出」失败，每次都一样，永远如此。

这个会话从此既不能压缩、也不能继续；而那些朴素实现的交接插件用的是同样的构造方式，所以**也交接不了**。这就是那个死锁。`/handoff` 就是为了打破它。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-session-handoff
```

如果你的 profile 的 `cordis.patch.yml` 已经手工挂载了本插件，**先删掉那一行**，否则会跑两个实例。

**必须重启 DSH。** 这是硬要求：harness 把已加载的插件模块放在 loader cache 里，而 `hmr.root` 默认是 `[]`，所以**改插件源码不会在运行中的宿主里生效**。

重启后日志会显示：

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

## 使用

```
/handoff           把这个对话交接给一个新会话
/handoff-status    显示测量值、绑定的上限、以及触发器状态
```

`/handoff` 会打印一份报告：

```
Handed off `session-9ef22e43-…` to `session-e7d70ba3-…`.

- read: 32286 messages, 117541 events
- memory: 240 facts, 0 checkpoints
- summarize: 70 chunk(s), source=map-reduce, 18422 chars
- seed: 21544 chars (~5386 tokens)
- create: session-e7d70ba3-…
- archive: session-9ef22e43-…

The source session is archived; it stays readable in the sidebar.
```

源会话**最后**才归档，所以中途任何一步失败都留下一个完好可用的源会话。

## 它做什么

### 盯着

每一轮对话结束时，插件测量会话的 token 压力，并对照**两条**独立上限分类，绑定更紧的那条：

| 上限 | 从哪来 | 为什么重要 |
| --- | --- | --- |
| 模型的上下文窗口 | 从会话**正在使用**的模型配置里读 | 模型自己接受多少 |
| 上游请求长度上限 | 配置项，因为没有地方声明它 | 服务商对**单次请求**接受多少 |

**真正杀死会话的是第二条**，而它**不能**从第一条推导 —— 一个路由可能宣称 1,000,000 的窗口，而它背后的账号对单次请求只给更少。

压力越过策略阶梯时，插件会往会话里注入一条**提醒**，写明实测数字、绑定的是哪条上限、以及出路。提醒是给下一步的模型可见上下文，所以它**永远不会自己开一轮**，并且在**增长**和**时间**两个维度都限流，停在 `critical` 的会话不会每一步都烦你。

### 交接

`/handoff` 跑一个事务：

```
1. read        读活会话（消息 + 事件）
2. memory      抽四层记忆
3. summarize   分块总结，每块一次请求，逐块限界
4. create      建后继，继承源的 route 和 cwd
5. deliver     把交接内容作为后继的开场消息投进去
6. archive     归档源，带 stopActivity —— 终止它的工作
7. release     丢掉源的 live 事件树
```

**后继立刻开工。** seed 不是留给你读的便条；它被投递为后继的第一轮输入，所以新会话直接接着干。

### 它带走的记忆

设计问题是**带什么**。四层，按成本排序：

| 层 | 来源 | 保真度 | 成本 |
| --- | --- | --- | --- |
| **逐字事实** | 对转录做正则抽取 | 精确 | 免费 |
| **已有检查点** | 会话自己写过的成功 `compaction/end` 摘要 | 精确 | 免费 |
| **最近若干轮原文** | 对话尾部，一字不改 | 精确 | 免费 |
| **叙述摘要** | 模型写的，分块归并总结 | 复述 | 一遍 |

**三层精确的永不为叙述层让位**：只有叙述层会被截断，且只从中间截。逐字尾部拿的是交接内容预算里**保留的份额**，而不是去和散文抢剩下的 —— 因为事实给你路径，而只有尾部给你「刚才那句话」。

### 凭据绝不跟着走

逐字层是**拷贝**，所以会话曾经回显过的东西 —— 调试时打印的 token、dotenv dump 里的 key —— 都会被拷进来。交接 seed 是一个**新产物**，可能被阅读或分享，所以按**形状**脱敏后才写入：bearer token、`sk-` / `ghp_` / `github_pat_` / `xox` / `AKIA` 密钥、JWT、PEM 私钥、`password=` 类赋值、连接串内联密码。事实层同样处理，因为路径里可能嵌密钥。

## 自动交接

自动交接**默认开**；自动归档**默认关**。

这个区分就是重点：交接**创建**一个继续干活的后继，而归档**藏起**那个坏掉的会话。会话在你不在的时候死掉时，那份记录是**证据** —— 你想看它当时在干什么，而不是发现它没了。

三个独立触发器，因为会话可以以三种不同方式变得不可用：

| 触发器 | 信号 | 默认 |
| --- | --- | --- |
| **压力** | 实测压力到 `atLevel` | `critical` |
| **连续失败** | 连续几轮对话都以失败收场 | 2 |
| **压缩失败** | 失败连续计数**并且**体量足够 | 3 次失败，窗口的 35% |

只有 `error` 和 `max-tokens` 两种结束算失败。`completed` 重置计数；`aborted`（你自己点的停止）和 `interrupted`（崩溃后自动补记的收尾）**都不算**，因为两者都不代表会话坏了。

**压缩触发器刻意做成联合条件。** 压缩失败从不单独判定：策略拒绝可以在一个**正常工作**的会话上重复几百次，所以光看次数会误杀健康会话。它要求失败连续计数**和**体量**同时**满足。*终局码*（请求在任何体量下都不再装得下）绕过体量下限，而平台级号池故障**刻意不作为**触发器 —— 交接修不了一个新会话照样继承的故障。

一个会话**最多交接一次**。成功的交接在本进程内抑制该会话；失败的交接三次之后停手，并让你手动跑 `/handoff`。

## 配置

在 profile patch 里挂配置，或者在 **设置 → 会话交接** 里实时改：

```yaml
- id: session-handoff
  name: 'dsh-session-handoff'
  config:
    monitor:
      enabled: true
    policy:
      language: zh                        # 对话里那条提醒用什么语言
      watchRatio: 0.45
      warnRatio: 0.6
      criticalRatio: 0.75
      remindEveryTokens: 50000
      remindCooldownMs: 600000
      seedBudgetTokens: 24000
    autoHandoff:
      enabled: true
      atLevel: critical
      onAnomaly: true
      anomalyThreshold: 2
      archive: false
```

> 配置里的键名（`upstreamPromptLimit` 等）是程序读的标识符，保持英文。

**两条上限都不需要配置。** 模型窗口从会话**正在使用**的模型配置里读，所以换模型就换上限，不用动任何设置。上游请求长度上限是路由背后**账号**的属性、不出现在任何模型配置里，所以插件带一个**本机实测出来的默认值**；换账号的部署可以改 `policy.upstreamPromptLimit`。

## 保证

由测试套件断言（`node --test tests/smoke.test.mjs`）：

- **组装出来的总结请求永远不会超预算** —— 这是让插件在**已经超限**的会话上仍然安全的不变量。
- **脱敏既不瞎也不过度**：干净的尾部逐字节原样通过（包括**看起来像密钥但正是该保留的证据**的 SHA-256 摘要），而同一条尾部注入凭据后，每一个都被移除。
- 散文层装不下时，事实和检查点依然保留。
- 隐藏推理永不泄进 seed。
- **估算值**可以提醒你，但**永远不能**触发自动交接。
- 设置页每一个标签都有双语，样式表里每一个颜色都来自设计 token。

## 它做不到什么（如实说明）

- **它不缩小活会话。** 交接把工作移到新会话；旧的留在磁盘上（已归档、仍可阅读），直到你删掉它。
- **摘要是复述。** 精确回忆来自事实层、检查点层，以及那个仍可打开的归档会话。
- **上游请求长度上限是实测默认值，不是探测出来的。** 它是唯一一条无处可读的上限，所以这个值是本机路由上实测出来的。
- **分块总结每块花一次请求。** 超大会话上是几十次；报告会告诉你几次。
- **归档不是删除。** 它把会话从侧栏默认视图里移走。
- **自动触发器还没在自然发生的故障上触发过。** 逻辑已用真实数据和隔离宿主验证，但那一刻仍未观测到。
- **提醒的语言是配置项，不是浏览器语言。** 宿主半读不到浏览器的语言设置，所以由 `policy.language`
  决定，默认中文。

## 目录

```
lib/
  index.js         插件入口：命令、压力监控、触发器
  client.js        设置界面（浏览器半）
  handoff.js       事务
  memory.js        分层抽取 + 脱敏 + seed 组装
  summarize.js     分块归并总结（每块独立限界）
  pressure.js      分类、提醒策略、压缩失败联合条件
  token-budget.js  token 估算与请求预算
tests/
  smoke.test.mjs           每个模块的单元测试
  auto-trigger-real.mjs    用真实失败序列重放自动触发器
  client-render.mjs        忠实渲染设置界面
  e2e-real-session.mjs     在真实转录上跑管线的只读探针
  make-fixture.mjs         从真实会话日志重建本地 fixture
docs/
  NOTES.md                 它是怎么被验证的、以及路上踩过什么坑
```

## 文档

| 文件 | 语言 |
| --- | --- |
| `README.md` | English |
| `README.zh-CN.md` | 简体中文 |
| `docs/NOTES.md` | English — 工程笔记与验证证据 |
| `docs/NOTES.zh-CN.md` | 简体中文 — 同上 |
| `DELIVERY.md` | 简体中文 |
| `DELIVERY.en.md` | English |

## 许可

MIT
