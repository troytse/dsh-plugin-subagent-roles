# 更新日志

本文件记录 `dsh-plugin-subagent-roles` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-09-16

### 新增

- **子代理提示词裁剪**（`childPromptTrim`）：核心把大多数工具说明注册成静态文本，只有 `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-web`、`dsh-file-reference-local` 会按 scope 求值，因此角色策略藏掉一个工具后，子代理仍在为它的说明付费，还继续读 Web GUI、harness checkout、交付链接这些它永远用不上的段落。现由**一个 host 层 `system-prompt/assemble` 监听器**精确丢弃这些死文本：
  - `tool:<name>` 说明——当 `<name>` 是注册表里**真实存在**的工具、而该 scope 看不到它时丢弃（规则从活的注册表推导，无需维护）；
  - 组标签说明（`tool:jobs`、`tool:goal`）——其名字不是工具名，改为在它**自身文本**里按整词匹配已知工具名，全部不可见时才丢弃；
  - `full` 模式额外丢弃 `childPromptTrimNames` 命名的提示词片段（默认 `harness:source`、`app:web-surface`、`ui:deliverable-file-references`、`context:file-reference`），**同一份名单同时匹配 section 与 context**。
- 两个行配置：`childPromptTrim`（**`full`（默认）** / `tools` / `off`）与 `childPromptTrimNames`。**默认即裁剪**，零配置生效；`off` 是安全阀，`tools` 是"只删死文本、保留 GUI/checkout 那几段"的保守档。
- **可在 Web 的 Settings → Plugins 里改**：裁剪策略以宿主 settings namespace `subagent-roles` 发布，配一张浏览器侧卡片。行 config 是 namespace 的 `base` 层，卡片把用户层写进 `~/.dsh/settings.yaml`，`applies: live` —— 下一次子代理轮次生效，不用重启。卡片遵循宿主约定：编辑先暂存、Save 才写、每字段可 Reset 回组合默认、并标出被覆盖的字段。
- 卡片**逐条对照宿主的 `PluginCard`** 自画外壳：可折叠表头（标题/说明/旋转箭头）、未保存徽标、底部 Reset / Discard / Save，沿用 `--dsw-alias-*` design token。宿主只铺一列并派发 slot，"chrome, controls, and copy" 全归插件；画成扁平常展开的盒子会与同排的 bash / agent-loop / subagent 卡片格格不入。
- 只注册一张卡，不额外占 Settings 导航分组（dshmarket 那样的分组是因为它有一整页浏览界面）。
- **编辑遵循宿主的卡片约定**：暂存 → Save 才写、Discard 丢草稿、**Reset 只暂存组合默认（写入的是 unset，让字段重新继承部署配置）**、清空保存后自动折叠、保存失败保持展开并保留草稿。
- **修掉一个已发出的低级错误**：Save 按钮的颜色用了不存在的 `--dsw-alias-label-inverse`，而 `--dsw-alias-brand-primary` 解析出来就是 `label-primary`（深色主题下≈白）→ **深色主题下白字白底，对比度 1.0:1**。现完全照抄宿主 `.save` 规则（`background: label-primary; color: bg-layer-3`，浅色 18.9:1、深色 11.6:1），并加了两道防线：**token 白名单**（只允许主题里真实存在的 `--dsw-alias-*`）与 **Save 配色成对断言**。
- **文案跟随 Language 设置**：注册 `zh` / `en` 两份同键词典并在注册项上声明 `locale: <namespace>`，由渲染层绑定 `t`（`props.t`）；无 locale 服务时依次退回自身绑定与英文词典。此前那版把"中英并列"硬编码进文案，既不跟随语言设置、在两种语言下都别扭，也偏离了生态里 dshmarket / task-board 的做法。
- 插件因此新增**浏览器半边**：`lib/client.js`（手写，走 `window.__ModuleLoader__` 信封，`react` 取自平台基线模块，**不引入任何构建步骤**，`node --check` 仍能检查它）、`exports["./client"]` 与 `dsh.client.platform: "web"` 声明。宿主侧只注册 namespace 是**不够的**：Plugins 页只为「已服务的 namespace × 注册在该 key 下的卡片」的交集渲染内容，没有卡片就是一个空标签页。

### 说明

