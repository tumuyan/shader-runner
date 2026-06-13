# CODEBUDDY.md

This file provides guidance to CodeBuddy when working with code in this repository.

## Commands

- **Run locally**: `npx serve .` — serves the project via HTTP (required for shader file loading; `file://` won't work for dynamic `<script>` loading).
- **Deploy to Netlify**: Push to git. Netlify auto-deploys from the repo. The `netlify.toml` configures static serving and the serverless function.
- **Deploy to Vercel**: Push to git. Vercel auto-deploys. The `api/shader.js` function handles publishing.
- **Add a built-in shader**: (1) Create `shader/name.shader.js` as an IIFE that pushes to `window.__SHADER_REGISTRY__`. (2) Add its path to `SHADER_JS_FILES` in `index.html`. No build step needed.
- **Test publish locally (Netlify)**: `npm install && ntl dev` — runs the Netlify function locally with `@netlify/blobs`.

## Architecture

### Single-Page App in `index.html`

The entire application is a single `index.html` (~1465 lines) containing embedded HTML, CSS, and JavaScript. No build tools, no bundlers, no framework — zero build step.

**Key DOM elements:**

| ID | Purpose |
|---|---|
| `#glCanvas` | WebGL2 rendering canvas (fills viewport via CSS) |
| `#inputOverlay` | Slide-up editor panel |
| `#shaderCode` | GLSL code textarea |
| `#shaderSelector` | Built-in shader dropdown |
| `#encodedUrlInput` | Share URL text box |
| `#maxSizeInput` | Resolution cap control (default 720) |
| `#shareBtn` | Top-bar share button |
| `#shareUrlBtn` | Editor share link button |
| `#uploadBtn` / `#shareServerBtn` | Publish buttons |
| `#fileInput` | Hidden `<input type="file">` for local `.glsl` loading |
| `#fetchLoader` | Loading spinner overlay |
| `#hud` / `#toast` | Transient status messages |

### Shader Loading (`shader/*.shader.js`)

Built-in shaders live in `shader/` as standalone `.shader.js` files. Each is an IIFE that registers itself:

```js
(function(w){
  (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []).push({
    path: 'shader/name.shader.js',
    label: 'Display Name',
    code: `GLSL source string`
  });
})(window);
```

At startup, `loadShaderScripts()` in `index.html` dynamically creates `<script>` tags for each file in the `SHADER_JS_FILES` array. `<script>` tags bypass CORS, so the page works when embedded in iframes with `sandbox`. After all scripts load, `BUILTIN_SHADERS` is populated from `window.__SHADER_REGISTRY__`, and the dropdown is filled.

### URL Parameters (`getURLParams()`)

Parsed from both query string and URL hash (hash is manually parsed because `URLSearchParams` decodes `+` to space, corrupting lz-string data):

| Parameter | Source | Purpose |
|---|---|---|
| `mode` | query/hash | `edit` or `preview` |
| `code` | hash | lz-string compressed GLSL (share URL) |
| `id` | hash | Server-stored shader ID (publish URL) |
| `src` | query | Load built-in shader by path |
| `maxSize` | query | Render resolution cap in pixels |

Priority: `code` > `id` > `src` > default shader.

### Share & Publish Flows

- **Local share** (`doShare`): Compresses GLSL with lz-string → `#code=...` in URL hash.
- **File short link** (when `currentSrc` is set): Generates `?mode=preview&maxSize=720&src=path`. `src` is always the last parameter to prevent subsequent params from being parsed as part of the file path.
- **Publish** (`uploadShader`): POSTs code to `/api/shader` → server returns 8-char ID → URL with `#id=...`.
- **Resolution limit** (`maxSizeQuery`): Appends `&maxSize=N` to all shared URLs when value > 0.

The API path is unified: frontend always calls `/api/shader`. On Netlify, `netlify.toml` rewrites `/api/shader` → `/.netlify/functions/shader` internally. On Vercel, `api/shader.js` handles it directly.

### Resolution Limiting (`maxSize`)

An input in the top bar (`#maxSizeInput`, default 720) caps the rendering resolution: `max(canvas.width, canvas.height) <= maxSize`. The canvas CSS remains 100vw×100vh, so the browser upscales the lower-resolution render to fill the page. Values ≤ 0 disable the limit (uses device pixel ratio). When > 0, all share/publish URLs include `&maxSize=N`.

### Rendering Loop

`resize()` sets `canvas.width/height` and `gl.viewport` based on either `maxSizeInput` (if > 0) or `clientWidth * dpr`. `render()` (rAF loop) uploads uniforms (`iResolution`, `iTime`, `iMouse`, etc.) and draws a full-screen triangle. Mouse coordinates are scaled to canvas pixel space.

### Serverless Functions

Both implement `POST` (store) and `GET` (retrieve) with 8-char random IDs:

- **Netlify** (`netlify/functions/shader.js`): Uses `@netlify/blobs` for persistence. Falls back to in-memory `Map` if Blob Storage is unavailable.
- **Vercel** (`api/shader.js`): Uses in-memory `Map` (volatile, restart loses data).

### Project File Layout

```
/
├── index.html                  # Single-page app (all logic)
├── shader/
│   ├── synthwave.shader.js     # Built-in shader IIFE
│   ├── aurora-paint.shader.js  # Built-in shader IIFE
│   └── (add new .shader.js files here)
├── netlify.toml                # Netlify config (publish dir, functions, redirects)
├── vercel.json                 # Vercel config
├── api/shader.js               # Vercel serverless function
├── netlify/functions/shader.js # Netlify serverless function
├── package.json                # Only @netlify/blobs
├── CODEBUDDY.md
└── README.md
```
