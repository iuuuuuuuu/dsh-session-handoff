[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4b6bfb)](https://github.com/iuuuuuuuu/dsh-session-handoff)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-339933)](https://nodejs.org)

# dsh-session-handoff

[English](./README.md) · **简体中文**

在会话变得不可用**之前**，把它的记忆交接到一个新会话。

## 它解决的死锁

一个跑久了的 DSH 会话，最终会大到连它自己的压缩都失效。这个机制值得说清楚，因为正是它让失败变得**永久**：

- 压缩会把**整个被遮蔽区域**当作一次总结请求的输入重放一遍。
- 上游 provider 对单次请求的 prompt 有硬上限（在本机 AI Gateway 路由上实测为 **2^20 = 1,048,576 token**）。
- 会话一旦越过这条线，**压缩请求自己就超限了**。
- 于是压缩以「它本该治好的那个溢出」失败，每次都一样，永远如此。

这个会话从此既不能压缩、也不能继续；而那些朴素实现的交接插件用的是同样的构造方式，所以**也交接不了**。这就是那个死锁。`/handoff` 就是为了打破它。

## 它做什么

两件事。

### 1. 盯着

在每个 turn 边界，插件通过 harness 的 token meter 测量会话的真实 token 压力，并对照**两条**独立上限分类：

| 上限 | 为什么重要 |
| --- | --- |
| 模型宣称的上下文窗口 | 模型自己接受多少 |
| 上游 prompt 上限 | provider 对**单次请求**接受多少 |

**真正杀死会话的是第二条**，而它**不能**从第一条推导 —— 一个路由可能宣称 1,000,000 的窗口，而它背后的账号对单次请求只给 1,048,576。压力越过策略阶梯时，插件会往会话里注入一条提醒，写明实测数字、当前绑定的是哪条上限、以及出路。

提醒在**增长**和**时间**两个维度都限流，所以停在 `critical` 的会话不会每一步都来烦你。

### 2. 交接

`/handoff` 跑一个事务：

1. **读** 活会话的消息和事件。
2. **抽** 四层记忆（见下）。
3. **总结** 转录 —— map-reduce，每个请求独立限界。
4. **建** 后继会话，并把 seed 作为它的开场 turn 投进去。
5. **归档** 源会话 —— **放在最后**。

### 它带走的记忆

设计问题是**带什么**。四层，按成本排序：

| 层 | 来源 | 保真度 | 成本 |
| --- | --- | --- | --- |
| **逐字事实** | 对转录做正则抽取 | 精确 | 免费 |
| **已有检查点** | 会话自己写过的成功 `compaction/end` 摘要 | 精确 | 免费 |
| **最近若干轮原文** | 对话尾部，一字不改 | 精确 | 免费 |
| **叙述摘要** | 模型写的，map-reduce | 复述 | 一遍 |

**三层精确的永不为叙述层让位**：只有叙述层会被截断，且只从中间截。逐字尾部拿的是 seed 预算里**保留的份额**（`recentShareRatio`），而不是去和散文抢剩下的 —— 因为事实给你路径，而只有尾部给你「刚才那句话」。

在一个 3460 万 token 的转录上，精确层产出了约 15,000 token 的 seed：240 条抽取事实 + 最近 35 轮逐字原文。

### 凭据绝不跟着走

逐字层是**拷贝**，所以会话曾经回显过的东西 —— 调试时打印的 token、dotenv dump 里的 key —— 都会被拷进来。交接 seed 是一个**新产物**，可能被阅读或分享，所以按**形状**脱敏后才写入：bearer token、`sk-` / `ghp_` / `github_pat_` / `xox` / `AKIA` 密钥、JWT、PEM 私钥、`password=` 类赋值、连接串内联密码。事实层同样处理，因为路径里可能嵌密钥。

事实抽取针对真实转录调过：

- **就近优先。** 一个 11.7 万事件的会话里有几千条过期路径；后继需要的是**最近**碰过的，所以上限保留最近出现的那几条。
- **生成物路径折叠。** 四十条 `target/debug/build/ai-gateway-core-<hash>/out/*` 是**一种形状**，不是四十条事实。
- **源码优先于产物。** `src/host/rpc.ts` 比一个构建目录值钱。
- **CJK 边界。** 真实转录里 Windows 路径后面经常**直接**跟中文，没有分隔符；模式在 CJK 标点处停下，而不是把它一起吞掉。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-session-handoff
```

如果你的 profile 的 `cordis.patch.yml` 已经手工挂载了本插件，**先删掉那一行**，否则会跑两个实例。

**必须重启 DSH。** 这是硬要求，不是可选项：harness 把已加载的插件模块放在 loader cache 里，而 `hmr.root` 默认是 `[]`，所以**改插件源码不会在运行中的宿主里生效**。配置重载只重读 profile patch，会复用已经求值过的模块。

重启后日志会显示：

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

不用猜它有没有活 —— 直接问宿主的命令注册表：

```sh
# 通过 harness 的 RPC 面
POST /api/commands/list  {"agentId":"<session-id>"}
# 返回的名字里必须有 /handoff
```

## 使用

```
/handoff
```

你会得到一份报告：

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

## 你问过的那两个行为

### 提醒

监控在每个 turn 边界跑，通过 harness 的 token meter 测量会话。它对照**两条**上限分类，绑定更紧的那条：

| 上限 | 是什么 | 为什么重要 |
| --- | --- | --- |
| 模型窗口 | 模型自己接受多少 | 显而易见的那条 |
| 上游 prompt 上限 | provider 对**单次请求**接受多少 | **这条才是杀死会话的**，且不能从模型窗口推导 |

提醒以 **notice** 的形式投递 —— 一条 source 声明 `form: 'notice'` 并带一行 summary 的 user message。那是 harness 自己表达「这件事发生了，显示在对话里」的词汇，模型切换行和 plan 模式行用的也是它。它走 `agent.inject`，那是给下一个 pre-step 的**模型可见**上下文，**不会唤醒 driver**，所以提醒永远不会自己开一个 turn。

限流是刻意的：**等级变化**总是说一次，但**重复同一等级**需要**同时**满足冷却（默认 10 分钟）**和**真实增长（默认 50,000 token）。没有这个，停在 `critical` 的会话会每一步都烦你，你就学会无视它了。

### 归档

**自动交接默认开；自动归档默认关。** 这个区分就是重点：交接**创建**一个继续干活的后继，而归档**藏起**那个坏掉的会话。会话在你不在的时候死掉时，那份记录是**证据** —— 你想看它当时在干什么，而不是发现它没了。

```yaml
config:
  autoHandoff:
    enabled: true           # 默认 true
    atLevel: critical       # 默认 critical
    onAnomaly: true         # 默认 true
    anomalyThreshold: 2     # 默认 2
    archive: false          # 默认 false —— 保留源会话可见
```

手动 `/handoff` **总是**归档，因为你要求了、而且你在看着。它**最后**才归档，在后继存在、seed 投递成功之后，所以中途任何一步失败都留下完好可用的源会话。

### 压缩失败触发器是**联合条件**

压缩失败算异常，但它**从不单独判定**，而且理由是**实测**出来的而不是假设的。重放一个真实会话的历史：

| 信号 | 观测 | 为什么单看它不够 |
| --- | --- | --- |
| `dsh_compaction_refused` | 一个会话里 **1062 次**，而它全程都在正常工作 | 策略拒绝，不是会话坏了 |
| `context_length_exceeded` | 只在最末尾出现一次 | 请求在任何体量下都不再装得下 |
| `model_param_invalid` | 9 次，全在最后一段 | 同上：终局 |

所以触发器要求**同时**满足失败连续计数**和**体量：

```
streak >= compactionFailureThreshold        (默认 3)
AND pressure / modelWindow >= compactionAnomalyVolumeRatio   (默认 0.35)
```

**终局码**（`context_length_exceeded`、`model_param_invalid`）绕过体量下限，因为没有哪个体量能让请求重新被接受。而 `no_healthy_account` **刻意不作为触发器**：它是平台级号池耗尽，那条路由上每个会话都同样失败，交接只会归档一个能用的会话去修一个**新会话照样继承**的故障。

验证方式是把一个已死的 106MB 会话里真实的 1,316 个结果序列喂进**已挂载的插件**重放：

| 会话体量 | 触发点 | 正确吗 |
| --- | --- | --- |
| 窗口的 10% | 第 #1336 次失败，一个终局 `model_param_invalid` | 对 —— 终局码绕过体量下限 |
| 窗口的 90% | 第 #43 次失败，第三次连续拒绝 | 对 —— 连续 + 体量 |
| 中间插一次成功 | 永不触发 | 对 —— 成功重置计数 |

### 只有真实宿主才能发现的三个 bug

单测全绿的时候，插件在**三个**不同方面是坏的。每一个都是在真实宿主里跑出来的，现在每一个都有测试覆盖。

**1. volatile 分组套 volatile 叶子会让 fiber 校验失败。**

```
ValidationError: invalid config:
  - $.monitor.enabled volatile fields require a fixed object path
    without an enclosing volatile field (at monitor.enabled)
```

把分组标 `.volatile()` **并且**把它的叶子也标 `.volatile()` 是最自然的错误。后果不是警告：fiber 校验失败，而设置层**只暴露 fiber 状态为 active 的命名空间** —— 于是设置页读到「此部署没有开放本插件的配置」，而所有命令照常工作。

**2. `turn/end` 和 `compaction/end` 是会话落盘事件，不是实时事件。**

这些持久化事件名长得像事件总线事件，所以监听它们**能编译、能跑、永远不触发**。真正的钩子是 `session/event`，它把每一次追加以 `(session, event)` 带出来。两个 watcher 通过它读 `turn/end`，一个读 `compaction/end`。

**3. turn 边界是在 driver 还在跑的时候观察到的。**

追加发生在 driver 自己的 `finally` 里，所以那一刻 agent 还是 `running`。要求「立即空闲」**挡住了每一个触发器** —— 插件正确计数，然后什么都不做。修复是等 driver 收敛，上限 10 秒；真的忙就推迟而不是卡死。

### 一个会话最多交接一次

重放真实失败序列暴露了第四个问题：交接成功之后，下一个失败 turn **又**触发，反复 —— 一个会话历史里触发了 **1,313 次**。坏掉的会话会**每个 turn 生一个后继**，比原来的故障还糟。两道闸修掉它：

- 成功的交接**永久抑制**该会话；
- 失败的交接在 `AUTO_HANDOFF_MAX_ATTEMPTS`（3）之后停手，并记录告诉你手动跑 `/handoff`。

### 为什么三个健康会话被分叉了

早期版本交接了三个**健康、仍在正常工作**的会话。原因在**测量**，不在触发器：

| 会话 | GUI 报的数 | 插件当时的估算 | 判定 |
| --- | --- | --- | --- |
| `2f11ef00` | 76,040 token | ~800,000 | ok (7.6%) |
| `e7d70ba3` | 71,120 token | ~900,000 | ok (7.1%) |
| `d46b3a4d` | 406,013 token | ~1,200,000 | ok (40.6%) |

插件读的是 `ctx.tokenMeter.measure(session).totalTokens`，它**给整个 surface 定价** —— 包括**已经被压缩遮蔽掉的历史**。在压缩过几次的会话上，这个估算远远跑在真实 prompt 前面。

**修复是改读 harness 自己的 `contextPressure` 投影**，它发布的是 **provider 上报**的占用 —— 真正决定下一个请求装不装得下的那个数。而且**估算值不允许触发任何东西**：

- 投影是主来源；meter 只做兜底；
- 兜底读数被**标记** `estimated: true`；
- 三个触发点全部经 `mayActOn(measured)` 把关，排除估算值。

估算仍然够格**提醒**你。它不够格把你的会话拿走。

### 上游上限是**按模型**的

provider 对单次请求的上限随模型不同，所以策略带一张表：

```yaml
config:
  policy:
    upstreamPromptLimit: 1048576       # 没有单独条目的路由用这个兜底
    upstreamPromptLimits:
      ai/deepseek-v4.1-flash: 1048576
      zcode/GLM-5.3-Flash: 500000
```

路由条目优先；未列出的用标量兜底。设置页里用 `provider/model = token` 每行一条来编辑这张表，而分类结果会写明它实际用的上限（`effectiveLimit`），所以读数永远不会对自己的天花板含糊。

### 模型窗口是**读出来的**，不是配置的

上限必须跟随会话**实际在用**的模型。适配器在模型 profile 里声明每个模型的
`contextWindow`，插件通过 `llm.resolveModelInfo(provider, model)` 读它 —— 和请求本身
构建所用的**同一份配置**。所以换模型就换上限，不用动插件里任何设置：

| 路由 | 声明的窗口 | 压力 | 判定 |
| --- | --- | --- | --- |
| `ai/big-model` | 2,000,000 | 150,000 | **ok**（14%） |
| `ai/small-model` | 200,000 | 150,000 | **critical**（75%） |

解析结果按路由缓存并在后台预热，所以观测者保持同步。某个路由的能力解析出来之前，先用
请求头自带的值。

**只有一条**上限仍然需要配置：**上游 prompt 上限**。它是路由背后**账号**的属性而不是模型的
属性，它不出现在任何模型配置里，唯一权威是实测。`upstreamPromptLimits` 按
`provider/model` 覆盖它。

### 设置界面

`设置 → 会话交接` 实时暴露每一个策略字段。改动以路径操作写进本插件在 profile patch 里的命名空间，而插件每次观测都重读策略，所以改动**下一个 turn 就生效**，不需要重启。

界面用的是 app 自己的设计系统而不是内联样式，所以跟随主题（含深色模式），并和内置设置页一致：

| 部分 | 怎么画 |
| --- | --- |
| 字段 | label、控件、说明 —— 之间是 shell 自己的细分隔线 |
| 开关 | 原生 36×20 胶囊，状态挂在 `aria-checked` 上 |
| 输入框 / 下拉 | 34px、`--dsw-radius-md`、token 化的聚焦环 |
| 按模型上限 | 等宽多行框，一行一条 `provider/model = token` |
| 颜色 | **每一个**值都是 `--dsw-*` token；出现字面量颜色测试就红 |

每一个标签都做了本地化（zh + en），**包括下拉框的选项**，并有测试保证渲染出来的标签没有一个在字典里缺失。

表单只在 profile 真的挂载了本插件的行时才出现，因为设置按 Loader entry id 寻址。

用 `/handoff-status` 随时查看状态：它会报出测量值、绑定的上限、是否有提醒待发、以及自动交接是否已武装。

## 对话中途交接

### 这里的「异常」指什么

自动交接有**两个独立触发器**，因为会话可以以两种不同方式变得不可用：

| 触发器 | 信号 | 默认 |
| --- | --- | --- |
| **压力** | 实测上下文压力到 `atLevel` | `critical` |
| **异常** | 一段**连续失败的 turn** | 2，经 `anomalyThreshold` |

压力是慢的那个。异常是快的那个，它抓的是**远在压力线以下就已经坏掉**的会话 —— 一个 turn 一直失败的会话，不管它占多少 token，都已经不能用了。

只有 `error` 和 `max-tokens` 两种 turn 结束算异常。`completed` 重置计数；`aborted`（你自己点的停止）和 `interrupted`（崩溃后 harness 补的 closer）**都不算**，因为两者都不代表会话坏了。

两个触发器的闸门一样：压力/计数到了、该会话没有正在跑的交接、agent 不在 turn 里。

### 触发后做什么

```
1. read        读活会话（消息 + 事件）
2. memory      抽事实、检查点、逐字最近尾部
3. summarize   限界 map-reduce，每块一次请求
4. create      建后继，继承源的 route 和 cwd
5. deliver     把 seed 作为后继的开场 turn 投进去
6. archive     归档源，带 stopActivity —— 终止它的工作
7. release     丢掉源的 live 事件树
```

**后继立刻开工。** seed 不是留给你读的便条；它被投递为后继的第一轮输入，所以新会话直接接着干。报告会这么说：

```
Handed off `session-3abd9fb1-…` to `session-1f9e608b-…`.
- read: 5 messages, 20 events
- memory: 3 facts, 0 checkpoints
- summarize: 1 chunk(s), source=single-pass, 6642 chars
- recent: 5 verbatim message(s)
- seed: 12114 chars (~4067 tokens)
- create: session-1f9e608b-…
- archive: session-3abd9fb1-… (work stopped)
- release: live event tree dropped for session-3abd9fb1-…

The source session is archived; it stays readable in the sidebar.
Its live event tree was released, so it no longer occupies memory.
```

### 终止旧会话

归档一个**正在 turn 中**的会话会被 harness 拒绝。所以交接传 `stopActivity: true`，让 registry 去问所有 `workspace/session-stop` 提供者停止该会话的工作。agent 那个提供者的实现是调用 `agent.cancel({ kind: 'user' })` —— **跟你自己点停止按钮完全一样**，只是不带 `keepInbox`，所以排队中的输入会被丢弃，而不是之后再把已归档的会话唤醒。

### 归档会移除什么吗？**不会 —— 这正是 release 这一步存在的原因。**

归档纯粹是**可见性**变化：

- 会话 id 加入 registry-global 归档集，把它从侧栏默认视图里藏起来；
- 它的 workspace 记账槽位**保留**，所以取消归档能恢复它原来的位置；
- 同一次持久写入里丢掉 pin（pin 和归档互斥）；
- **什么都没删。** 磁盘上的 durable log 原样不动，会话仍可阅读 —— 你随时可以取消归档。

真实交接之后实测：源已归档，它的日志仍在磁盘上（`…\session-3abd9fb1-…\session.v4.jsonl.zstd`，28,227 字节）且仍可打开。

但归档**也不释放内存**。live 事件树由 session store 持有，对超大会话来说那棵树才是贵的部分。所以交接加了 **release** 一步：`SessionStore.remove(id)` 跑 store 官方的 detach 生命周期，把会话从 live 集合里摘掉，而它的 durable log 留在磁盘上。

release 刻意做得很谨慎：它**拒绝**摘一个 agent 还在 `running` 的会话（那时摘会跟 driver 的收尾事件打架），而 store 拒绝移除时，交接**仍然算成功**并报一条 warning，而不是失败。想再读那个归档会话时，DSH 会从磁盘重新打开它。

## 配置

在 profile patch 里挂配置：

```yaml
- id: session-handoff
  name: 'dsh-session-handoff'
  config:
    monitor:
      enabled: true
    policy:
      upstreamPromptLimit: 1048576
      upstreamPromptLimits:
        ai/deepseek-v4.1-flash: 1048576
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

`upstreamPromptLimit` 刻意做成配置而不是算出来的值：它是路由背后**账号**的属性，唯一的权威是**实测**。

## 保证

这些由测试套件断言（`node --test tests/smoke.test.mjs`）：

- **组装出来的总结请求永远不会超预算** —— 用一个 2000 万 token 的合成转录验证过。这是让插件在**已经超限**的会话上仍然安全的不变量。
- **脱敏既不瞎也不过度**：干净的转录尾部逐字节原样通过 —— 包括**看起来像密钥但正是交接必须保留的证据**的 SHA-256 摘要 —— 而同一条尾部注入凭据后，每一个都被移除。
- 散文层装不下时，事实和检查点依然保留。
- 隐藏推理永不泄进 seed。
- 等级变化总说一次；重复需要冷却**和**真实增长。
- 路由解析优先用 live 请求头而不是 agent 默认值，且能在请求头抛错时存活。
- 已安装的入口点在全新进程里能干净导入；完整的 读 → 记忆 → 总结 → 建 → 归档 管线能在 stub 宿主 + stub 模型上跑通，并断言 seed 里带着真实路径、早先的检查点、模型摘要和错误码 —— 且源会话恰好归档一次。
- 界面渲染出的每一个标签在 zh 和 en 字典里都存在；样式表里每一个颜色都来自 `--dsw-*` token。

## 它做不到什么（如实说明）

- **它不缩小活会话。** 交接把工作移到新会话；旧的留在磁盘上（已归档、仍可阅读），直到你删掉它。
- **摘要是复述。** 精确回忆来自事实层、检查点层，以及那个仍可打开的归档会话。
- **`upstreamPromptLimit` 在你实测之前只是猜测。** 它是唯一一条无处可读的上限，所以默认值是
  本机路由上实测出来的。模型窗口相反 —— 它从模型配置里读，不需要任何设置。
- **map-reduce 每块花一次请求。** 超大会话上是几十次；报告会告诉你几次。
- **归档不是删除。** 它把会话从侧栏默认视图里移走。

## 目录

```
lib/
  index.js         插件入口：/handoff 命令 + 压力监控
  client.js        设置界面（浏览器半）
  handoff.js       事务：读 → 记忆 → 总结 → 建 → 归档 → 释放
  memory.js        分层抽取（事实、检查点、逐字尾部）+ 脱敏 + seed 组装
  summarize.js     限界 map-reduce 总结
  pressure.js      分类、提醒策略、提醒文案
  token-budget.js  token 估算与请求预算
tests/
  smoke.test.mjs           每个模块的单元测试
  auto-trigger-real.mjs    用真实失败序列重放自动触发器
  client-render.mjs        忠实渲染设置界面
  e2e-real-session.mjs     在真实转录上跑管线的只读探针
  make-fixture.mjs         从真实会话日志重建本地 fixture
```

## 文档

| 文件 | 语言 |
| --- | --- |
| `README.md` | English |
| `README.zh-CN.md` | 简体中文 |
| `DELIVERY.md` | 简体中文 |
| `DELIVERY.en.md` | English |

## 许可

MIT