- **只动子代理**：深度为 0 的顶层 agent 提示词逐字节不变（同一次实测里父子两次运行的父提示词逐字节相同，均为 6,431 字符）。真实委派实测：角色子代理提示词 **5,765 → 1,904 字符（−67%）**——该数字是**默认配置**（不带任何 override）跑出来的。
- 为什么默认连 GUI / harness checkout / 交付链接 / `@` 路径四段一起删：它们对验证者、审查者这类子代理是纯噪声，而父代理随时能在派发提示词里补上任何真正需要的上下文。若某个部署确实需要（例如派子代理改 DSH 本身、或 fork 子代理的回答直接面向 GUI 用户），把 `childPromptTrimNames` 清空即可全部保留。
- 规则基于**活的工具注册表**，因此 `tools` 模式不依赖任何写死的 section 名；`full` 模式的名单是版本敏感的，核心改名后该段只是不再被裁剪（安全方向），不会报错。
- 作用于宿主所见**每一个**子代理的组装，而不只是本插件发起的角色子代理——运行时不在子代理上记录角色标记。注册在 agent 自身作用域的工具（`subagent`、`list_agents`）不在全局视图里，其说明永不被裁剪。

### 说明（settings 侧）

- 没有 settings provider 的部署仍以行 config 为唯一权威；namespace 注册失败（存量配置非法、与另一行撞名、`ctx.get`/`inject` 抛错）只记告警并退回行 config —— 设置出问题不该让插件行倒下，更不该让裁剪失效。
- 卡片只覆盖默认行的 namespace；用改名 `toolName` 挂的第二行属于 `subagent-roles-<tool>`，没有卡片，直接改 `settings.yaml`。
- 实测（真实 `dsh-settings-file` 服务 + 真实 headless 委派）：行 config 写 `tools`、用户层写 `full` 时，子代理提示词按 `full` 裁剪（3,882 → 1,904 字符）；删掉用户层后回到 `tools`（1,627 字符的命名段落保留）。`settings.describe()` 带出组合 base，写入落进 settings 文档，`replace({})` 后重新继承行 config。

### 修复（第二轮：独立审查复核后）

- **`off` 之前并不生效**：`trimChildPrompt` 只在 `full` 分支上判断模式，R1/R1b 无条件执行，于是 Settings 里的 `off` 与 `tools` **行为完全相同**（实测：两者都丢掉 `tool:workflow`）。现 `off` 直接原样返回，并补了两条回归用例——一条纯函数、一条**驱动真实的 Settings 切换路径**（桩服务现在会 commit 并触发 watch，否则该断言会假通过）。
- **Reset 后继续编辑会被静默丢弃**：`patch` 从不清除该字段的暂存，Save 于是写 unset、把用户刚输入的值丢掉。现编辑会取消该字段的暂存（`applyEdit` 纯函数 + 回归用例）。
- **没改动的字段会被写成覆盖值**：用户层里"存在"即"已覆盖"，只改模式也会把名单钉住、让以后改部署配置失效。现 `planSave` 只写真正变化的字段（未改动且未暂存则不写）。
- 补防线：token 白名单**改为从已安装主题派生**（CI 无主题时回退手抄清单）、删掉一条"匹配源码文本"的空洞断言、换成语义级的保存计划用例；状态行补 `role="status"`；重复点 Save 加在飞守卫；"与宿主逐条一致"的说法改为写明两处刻意偏离。

### 修复（第一轮）

- **实测发现的真 bug**：`context:file-reference`（`@路径` 说明）在当前核心里是以 **section** 注册的（`dsh-file-reference-local` 里 `systemPrompt.section({ name: "context:file-reference" })`），尽管名字带 `context:`。原先按 "section 名单 / context 名单" 分开匹配，导致这一段在真实会话里**没有被裁剪**——是重启后的活体会话验证抓到的（子代理仍带 `@路径`，另外三段已消失）。现在合并为**一份 kind-agnostic 名单**，对两个数组都匹配；回归用例 `a name is dropped wherever it appears — section or context` 钉住它。
- 记录一条实测踩坑并据以设计规则：直接把 `tool:<x>` 的 `<x>` 当工具名，会把组标签 `tool:jobs` / `tool:goal` 误判为「工具 jobs/goal 不存在」，从而删掉 1,116 字符仍然有效的说明（子代理明明有 `job_output`、`create_goal` 等工具）。规则必须先与注册表已知工具名求交集。
- 组标签规则的工具名匹配用**整词**而非子串：`already` 里含有 `read`，子串匹配会让一段无关文字被当成"点到了 read 工具"。

