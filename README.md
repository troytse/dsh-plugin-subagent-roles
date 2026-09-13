# dsh-plugin-subagent-roles

文件定义的子代理角色（subagent roles）：角色写在 **`.dsh/roles/<id>.md`** 里，项目级与全局级两层解析；委派方上下文里只多一行紧凑目录；角色的 persona 与工具策略**真实**作用于子代理。

它是 `dsh-plugin-subagent-director` 的替代实现，修掉后者的三个问题：

| 旧插件 | 本插件 |
|---|---|
| 角色只能写在全局 `settings.yaml` 的 `subagent-director` 命名空间 | 角色是文件：`<项目根>/.dsh/roles/`（项目级）与 `~/.dsh/roles/`（全局级） |
| 系统提示强制注入全部角色描述，无法关闭 | 只注入一行紧凑目录（id + 显示名 + 截断描述）；无角色时为**空**，可用 `catalog: off` 关闭；子代理默认不收 |
| 工具过滤"看不见效果" | 原生 `tools.restrict` + 通配符展开 + 缺名降级 + 诊断工具，`request/header.tools` 可直接核对 |

## 安装

```bash
# 本地 checkout 以 link 方式装入 profile
dsh plugin --profile web add link:/abs/path/to/dsh-plugin-subagent-roles
# 重启后生效
dsh web
```

包内自带 `cordis.patch.yml`，会自动插入唯一一行 host 层插件（`id: subagent-roles`），**不需要**手工 `insert`。要覆盖配置就按 id 覆盖：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: subagent-roles
  name: dsh-plugin-subagent-roles
  config:
    catalogDescriptionMaxLength: 120
