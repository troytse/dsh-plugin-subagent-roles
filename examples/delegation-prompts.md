# 角色委派 prompt 包（worked example）

> 这是一个真实项目（原生小程序 + Vben Admin 后台）里跑通的派发 prompt 示例；命令、目录名与技能名请按你自己的项目替换（`<项目根>` = 你的仓库根）。
> 角色定义在 `<项目根>/.dsh/roles/{web-operator,mp-operator}.md`（frontmatter 里是 provider/model/tools 策略，正文是 persona）。
> 角色文件改动**不需要重启 `dsh web`**（每次提示词组装按 mtime 读取）；只有改插件本机代码或组合层才需要重启。

---

## 0. 主代理侧（你在项目会话里说的话）

**自然触发**（主代理会照角色目录自己选角色）：

```text
用 web-operator 验证「模板管理」页这次改动，跑 platform_frontend 的 Playwright E2E，按 web-verify SOP 的全覆盖口径给我结论；你不要自己跑浏览器。
```

```text
用 mp-operator 验证 mp_member 的订单列表页改动，走 wechat-devtools SOP 的强制门禁；你不要自己碰 DevTools。
```

**想同时明确边界时**加一句：

```text
两个操作员都只做验证、不改文件、不碰后端；后端如果要重启由你（主代理）先做。
```

---

## 1. web-operator 派发模板（主代理 → 子代理）

```text
【唯一任务】用真实浏览器验证 <页面/功能> 的这次改动是否可用，并给出全覆盖结论。

【目标】
- 项目根：<项目根>
- 前端目录：platform_frontend（Vben Admin，dev 地址 http://localhost:5777）
- 后端：http://localhost:8000（你只读观察，不启停）
- SOP（先读）：<项目根>/.dsh/skills/web-verify/SKILL.md

【步骤】
1. 先取锁再动状态：mkdir ~/.dsh/.debug-locks/tcp-5777.d 与 tcp-8000.d（只读探活不需要锁），随即写 owner.json 并在每步刷新心跳；结束立即释放。
2. 读 AGENTS.md「测试与验证」与 web-verify SOP，确认服务状态：bash .dev/serve.sh status（前端 5777、后端 8000 均需 ✅）。
3. 跑用例：cd platform_frontend && pnpm e2e:ele <spec 相对路径，如 apps/web-ele/e2e/mp-pages.spec.ts>
   管理员账号：见项目 AGENTS.md「开发环境与端口」（滑块拖到最右即通过）。
4. 对新页面/新控件**先补映射表再跑**：spec 头部「功能清单 → 用例」必须逐条覆盖列表搜索/筛选/重置、每个行操作、抽屉与弹窗内每个控件。
5. 浏览器 console 断言：出现 [Global Error] / 未捕获异常即判失败（后端 429 限流属环境噪声，可过滤；若影响断言则如实回报）。
6. 若页面支持语言切换：用真实控件切到 en-US 断言后台自身文案变化、再切回 zh-CN（小程序侧内容文案不随之变化，属预期）。

【验收】
- `pnpm e2e:ele` 结果 + spec 头部映射表**逐项**覆盖结论（覆盖/未覆盖）
- 覆盖不到的控件必须单列「未覆盖清单」并置 WAITING，不得以「N passed」收尾
- 失败时附 test-results/ 的 error-context 要点或 trace 路径

【禁止】
- 修改任何项目文件（edit/write/bash 落盘全禁；仅 ~/.dsh/.debug-locks/ 的 mkdir 例外）
- 启停/重启后端、跑 artisan/pest/composer、dbreset、直接读写数据库、用 curl/API 造数
- 起新的 dev server 或改端口；不要另起 Playwright 的 webServer
- 调 wechat_* / harmony_* 等与小程序无关的工具

【回报】1 做了什么（以「工具名 + 目标路径」开头） 2 观察结果（用例名 + passed/failed + 映射表逐项覆盖结论） 3 问题与建议 4 状态：DONE 或 WAITING
```

---

## 2. mp-operator 派发模板（主代理 → 子代理）

