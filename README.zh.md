# dsh-plugin-subagent-roles

[English](README.md) | 中文 | [更新日志](CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-subagent-roles)](https://www.npmjs.com/package/dsh-plugin-subagent-roles)
[![CI](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml/badge.svg)](https://github.com/troytse/dsh-plugin-subagent-roles/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 概述

`dsh-plugin-subagent-roles` 用文件来定义子代理角色。一个角色就是一个 Markdown 文件：frontmatter 里是显示名、路由描述、可选的模型路由、工具策略和可选的工具调用预算，正文是子代理要遵循的 persona。项目级角色放在 `<项目>/.dsh/roles/`，全局角色放在 `~/.dsh/roles/`；同 id 同时存在时项目级生效。

插件注册一个委派工具，并把当前工作区里的角色以一行行的紧凑目录告知主代理。委派到某个角色时，子代理带着该角色的 persona 启动，且只保留策略允许的工具——主代理的上下文里不会出现 persona 正文，没有角色文件的项目也不会看到任何目录。角色还可以限制子代理能用多少次工具：这是由框架自己的 `tool/call` 事件计数的**硬**上限，因此不肯收尾的子代理会被强制停下。

## 安装

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-plugin-subagent-roles

# 或本地 checkout
dsh plugin --profile web add link:/path/to/dsh-plugin-subagent-roles
```

装好后重启 profile（`dsh web`）。包内自带 bundle patch，会自行插入它的那一行组合，无需手改 composition。要求 Node.js 20 以上，以及提供 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-subagent` 的 DSH 部署。

## 快速开始

在项目里创建一个角色文件：

```markdown
---
displayName: 代码审查员
description: 审查改动的正确性、安全性与测试覆盖，按严重级别给出结论。
provider: deepseek-official
model: deepseek-v4-flash
reasoningEffort: low
tools: [read, grep, glob]
---
你是代码审查员。先读改动再下结论，区分阻塞项与建议项，
每条问题都给出文件与行号。
```

然后让主代理委派——“让代码审查员角色审一下这个改动”——或直接调用工具：

```js
subagent_role({ role: "code-reviewer", prompt: "审查已暂存的改动。", description: "审查暂存改动" })
```

角色在组装提示词时读取、在委派开始时再读取一次，因此改角色文件**不需要重启 DSH**。同风格的派发提示词见 `examples/delegation-prompts.zh.md`。

## 角色文件

### 角色从哪里读取

| 优先级 | 路径 | 说明 |
|---|---|---|
| 1 | `<项目>/.dsh/roles/<id>.md` | `<项目>` 是从会话工作目录向上找到的第一个含项目标记（默认 `.git`）的目录；找不到标记时就是工作目录本身。 |
| 2 | `~/.dsh/roles/<id>.md` | 跨项目共用。可用 `dshHome` 改位置。 |

角色文件可以是符号链接。文件按文件名寻址，因此 id 就是文件名（去掉 `.md`），必须是 kebab-case。

### 文件格式

frontmatter 是 YAML 映射，正文是 persona。

| 字段 | 必填 | 含义 |
|---|---|---|
| `description` | 是 | 目录里显示的一行描述，主代理据此判断要不要委派。 |
| `name` | 否 | 写了就必须与文件 id 一致，用来拦住"改了文件名却没改声明"。 |
| `displayName` | 否 | 人可读的名字，默认取 id。 |
| `whenToUse` | 否 | 追加在目录行末尾的补充路由提示。 |
| `provider`、`model` | 否 | 子代理的模型路由。两者必须同时出现或同时省略；省略时继承主代理的路由。 |
| `reasoningEffort` | 否 | 子代理的思考力度，随路由一起生效。 |
| `tools` | 否 | 允许清单简写，如 `[read, grep, glob]`。 |
| `toolFilter` | 否 | 显式策略：`{ allow: [...], deny: [...] }`。 |
| `maxToolCalls` | 否 | 子代理工具调用次数的硬上限，整数。**省略**则继承行配置的 `defaultMaxToolCalls`；写 `0` 表示**显式不限**，它会**覆盖**行默认值。 |
| `maxToolCallsScope` | 否 | `delegation`（默认）每次委派重新计数——continuable 子代理的每个 `turn/start`（即一次后台唤醒）也算新的一次；`session` 则按该子代理整个生命周期累计。 |
| `onToolCallBudget` | 否 | 额度耗尽时的行为：`wrap-up`（默认）、`interrupt` 或 `off`。 |
| `graceToolCalls` | 否 | `wrap-up` 注入通知后额外放行的调用次数，默认 `1`；`0` 表示在触发的那一次调用上直接收口。 |

`tools` 与 `toolFilter` 只能二选一。**未知的 frontmatter 键会被拒绝**而不是忽略，避免拼写错误悄悄放宽角色的工具范围。

`maxToolCalls` 族字段需要**插件 ≥ 0.4.0**。旧版本完全不认识这些键，会把整个角色文件判为非法而跳过，因此**角色文件与插件版本是绑定的**：给某个角色加上额度，就意味着每个使用该工作区的机器都要升级插件。

persona 正文可以使用 `{{cwd}}`、`{{model}}`、`{{provider}}`——**恰好是 agent loop 注册的那三个**，由框架在子代理侧插值。部署里若另有插件注册了更多变量，可在 `personaVariables` 中列出；除此之外的任何引用都会在读取角色文件时被拒绝，因为未知变量会让**该子代理的每一轮**都抛错。引用按精确规则匹配（花括号内不能有空格）；而目录字段——`description`、`displayName`、`whenToUse`——**完全不能出现 `{{`**，因为目录文本在到达模型之前同样会经过插值。

## 配置

行配置如下；在 profile patch 里按 id 覆盖即可：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: subagent-roles
  name: dsh-plugin-subagent-roles
  config:
    catalogDescriptionMaxLength: 120
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `toolName` | `subagent_role` | 模型可见的委派工具名。 |
| `subagentProvider` | `spawn` | 子代理传输 provider。 |
| `backgroundMode` | `one-shot` | `one-shot` 或 `continuable`。 |
| `enableRunInBackground` | `true` | 是否在工具上暴露 `run_in_background`。 |
| `maxDepth` | 不设 | 委派深度上限；不设则由 provider 决定。`0` 表示拒绝任何委派。 |
| `defaultRole` | 不设 | 调用未给 `role` 时使用的角色。 |
| `catalog` | `compact` | `compact` 渲染角色目录；`off` 完全不渲染。 |
| `catalogScope` | `main` | `main` 只向顶层 agent 展示角色；`all` 连子代理也展示。 |
| `catalogDescriptionMaxLength` | `160` | 目录行里每条描述的截断长度。 |
| `projectRootMarkers` | `['.git']` | 从会话工作目录向上寻找项目根的标记。 |
| `projectRootTtlMs` | `5000` | 项目根结果被信任多久后重新向上查找，好让会话运行中 `git init` 也能被发现。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 全局 `roles/` 目录所在位置。 |
| `maxBodyBytes` | `65536` | persona 体积上限，按 UTF-8 字节计。超过该值加 64 KiB frontmatter 余量的文件**在读取之前**就被拒绝。 |
| `personaVariables` | `['cwd', 'model', 'provider']` | 允许 persona 引用的提示词变量。仅当部署确实注册了更多变量时才扩充。 |
| `respectModelSelection` | `true` | 是否遵守官方 `subagent-model-selection` 允许清单：先看会话已捕获的策略，再看实时设置。 |
| `onMissingTool` | `drop` | 不可用的工具名：`drop` 告警后继续，`error` 直接拒绝委派。 |
| `timeoutMs` | 不设 | 单次前台委派的工具调用超时。不设则不限时。 |
| `defaultMaxToolCalls` | `0` | 角色文件未声明额度时使用的工具调用预算。`0` 表示不限，且**默认就是 0**：2277 个文件的大仓和一个小项目对"合理调用数"的定义不同，所以这个数字属于角色文件而不是全局硬编码。 |
| `maxToolCallsHardCap` | `0` | 角色文件不得超过的上限，防止项目侧把额度开到失去意义。`0` 表示不设上限，且**永不削顶显式的 `maxToolCalls: 0`**——"不限"是哨兵值而不是数值零。 |
| `onToolCallBudget` | `wrap-up` | 额度耗尽行为的行级默认值，可被角色文件覆盖。 |
| `graceToolCalls` | `1` | 宽限次数的行级默认值，可被角色文件覆盖。 |
| `enableListTool` | `false` | 是否注册诊断工具。 |
| `listToolName` | `subagent_roles` | 诊断工具的名字，让第二行能与之共存。 |
| `childPromptTrim` | `full` | 裁剪**子代理**提示词：`full` 丢弃子代理用不上的工具说明，外加命名过的提示词片段；`tools` 只丢前者；`off` 不注册该监听器。主代理的提示词永不改动。 |
| `childPromptTrimNames` | `['harness:source', 'app:web-surface', 'ui:deliverable-file-references', 'context:file-reference']` | `full` 模式下丢弃的提示词片段名，**section 与 context 一并匹配**。清空该列表即全部保留。 |

## 工具策略

角色的策略决定子代理能看见、能调用哪些工具。`tools`（以及 `toolFilter.allow`）是允许清单：未列出的一切都会从子代理消失——schema 与对应提示词一起——调用也会被拒。`toolFilter.deny` 只移除指定工具、保留其余。条目支持通配符 `*` 与 `?`，例如 `mcp__demo__*`。

通配符在委派时按**主代理当时可见的工具名**展开，所以某个工具还没注册也不会让委派失败。不可用的字面名会被丢弃并告警；`onMissingTool: 'error'` 会改为直接拒绝。允许清单展开为空时会原样传下去（空允许清单 = 隐藏全部继承来的工具），而不是放开全部工具。

两类情况单独处理：

- `run_code`（PTC 部署的呈现传输）永远不会进入策略：工具注册表会列出它，但核心不允许按这个名字做限制。
- 主代理**自己作用域**里注册的工具会被父代理继承，但不属于子代理的作用域链。写出这类名字会导致核心拒绝创建子代理；插件会把这些名字剔除、重试一次委派，并告警。

## 工具调用预算

角色文件里的 `maxToolCalls` 是插件**强制执行**的硬上限，**不依赖子代理自觉**。计数取自框架自己记录的 `tool/call` 事件，既不采信子代理自报，也不解析它的输出。

### 什么算"一次"

计量单位是**次**而不是**轮**——这正是当初"8 步"口头约定失效的原因：

| 情形 | 计为 |
|---|---|
| 同一步内并行发起的多个调用 | 各计 1 |
| 调度器已落盘、随后被策略/guard 拒绝的调用 | 1 |
| 同一步中被取消而跳过的调用 | 1 |
| wrap-up 注入的收尾通知本身（是消息，不是工具调用） | 0 |
| 子代理自己再派生的孙代理 | 只计该子代理自身；每个孙代理独立计数 |

`used === limit` **不算超限**；跨过上限的那一次才算。收口是**反应式**的：那次调用已经写进会话日志，插件是在它结束前把子代理停下。所以保证的是"子代理会停"，而不是"触发的那次调用不会开始"。

### 额度耗尽时

| 模式 | 行为 |
|---|---|
| `wrap-up`（默认） | 投递一条插件署名的收尾通知（"预算已耗尽，请产出部分结论"），再宽限 `graceToolCalls` 次调用，之后才停下子代理。 |
| `interrupt` | 投递**同一条**通知，并在触发的那一次调用上立即停下。 |
| `off` | 只告警一次，永不拦截——因此也**不往子会话写入任何持久记录**。 |

`graceToolCalls: 0` 就是 `interrupt`：同一条通知、同一次调用上的同一个停止点。

收口机制取决于委派路径，这一点值得记住：`SubagentRuntime.interrupt()` 对 one-shot run 是**被接受的 no-op**，因此前台/后台的 one-shot 子代理是通过它启动时所用的信号被取消的，只有 `continuable` 子代理才走运行时中断。远程传输若不发布本地子代理对象，它的子代理就**跑在本进程之外**：其 `tool/call` 事件到达不了护栏，既数不到也停不下，wrap-up 通知也投递不了——插件会在委派时就告警，而不是把一个并未受保护的角色报成已受保护。

### 如何通知子代理与主代理

收尾通知是一条带**显式 `plugin` 来源**的 `user` 角色消息，通过 `Agent.inject()` 投递，因此它落在下一个 step 边界，且**不会把空闲子代理唤醒成一个新轮次**。显式来源是必须的：省略 source 会被解析成 `user`，等于让机器生成的指令冒充人类输入。

同一条通知就是**这次收口的持久记录**：它把 `used`/`limit`/`scope`/`mode` 写进子会话自己的日志，因此被停下的委派可以回放——**停在哪一次、还剩多少**。正因如此，它在**每一次**收口时都会投递（包括 `interrupt`），而不只是 `wrap-up`：对一个被直接杀掉的子代理，光靠宿主日志回答不了这个问题。`off` 是唯一从不收口的姿态，因此不写子会话记录。

被停下的**前台**委派返回一个正常的结构化结果——`status: 'tool-call-budget-exceeded'`，外加 `reason`、`role`、`used`、`limit`、`scope`、`mode` 与可能的 `partialOutput`。它**故意不是错误**：抛错会被主代理当成可重试的工具故障，而这里真正该选的是"派更窄的任务 / 放宽额度 / 接受部分结论"。**后台**委派则让 job 的 detail 明确写出预算收口，从而不会与"用户 kill"混淆。

`timeoutMs` 与预算是**正交**的两个护栏，谁先到就由谁出报告：预算收口是上面那个结构化结果，而超时保留核心自己的 `TOOL_TIMEOUT` 错误。两者不会被混成同一个失败。

## 诊断

打开 `enableListTool` 后会注册 `subagent_roles`：它逐个列出角色及其来源、文件路径、绑定路由、persona 体积、展开后的策略、schema 字符预算，以及**工具调用额度与它的来源**（角色文件 / 行默认 / 不限），还有被跳过的文件和原因。

要核对一次已完成的委派，读子代理的会话日志即可：

```sh
node scripts/inspect-session-budget.mjs --project <项目目录>
node scripts/inspect-session-budget.mjs <会话目录> --all --grep "你是代码审查员"
```

该脚本只读地解码会话日志，打印系统提示体积、该会话请求的工具 schema，以及角色目录是否到达了那个会话。

## 设置界面

裁剪策略**与工具调用预算**共用一个宿主 settings namespace（`subagent-roles`），并在 **Settings → Plugins** 里配一张卡片，因此不改文件也能调。行 config 是该 namespace 的 `base` 层；卡片把用户层写进 `~/.dsh/settings.yaml`，且**下一个子代理轮次**即生效（`applies: live`），无需重启。预算的四个键与行 config 同名：`defaultMaxToolCalls`、`maxToolCallsHardCap`、`onToolCallBudget`、`graceToolCalls`。角色文件自己声明的 `maxToolCalls` 仍然优先；设置层只提供"角色文件省略时的默认值"。

卡片外观按宿主约定由本插件自画，并**对照宿主的 `PluginCard`**：可折叠的表头（标题 + 说明 + 箭头旋转）、未保存徽标、正文表单、底部 Reset / Discard / Save，直接用宿主自己的规则与 `--dsw-alias-*` token，因此与 bash、agent-loop、subagent 模型选择那几张卡同款。两处刻意偏离并已在代码注释说明：徽标是自绘（宿主用 `Tag` 原语，但那需要声明非基线模块请求）；失败文案用 `--dsw-alias-state-error-primary`，因为宿主自己用的 `--dsw-alias-label-error` 在当前主题里**并不存在**。宿主只负责铺一列并派发 slot —— "chrome, controls, and copy" 全归插件。

**编辑遵循宿主的卡片约定**：所有控件只渲染暂存值，Save 才写入（由 settings scope 以读取时的 revision 做栅栏）；Discard 丢弃草稿；**Reset 只暂存组合默认值、不立即写入**（写入的是 unset，因此字段重新继承部署配置，而不是把当前默认钉成覆盖值）；**没改动的字段根本不写**（用户层里"存在"即等于"已覆盖"，写它会让以后改部署配置失效）；**编辑某字段会取消该字段的 Reset 暂存**（否则你输入的内容会被静默丢掉）；清空保存后卡片自动折叠，保存失败则保持展开并保留草稿。表头的"未保存"徽标在折叠状态下也可见。

**文案跟随 Language 设置**：卡片注册自己的 locale 词典（`zh` / `en`，键相同），并在注册项上声明 `locale: <namespace>`，由渲染层把 `t` 绑到该 namespace（`props.t`）；拿不到 locale 服务时退回插件自带的英文词典（`locale.bind` 绑定优先，其次英文表）。**不写"中英并列"的硬编码文案** —— 那既不跟随语言设置，也会在两种语言下都显得别扭。

卡片编辑的就是行 config 那六个键（裁剪两个 + 预算四个）。两条配对规则来自宿主而非本插件：Plugins 页为**每个已服务的 namespace** 派发一个 slot key，只渲染注册在该 key 下的卡片——这就是插件要带浏览器半边的原因（`lib/client.js`，经 `dsh.client` 与 `exports["./client"]` 声明）；反之，卡片对应的 namespace 若本部署没有服务，卡片也不会被派发。用改名后的 `toolName` 挂第二行时，其 namespace 是 `subagent-roles-<tool>`，**没有卡片**（浏览器半边绑定的是默认 key），请直接改 `settings.yaml`。

没有 settings provider 的部署仍以行 config 为唯一权威；namespace 注册失败（存量配置非法、与另一行撞名）会记一条告警并退回行 config，而不是让裁剪失效。

## 工作原理

- **目录**：一个提示词 section，按每次组装求值，列出该 agent 工作区的角色：一行说明，加每个角色一行 `- <id> (<显示名>): <描述>`。在以下情况渲染为空且不占上下文——项目没有角色、目录被关闭、当前是子代理、或该 agent 看不到委派工具。
- **委派**：`subagent_role` 按主代理的工作目录解析角色，然后经 `ctx.subagents` 启动子代理，带上该角色的 persona、路由与工具策略。工具面向模型的说明会跟随传输 provider：fork 型 provider 的子代理已带上本会话已完成的轮次，此时说明改成「在已有轮次上继续」，而不是「必须自带完整上下文」。路由在子代理存在之前就会经 `llm.resolveCallConfig()` 预检，因此角色文件里 `model` 或 `reasoningEffort` 写错时，报错会回到主代理手上，而不是从子代理创建过程里抛出。
- **多行共存**：目录 section 与诊断工具都按行命名（`<toolName>:catalog`、`listToolName`），所以同一个 profile 可以为另一种传输 provider 再挂一行（`toolName: subagent_role_fork`），两边都不会撞名。
- **子代理提示词裁剪**：核心把大多数工具说明注册成**静态文本**（只有 `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-web`、`dsh-file-reference-local` 会按 scope 求值），于是子代理既继续为「被角色策略藏掉的工具」付说明费，也继续读它永远用不上的 Web GUI、harness checkout 与交付链接说明。一个 host 层的 `system-prompt/assemble` 监听器只丢这些死文本：子代理看不到的**已注册**工具的 `tool:<name>` 说明；组标签说明（`tool:jobs`、`tool:goal`）在它自身文本点到的工具全部不可见时丢弃；`full` 模式（默认）再丢命名过的提示词片段。真实委派实测：角色子代理提示词 5,765 → 1,904 字符（−67%），而主代理逐字节不变。规则推导的部分无需维护；命名的那部分是逐行可覆盖的——子代理该不该继续看到 harness checkout 或交付链接属于部署判断，不是事实。**一份名单同时匹配 section 与 context 是刻意的**：实测发现当前核心把 `context:file-reference` 注册成了 section（尽管名字里有 `context:`），只匹配 context 的名单会静默放过它。
- **继承**：子代理加入父代理的 agent preset，因此保留父代理的提示词与工具，仅由角色策略移除其中一部分。角色 persona 只对该子代理遮蔽部署 persona 前缀。
- **工具调用预算**：每行一个 host 层 `session/event` 观察者，统计本行发起过的每个子会话所提交的 `tool/call` 事件；另有一个 `session/disposed` 释放钩子，避免已结束子会话的记录滞留。委派启动时登记一条记录——`0`（不限）不登记任何东西，因此没有预算的角色零成本。跨过上限时通过 `Agent.inject()` 投递一条插件署名通知（它同时就是持久审计记录），随后由收口姿态用两种机制之一结束子代理：one-shot 用其 run 信号，continuable 用 `SubagentRuntime.interrupt()`。收口按轮次限流为一次，因此被停下那一批里从未启动的调用不会把同一次停止重复一遍。计数按子会话 id 索引，父代理、兄弟与孙代理互不共享。

## 已知边界

- 子代理**自己作用域**里注册的工具不受角色工具策略影响：核心的 restrict 只作用于继承来的工具。委派运行时与部分工具插件会按 agent 注册，因此子代理可能比允许清单多出少量工具。
- 隐藏工具会移除它的 schema 以及作用域感知的提示词段落；纯静态文本的段落仍会留在子代理提示词里——这正是 `childPromptTrim` 要处理的部分，也是 `tools` 模式无需维护、而 `full` 模式依赖 section 名的原因（未来核心改名后该段只是不再被裁剪，不会报错）。
- 角色 persona 会替换子代理的部署 persona 前缀；persona 后缀（例如工作目录那一行）保留。
- `respectModelSelection` 优先使用会话已捕获的策略（与官方委派工具写入的同一个持久 projection），没有捕获时才回退到实时 `subagent-model-selection` 设置——实时设置只用于给新会话播种。因此改动只对**尚未捕获策略**的会话生效。
- **行 config 写 `childPromptTrim: 'off'` 会连同 Settings 卡片一起卸掉**：不注册 namespace 就没有可派发的 key，卡片不会出现（这是刻意的——运维的 `off` 应当是不可被 UI 翻回来的关闭开关）。工具调用预算与该 namespace 共用同一个键，因此 `off` 也会一并去掉设置里的预算旋钮，此时额度只来自角色文件与行 config。想在保留卡片的前提下停用裁剪，请把**卡片里的模式**设为 `off`，或行 config 用 `tools`。
- Settings 卡片只覆盖默认行的 namespace（`subagent-roles`）。经 `toolName` 改名的第二行属于另一个 namespace，因此不显示卡片。
- 本插件只注册**一张卡**（Settings → Plugins → Plugin configuration），不额外占一个 Settings 导航分组。插件配置走卡片是宿主约定（bash、agent-loop、subagent 模型选择、web 搜索都是卡片）；像 dshmarket 那样自成一个导航分组，是因为它有一整页浏览界面。
- `childPromptTrim` 作用于宿主所见**每一个**子代理的组装，而不只是本插件发起的角色子代理：运行时不在子代理上记录角色标记，所以 `subagent` 等其他行的子代理同样受益。注册在 agent 自身作用域里的工具（`subagent`、`list_agents`）不在注册表的全局视图里，因此它们的说明永不被裁剪——真的能调用它的子代理会保住自己的说明。
- 委派工具默认不声明 `timeoutMs`，前台委派因此可能比发起它的对话活得更久；长任务请用 `timeoutMs`、`maxDepth` 或派发提示词约束。
- 工具调用预算是**反应式**收口的：跨过上限的那一次调用已经写进会话日志，插件是在它结束前停下子代理，而不是阻止它开始。计数本身是精确的。
- 远程传输若不发布本地子代理对象（`SubagentRun.localAgent` 为 `undefined`，例如进程外 provider），其子代理跑在本进程之外，`tool/call` 事件到达不了护栏：预算既数不到也停不下它，通知也投递不了。插件会在委派时告警，而不是把一个并未受保护的角色报成已受保护。进程内传输不受影响。
- `timeoutMs` 与预算是相互独立的，但它们**呈现**结果的方式也独立——如果预算收口已经开始、而工具调用 deadline 在停止后的 run 仍在拆卸时到期，核心自己的 timeout 包装器会用 `TOOL_TIMEOUT` 错误替换掉那个结构化结果。子代理两种情况下都会被停下，只是"报告"可能归后到的那个护栏。
- `scope: session` 的收口按轮次限流为一次：被父代理再次唤醒的、已超额的 continuable 子代理会被**再次**停下，但被停下那一批里从未启动的调用不会各自重复一遍停止。
- 反过来，按轮次限流也意味着：`scope: delegation` 的额度一旦触发，在**该轮剩余时间里**会保持安静，即使 `used` 继续增长；下一轮重新计数（也会重新收口）。
- 监视器的记录表有上限（256 条），淘汰顺序是**插入序而不是使用序**——它是防泄漏的兜底，不是生命周期本体。记录通常会在其子会话被 dispose、或委派结算时释放，所以淘汰理应只碰到被遗弃的条目；极端churn 下若真有活记录被淘汰，那个角色的额度会静默失效。
- `maxToolCallsHardCap` **不会**约束显式的 `maxToolCalls: 0` / `defaultMaxToolCalls: 0`。`0` 是"不限"哨兵而不是计数，因此逃生口优先于上限——请用上限去削一个已声明的数字，而不是用它禁止"不限"。
- 额度按子会话计数：同名角色的两个并发委派不会共享计数；`scope: session` 会跨 continuable 子代理的多次唤醒持续累计，直到插件行卸载或那个有上限的记录表把它淘汰。
- 角色额度**不会**出现在角色目录里，只有 `subagent_roles` 会报告它，因此带预算的角色对提示词体积没有影响。
- 发现缓存有上限（512 条），因此同一宿主进程里访问过极多不同项目时，会比其他情况更频繁地重新 stat 文件；结果不受影响。
- 诊断脚本需要 Node.js 22.15 以上（多帧 zstd 解码）；插件本身在 Node.js 20 上运行。

## 开发

```sh
npm test                                      # 单元测试（node --test）
npm run lint                                  # 对 lib/、scripts/、test/ 做 node --check
node --test --experimental-test-coverage      # 逐文件覆盖率
```

运行时在 `lib/`：`roles.js`（发现与解析）、`catalog.js`（目录文本）、`policy.js`（工具策略）、`route.js`（模型路由）、`budget.js`（工具调用预算的解析与计数）、`tool.js`（委派与诊断工具）、`config.js`（行配置）、`settings.js`（设置命名空间）、`index.js`（插件装配）。

CI 在 Node.js 20、22、24 上运行 `npm run lint` 与 `npm test`。

### 发版

1. 先在 `CHANGELOG.md` 补一条 `## [<版本号>]` 记录。发版工作流会拒绝发布一个更新日志里没有的版本。
2. `npm version <patch|minor|major>` 会提交版本号变更并打 tag，推送提交与 tag。
3. `.github/workflows/publish.yml` 会跑测试、校验 tag 与 `package.json` 版本一致、校验更新日志条目，再通过 npm trusted publishing（OIDC）发布并附带 provenance 证明，因此仓库里不保存任何长期 token。

首次自动发版前，需要先在 npm 的包设置页把 `publish.yml` 登记为 trusted publisher。

## 许可

MIT