## [0.2.1] - 2026-09-13

本次为**文档与基建补丁**，不含运行期行为变更。

### 其他

- 新增本文件（`CHANGELOG.md`，中文），追溯 0.1.0 以来的全部版本，并纳入 `files` 随包发布。
- 发版工作流增加门禁：`CHANGELOG.md` 中没有 `## [<版本号>]` 条目即拒绝发布。发出去就收不回来，所以更新日志条目是发布的前置条件，而不是约定。
- 两份 README 的发版段落改写为三步（先补日志 → 再 `npm version` 推标签 → 工作流校验后发布），并互加更新日志入口。

## [0.2.0] - 2026-09-13

### 新增

- `timeoutMs` 行配置：前台委派的工具级超时。核心的 timeout policy 会替换 `exec.signal`，而前台路径本就把该 signal 传给 `ctx.subagents.start`，因此子代理随调用一起结束；后台委派立即返回，不受影响。
- `personaVariables` 行配置：扩充 persona 允许引用的提示词变量。默认仍是 agent loop 注册的 `cwd`、`model`、`provider`；不合核心语法的名字会被过滤。
- `listToolName` 行配置：诊断工具改名，使同一 profile 可以挂两行。
- `projectRootTtlMs` 行配置：项目根结果被信任多久后重新向上查找（此前 loader 支持但配置层触达不到）。
- 支持传输 provider 的 `agentRouteDefaults`：按官方语义合在角色自身绑定之下，且绝不会用来复活一个刚被授权清单拒绝的路由。
- **同一 profile 可挂两行**：角色目录的 section 名改为由 `toolName` 派生（`<toolName>:catalog`），诊断工具名走 `listToolName`。此前两者都是写死的常量，第二行的注册会抛"already registered"并被静默吞掉 —— 结果是第二行的角色永远不进目录，而插件看起来"半好"。
- 与官方 delegation 工具（`@deepseek-ai/dsh-tool-subagent`）的**对照测试**：同一形态的宿主桩挂载官方实现，两边用同一个假子代理结果驱动，凡"本应逐字一致"的部分断言相等。该包作为 devDependency 引入。

### 变更

- **路由改为真预检**：角色绑定的路由在子代理存在之前经 `llm.resolveCallConfig({provider, model, reasoningEffort}, signal)` 解析。角色文件里 `model` 写错、或 `reasoningEffort` 不为 adapter 所认，现在会当场报出可对症修正的错误，而不是从子代理创建深处抛出晦涩失败。旧部署没有该 seam 时降级回 provider 成员检查。
- **`respectModelSelection` 改为分层读取**：优先采用会话已捕获的策略（与官方委派工具写入的同一个 session projection `subagentModelSelectionPolicy`），没有捕获时才回退实时 `subagent-model-selection` 设置，子会话再回退其父会话。实时设置只用于给新会话播种，因此改动不再追溯影响运行中的会话。
- 委派日志改报**本次调用实际执行**的模式（此前直接抄 `backgroundMode`，在 `enableRunInBackground: false` + `backgroundMode: continuable` 时报了一个根本不会走的模式），并带上解析后的路由层级。

### 说明（settings 侧）

- 没有 settings provider 的部署仍以行 config 为唯一权威；namespace 注册失败（存量配置非法、与另一行撞名、`ctx.get`/`inject` 抛错）只记告警并退回行 config —— 设置出问题不该让插件行倒下，更不该让裁剪失效。
- 卡片只覆盖默认行的 namespace；用改名 `toolName` 挂的第二行属于 `subagent-roles-<tool>`，没有卡片，直接改 `settings.yaml`。
- 实测（真实 `dsh-settings-file` 服务 + 真实 headless 委派）：行 config 写 `tools`、用户层写 `full` 时，子代理提示词按 `full` 裁剪（3,882 → 1,904 字符）；删掉用户层后回到 `tools`（1,627 字符的命名段落保留）。`settings.describe()` 带出组合 base，写入落进 settings 文档，`replace({})` 后重新继承行 config。

### 修复

- `displayName` 撞名（例如项目角色与全局角色同名）时静默取先加载者，现明确告警并列出候选 id。
- 发现缓存（文件、目录、项目根、已告警诊断）按绝对路径无界增长，宿主常驻时会持续膨胀；现统一 512 条上限并淘汰最旧，结果不受影响。
- `route.js` 的 `layer` 只产出、无人消费，现接入委派日志。
- 诊断脚本的 `--project` / `--grep` 缺值会抛 TypeError 或去找字面量 `undefined`，现统一报错退出；裸 flag 不再被当作会话目录。

