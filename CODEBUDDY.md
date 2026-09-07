# CODEBUDDY.md

Guidance for AI assistants working in this repo. A single-page WebGL2 GLSL runner — `index.html` is markup only, logic lives in `js/*.js`, zero build step.

**这里只写规则：做什么、怎么做、不做什么。** 设计理由在 `docs/design.md`，用户用法在 `README.md` —— 不要在这里复述「为什么」。

## 铁律

| 场景 | 做 | **不**做 |
|---|---|---|
| 改 shader | 改 `drafts/*.glsl` → `npm run add <name>` | 手改 `shader/*.shader.js` |
| `product-edited` / `conflict` | **停下来问用户** | 用 `--force` 强推 |
| 提交 | 只提交 `shader/`；`drafts/` 留在工作区 | 提交 `drafts/`；把它写进 `.gitignore` |
| `glsl:check` 失败 | 先怀疑工具，浏览器里验证过再动 shader | 为了让校验器变绿去改对的 shader |
| 近黑 / 全黑帧 | 当警告 | 调亮 shader 去消掉它 |
| GLSL 包装器（两份） | 改一处同步另一处 | 去重排模板字符串里的缩进（那也是 GLSL 文本） |
| 新的跨模块状态 / 常量 | 加进 `js/state.js` / `js/config.js` | 跨文件偷渡变量 |
| 加载顺序 | 改 `index.html` 底部 `<script>` 列表 + 两处顺序注释 | 随手调换顺序（TDZ → `ReferenceError`） |
| DOM 访问 | 走 `js/ui.js` | 自己 `getElementById` |
| URL 参数 | 读用 `params.js` 的 `pick()`，写用 `codec.js` 的 `buildUrl()` | 手写 `h.x \|\| p.get('x')`、自己拼链接 |
| 服务端写入校验 | 只改 `shared/shader-api.js` | 在两个 entry 里各实现一遍 |
| 服务端 GLSL 校验 | 只收「必定失败」的形态特征 | 放真编译器；把写侧规则套到读路径 |
| `precision` 重声明 | 放行（ANGLE 合法） | 拒绝 |
| 发布按钮置灰 | `aria-disabled` + `.is-disabled` | 用 `disabled` 属性（无 click、无 title） |
| 编译失败黑屏 | 保持 | 「修」成临时 program 成功后替换 |
| 发布前校验 | 用 `lastCompiledCode`（浏览器 ANGLE） | 相信静态检查结果 |

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | 本地运行 **带可用 `/api/shader`**（静态 + 真实 handler，内存存储）。要测发布就用它 |
| `npx serve .` | 纯静态，无 `/api/shader`，发布按钮会置灰 |
| `npm run add <name>` | 草稿 → 产物 + 刷新清单。可传多个名 |
| `npm run add:all` | 重装配已加入的草稿（不新增） |
| `npm run add:check` | 草稿改了没重新 add → 退出 1（`check` 的一关） |
| `npm run add:refresh` | 只重建清单。手改过 `label`、或手动增删 `shader/` 后必跑 |
| `npm run status` | 看草稿状态（`add` 不带参数也是只读） |
| `npm run remove <name>` | 删产物 + 刷新清单。**永不碰 `drafts/`** |
| `npm run glsl:check` | GLSL 运行校验：真 WebGL2 编译 + 链接 + 渲染（传参需 `--`） |
| `npm run draft:check` | 只校验 `drafts/*.glsl` |
| `npm run api:check` | 服务端写入防护：体积 / ID / 限流 / 配额，两个 handler 都真跑一遍 |
| `npm run ci:setup` | CI / 新机器环境准备（幂等，末尾自检） |
| `npm run drafts:extract -- shader/x.js` | 产物 → 可编辑草稿 |
| `npm run check` | 总校验（CI 用）：清单同步 + 字段 + 草稿同步 + 写入防护 + GLSL |

`<name>` 可写成 `underwater` / `underwater.glsl` / `drafts/underwater.glsl` / `shader/underwater.shader.js`，都是同一个东西（精确匹配，不猜前缀）。`release` / `release:*` 是 `add` / `add:*` 的别名。完整 flag 列表在各脚本的头注释里。

**任何 flag 都必须在脚本名后加 `--`**，否则 npm 会吞掉它且不报错：

```bash
npm run add -- a --label X              # ✓
npm run add a --label X                 # ✗ "X" 被当成文件名
```

