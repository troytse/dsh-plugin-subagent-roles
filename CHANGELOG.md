# 更新日志

本文件记录 `dsh-plugin-subagent-roles` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
