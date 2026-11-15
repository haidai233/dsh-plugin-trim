# dsh-plugin-trim

按模型裁剪插件和工具的 DSH 插件：**用本地模型时自动关掉一批吃 token 的插件、把工具面裁到白名单**，切回云端自动放开；带一个自带的面板（浏览器直开，不依赖 DSH 侧栏）。

Trim plugins and the tool surface per provider: when a local model is in use, switch off token-hungry plugins and restrict tools to a whitelist; restore automatically on cloud providers. Ships a self-hosted panel that works without any market listing.

## 为什么

DSH 每轮请求都会把**所有**工具的 JSON schema 塞进上下文。常见的 100+ 个工具，工具定义本身就占 **~2.9 万 token**；本地 27B 的 prefill 只有 ~500 tok/s，等于每轮固定交 1 分钟入场费，且上下文越长越慢。

实测（RTX 4080 Laptop 12G + 27B 2-bit KV，256K 全驻留）：

| 阶段 | tools | prompt | decode | prefill |
|---|---|---|---|---|
| 全开 | 105 | 56,306 | 22.5 tok/s | 487 tok/s |
| 关三个插件 | 62 | 34,207 | 43.0 tok/s | 136 tok/s |
| 再裁工具白名单 | **14** | **12,890** | **66.8 tok/s** | **1.31k tok/s** |

## 装

```bash
dsh plugin --profile <你的 profile> add github:haidai233/dsh-plugin-trim
```

或本地目录：

```bash
dsh plugin --profile desktop add D:\path\to\dsh-plugin-trim
```

装完重启 DSH。

## 两层控制

| 层 | 机制 | 可逆性 |
|---|---|---|
| 插件层 | `pluginManager.setPluginEnabled(entryId, enabled)`，和「设置 → 插件」手点一样 | 大部分可逆；整条 bundle 停用后会脱离组合，见「已知限制」 |
| 工具层 | `agent.ctx.tools.restrict({ allow })` + disposer | 完全可逆，不写任何配置 |

工具层**按会话**生效：每个 agent 按它自己的 provider 判断该不该裁，切模型时实时重排（事件 + 120ms 补排，防投影晚一拍），**不会把云端会话一起裁掉**。

## 面板

自带一个页面，不依赖插件市场列表（本地 `link:` 安装的包没有市场卡片）：

```
http://127.0.0.1:<DSH 当前端口>/api/plugin-trim/panel
```

DSH 端口每次启动都变，所以仓库里带了一个启动器（Windows）：

```
open-panel.cmd          # 找出 DSH 正在监听的端口，打开面板
open-panel.cmd check    # 只打印地址
```

Windows 上可以给它建个桌面快捷方式，就不用记端口。

面板内容：provider 选择（哪些算本地）、工具勾选（保留/裁掉）、全部插件开关（分页、搜索、只看停用）、一键「本地模式 / 还原」、**作用范围：只对本地会话生效**（默认勾）。

## 给模型的工具

`tool_trim`：`list` / `status` / `set` / `apply` / `restore`。

## 配置（`cordis.patch.yml` 的 config 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `auto` | false | true = 切到本地 provider 时**同时**开关插件（工具层不受此开关控制，始终跟随） |
| `followTools` | true | 工具层是否跟随 provider 自动裁/放 |
| `localProvider` | 空 | 写死哪个 provider 算本地；面板里选的值优先，存在 `~/.dsh/plugin-trim-state.json` |
| `routes` | `[]` | 非空时只认这些 provider，关掉自动识别 |
| `localEntries` | 示例 3 条 | 插件层要关掉的 entryId |
| `keep` | 14 项 | 工具白名单 |

本地 provider 判定（和 `dsh-local-trim` 同一套）：`localProvider` 写死 / `routes` 命中 / baseURL 落在回环或私有网段 / provider 名带 local、ollama、llama、vllm、sglang 等标记。

## HTTP 接口

`POST /api/plugin-trim/{status,apply,restore,set,tools,toolsApply,toolsRestore,setTool,setProvider}`
`GET  /api/plugin-trim/panel`

同源校验（Origin 与 Host 不同源即 403）。

## 已知限制

- 关/开插件会写 profile 的 `cordis.patch.yml`（`- id: xxx` + `disabled: true`）。
- **整条 bundle 停用后会脱离组合**，DSH 自己也认不回来（`unknown-plugin`）。这类条目「还原」无效，只能去 patch 文件里删掉那两行再重启；接口会以 `skipped[].hint` 明确提示。
- **裁工具会把 `skill` 一起裁掉**，技能目录随之不再注入（约 4.3K token 一起省了）。要用技能就把 `skill` 加进 `keep`。
- `tool_trim` 自己不在白名单里，装了限制后模型侧调不到它 —— 还原走面板或 HTTP。
- 与 `dsh-local-trim` 功能有重叠，**不要同时启用两者**对同一 provider 做裁剪。
- 面板的 DSH 侧栏卡片需要市场收录；本地 `link:` 包不会出现在侧栏，用自带面板页。

## 许可

MIT
