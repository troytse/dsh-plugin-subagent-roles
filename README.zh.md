# dsh-plugin-subagent-roles

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-plugin-subagent-roles)](https://www.npmjs.com/package/dsh-plugin-subagent-roles)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 概述

`dsh-plugin-subagent-roles` 用文件来定义子代理角色。一个角色就是一个 Markdown 文件：frontmatter 里是显示名、路由描述、可选的模型路由和工具策略，正文是子代理要遵循的 persona。项目级角色放在 `<项目>/.dsh/roles/`，全局角色放在 `~/.dsh/roles/`；同 id 同时存在时项目级生效。

插件注册一个委派工具，并把当前工作区里的角色以一行行的紧凑目录告知主代理。委派到某个角色时，子代理带着该角色的 persona 启动，且只保留策略允许的工具——主代理的上下文里不会出现 persona 正文，没有角色文件的项目也不会看到任何目录。

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

角色在组装提示词时读取、在委派开始时再读取一次，因此改角色文件**不需要重启 DSH**。同风格的派发提示词见 `examples/delegation-prompts.md`。

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
| `displayName` | 否 | 人可读的名字，默认取 id。 |
| `whenToUse` | 否 | 追加在目录行末尾的补充路由提示。 |
| `provider`、`model` | 否 | 子代理的模型路由。两者必须同时出现或同时省略；省略时继承主代理的路由。 |
| `reasoningEffort` | 否 | 子代理的思考力度，随路由一起生效。 |
| `tools` | 否 | 允许清单简写，如 `[read, grep, glob]`。 |
| `toolFilter` | 否 | 显式策略：`{ allow: [...], deny: [...] }`。 |

`tools` 与 `toolFilter` 只能二选一。**未知的 frontmatter 键会被拒绝**而不是忽略，避免拼写错误悄悄放宽角色的工具范围。

persona 正文可以使用 `{{cwd}}`、`{{model}}`、`{{provider}}` 三个提示词变量，由框架在子代理侧插值。引用按精确规则匹配（花括号内不能有空格）；而目录字段——`description`、`displayName`、`whenToUse`——**完全不能出现 `{{`**，因为目录文本在到达模型之前同样会经过插值。

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
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 全局 `roles/` 目录所在位置。 |
| `maxBodyBytes` | `65536` | persona 体积上限，按 UTF-8 字节计。 |
| `respectModelSelection` | `true` | 是否遵守官方 `subagent-model-selection` 允许清单。 |
| `onMissingTool` | `drop` | 不可用的工具名：`drop` 告警后继续，`error` 直接拒绝委派。 |
| `enableListTool` | `false` | 是否注册诊断工具 `subagent_roles`。 |

## 工具策略

角色的策略决定子代理能看见、能调用哪些工具。`tools`（以及 `toolFilter.allow`）是允许清单：未列出的一切都会从子代理消失——schema 与对应提示词一起——调用也会被拒。`toolFilter.deny` 只移除指定工具、保留其余。条目支持通配符 `*` 与 `?`，例如 `mcp__demo__*`。

通配符在委派时按**主代理当时可见的工具名**展开，所以某个工具还没注册也不会让委派失败。不可用的字面名会被丢弃并告警；`onMissingTool: 'error'` 会改为直接拒绝。允许清单展开为空时会原样传下去（空允许清单 = 隐藏全部继承来的工具），而不是放开全部工具。

两类情况单独处理：

- `run_code`（PTC 部署的呈现传输）永远不会进入策略：工具注册表会列出它，但核心不允许按这个名字做限制。
- 主代理**自己作用域**里注册的工具会被父代理继承，但不属于子代理的作用域链。写出这类名字会导致核心拒绝创建子代理；插件会把这些名字剔除、重试一次委派，并告警。

## 诊断

打开 `enableListTool` 后会注册 `subagent_roles`：它逐个列出角色及其来源、文件路径、绑定路由、persona 体积、展开后的策略与 schema 字符预算，以及被跳过的文件和原因。

要核对一次已完成的委派，读子代理的会话日志即可：

```sh
node scripts/inspect-session-budget.mjs --project <项目目录>
node scripts/inspect-session-budget.mjs <会话目录> --all --grep "你是代码审查员"
```

该脚本只读地解码会话日志，打印系统提示体积、该会话请求的工具 schema，以及角色目录是否到达了那个会话。

## 工作原理

- **目录**：一个提示词 section，按每次组装求值，列出该 agent 工作区的角色：一行说明，加每个角色一行 `- <id> (<显示名>): <描述>`。在以下情况渲染为空且不占上下文——项目没有角色、目录被关闭、当前是子代理、或该 agent 看不到委派工具。
- **委派**：`subagent_role` 按主代理的工作目录解析角色，然后经 `ctx.subagents` 启动子代理，带上该角色的 persona、路由与工具策略。
- **继承**：子代理加入父代理的 agent preset，因此保留父代理的提示词与工具，仅由角色策略移除其中一部分。角色 persona 只对该子代理遮蔽部署 persona 前缀。

## 已知边界

- 子代理**自己作用域**里注册的工具不受角色工具策略影响：核心的 restrict 只作用于继承来的工具。委派运行时与部分工具插件会按 agent 注册，因此子代理可能比允许清单多出少量工具。
- 隐藏工具会移除它的 schema 以及作用域感知的提示词段落；纯静态文本的段落仍会留在子代理提示词里。
- 角色 persona 会替换子代理的部署 persona 前缀；persona 后缀（例如工作目录那一行）保留。
- `respectModelSelection` 在委派时读取 `subagent-model-selection`，因此设置改动立即生效。
- 委派工具没有声明 `timeoutMs`，前台委派没有工具级超时；长任务请用 `maxDepth` 与派发提示词约束。
- 诊断脚本需要 Node.js 22.15 以上（多帧 zstd 解码）；插件本身在 Node.js 20 上运行。

## 开发

```sh
node --test                                    # 单元测试
node --test --experimental-test-coverage       # 逐文件覆盖率
```

运行时在 `lib/`：`roles.js`（发现与解析）、`catalog.js`（目录文本）、`policy.js`（工具策略）、`route.js`（模型路由）、`tool.js`（委派与诊断工具）、`config.js`（行配置）、`index.js`（插件装配）。

## 许可

MIT