```

> 本地 `link:` 开发时，checkout 需要能解析 `@deepseek-ai/*` 与 `yaml`。最省事的做法是在 checkout 里放一个指向 profile 依赖库的软链：
> `ln -s ~/.dsh/profiles/node_modules <checkout>/node_modules`

## 角色目录（唯一定案）

| 优先级 | 路径 | 说明 |
|---|---|---|
| 1 | `<项目根>/.dsh/roles/<id>.md` | 项目级。`<项目根>` = 从会话 cwd 向上找到第一个带 `.git` 的目录；找不到就用 cwd 本身 |
| 2 | `~/.dsh/roles/<id>.md` | 全局级，通用角色放这里 |

- 只认 `.dsh/roles` 这一个目录名，只有 `<id>.md` 这一种文件形态。
- 同 id 时**项目级胜出**，被遮蔽的全局角色会记一条 warn 日志。
- `<id>` 必须是 kebab-case（小写字母、数字、单连字符），且与文件名一致。

## 角色文件格式

```markdown
---
displayName: 浏览器操作员            # 可选，默认取 id
description: 浏览器/Web 端调试与验证执行者…   # 必填：唯一进入委派方目录的文本
whenToUse: 前端 E2E、服务启停…        # 可选，追加在目录行末尾
provider: deepseek-official         # 路由（与 model 成对）；工具不接受逐次覆盖
model: deepseek-v4-flash
reasoningEffort: low
tools: [bash, read, grep, glob, read_image, 'mcp__demo__*']   # 支持通配符
# 或：toolFilter: { allow: [...] } / { deny: [...] }
---
角色 persona 正文。只有委派时才读盘注入子代理，永不进入委派方上下文。
可用 {{cwd}} / {{model}} / {{provider}}；其他 {{...}} 会被拒绝（系统提示是严格插值）。
```

字段校验（**任何一个文件不合法只会被跳过并记 warn，不会让会话报错**）：

- **未知键会被拒绝**（列出支持的键）：拼错 `toolfilter` 之类必须响，而不是静默放开全部工具。
- `description` 必填；`displayName`/`whenToUse` 若出现必须非空。
- `name` 若出现必须等于文件 id（id 由文件名决定，避免两处真相）。
- `provider` 与 `model` **必须成对**（或都不写继承父级）；只写一半会被拒，避免与父代理的另一半静默混搭。`reasoningEffort` 可单独出现。
- `tools` 与 `toolFilter` 只能二选一。
- **目录字段（`description`/`displayName`/`whenToUse`）不得包含 `{{`**：这些文本走的是与 persona 相同的严格插值，但组装发生在插件之外——`{{unknown}}` 会让**每一轮**提示词组装抛错，`{{cwd}}` 则会静默泄漏真实路径。写普通文本即可。
- **`tools: []` / `toolFilter: { allow: [] }` 是合法的"零工具"声明**（核心读作"隐藏全部继承工具"）；显式空 `allow` 一律保留，不会退化成 deny-only（那会静默放开其余全部工具）。只有 `toolFilter: {}` 与单独的 `{ deny: [] }` 这种"什么也没声明"会被拒。
- persona 正文超过 `maxBodyBytes`（按 **UTF-8 字节**计）会被拒。
- persona 里的 `{{...}}` 按**核心的精确规则**校验（变量名只能小写字母/数字/下划线，花括号内不能有空格）：`{{cwd }}`、`{{CWD}}` 都会被拒。
- 角色文件可以是**符号链接**（按链接目标读取，便于在多个项目间共享同一份角色）。

## 配置（行 config，全部有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `toolName` | `subagent_role` | 模型可见的委派工具名 |
| `subagentProvider` | `spawn` | 传输 provider（`spawn` / `fork`） |
| `backgroundMode` | `one-shot` | `one-shot` 或 `continuable` |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background` |
| `maxDepth` | 不设 | 数值则限制递归深度；不设 = provider 自管 |
| `defaultRole` | 不设 | 调用未给 `role` 时的兜底角色 |
| `catalog` | `compact` | `off` 完全不注入角色目录 |
| `catalogScope` | `main` | `main` 只给顶层 agent；`all` 连子代理也给 |
| `catalogDescriptionMaxLength` | `160` | 目录行描述截断长度 |
| `projectRootMarkers` | `['.git']` | 向上寻找项目根的标记 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 全局角色根所在 |
| `maxBodyBytes` | `65536` | persona 体积上限 |
| `respectModelSelection` | `true` | 遵守官方 `subagent-model-selection.allowedModels` |
| `onMissingTool` | `drop` | 角色工具策略里指名但当前不可见的工具：`drop` 告警后跳过（并对"子代理无法 restrict"的名字去掉重试），`error` 直接拒绝委派 |
| `enableListTool` | `false` | 打开诊断工具 `subagent_roles` |

## 工具策略语义（重要）

- `tools: [...]` 是 **allow 白名单**：只保留列出的，其余工具**连 schema 带系统提示段落一起消失**，调用也会被拒。
- `toolFilter.deny: [...]` 是黑名单：只想"除少数外都要"就用它。
- 条目支持通配符 `*` / `?`，例如 `'mcp__demo__*'`（把所有 `mcp__demo__` 前缀的工具一次纳入）。
- 委派时通配符会按**当刻可见的工具名**展开成具体名字。这样既能避免 MCP 尚未注册完导致的硬报错，也不会把过期名字塞给核心。
- 指名了但当前不可见的工具：默认丢弃并 warn（`onMissingTool: 'error'` 可改为直接拒绝）。角色因此不会因为 MCP 未挂载而委派失败，子代理会按 persona 要求如实回报"工具不可用"。
- allow 展开后为空时**按空 allow 传下去**（fail closed）：子代理看不到任何继承来的工具，而不是静默拿到全部工具。
- `subagent_role`/`subagent`/`send_message` 等未列出的工具也会被隐藏——通常正是想要的：子代理不能再委派、不能写文件。
- **两个由框架决定的例外**：`run_code`（PTC 呈现传输，核心禁止按名 restrict）会被无条件排除；**"父代理自己层"注册的工具**（例如官方 `dsh-tool-subagent` 配了 `modelSelectionSettings: true` 时按每个 agent 注册的 `subagent`/`list_subagent_models`）对父代理可见、却不属于子代理的 scope 链，把它们的名字传给核心会直接报错。插件遇到这类报错会**去掉该名字重试一次**并告警（`onMissingTool: 'error'` 时保持硬报错）。
- 行配置里**未知键会被忽略**（schemastery 不拒绝多余字段），配置拼错请以启动日志为准。

## 上下文预算

实测（真实会话，standard preset）：父级 71 个工具 / 51,810 字符；本插件把**子代理**从"继承全部"降到"只拿角色需要的"——一个 `bash, read, grep, glob, read_image, todo_write, skill` 白名单的角色，子代理实测 **9 个工具 / 11,015 字符**（含 2 个无法被过滤的框架自留工具，见「已知边界」）。

插件自身在**主代理**目录里的开销：`subagent_role` 1,074 字符 + 角色目录段（每个角色一行，两个角色时 418 字符，无角色时为 0）。调小 `catalogDescriptionMaxLength`（下限 16）、精简 `tools` 是最直接的两个旋钮。

## 诊断

临时打开 `enableListTool: true` 后，模型（或你自己）可以调用 `subagent_roles`，它会输出：每个角色的来源（project/global）、文件路径、绑定路由、persona 体积、展开后的工具名与 schema 字符预算，以及被跳过的文件及原因。

核对"过滤真的生效"的硬证据：委派一次后打开子代理会话日志（`$DSH_HOME/sessions/--<项目路径把 / 换成 ->--/<session-id>/session.v3.jsonl.zstd`），看最新 `request/header` 的 `tools` 名单；再读 `system/message` 事件确认角色 persona 已注入。上面的脚本可直接打印这些（它会自己解析日志路径与多帧 zstd）：
`node scripts/inspect-session-budget.mjs --project <项目目录>` / `node scripts/inspect-session-budget.mjs <会话目录> --all --grep <文本>`

## 安装前提与安全提示

- **必须以 host 层（profile 根）挂载**：角色目录的可见性判断用的是全局层的工具视图；若把本插件装进 preset/agent 作用域，目录会恒为空。随包 `cordis.patch.yml` 已经是 host 层 insert，照默认安装即可。
- 装完确认依赖可解析（`yaml`、`@deepseek-ai/schemastery` 在 `dependencies`）：`node -e "import('yaml')"`。作为 profile bundle 用 `link:` 或 npm 安装时，pnpm 会装好它们。
- **角色文件就是提示词**：`.dsh/roles/*.md` 的 persona 与工具策略会直接进入子代理的系统提示，克隆一个不可信的仓库即等于接受它给出的角色。不要在不信任的仓库里委派项目角色。
- 本插件的工具**没有声明 `timeoutMs`**，前台委派与官方 `subagent` 一样不设工具级超时；需要上限请用 `maxDepth` 与派发 prompt 的步数约束。

## 已知边界（实测确认，不是 bug）

1. **子代理自己层注册的工具不受 allow 名单约束。** `tools.restrict()` 的设计是"只过滤**继承**来的工具；作用域**自己**注册的一律不过滤"（`dsh-tools` 源码注释明确写了）。官方 `dsh-tool-subagent` 在 `modelSelectionSettings: true`（`standard` preset 默认）时会**按每个 agent 自己的 ctx** 注册 `subagent` 与 `list_subagent_models`，所以这两个会留在子代理里。实测：主代理 71 个工具 / 51,810 字符 → 白名单角色子代理 9 个 / 11,015 字符（其中 2 个就是这两个框架自留工具）。
   - 注意：这两个名字**也不能写进角色的 `tools`**——父代理看得见它们，子代理却无法 restrict，把名字传给核心会直接报错。插件会去掉这类名字重试一次并告警（见「工具策略语义」）。
   - 想把这两个也拿掉：复制一份 preset，把 `tool-subagent` 行的 `modelSelectionSettings` 改成 `false`，工具即退回 preset 作用域（= 继承层），从而可被 allow 名单过滤。代价：内置 `subagent` 失去 `provider`/`model`/`reasoning_effort` 参数、`list_subagent_models` 消失、官方 subagent-model-selection 不再作用于它。**不要改 shipped preset 安装**。
2. **被隐藏工具的提示词段落只消失一部分。** 作用域感知的段落（如 `tool:read`）会随工具一起消失；静态一句话段落（如 `tool:bash` 的 "[exit code: N]" 提示）即使工具被过滤仍留在子代理 system prompt 里，成本几十字符量级。
3. **角色 persona 覆盖的是 preset 的 persona 前缀**（`deployment:persona-prefix` 语义），后缀（如 "Your working directory is {{cwd}}."）保留。
4. **`maxDepth: 0` 等于禁止委派**：子代理深度从 1 起算，任何委派都会被核心以 `SubagentDepthError` 拒绝（配置层允许该值，属显式意图）。
5. **模型白名单读的是实时 settings**：`subagent-model-selection` 一旦改动，本插件立刻按新清单裁决；官方 `subagent` 工具读的是会话捕获的策略，两者在会话中途改设置时可能短暂不一致。

## 与旧插件的关系 / 不做什么

- 不提供设置面板，也不注册 `settings` 命名空间：角色的唯一真相是文件。
- 不提供 `/orchestrate` 命令、`close_subagent` 工具（旧插件自带、实测零调用）。
- 不修改也不禁用官方的 `subagent` / `subagent_fork` / `send_message` / `interrupt_agent` / `list_agents`；角色目录里的那行说明只是引导模型优先用 `subagent_role`。
- 子代理仍然继承父 preset 的系统提示（这是框架行为）；本插件能做的是把它的工具目录与角色 persona 精确化。

## 开发

```bash
node --test                                                     # 84 个单元测试：解析、优先级、工具策略展开、目录渲染、路由、委派模式、挂载
node scripts/inspect-session-budget.mjs --project <项目目录>      # 打印某会话的 system+tools 体积与 subagent_role 归属
node scripts/inspect-session-budget.mjs <会话目录> --all --grep <文本>   # 列出全部工具名 / 在 system prompt 里查找文本
node scripts/migrate-roles.mjs --project <项目目录> [--dry-run]   # 一次性：把旧 settings 命名空间里的角色迁成 .dsh/roles 文件
```