优先用无 flag 的子命令（`add:all` / `add:check` / `add:refresh` / `status` / `check`）。

## 改 shader 的流程

单向约束：**AI 只能 GLSL → JS；人类可以手改 JS。** 工具会检测并保护手改。

| 状态 | 含义 | `add` | `remove` | `--check` |
|---|---|---|---|---|
| `unreleased` | 无产物 | 创建 | no-op（警告） | ok |
| `synced` | 两边都没动 | no-op | 删除 | ok |
| `foreign` | 产物不是本工具生成 | 拒绝（需 `--force`） | 拒绝（需 `--force`） | ok |
| `draft-stale` | 只有草稿变了 | 更新 | 删除（草稿保留新代码） | **exit 1** |
| `product-edited` | 只有产物被手改 | **拒绝** | 拒绝（需 `--force`） | 警告 |
| `conflict` | 两边都变了 | **拒绝** | 拒绝（需 `--force`） | **exit 1** |

三个哈希（`draftHash` / `recordedHash` / `actualHash`）判定哪边动了 —— 人类微调 shader 不会误伤 CI，`add` 也不会静默覆盖。`remove` 只删产物，`add` 能按字节还原。

退出码可信：任一草稿被拦，整轮退出 1（即使其它成功）。

捞回一次手改：

```bash
npm run drafts:extract -- shader/x.shader.js --force   # 把手改拉回草稿
npm run add x                                          # 刷新指纹（无需 --force）
```

## Commit rules

- 提交前 `git status --short`，确认暂存列表。
- `drafts/` 若被暂存：`git restore --staged drafts/`。只在明确要求时才提交。
- **永不把 `drafts/` 写进 `.gitignore`** —— 云环境只快照 git 未忽略的文件，忽略等于销毁它们。
- `shader/manifest.js` 是产物但要提交（静态托管运行时列不出目录）。

## Architecture

**DOM**：`#glCanvas`、`#inputOverlay`、`#shaderCode`、`#shaderSelector`、`#encodedUrlInput`、`#maxSizeInput`、`#fileInput`、`#toast`。`index.html` 是唯一权威列表，`js/ui.js` 一次性取完。

**加载**（懒加载，一次一个）：`loadShaderIndex()` 只加载 `shader/manifest.js` → `window.__SHADER_MANIFEST__`（`{ path, label }` 数组）。下拉只靠它渲染，**首屏不下载任何 `shader/*.shader.js`**；`ensureShader(path)` 在首次需要时注入一个 `<script>` 并缓存。

- `SHADER_MANIFEST` —— 下拉的唯一数据源
- `BUILTIN_SHADERS` —— 已加载内置 `{ path, label, code }`
- `customShaders` —— `?js=` 外部源，按 URL 缓存（与上面分开，重建下拉时不丢）
- `injectedPaths` —— 已注入的路径/URL（成败都记），坏文件不会重复请求
- `currentSrc` / `currentJs` —— 当前生效源，**互斥**；`loadShaderFile()` 与 `loadCustomUrl()` 各自清掉对方的标记，否则切回去会被当成「已选中」而跳过

`manifest.js` 之所以带 `label`：产物此时还没加载。因此手改 `shader/*.shader.js` 里的 label 必须跑 `npm run add:refresh`，`npm run check` 会拦。

**Applying a shader**：所有来源（编辑器、下拉、文件、URL 参数）都汇入 `applyShader()` → `createProgram()`，它在编译**前**删旧 `program`，失败即 `program === null` → 黑屏。这是刻意的「编辑没生效」信号，不要修（理由见 `docs/design.md`）。完全可逆：改对了重新应用即重建 program。

**Pipeline**：

```
drafts/x.glsl ──add──▶ shader/x.shader.js ──▶ shader/manifest.js  (自动刷新)
      ▲                       │  ▲
      │                       │  └── remove（只删产物）
      └────drafts:extract─────┘
```

- `drafts/*.glsl` —— `_` 前缀是模板，被 `--status` / `--all` 跳过。可选 frontmatter `// @label:` / `// @name:`（仅这两个，哈希前剥掉）
- `shader/*.shader.js` —— 生成物，提交
- `shader/manifest.js` —— 生成物，提交，每项 `{ path, label }`

