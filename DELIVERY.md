# 交付说明 · dsh-session-handoff 0.1.0

**简体中文** · [English](./DELIVERY.en.md)

## 一句话

DSH 插件：在会话大到**自身压缩永久失效**之前，把它的记忆交接给一个新会话。
新会话继承**四层**记忆（逐字事实 / 已有检查点 / 最近若干轮原文 / 分块摘要）；**任何一次总结
请求都不可能超出上游请求长度上限**，所以对已经中毒（超限无法压缩）的会话同样有效。

## 交付物

| 路径 | 说明 |
| --- | --- |
| `lib/` | 插件本体（7 个模块） |
| `tests/` | 69 条测试 + 真实序列重放 + 渲染测试 + fixture 重建脚本 |
| `docs/NOTES.zh-CN.md` | **工程笔记**：怎么验证的、踩过什么坑 |
| `README.zh-CN.md` | 面向用户的完整文档 |

安装、使用、配置、以及「它做不到什么」，都写在 [README](./README.zh-CN.md) 里。

## 安装状态

- 已 `link:` 安装进 **tauri** profile：`D:\DSHHome\profiles\tauri\package.json`
  → `"dsh-session-handoff": "link:D:/WishProject/dsh-session-handoff/"`
- 已注册进 `dsh.profile.bundles`
- 已用宿主 RPC 确认命令已注册：`POST /api/commands/list` 返回的命令里包含 `handoff` 和
  `handoff-status`
- 已发布到 GitHub（公开）：<https://github.com/iuuuuuuuu/dsh-session-handoff>，带 `dsh-plugin` topic

## ⚠ 需要重启 DSH 才生效

**这是硬要求，不是建议。** 原因：

- harness 把已加载的插件模块放在 loader cache 里；
- `hmr.root` 默认是 `[]`（模块根是 opt-in 且为空）；
- 所以**改插件源码不会在运行中的宿主里生效**。配置重载会重读 profile patch，但**复用**已经
  求值过的模块。

已实测确认：在宿主运行期间修正磁盘上的模块后，`/handoff` 仍报旧模块的错误；而**在全新进程里
加载同一份文件**则完全正常。测试套件里有一条专门守这个坑的用例。

重启后日志应出现：

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

## 验证命令

```sh
node --test tests/smoke.test.mjs                        # 69 条
node tests/auto-trigger-real.mjs                        # 重放真实失败序列
node tests/client-render.mjs                            # 渲染设置界面
node tests/e2e-real-session.mjs <session.v4.jsonl.zstd> # 只读真实转录探针
```

## 它做不到什么（如实说明）

- **它不缩小 live 会话。** 交接是把工作搬到新会话；老会话仍在磁盘上（已归档、可读）。
- **摘要层是复述。** 精确性来自事实层、检查点层，以及仍可打开的归档会话。
- **`upstreamPromptLimit` 在你实测之前只是猜测。** 它是唯一一条无处可读的上限（模型窗口已改为
  从会话的模型配置里读）。
- **自动触发器还没在自然发生的故障上触发过。** 逻辑已用真实序列和隔离宿主验证，但那一刻仍未
  观测到。

## 证据在哪

实测数字、四个只有真机才能发现的 bug、脱敏的正负对照、事实抽取的迭代过程 —— 全部在
[工程笔记](./docs/NOTES.zh-CN.md) 里。这份交付说明只保留「装了什么、怎么验证、要注意什么」。
