# CODEBUDDY.md

Guidance for AI assistants working in this repo. A single-page WebGL2 GLSL runner — `index.html` is markup only, logic lives in `js/*.js`, zero build step.

## Commands

| Command | Purpose |
|---|---|
| `npx serve .` | Run locally. `file://` renders fine but **disables the clipboard API**, so share buttons silently fail — use HTTP to test sharing. |
| `npm run add <name>` | Add a draft → writes `shader/x.shader.js` + refreshes manifest. Multiple names OK. |
| `npm run add:all` | Re-assemble drafts that are already added (never adds new) |
| `npm run add:check` | Exit 1 if a draft changed without re-adding (one step of `check`) |
| `npm run add:refresh` | Rebuild manifest only — needed after hand-adding/-removing files in `shader/`, or **after hand-editing a `label`** |
| `npm run status` | Show draft states (`npm run add` with no args does the same — read-only) |
| `npm run remove <name>` | Remove a builtin: deletes `shader/x.shader.js` + refreshes manifest. **Never touches `drafts/`** |
| `npm run glsl:check` | GLSL 运行校验：真 WebGL2 编译 + 链接 + 渲染（传参需 `--`） |
| `npm run draft:check` | 只校验 `drafts/*.glsl` |
| `npm run ci:setup` | CI / 新机器环境准备（幂等，末尾自检）：依赖 + Chromium + 系统库 |
| `npm run drafts:extract -- shader/x.js` | Reverse a product back into an editable `drafts/x.glsl` |
| `npm run check` | **Superset** check: manifest sync + field lint + draft sync + GLSL compile. Use in CI. |

`<name>` is flexible — `underwater`, `underwater.glsl`, `drafts/underwater.glsl`,
`shader/underwater.shader.js` all resolve to the same thing (exact match only, never prefix-guessed).
`release` / `release:*` are silent aliases of `add` / `add:*`. Full flag lists live in each script's header comment.

## Commit rules

`drafts/` is WIP and is **normally not committed** (the cloud environment persists untracked files).

