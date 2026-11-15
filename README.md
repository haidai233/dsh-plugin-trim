# dsh-plugin-trim

按**会话**裁剪工具面的 DSH 插件：每个会话自己一个「档位」，provider 只负责给它自动套默认档。另带一层 profile 级的插件物理开关，和一个自托管面板。

Per-session tool trimming for DeepSeek Harness: every session carries its own profile (a tool whitelist); the provider only decides which profile a session starts on. A second, profile-level layer physically disables plugin entries. Self-hosted panel included.

## 为什么按会话，而不是按 provider

这不是风格选择，是 API 的硬约束：

| 能力 | 作用域 | 依据 |
|---|---|---|
| `tools.restrict({ allow })` | **只能 agent 作用域** | 源码：`requires a scoped context (agent.ctx): a context-global restriction would mask every agent` |
| `pluginManager.setPluginEnabled()` | **profile 作用域** | 它写 `cordis.patch.yml` 的 `disabled: true`，一改影响全部会话 |

所以：

- **工具面只能按会话裁** —— 按 provider 裁只是「把同一份白名单套给所有本地会话」
- **插件只能 profile 级物理开关** —— "只对这个会话关掉某插件"物理上做不到，别假装能做

## 实测收益

12GB 笔记本显卡跑 27B、256K 全驻留，同一段对话：

| 阶段 | tools | prompt | decode | prefill |
|---|---|---|---|---|
| 全开 | 105 | 56,306 | 22.5 tok/s | 487 tok/s |
| 关三个插件（插件层） | 62 | 34,207 | 43.0 tok/s | 136 tok/s |
| 会话套 local 档（工具层） | **14** | **12,890** | **66.8 tok/s** | **1.31k tok/s** |

裁工具面会连带去掉技能目录注入，再省约 4.3K token。

## 三层

| 层 | 作用域 | 做什么 |
|---|---|---|
| 会话档位 | 单个会话 | `agent.ctx.tools.restrict({ allow })`，`full` 档 = 不限制 |
| provider 默认档 | 触发条件 | 本地 provider 的新会话套 `local`，云端套 `full`；切了就重算**这一条**会话 |
| 插件开关 | profile | `setPluginEnabled`，物理启停，影响全部会话 |

## 装

```bash
dsh plugin --profile <你的 profile> add github:haidai233/dsh-plugin-trim
```

或本地目录：

```bash
dsh plugin --profile desktop add D:\path\to\dsh-plugin-trim
```

装完重启 DSH。

## 面板

**固定地址，装完就能开：**

```
http://127.0.0.1:12256/
```

插件自己起一个只监听回环的 HTTP 服务（默认 12256，被占则自动 +1 顺延，可用 `panelPort` 改）。**跟 DSH 的端口无关**，DSH 重启多少次都不变。

Windows 上还有个启动器（包里自带）：

```
open-panel.cmd          # 打开面板；12256 不通时回退扫 DSH 端口
open-panel.cmd check    # 只打印地址
```

面板内容：

- **会话**：每行一个会话（本地/云端、provider、档位下拉、工具数、是否已裁），可以给单条会话换档或改回「跟随 provider」
- **档位定义**：选一个档位（`local` / `custom`），逐工具勾选白名单并保存；`full` 固定不限
- **本地 provider**：指定哪个 provider 算本地
- **插件（profile 级）**：全部可管理插件，带搜索/分页/「只看已停用」，核心组件停用前弹确认

## 给模型的工具

`tool_trim`：

| action | 作用 |
|---|---|
| `list` | 本会话可见的工具名 |
| `status` | 本会话的 provider / 档位 / 是否已裁 |
| `profile` | 给本会话换档（`full` / `local` / `custom`） |
| `set` | 把某个工具加进/移出本会话当前档位 |
| `apply` | 按当前档位重装 |
| `restore` | 撤掉限制，恢复全部 |

## 配置（`cordis.patch.yml` 的 config 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `followTools` | true | provider 变化时给这条会话自动套默认档 |
| `auto` | false | true = 切到本地 provider 时**顺带物理开关插件**（profile 级，慎用） |
| `localProvider` | 空 | 哪个 provider 算本地；面板选的值存在 `~/.dsh/plugin-trim-state.json`，优先于这里 |
| `routes` | `[]` | 非空时只认这些 provider |
| `localEntries` | 示例 3 条 | 插件层要关掉的 entryId |
| `defaultProfileFor` | `{local: local, cloud: full}` | 本地/云端各套哪个档 |
| `profiles.local` | 14 项 | `local` 档白名单 |

本地 provider 判定：`localProvider` 写死 / `routes` 命中 / baseURL 落在回环或私有网段 / id 带 local、ollama、llama、vllm、sglang 等标记。

## HTTP 接口

固定端口面板（`127.0.0.1:12256`）：

| 方法 | 路径 |
|---|---|
| GET | `/` 面板页 |
| GET | `/health` |
| POST | `/api/plugin-trim/{status,setProfile,autoProfile,setProfileTools,setProvider,applyAll,restoreAll,set,applyPlugins,restorePlugins}` |

同一套处理函数还会注册到 DSH 自带 webServer 上（`/api/plugin-trim/...`，带同源校验），两个入口等价。

## 已知限制

- **换到更宽的档位之前必须先撤旧限制**，否则读到的是上一次裁过的工具集，越裁越少。已修（`applyProfile` 里先 release 再读可见集），但**热重载会泄漏**：v0.1 没有把 restrict 的 disposer 注册到 `ctx.effect`，重载后旧限制留在工具层撤不掉。v0.2 已修；升级后**重启一次 DSH** 清掉遗留。
- 插件层：整条 bundle 停用后会脱离组合，DSH 自己也认不回来（`unknown-plugin`）。这类条目「还原」无效，只能去 patch 文件删掉那两行再重启；接口会以 `skipped[].hint` 提示。
- 裁工具会把 `skill` 一起裁掉，技能目录随之不再注入（约 4.3K token）。要用技能就把 `skill` 加进档位。
- `tool_trim` 自己不在白名单里，装了小档位后模型侧调不到它 —— 换档走面板或 HTTP。
- 与 `dsh-local-trim` 功能有重叠，**不要同时启用两者**对同一 provider 做裁剪。

## 许可

MIT