### 其他

- CI 增加 `npm run lint`（对 `lib/`、`scripts/`、`test/` 做 `node --check`），零依赖，能抓住不被任何测试 import 的文件的语法错误。
- `.gitignore` 忽略 `package-lock.json` —— 与本仓库"有意不提交 lockfile"的约定保持一致。
- README（中英同步）：补 `name` frontmatter 字段与上述新增配置项；改写 `respectModelSelection`、`timeoutMs` 两条已知边界；补多行共存与缓存上限说明。

## [0.1.2] - 2026-09-13

### 说明（settings 侧）

- 没有 settings provider 的部署仍以行 config 为唯一权威；namespace 注册失败（存量配置非法、与另一行撞名、`ctx.get`/`inject` 抛错）只记告警并退回行 config —— 设置出问题不该让插件行倒下，更不该让裁剪失效。
- 卡片只覆盖默认行的 namespace；用改名 `toolName` 挂的第二行属于 `subagent-roles-<tool>`，没有卡片，直接改 `settings.yaml`。
- 实测（真实 `dsh-settings-file` 服务 + 真实 headless 委派）：行 config 写 `tools`、用户层写 `full` 时，子代理提示词按 `full` 裁剪（3,882 → 1,904 字符）；删掉用户层后回到 `tools`（1,627 字符的命名段落保留）。`settings.describe()` 带出组合 base，写入落进 settings 文档，`replace({})` 后重新继承行 config。

### 修复

- **子代理非正常结束时，provider 自己的 `diagnostic` 被整段丢弃**，主代理只拿到一句 `subagent run failed`，既无法自救也无法上报。现随报错一并给出（与官方工具逐字一致），并补上输出块的类型守卫。
- **fork 型传输 provider 下工具对模型说的是假话**：描述与 `prompt` 参数写死"子代理看不到本对话"，而 fork 的子代理其实已带上本会话已完成的轮次。现按 `provider.inheritsParentContext` 切换措辞。
- **角色文件若是指向 FIFO 或字符设备的符号链接，`readFileSync` 会在提示词组装中同步永久阻塞**（无 signal、无 timeout 可打断），宿主当场冻死。现要求链接解析后仍是普通文件。
- **`maxBodyBytes` 此前在读完文件之后才比较**，`statSync` 已经给出的 `size` 形同虚设：10 字节的上限照样会把 64 MB 整份读进内存。守卫前移到读取之前，并留出 64 KiB frontmatter 余量。
- 诊断脚本的归属判定依赖"self-contained"字样，在 fork 措辞下会把自家工具误报为他人注册。

### 文档

- README / README.zh：说明委派措辞随传输 provider 变化。

## [0.1.1] - 2026-09-13

### 变更

- CI 在 Node.js 20、22、24 上运行测试。
- 发版改为 npm trusted publishing（OIDC）并附 provenance 证明，仓库不再保存长期 token。

## [0.1.0] - 2026-09-13

### 新增

- 首次发布。文件定义子代理角色：`<项目>/.dsh/roles/<id>.md` 与 `~/.dsh/roles/<id>.md`，项目同名角色优先。
- YAML frontmatter 承载 `description`、`displayName`、`whenToUse`、`provider`/`model`、`reasoningEffort`、`tools`/`toolFilter`；正文是该子代理的 persona。
- 紧凑角色目录：一个提示词 section，每个角色一行，仅在委派工具对该 agent 可见且工作区确有角色时渲染。
- 逐角色工具策略：允许清单 / 拒绝清单，支持 `*`、`?` 通配，按委派时可见的工具名展开；`run_code` 与子代理作用域内注册的工具名有专门处理。
- 逐角色模型路由，遵守官方 `subagent-model-selection` 授权清单。
- 可选诊断工具 `subagent_roles`；诊断脚本 `scripts/inspect-session-budget.mjs`。

[0.2.1]: https://github.com/troytse/dsh-plugin-subagent-roles/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/troytse/dsh-plugin-subagent-roles/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/troytse/dsh-plugin-subagent-roles/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/troytse/dsh-plugin-subagent-roles/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/troytse/dsh-plugin-subagent-roles/releases/tag/v0.1.0