- Before committing: `git status --short`, then confirm the staged list.
- If `drafts/` is staged, unstage it: `git restore --staged drafts/`. Commit it only on explicit request.
- **Never add `drafts/` to `.gitignore`** — the cloud snapshots files git does *not* exclude, so ignoring them would destroy them on environment recreation.
- `shader/manifest.js` is a build product but IS committed (static hosts can't list directories at runtime).

## The `--` separator rule

**Any flag requires `--` after the script name** — otherwise npm swallows it with **no error**:

```bash
npm run add -- a --label X              # ✓
npm run add a --label X                 # ✗ "X" parsed as a filename
npm run drafts:extract s.js --force     # ✗ runs WITHOUT --force
```

Prefer the flag-free sub-commands (`add:all`, `add:check`, `add:refresh`, `status`, `check`) — they can't be
swallowed. `add` with no args is deliberately read-only, so a missing separator wastes a command rather
than causing a write.

## GLSL run check

`scripts/check-glsl.js` answers one question: **will this shader actually run in a browser?**
Not "does it look syntactically fine".

Two backends: `browser` (default) compiles + links + renders several frames in a real WebGL2 context and
is **authoritative**; `glslang` is a static compile used only when Chromium is unavailable and is
**advisory**. `CI=true` fails outright on a glslang fallback — a green run on the weak backend is a fake
green. `--allow-fallback` opts in explicitly.

Three rules that bind you:

- **When a check fails, suspect the tool before the shader.** Verify in a real browser before proposing
  edits to a shader — do not "fix" shader code to satisfy a checker. (`70s-melt-color` runs fine in
  Chromium/ANGLE but glslang rejects it — they are separate implementations of the same spec.)
- **Near-black frames are a warning, never a failure.** Fade-in shaders are legitimately dark at t≈0;
  several sample times are used. Don't brighten a shader to silence this.
- **The GLSL wrapper lives in two places**: `js/renderer.js` (runtime, as `VERTEX_SHADER` /
  `buildFragmentShader`) and `scripts/lib/glsl-wrap.js` (checker), sha1-compared every run — a mismatch
  aborts, since a drifted wrapper makes "passed" a lie. Edit one, sync the other. The indentation inside
  those template literals **is part of the GLSL text** — re-aligning it "for tidiness" trips the guard.

Mechanism details (why the checker uses `extractShaderCode()`, what runtime env the browser backend
replicates) are documented in the source files — read them there and keep them there.

## Shader rules for AI

**One-directional constraint: AI goes GLSL → JS; humans may hand-edit the JS.** The tooling detects and protects manual edits.

| State | Meaning | `add` | `remove` | `--check` |
|---|---|---|---|---|
| `unreleased` | no product yet | creates | no-op (warn) | ok |
| `synced` | both unchanged | no-op | deletes | ok |
| `foreign` | product not from this tool | refuses (needs `--force`) | refuses (needs `--force`) | ok |
| `draft-stale` | only draft changed | updates | deletes (draft keeps the new code) | **exit 1** |
| `product-edited` | only product hand-edited | **refuses** | refuses (needs `--force`) | warn |
| `conflict` | both changed | **refuses** | refuses (needs `--force`) | **exit 1** |

Three hashes (`draftHash` / `recordedHash` / `actualHash`) tell which side moved, so a human tuning a shader never trips CI and `add` never silently clobbers it.

- Change a shader by editing `drafts/*.glsl`, then `npm run add <name>`. Never hand-edit `shader/*.shader.js`.
- On `product-edited` or `conflict`: **stop and ask the user** — only they can decide which side wins.
- Never use `--force` to bypass a block without approval.
- `remove` deletes only the product; `drafts/*.glsl` is never touched, so `add` brings it back byte-for-byte.
- Exit code is trustworthy: if any draft is blocked the run exits 1, even if others succeeded.

Recovering a manual edit:

```bash
npm run drafts:extract -- shader/x.shader.js --force   # pull edit back into the draft
npm run add x                                          # refresh fingerprint (no --force)
```

## Architecture

**DOM**: `#glCanvas`, `#inputOverlay`, `#shaderCode` (textarea), `#shaderSelector` (dropdown),
`#encodedUrlInput`, `#maxSizeInput`, `#fileInput`, `#toast`. Element IDs are discoverable in
`index.html` — that is the authoritative list. They are all fetched once, in `js/ui.js`;
other modules use those constants instead of calling `getElementById` again.

**Loading** (lazy — one shader at a time): `loadShaderIndex()` loads only `shader/manifest.js` →
`window.__SHADER_MANIFEST__`, an array of `{ path, label }`. The dropdown renders from that index alone;
**no `shader/*.shader.js` is fetched on first paint**. `ensureShader(path)` injects a single `<script>`
the first time a shader is needed (dropdown pick or `?src=`), then caches it in `BUILTIN_SHADERS`.

- `SHADER_MANIFEST` — `{ path, label }` index, the **only** source for the dropdown.
- `BUILTIN_SHADERS` — cache of already-loaded builtins `{ path, label, code }`.
- `customShaders` — cache of `?js=` externals, keyed by URL. Separate from `BUILTIN_SHADERS` so rebuilding the dropdown doesn't lose them.
- `injectedPaths` — already-injected paths/URLs (success or not), so a broken file isn't re-requested.
- `currentSrc` / `currentJs` — which source is active; **mutually exclusive**. `loadShaderFile()` and `loadCustomUrl()` each clear the other's flag, or switching back would be mistaken for "already selected" and skipped.

`manifest.js` carries `label` because the product holding it isn't loaded yet. Editing a label in
`shader/*.shader.js` therefore requires `npm run add:refresh` — `npm run check` fails if you forget.

**Pipeline**:

```
drafts/x.glsl ──add──▶ shader/x.shader.js ──▶ shader/manifest.js  (auto-refreshed)
      ▲                       │  ▲
      │                       │  └── remove (deletes only the product)
      └────drafts:extract─────┘
```

- `drafts/*.glsl` — WIP, not committed. `_` prefix = template, skipped by `--status`/`--all`.
  Optional frontmatter `// @label:` / `// @name:` (metadata, stripped before hashing, these two only).
- `shader/*.shader.js` — generated, committed.
- `shader/manifest.js` — generated, committed. Holds `{ path, label }` per shader.

**URL params** (query + hash; hash parsed manually because `URLSearchParams` decodes `+` to space):
`mode`, `code`, `id`, `src`, `js`, `maxSize`, `fpsCap`, `autoPauseMs`. Priority `code` > `id` > `src` > `js` > default.

`?js=<url>` loads a shader from any http(s) JS file pushing into `window.__SHADER_REGISTRY__` (same shape
as a generated product). `validateJsUrl()` checks the **scheme only** (`http:`/`https:`) — hosts are
deliberately unrestricted, since a host whitelist would only create false confidence.

**`<script src>` bypasses CORS but not CORP.** A working `?js=` target needs all three: a JS
`Content-Type` (`text/plain` + `nosniff` is fatal with no client-side workaround), `Cross-Origin-Resource-Policy`
absent or `cross-origin`, and `Access-Control-Allow-Origin: *` if CORP blocks. So `crossorigin` is a
**fallback only** (`injectScript(src, true)`) — without ACAO it breaks loads that would otherwise succeed.
Raw source endpoints (GitHub raw, CNB raw) serve `text/plain` + `nosniff` and can never work; use
jsDelivr / unpkg, or a pages host. `diagnoseShaderUrl()` bisects failures with a CORS-mode fetch and
deliberately does not eval the fetched text (that would rescue GitHub raw at the cost of anonymous stack
frames). The measured matrix behind these rules is in `docs/external-js.md`.

**Serverless**: frontend always calls `/api/shader`. Netlify rewrites it to `/.netlify/functions/shader`
(Blob Storage); on Vercel `api/shader.js` handles it (in-memory, volatile).

## Frontend modules

`js/` is loaded as **plain `<script src>` in a fixed order** — deliberately not ES modules:
`file://` blocks module requests via CORS, and this page must survive being double-clicked.
So there is no `import`/`export`; modules communicate through the shared global lexical scope.

Four rules that follow from that, and that you must not break:

- **Order is the dependency graph.** The `<script>` list at the bottom of `index.html` is the
  authoritative ordering: `vendor/lz-string → config → state → params → ui → codec → renderer →
  catalog → share → editor → app`. Adding a `<script>` or reordering the list is a dependency change.
  A `const`/`let` used by an earlier file than the one declaring it throws `ReferenceError` (TDZ).
- **Shared mutable state goes in `js/state.js`** (`currentSrc`, `currentJs`, `currentCode`, `paused`,
  `autoPauseMs`, `autoPauseFired`, `frameCap`, `contextLost`, `glResourcesReady`, `glInitFailed`).
  State used by exactly one module stays in that module. If you find yourself needing a new
  cross-module variable, add it to `state.js` rather than smuggling it across file boundaries.
- **Shared constants go in `js/config.js`** (`DEFAULT_SHADER`, `MAX_SIZE_DEFAULT`, `FPS_CAP_DEFAULT`,
  `API_PATH`, `SHADER_MANIFEST_PATH`, `INDENT`).
- **Every file starts with a header** listing what it defines and which modules it depends on /
  is depended on by. Keep it true when you edit.

Anything DOM-level goes through `js/ui.js` — it is the single place that calls `getElementById`.
`'use strict'` is on in every file except the vendored `lz-string.js`.

Adding a new module: create the file, add a `<script>` tag at the right position, update the
two order comments (file header list in `index.html` and the note in `README.md`).

## File layout

```
/
├── index.html              # DOM only — the <script> list at the bottom IS the dependency graph
├── css/app.css             # 全部样式
├── js/                     # 浏览器运行时 —— 见下节「Frontend modules」
│   ├── vendor/lz-string.js # 第三方库，原样搬运，禁止改动
│   ├── config.js           # 常量（无依赖）
│   ├── state.js            # 跨模块共享的可变状态（无依赖）
│   ├── params.js           # URL 参数
│   ├── ui.js               # DOM 引用 + toast + 剪贴板 + 面板开合
│   ├── codec.js            # lz 编解码 + 链接构建
│   ├── renderer.js         # WebGL2（含 GLSL 包装器，改动要同步 scripts/lib/glsl-wrap.js）
│   ├── catalog.js          # 内置清单 / ?js= 外部源 / 本地文件 / 应用 shader
│   ├── share.js            # 分享 + 发布
│   ├── editor.js           # 编辑器按键 + 链接解码
│   └── app.js              # 启动编排 + 全局监听（最后加载）
├── drafts/                 # WIP GLSL — not committed, NOT gitignored
│   └── _temple.glsl        # `_` prefix = template
├── shader/                 # GENERATED — AI: never hand-edit (humans may edit *.shader.js)
├── img/                    # README screenshots
├── scripts/
│   ├── ci-setup.sh
│   ├── check-glsl.js       # GLSL 运行校验（check 的最后一关）
│   ├── release-shader.js   # drafts → shader   (npm run add)
│   ├── remove-shader.js    # shader → 移除      (npm run remove)
│   ├── extract-shader.js   # shader → drafts
│   ├── gen-shader-manifest.js  # manifest generator + --check
│   └── lib/                # shader-build（共享解析/转义/哈希）, glsl-*（校验后端与包装器）
├── api/shader.js           # Vercel function
├── netlify/functions/shader.js  # Netlify function
└── netlify.toml, vercel.json, package.json
```
