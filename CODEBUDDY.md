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
| `npm run api:check` | 服务端写入防护：体积 / ID / 限流 / 配额，两个 handler 都真跑一遍 |
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

**Applying a shader**: every source (editor, dropdown, file, URL param) ends in `applyShader()` →
`createProgram()`, which deletes the old `program` *before* compiling the new code. So a compile/link
failure leaves `program === null` and `render()` skips drawing → **black canvas**. That is the intended
"your edit did not apply" signal, not a bug: the failure path already keeps the editor open and shows
an error toast, and the black frame is what remains once the editor closes. The alternative (compile
into a temp program, swap only on success) would leave the previous shader animating after the editor
closes, so a failed edit would look successful. Fully reversible — fixing the code and re-applying
rebuilds the program; nothing deadlocks.

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

Of the three limit params, `maxSize` and `fpsCap` are **live controls** — they take effect on the
current page as soon as they change. `autoPauseMs` is **not**: it is a link parameter. It is entered in
edit mode, serialized by `autoPauseQuery()` into the generated preview links (`share.js`,
`buildServerUrl`, `buildSourceUrl`), and consumed only under the `isPreview` gate in `renderer.js`.
Two consequences that look contradictory but are both correct: it never fires in edit mode (so editing
is never auto-interrupted), and `.pause-group` is hidden in preview mode, where the value is already
baked into the URL. The user-facing wording is the input's `title` in `index.html`.

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

**Publish-availability probe**: static hosting has no `/api/shader`, so `share.js` probes once at startup
with `GET /api/shader` (no `id` → both backends answer 400 + JSON, zero side effects) and gates the two
publish buttons (`uploadBtn`, `shareServerBtn`). **A JSON body is the only proof the backend exists** —
status alone is not, because hosts with an SPA fallback rewrite unknown paths to `index.html` and return
200 HTML. Gating uses `aria-disabled` + `.is-disabled`, **not** the `disabled` attribute: a disabled button
fires no click and shows no title, which is exactly the silent failure being fixed. State lives in
`apiAvailable` / `apiUnavailableReason` (state.js); `ensureApiProbe()` memoizes so startup, `?id=` loading
and clicks share one request. With `?id=`, `init()` awaits the probe and skips the doomed fetch when the
backend is absent.

**Compile verification happens in the browser, not on the server.** `renderer.js` records
`lastCompiledCode` (state.js) only on successful compile+link, and `share.js` refuses to publish code
that differs from it — using the same ANGLE that will render it, so zero false verdicts. The server
adds `validateGlslShape()`, which rejects **only what is guaranteed to fail in every implementation**
(missing `mainImage`, own `#version`, redefining `void main()`, `script` tags); comments are stripped
first so a comment reading `void main()` is not a false rejection. **Do not put a real compiler in the
serverless request path.** No GPU there, and the only viable option (glslangValidator, 6.7 MB binary)
rejects shaders that work: `70s-melt-color` compiles, links and renders fine in real WebGL2/ANGLE but
glslang fails it. `BROWSER_DIVERGENT` in `scripts/lib/glsl-backend-glslang.js` exists for exactly this,
and that list is empirical and necessarily incomplete — as a *blocking* gate, every uncatalogued
divergence becomes "this user cannot publish and has no way to appeal". Cheap to absorb in CI, expensive
for users. The browser gate is a UX guardrail (bypassable by direct POST), not a security control; the
server shape check is the backstop. Both are needed.

Two things to not do: never reject `precision` redeclaration (it is legal in ANGLE and `70s-melt-color`
depends on it — `scripts/lib/glsl-wrap.js`'s header comment lumps it with wrapper conflicts, which is
wrong), and never apply the write-side shape rules on the read path (they evolve; tightening them would
turn historically valid records into "content corrupted", and reads are the only recovery path).

**Write limits live in `shared/shader-api.js`** (CJS, because the Netlify function is CJS and Vercel's ESM
entry can default-import CJS but not the reverse). Both `api/shader.js` and `netlify/functions/shader.js`
must route every write and read through it — do not re-implement a check in either entry. Enforced there:
512 KB code cap (UTF-8 **bytes**, not `String.length`), ~1 MB body cap, 20 POST / 10 min / IP and 1200 GET /
10 min / IP sliding window, `crypto` IDs, a 5000-entry **and** 64 MB cap on the in-memory store (entries alone is not enough:
5000 × 512 KB = 2.44 GiB, so the process OOMs long before it can return 503), and `validateStored()`
on every read (storage is not trusted). **The write path must measure the same bytes the read path
does** — go through `serialize()` on both sides. `MAX_STORED_BYTES` is 2× the code cap + 16 KB because
JSON escaping can nearly double the bytes (every newline/quote/backslash becomes 2). Measuring code
bytes on write and serialized bytes on read creates records that can be written but never read:
GET returns 500 forever, and dedup silently degrades (unreadable content is treated as a collision, so
every resubmit stores another full copy). `validateCode` checks size **before** shape, so a 600 KB
payload reports "too large" rather than the misleading "missing mainImage".

**Storage keys are content-addressed**: `contentKey(code)` = base62(sha256(code)) truncated to 8 chars,
so identical code reuses one ID and duplicate submissions cost no extra storage. This is the real fix
for storage exhaustion — it converts the attack from "cheap per request" to "expensive per distinct
byte". The byte budget stays because the two are orthogonal. **Truncating to 8 chars keeps only 47.5
bits, and a hash collision here is not benign** (unlike a random-ID collision, which `isTaken` catches
and retries): treating a collision as "same content" hands the user a link to the wrong shader. So
`assignId()` always **reads back and compares the content** — equal → dedupe; different → real
collision, fall back to a random ID with retry. These are **speed bumps, not a wall**: serverless
instances don't share counters, so the real ceiling is roughly `limit × live instances`, and on Vercel the IP
comes from `x-forwarded-for`. Platform-level limits (Vercel Firewall / Netlify) are the real enforcement.
`npm run api:check` exercises both handlers end to end.

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
│   ├── share.js            # 分享 + 发布（含接口探测与体积预检）
│   ├── editor.js           # 编辑器按键 + 链接解码
│   └── app.js              # 启动编排 + 全局监听（最后加载）
├── drafts/                 # WIP GLSL — not committed, NOT gitignored
│   └── _temple.glsl        # `_` prefix = template
├── shader/                 # GENERATED — AI: never hand-edit (humans may edit *.shader.js)
├── img/                    # README screenshots
├── scripts/
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
└── netlify.toml, vercel.json, package.json
```