**URL params**（query + hash；hash 手工解析，因为 `URLSearchParams` 会把 `+` 解成空格）：`mode`、`code`、`id`、`src`、`js`、`maxSize`、`fpsCap`、`autoPauseMs`。优先级 `code` > `id` > `src` > `js` > 默认。

- 每个参数都从 **query 和 hash 两处**读，由 `params.js` 里唯一的 `pick()` 合并，hash 优先 —— 别在别处手写合并逻辑。
- 生成是读取的镜像：`codec.js` 只有 `buildUrl()` 一个出口，`mode`/`src`/`js` 与三个限制参数进 query，`code` **或** `id` 进 hash（`code` 可能几 KB，hash 不会发给服务端，也就不会被按 URL 长度截断）。三个限制参数由 `limitParams()` 一次给出，免得有调用方只拼两个。
- `pageBase()` 特判 `file://`（那里 `location.origin` 是字符串 `"null"`）。

三个限制参数里 `maxSize` / `fpsCap` 是**实时控件**，改了立刻生效；`autoPauseMs` **不是** —— 它是链接参数：编辑模式下填，由 `limitParams()` 写进生成的预览链接，只在 `renderer.js` 的 `isPreview` 分支里消费。两个看似矛盾的推论都对：编辑模式下永不触发（不会打断编辑），预览模式下 `.pause-group` 隐藏（值已烧进 URL）。用户可见文案在 `index.html`：`.pause-group` 的 **label** 承载语义（它不像另两个有实时反馈，不能只在 hover 时说明），`title` 补剩下部分。**改就两处一起改。**

`?js=<url>` 从任意 http(s) JS 加载 shader（往 `window.__SHADER_REGISTRY__` 里推，形状同生成产物）。`validateJsUrl()` **只校验 scheme**（`http:`/`https:`）—— 故意不限 host，白名单只会制造虚假安全感。`crossorigin` 只作兜底（`injectScript(src, true)`），没有 ACAO 时会弄坏本来能成功的加载。`diagnoseShaderUrl()` 只做诊断，**绝不 eval 抓到的文本**。

**Serverless**：前端只调 `/api/shader`。Netlify 重写到 `/.netlify/functions/shader`（Blob Storage）；Vercel 由 `api/shader.js` 处理（内存，易失）。

**发布可用性探测**：`share.js` 启动时探一次 `GET /api/shader`（不带 `id`），据此置灰 `uploadBtn` / `shareServerBtn`。**判定要同时看状态码和响应体**（只看一个会被 SPA fallback 或「404 + JSON」的网关骗过）。状态存 `apiAvailable` / `apiUnavailableReason`（state.js）；`ensureApiProbe()` 记忆化，让启动、`?id=` 加载和点击共用一次请求。带 `?id=` 时 `init()` 先等探测，后端缺席就跳过那次注定失败的取。

**编译验证在浏览器**：`renderer.js` 只在编译 + 链接成功后记录 `lastCompiledCode`，`share.js` 拒绝发布与它不一致的代码 —— 用的是将来渲染它的那个 ANGLE，零误判。服务端只加 `validateGlslShape()`。

**存储键是内容寻址的**：`contentKey(code)` = `base62(sha256(code))` 前 8 位，相同代码复用同一个 ID。8 位只保留 47.5 bit，**这里的哈希碰撞不是良性的**（随机 ID 碰撞能被 `isTaken` 检出并重试，内容哈希碰撞会被误判成「同一份内容」、把错误 shader 的链接发给用户）。所以 `assignId()` 必须**回读并比对内容**：相同 → 去重；不同 → 真碰撞，退回随机 ID 并重试。

**写入限制集中在 `shared/shader-api.js`**（CJS，因为 Netlify function 是 CJS，Vercel 的 ESM 入口能默认导入 CJS，反之不行）。两个 entry 的每次读写都必须走它，不要在任一 entry 里自己实现检查。每次读取都要过 `validateStored()`（存储不可信）；**写路径和读路径必须量同一个字节数**（都走 `serialize()`）。`npm run api:check` 端到端打两个 handler。

## Frontend modules

`js/` 由**固定顺序的普通 `<script src>`** 加载，故意不用 ES module（`file://` 会拦模块请求，而本页必须能双击打开）。没有 `import`/`export`，靠共享全局词法作用域通信。由此四条：

