# 更新日志

本文件记录 `dsh-plugin-subagent-roles` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-09-22

### ⚠️ 不兼容提示（务必先读）

- **角色文件与插件版本从此绑定。** 本插件的 frontmatter **未知键会被拒绝**（见 README「文件格式」），因此任何使用了 `maxToolCalls` / `maxToolCallsScope` / `onToolCallBudget` / `graceToolCalls` 的角色文件，在**旧版插件**上会直接报 `unknown frontmatter key` 并被跳过。给角色加额度 = 每台使用该工作区的机器都必须把插件升到 **≥ 0.4.0**。
- 新增一个**运行时依赖** `@deepseek-ai/dsh-llm`（peer + dev）：收尾通知需要用核心自己的 `createUserMessage` 构造，才能带上正确的 `plugin` 来源（见下方「说明」）。

### 新增

- **角色级工具调用预算硬上限**（`maxToolCalls`）：可选、可继承、由插件**强制执行**，不依赖模型自律。计量单位钉死为**「次」而不是「轮」**——这正是口头「8 步」约定失效的根因（§1 实测：两个只读角色分别跑到 19 / 25 次且都未披露）。
  - **计数来源是框架自己的 `tool/call` 事件**，不解析模型输出、不采信模型自报。同一步内并行调用**各计 1**；被策略/guard 拒绝的调用计 1、取消后跳过的调用也计 1（核心在 `startCall()` 第一行就无条件落盘 `tool/call`，拒绝/跳过随后补 `tool/result`，因此口径对三种情形一致）。`used === limit` **不触发**，第 `limit + 1` 次才触发。
  - 四个 frontmatter 字段：`maxToolCalls`（`0` = 不限）、`maxToolCallsScope`（`delegation`（默认）/ `session`）、`onToolCallBudget`（`wrap-up`（默认）/ `interrupt` / `off`）、`graceToolCalls`（默认 `1`；`0` 等价 `interrupt`）。
  - 四个行配置：`defaultMaxToolCalls`（默认 `0`，**刻意不硬编码全局默认数字**）、`maxToolCallsHardCap`（默认 `0`）、`onToolCallBudget`、`graceToolCalls`。角色文件优先于行/设置默认值；`maxToolCallsHardCap > 0` 时角色值被 `min` 削顶并告警——但**永不削顶「不限」的 `0`**（`0` 是哨兵而不是计数）。
  - `scope: delegation` 在已知子会话观察到 `turn/start` 时重置计数，这是「每次后台唤醒各起一个新计数」唯一可观测的定义；`scope: session` 跨唤醒累计。
