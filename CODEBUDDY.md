# CODEBUDDY.md

Guidance for AI assistants working in this repo. A single-page WebGL2 GLSL runner — all logic in `index.html`, zero build step.

## Commands

| Command | Purpose |
|---|---|
| `npx serve .` | Run locally. `file://` renders fine but **disables the clipboard API**, so share buttons silently fail — use HTTP to test sharing. |
| `npm run add <name>` | Add a draft → writes `shader/x.shader.js` + refreshes manifest. Multiple names OK. |
| `npm run add:all` | Re-assemble drafts that are already added (never adds new) |
| `npm run add:check` | Exit 1 if a draft changed without re-adding (one step of `check`) |
| `npm run add:refresh` | Rebuild manifest only — needed only after hand-adding/-removing files in `shader/` |
| `npm run status` | Show draft states (`npm run add` with no args does the same — read-only) |
| `npm run remove <name>` | Remove a builtin: deletes `shader/x.shader.js` + refreshes manifest. **Never touches `drafts/`** |
| `npm run glsl:check` | GLSL 运行校验：真 WebGL2 编译 + 链接 + 渲染（传参需 `--`；默认只校验 manifest 引用的） |
| `npm run draft:check` | 只校验 `drafts/*.glsl`（无参数子命令，不会被 npm 吞掉） |
| `npm run ci:setup` | CI / 新机器环境准备：依赖 + Chromium + 系统库 + 自检（幂等，传参需 `--`） |
| `npm run drafts:extract -- shader/x.js` | Reverse a product back into an editable `drafts/x.glsl` |
| `npm run check` | **Superset** check: manifest sync + field lint + draft sync + GLSL compile. Use in CI. `shaders:check` is a legacy alias. |

`<name>` is flexible — `underwater`, `underwater.glsl`, `drafts/underwater.glsl`,
`shader/underwater.shader.js` all resolve to the same thing (exact match only, never prefix-guessed).
The old `release` / `release:*` names still exist as silent aliases of `add` / `add:*`.

## Commit rules

`drafts/` is WIP and is **normally not committed** (the cloud environment persists untracked files).