- **顺序即依赖图**：`index.html` 底部的 `<script>` 列表是权威顺序 —— `vendor/lz-string → config → state → params → ui → codec → renderer → catalog → share → editor → app`。加文件或调换顺序是一次依赖变更。
- **跨模块共享可变状态放 `js/state.js`**（`currentSrc`、`currentJs`、`currentCode`、`paused`、`autoPauseMs`、`autoPauseFired`、`frameCap`、`contextLost`、`glResourcesReady`、`glInitFailed`）。只被一个模块用的状态留在那个模块里。
- **共享常量放 `js/config.js`**（`DEFAULT_SHADER`、`MAX_SIZE_DEFAULT`、`FPS_CAP_DEFAULT`、`API_PATH`、`SHADER_MANIFEST_PATH`、`INDENT`）。
- **每个文件开头有头注释**，写明它定义什么、依赖谁、被谁依赖。改动时保持它为真。

任何 DOM 操作走 `js/ui.js`（唯一调 `getElementById` 的地方）。除 vendored `lz-string.js` 外，每个文件都有 `'use strict'`。

新增模块：建文件 → 在正确位置加 `<script>` → 更新两处顺序注释（`index.html` 文件头列表、`README.md` 的那条说明）。

## File layout

```
/
├── index.html              # DOM only — 底部 <script> 顺序即依赖图（见「Frontend modules」）
├── css/app.css             # 全部样式
├── js/                     # 浏览器运行时 —— 见上节
│   ├── vendor/lz-string.js # 第三方库，原样搬运，禁止改动
│   ├── config.js           # 常量（无依赖）
│   ├── state.js            # 跨模块共享的可变状态（无依赖）
│   ├── params.js           # URL 参数
│   ├── ui.js               # DOM 引用 + toast + 剪贴板 + 面板开合
│   ├── codec.js            # lz 编解码 + 链接构建
│   ├── renderer.js         # WebGL2（含 GLSL 包装器，改动要同步 scripts/lib/glsl-wrap.js）
│   ├── catalog.js          # 内置清单 / ?js= 外部源 / 本地文件 / 应用 shader
│   ├── share.js            # 分享 + 发布（含接口探测与体积预检）
│   ├── editor.js           # 编辑器按键 + 链接解码
│   └── app.js              # 启动编排 + 全局监听（最后加载）
├── drafts/                 # WIP GLSL — 提交与忽略规则见「Commit rules」
│   └── _temple.glsl        # `_` prefix = template
├── shader/                 # GENERATED — AI: never hand-edit (humans may edit *.shader.js)
├── img/                    # README screenshots
├── scripts/
│   ├── dev-server.js      # 本地开发服务器：静态文件 + /api/shader（npm run dev，零依赖）
│   ├── ci-setup.sh
│   ├── check-api.js        # 服务端写入防护校验（并入 npm run check）
│   ├── check-glsl.js       # GLSL 运行校验（check 的最后一关）
│   ├── release-shader.js   # drafts → shader   (npm run add)
│   ├── remove-shader.js    # shader → 移除      (npm run remove)
│   ├── extract-shader.js   # shader → drafts
│   ├── gen-shader-manifest.js  # manifest generator + --check
│   └── lib/                # shader-build（共享解析/转义/哈希）, glsl-*（校验后端与包装器）
├── shared/shader-api.js    # 服务端写入防护：体积 / ID / 限流 / 配额（两个后端共用）
├── api/shader.js           # Vercel function
├── netlify/functions/shader.js  # Netlify function
├── docs/                   # 分主题：shader-workflow / checking / external-js / design / wont-fix
└── netlify.toml, vercel.json, package.json
```

## GLSL run check

`scripts/check-glsl.js` 回答的是「**这个 shader 能不能在浏览器里真的跑起来**」。两个后端：`browser`（默认，真 WebGL2 编译 + 链接 + 渲染多帧，**权威**）、`glslang`（无 Chromium 时的静态编译，**仅供参考**）。`CI=true` 对降级直接判失败 —— 弱后端跑出绿灯是假绿灯；`--allow-fallback` 显式放行。

- **校验失败先怀疑工具**，别为了让校验器变绿去改对的 shader。
- **近黑帧只是警告，从不判失败**（渐入型 shader 在 t≈0 本来就接近全黑）。
- 包装器两份（`js/renderer.js` 与 `scripts/lib/glsl-wrap.js`）每次运行 sha1 比对，不一致即中止。

机制细节（为什么用 `extractShaderCode()`、浏览器后端复刻了什么运行时环境）写在源码里，读源码并在那里维护。