- **三条委派路径各自收口**：continuable 子代理走 `SubagentRuntime.interrupt(childId, { kind: 'ancestor', agent })`。**前台/后台 one-shot 走插件自持的取消信号**——因为 `interrupt` 对 one-shot/未知目标是**被接受的 no-op**（核心文档原文：「including a one-shot or unknown id」），若只依赖它会得到「看着生效、实际不生效」的最坏失败形态。前台路径把 `exec.signal` 的取消转发进插件自己的 controller；后台路径复用既有 job controller。
- **收口记录写进子会话**：收尾通知就是这次收口的**持久审计记录**（携带 `used`/`limit`/`scope`/`mode`），因此在**每次收口**时都会投递——包括 `interrupt`——而不是只在 `wrap-up`。这正是需求 5.3/§7「同一事实写入子会话」「可回放到停在哪一次、剩多少」：对一个被直接杀掉的子代理，宿主日志回答不了这个问题。`off` 只告警、不收口，因此不写子会话记录（已在 README 说明）。
- **`wrap-up` 在下一个 step 边界注入收尾通知**：用 `Agent.inject()`（`send(msg, 'next-step', false)`）而不是 `steer()`/`followup()`——后者 `wakeup: true` 会把**空闲**子代理唤醒成一个新轮次，等于把收尾指令变成额外工作量。通知是一条**显式 `plugin` 来源**的 `user` 消息：省略 source 会被解析成 `user`，那等于让机器生成的指令**冒充人类输入**并继承人类权威。远程传输不发布本地子代理对象（`SubagentRun.localAgent` 为 `undefined`）时，子代理跑在本进程之外：`tool/call` 到达不了护栏（既数不到也停不下），通知也投递不了——插件在**委派时**就告警，而不是把一个并未受保护的角色报成已受保护。进程内传输不受影响。
- **超限对主代理是「正常结果 + 状态字段」，不是错误**：前台返回 `status: 'tool-call-budget-exceeded'`、`reason: 'tool-call-budget'`、`role`/`used`/`limit`/`scope`/`mode` 与可选的 `partialOutput`，让主代理明确选择「再派一次更窄的任务 / 放宽额度 / 接受部分结论」；抛错会被当成可重试的工具故障，恰好相反。后台 job 的 detail 写明预算收口，从而不再与「用户 kill」混淆。
- **与 `timeoutMs` 正交**：预算先到 → 上面的结构化结果；deadline 先到 → 核心自己的 `TOOL_TIMEOUT` 错误（核心的 timeout 包装器在 `next()` 返回后按自己的 deadline 命中**替换**结果，插件无法也不应抢这条通道）。两者都有 `breached` / `isTornDown` 判定，绝不互相误报。
- **可在 Settings → Plugins 里改**：预算四个键与裁剪两个键共用同一个宿主 namespace `subagent-roles`（宿主按 namespace 整体服务，第二次注册同名 namespace 会被拒），行 config 仍是 `base` 层。浏览器卡片改为**声明式字段表**驱动，并对每个键做类型化转换（计数以**数字**写入，非法文本折叠为回退值而绝不写出宿主会拒绝的值）。
- **可观测**：`subagent_roles` 每个角色多一行 `tool-call budget: 30 (role, scope delegation, mode wrap-up, grace 1)`，来源标注角色文件 / 行默认 / 不限；超限日志固定一行 `[subagent-roles] role=… tool-call budget exceeded: used=… limit=… scope=… mode=…`；收尾通知本身持久化在子会话日志里，因此停在哪一次、剩多少都可回放。

### 说明

- **不改 DSH 核心**。核心确实没有 `maxSteps` / `maxToolCalls` 类旋钮（已 grep 确认），因此护栏全部落在本插件的配置与角色文件格式内。
- **收口按轮次限流为一次**：`scope: session` 的计数永不复位，因此父代理再次唤醒已超额的 continuable 子代理时会被**再次**停下（第一版把「已上报」与「已收口」合成一个锁，导致只有第一次唤醒会被拦——已修）；但被停下那一批里从未启动的调用（核心会为它们补 `tool/call`）不会各自重复一遍停止。首次触发的事实（`usedAtBreach`）不会被后续唤醒改写。
- **`maxToolCallsHardCap` 的告警按来源措辞**：削顶的是角色文件就点名角色，削顶的是行/设置默认值就说「the row/Settings default asked for …」，不再把继承来的默认值说成角色自己要求的。
- **`maxToolCallsHardCap` 的削顶告警也进诊断工具**：`subagent_roles` 多一行 `warning: …`，否则它只显示被削后的数字而不说为什么。
- **超时与预算的次序**：两者独立呈现——预算收口是结构化结果，超时保留核心的 `TOOL_TIMEOUT`。已补「配置了 `timeoutMs` 但预算先到」的用例；反向的窄竞态（预算已开始收口、deadline 在拆卸期间到期导致核心替换结果）已在 README 已知边界里如实写明。
- **需求 3.1 的「报错信息带上该键需要插件 ≥ x.y」未实现**：旧版插件的未知键报错只能列出它**自己认识**的键，一个不认识 `maxToolCalls` 的版本不可能在报错里提到它——该要求对已发布版本逻辑上不可达。已改为文档层面的版本绑定（README 文件格式表 + 本文件顶部的不兼容提示）。
- **计数精度与保证边界**：收口是**反应式**的——跨过上限的那次调用已经写进会话日志，插件是在它结束前停下子代理，而不是阻止它开始。保证的是「子代理会停」，计数则是精确的。
- **`0` 语义**：额度 `0` 表示不限，且 `maxToolCallsHardCap` **不削顶它**。逃生口优先于上限是刻意的：硬上限的用途是削回一个已声明的数字，而不是禁止「不限」。
- **零成本**：`0`（不限）不会登记任何计数记录，也不参与事件处理；记录表有上限（256 条，**按插入序**淘汰，不是 LRU），且这只是防泄漏兜底：记录会在子会话 `session/disposed`、或委派结算时正常释放（前台/后台在 `finally` 里释放，continuable 靠 `session/disposed`），因此活记录不会被淘汰掉。
- **`childPromptTrim: 'off'` 的既有语义保留**：它仍会连同 Settings 卡片一起卸掉整个 namespace，因此预算旋钮也一并在 UI 里消失（额度此时只来自角色文件与行 config）。这是原「off 是不可被 UI 翻回来的关闭开关」约定，未改动。
- 预算**不出现在角色目录文本里**，只有 `subagent_roles` 报告它，因此带预算的角色对提示词体积没有影响。