- Before committing: `git status --short`, then confirm the staged list.
- If `drafts/` is staged, unstage it: `git restore --staged drafts/`. Commit it only on explicit request.
- **Never add `drafts/` to `.gitignore`** — the cloud snapshots files git does *not* exclude, so ignoring them would destroy them on environment recreation.
- `shader/manifest.js` is a build product but IS committed (static hosts can't list directories at runtime).

## The `--` separator rule

**Any flag requires `--` after the script name** — otherwise npm swallows it with **no error**:

```bash
npm run add a                              # ✓ positional only — no separator
npm run add:all                            # ✓ sub-command — no separator
npm run add -- a --label X                 # ✓ flag present
npm run add a --label X                    # ✗ "X" parsed as a filename
npm run drafts:extract shader/x.js --force # ✗ runs WITHOUT --force
```

A flag is swallowed even after a filename. Prefer the flag-free sub-commands (`add:all`, `add:check`,
`add:refresh`, `status`, `check`) — they can't be swallowed. `add` with no args is deliberately read-only, so a
missing separator wastes a command rather than causing a write. `remove` is the one command where a
swallowed `--force` is harmless: it just refuses and prints the full command to re-run.

## GLSL run check

`scripts/check-glsl.js` answers one question: **will this shader actually run in a browser?**
Not "does it look syntactically fine".

```bash
npm run glsl:check                  # shaders referenced by manifest.js (default)
npm run draft:check                 # drafts/*.glsl only
npm run glsl:check -- --all         # everything under shader/, incl. unreferenced
npm run glsl:check -- rain aurora   # specific targets, short name or path
npm run glsl:check -- --backend glslang   # force the fallback backend
```

Two backends: `browser` (default) compiles + links + renders several frames in a real WebGL2
context and is **authoritative**; `glslang` is a static compile that only runs when Chromium is
unavailable and is **advisory**.

**The browser is the authority, not glslang.** They are separate implementations of the same spec
and disagree — `70s-melt-color` runs fine in Chromium/ANGLE but glslang rejects it.

Exit codes: a real failure is 1. If neither backend is installed the check **skips with exit 0**
(they're devDependencies), unless `CI=true` or `--require`. `CI=true` also fails outright when it
had to fall back to `glslang` — a green run on the weak backend only *warned* about known
divergences, so the green is fake. `--allow-fallback` opts in explicitly.

Three rules that bind you:

- **When a check fails, suspect the tool before the shader.** Verify in a real browser before
  proposing edits to a shader — do not "fix" shader code to satisfy a checker.
- **Near-black frames are a warning, never a failure.** Fade-in shaders are legitimately dark at
  t≈0; several sample times are used. Don't brighten a shader to silence this.
- **The wrapper lives in two places**: `index.html` (runtime) and `scripts/lib/glsl-wrap.js`
  (checker), compared by sha1 every run — a mismatch aborts, since a drifted wrapper makes
  "passed" a lie. Edit one, sync the other.

Mechanism details — how `glslang` downgrades a known divergence via a second compile, why the
checker uses `extractShaderCode()` rather than `parseShaderFile()`, what runtime env the browser
backend replicates — are documented in the source files. Read them there and keep them there;
duplicating them here is how they go stale (the moment `--drafts` became `--drafts-only`, both
docs were wrong at once).

### CI setup

`npm run ci:setup` is idempotent and ends with `--self-test`: installed ≠ working — Chromium
installs fine but crashes at launch when system libs are missing. The self-test verifies both
directions — one known-good shader must pass, three known-bad ones must be caught — so a backend
that returns "pass" unconditionally can't slip through.
`.github/workflows/check.yml` runs it on push/PR with Playwright browser caching.

```bash
npm run ci:setup -- --no-npm     # deps already installed by actions/setup-node
npm run ci:setup -- --no-deps    # image already has system libs
npm run ci:setup -- --no-verify  # install only, skip self-test
```

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
- `remove` deletes only the product — `drafts/*.glsl` is uncommitted hand work and is never touched. After removal the draft shows as `unreleased` again, so `add` brings it back byte-for-byte.
- All three blocked `remove` cases (foreign / no draft / hand-edited product) print the exact escape hatch, including the `--` separator.
- On `product-edited` or `conflict`: **stop and ask the user** — only they can decide which side wins.
- Never use `--force` to bypass a block without approval.
- Exit code is trustworthy: if any draft is blocked the run exits 1, even if others succeeded.

Recovering a manual edit:

```bash
npm run drafts:extract -- shader/x.shader.js --force   # pull edit back into the draft
npm run add x                                          # refresh fingerprint (no --force)
```

## Architecture

**DOM** (`index.html`, ~1800 lines): `#glCanvas`, `#inputOverlay`, `#shaderCode` (textarea), `#shaderSelector` (dropdown), `#encodedUrlInput`, `#maxSizeInput` (default 0 = unlimited; the HTML `value="2560"` is overwritten by JS), `#fileInput` (accepts `.glsl/.frag/.vert/.txt`), `#toast`.

**Loading**: `loadShaderScripts()` loads `shader/manifest.js` → `window.__SHADER_MANIFEST__`, then injects a `<script>` per path in parallel (bypasses CORS, so sandbox iframes work). `BUILTIN_SHADERS` is then **re-sorted to manifest order**, since parallel execution order isn't guaranteed.

**Pipeline**:

```
drafts/x.glsl ──add──▶ shader/x.shader.js ──▶ shader/manifest.js  (auto-refreshed)
      ▲                       │  ▲
      │                       │  └── remove (deletes only the product)
      └────drafts:extract─────┘
```

- `drafts/*.glsl` — WIP, not committed. `_` prefix = template, skipped by `--status`/`--all`.
- `shader/*.shader.js` — generated, committed, carries a `源草稿: <path> @ sha1:<hash>` line.
- `shader/manifest.js` — generated, committed.

Optional draft frontmatter (metadata — stripped before hashing):

```glsl
// @label: Aero Waves   // else filename → Title Case
// @name:  aero-waves   // else filename
```

Only `label` and `name` are recognized; other `// @foo:` comments stay part of the shader code.

**URL params** (query + hash; hash parsed manually because `URLSearchParams` decodes `+` to space): `mode`, `code`, `id`, `src`, `maxSize`, `fpsCap`, `autoPauseMs`. Priority `code` > `id` > `src` > default.

**Serverless**: frontend always calls `/api/shader`. Netlify rewrites it to `/.netlify/functions/shader` (Blob Storage); on Vercel `api/shader.js` handles it (in-memory, volatile).

## File layout

```
/
├── index.html              # Entire app
├── drafts/                 # WIP GLSL — not committed, NOT gitignored
│   ├── _temple.glsl        # Template
│   └── *.glsl
├── shader/
│   ├── manifest.js         # GENERATED (AI: never hand-edit)
│   └── *.shader.js         # GENERATED (AI: never hand-edit, humans may)
├── img/                    # README screenshots
├── scripts/
│   ├── ci-setup.sh                   # CI / 新机器环境准备（幂等，末尾自检）
│   ├── check-glsl.js          # GLSL 运行校验（npm run glsl:check，check 的最后一关）
│   ├── release-shader.js   # drafts → shader   (npm run add)
│   ├── remove-shader.js    # shader → 移除      (npm run remove)
│   ├── extract-shader.js   # shader → drafts
│   ├── gen-shader-manifest.js  # manifest generator + --check
│   └── lib/shader-build.js # Shared: frontmatter, escaping, hashing
│   └── lib/glsl-wrap.js    # Shared: 浏览器包装器 + 运行时环境（与 index.html sha1 比对）
│   └── lib/glsl-errors.js  # Shared: 编译日志解析与行号映射（不判断降级）
│   └── lib/glsl-backend-browser.js  # 真 WebGL2 后端（权威）
│   └── lib/glsl-backend-glslang.js  # glslang 静态后端（回退）
├── api/shader.js           # Vercel function
├── netlify/functions/shader.js  # Netlify function
├── netlify.toml, vercel.json, package.json
└── README.md
```