```text
【唯一任务】用 DevTools 验证 <小程序页面/流程> 的这次改动，跑强制门禁并给出全覆盖结论。

【目标】
- 项目根：<项目根>
- 小程序目录：<项目根>/mp_member   ← 以项目根为目标，不要指向 dist/
  （creator 端同理；自动化端口 creator 用 9421 错峰）
- 后端：http://localhost:8000（你只读观察，不启停）
- SOP（先读）：<项目根>/.dsh/skills/wechat-devtools/SKILL.md

【步骤】
1. 先取全局锁：mkdir ~/.dsh/.debug-locks/wechat-devtools.d 成功即持有，随即写 owner.json，每步刷新心跳；结束立即释放。锁被占且心跳新鲜 → 回报占用方并 WAITING，绝不抢占。
2. 硬前置：IDE 调试基础库必须是 3.17.2（不是则停止跑用例并回报，要求你切回）。
3. 容器健康探针（只读，必做）：
   node .dsh/skills/wechat-devtools/scripts/wechat-auto.js evaluate \
     "return { sdk: wx.getSystemInfoSync().SDKVersion, pages: getCurrentPages().length, routes: getCurrentPages().map(function(p){return p.route;}), appLogs: (wx.__tn_logs||[]).length };"
   期望 sdk=3.17.2、pages ≥ 1。pages=0 或含 routeDone/webviewId ... not found → 走一次性恢复链 close_project → open_project → automation_start(autoPort=9420) 后复验，不要反复刷。
4. 重建产物：cd mp_member && rm -rf dist && pnpm build && pnpm type-check（运行套件期间禁止再重建 dist）。
5. 跑门禁：export WECHAT_PROJECT_PATH=<项目根>/mp_member；node .dsh/skills/wechat-devtools/scripts/wechat-test.js run-all（或 pnpm verify:mp）。
6. 列表行为必须覆盖（缺一即未验过）：有 enablePullDownRefresh 的页面断言数据就绪**且**调用了 wx.stopPullDownRefresh；有 onReachBottom 的断言触底变长或明确 hasMore===false；列表排列用 boundingClientRect 核验「元素数==数据条数、尺寸>0」。
7. 非 Tab 页必须经真实点击到达；mock 登录每次建新会员，凡「假设已有数据」的用例先经 UI 造数据。

【验收】
- `wechat-test.js run-all` 结果 + 被验页面**每个可交互入口**逐项覆盖结论（覆盖/未覆盖）
- 覆盖不到或点了没反应/静默失败的入口必须单列，并置 WAITING
- 断言看结果：操作后必须核对页面数据/文案/列表变化，只点不验不算

【禁止】
- 修改任何项目文件（edit/write/bash 落盘全禁；仅锁目录 mkdir 例外）
- 启停/重启后端、跑 artisan/pest/composer、dbreset、读写数据库、curl/API 造数
- pkill 任何 DevTools 进程；用 automator.launch() 自建会话；close/open 循环当「刷新」用
- 调 web_fetch / web_search / present / ask_user_question / job_* 等与任务无关的工具

【回报】1 做了什么（以「工具名 + 目标路径」开头） 2 观察结果（探针数据 + 用例名摘要 + 覆盖结论 + 锁占用/释放） 3 问题与建议 4 状态：DONE 或 WAITING
```

---

## 3. AGENTS.md 里两处需要更新的表述

改角色/prompt 时顺手改掉即可（当前文本与迁移后的实现不符）：

**(1) 第 245 行**，现在写：

> 系统提示中的角色目录段（Subagent Director roles / 另一角色描述）与操作员无关，可要求其忽略。

建议改为：

> 操作员子代理默认**不会**收到角色目录（`catalogScope: main`），无需再要求它忽略；若某次仍出现角色目录段，可忽略。

**(2) 第 250 行**，现在写：

> （角色 persona v6 已内置该口径，改角色需重启 `dsh web` 生效）

建议改为：

> （角色 persona 已内置该口径；角色定义在 `.dsh/roles/<id>.md`，改文件即生效，**不需要重启 `dsh web`**——只有改插件代码或 profile 组合才需要重启）

**(3) 建议新增一段（放在「调试验证委派」开头）**：

> 角色由项目文件定义：`.dsh/roles/web-operator.md`、`.dsh/roles/mp-operator.md`（frontmatter：`provider`/`model`/`reasoningEffort`/`tools`；正文：persona）。工具策略是**白名单**：未列出的工具对子代理不可见且不可调（含 `write`/`edit` 与委派类工具）。同一 id 同时存在于项目级与全局级（`~/.dsh/roles/`）时，项目级胜出。SOP 文件在 `.dsh/skills/`，标了 `disable-model-invocation`，**子代理要用 `read` 直接读 SKILL.md**（`skill` 工具对它们不可用）——所以派发 prompt 里必须写明 SOP 路径。

最后一条同样解释了为什么上面两个模板都把 SOP 绝对/相对路径直接写进 prompt。