### 测试

- 新增 `test/budget.test.js`（41 例）：frontmatter 四种字段的合法/拒绝、额度解析与优先级、硬上限削顶与「不削顶 0」、计数语义（恰好等于上限不触发 / 第 `limit+1` 次触发 / 并行各计 1 / 非 `tool/call` 事件不计 / 未登记会话不计）、三种姿态与 grace 边界（`grace: 0` 等价 `interrupt`）、两种 scope 的隔离与 `turn/start` 重置、健壮性（已在拆卸中的委派不误报 / enforce 与 inject 抛错不外泄 / 通知投递失败要告警 / 记录表有界）、结构化结果的形状。
- `test/delegation.test.js` 扩到 72 例：三条路径端到端（前台断言 run 信号被 abort 而**不是** `interrupt`、continuable 断言 `interrupt` 参数与 ancestor authority、后台断言 job detail）、收尾通知**必须是 plugin 来源**（防回归到冒充人类输入）、`interrupt` 也必须投递那条持久通知、deadline 先到**不得**产生预算结果、**配置了 `timeoutMs` 但预算先到**必须返回预算结果、`session` 作用域的 continuable 在**下一次唤醒**会被再次停下、子会话 `session/disposed` 会释放记录、远程 provider 降级、行默认生效、诊断工具三态来源与削顶告警。
- `test/parity.test.js` 把「输出 schema」那条从「完全相同」改为「官方三支逐字节相同 + 追加的 budget-stop 支被显式钉死」，并把两处刻意偏离写进该文件的说明。
- `test/settings.test.js` / `test/client.test.js` 跟着 namespace 扩到六个键：`base` 层必须带上全部键（否则会静默落到 schema 默认而非行 config）、卡片字段表必须与宿主 schema 的键集**完全一致**、计数以数字写入、非法计数文本折叠为回退值。
- 新增 `test/seam.test.js`：用**真实的 cordis Context + 真实 SessionStore**（无 LLM、无 profile）验证整条护栏所依赖的**唯一假设**——带 `{ global: true }` 的 `session/event` 订阅确实能收到**子会话**已提交的事件（cordis 默认按 context 过滤监听器，写错就会「静默什么都数不到」，正是本插件已经吃过一次的失败形态）。同时钉住「恰好等于上限不触发 / 跨过才触发 / 未登记会话不计 / `turn/start` 重置 delegation 计数」。这两个包是 devDependencies；缺失时该套件按原因 skip 而不是失败。

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
