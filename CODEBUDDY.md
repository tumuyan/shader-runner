# CODEBUDDY.md

Guidance for AI assistants working in this repo. A single-page WebGL2 GLSL runner — all logic in `index.html`, zero build step.

## Commands

| Command | Purpose |
|---|---|
| `npx serve .` | Run locally. `file://` renders fine but **disables the clipboard API**, so share buttons silently fail — use HTTP to test sharing. |
| `npm run release` | No args = **show status (read-only)** |
| `npm run release drafts/x.glsl` | Release a draft → writes `shader/x.shader.js` + refreshes manifest. Multiple drafts OK. |
| `npm run release:status` | Show draft states |
| `npm run release:all` | Re-assemble drafts that are already released (never adds new) |
| `npm run release:refresh` | Rebuild manifest only — needed only after hand-adding/-removing files in `shader/` |
| `npm run release:check` | Exit 1 if a draft changed without re-releasing |
| `npm run drafts:extract -- shader/x.js` | Reverse a product back into an editable `drafts/x.glsl` |
| `npm run shaders:check` | **Superset** check: manifest sync + field lint + draft sync. Use in CI. |

## Commit rules

`drafts/` is WIP and is **normally not committed** (the cloud environment persists untracked files).

- Before committing: `git status --short`, then confirm the staged list.
- If `drafts/` is staged, unstage it: `git restore --staged drafts/`. Commit it only on explicit request.
- **Never add `drafts/` to `.gitignore`** — the cloud snapshots files git does *not* exclude, so ignoring them would destroy them on environment recreation.
- `shader/manifest.js` is a build product but IS committed (static hosts can't list directories at runtime).

## The `--` separator rule

**Any flag requires `--` after the script name** — otherwise npm swallows it with **no error**:

```bash
npm run release drafts/a.glsl              # ✓ positional only — no separator
npm run release:all                        # ✓ sub-command — no separator
npm run release -- drafts/a.glsl --label X # ✓ flag present
npm run release drafts/a.glsl --label X    # ✗ "X" parsed as a filename
npm run drafts:extract shader/x.js --force # ✗ runs WITHOUT --force
```

A flag is swallowed even after a filename. `release` with no args is deliberately read-only, so a missing separator wastes a command rather than causing a write.

## Shader rules for AI

**One-directional constraint: AI goes GLSL → JS; humans may hand-edit the JS.** The tooling detects and protects manual edits.

| State | Meaning | `release` | `--check` |
|---|---|---|---|
| `unreleased` | no product yet | creates | ok |
| `synced` | both unchanged | no-op | ok |
| `foreign` | product not from this tool | refuses (needs `--force`) | ok |
| `draft-stale` | only draft changed | updates | **exit 1** |
| `product-edited` | only product hand-edited | **refuses** | warn |
| `conflict` | both changed | **refuses** | **exit 1** |

Three hashes (`draftHash` / `recordedHash` / `actualHash`) tell which side moved, so a human tuning a shader never trips CI and `release` never silently clobbers it.

- Change a shader by editing `drafts/*.glsl`, then releasing. Never hand-edit `shader/*.shader.js`.
- On `product-edited` or `conflict`: **stop and ask the user** — only they can decide which side wins.
- Never use `--force` to bypass a block without approval.
- Exit code is trustworthy: if any draft is blocked the run exits 1, even if others succeeded.

Recovering a manual edit:

```bash
npm run drafts:extract -- shader/x.shader.js --force   # pull edit back into the draft
npm run release drafts/x.glsl                          # refresh fingerprint (no --force)
```

## Architecture

**DOM** (`index.html`, ~1800 lines): `#glCanvas`, `#inputOverlay`, `#shaderCode` (textarea), `#shaderSelector` (dropdown), `#encodedUrlInput`, `#maxSizeInput` (default 0 = unlimited; the HTML `value="2560"` is overwritten by JS), `#fileInput` (accepts `.glsl/.frag/.vert/.txt`), `#toast`.

**Loading**: `loadShaderScripts()` loads `shader/manifest.js` → `window.__SHADER_MANIFEST__`, then injects a `<script>` per path in parallel (bypasses CORS, so sandbox iframes work). `BUILTIN_SHADERS` is then **re-sorted to manifest order**, since parallel execution order isn't guaranteed.

**Pipeline**:

```
drafts/x.glsl ──release──▶ shader/x.shader.js ──▶ shader/manifest.js  (auto-refreshed)
      ▲                            │
      └────────drafts:extract──────┘
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
│   ├── release-shader.js   # drafts → shader
│   ├── extract-shader.js   # shader → drafts
│   ├── gen-shader-manifest.js  # manifest generator + --check
│   └── lib/shader-build.js # Shared: frontmatter, escaping, hashing
├── api/shader.js           # Vercel function
├── netlify/functions/shader.js  # Netlify function
├── netlify.toml, vercel.json, package.json
└── README.md
```
