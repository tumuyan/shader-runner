# 校验与 CI

## GLSL 运行校验

要回答的是「**这个 shader 能不能在浏览器里真的跑起来**」，而不是「语法看起来对不对」。

```bash
npm run glsl:check                       # manifest 引用的全部（默认）
npm run draft:check                      # 只校验 drafts/*.glsl
npm run glsl:check -- --all              # shader/ 下全部，含未被 manifest 引用的
npm run glsl:check -- rain aurora        # 指定若干，短名 / 路径都行
npm run glsl:check -- --backend glslang  # 指定后端
```

| 后端 | 做法 | 结论强度 |
|---|---|---|
| `browser`（默认） | 真实 WebGL2 上下文里编译 + 链接 + 渲染多帧 | **权威** |
| `glslang` | 静态编译 + 链接校验 | 参考 |

**以浏览器为准。** glslang 与浏览器的 ANGLE 是两个独立实现，对规范的解读并不一致 —— 仓库里的
`70s-melt-color` 在浏览器里跑得好好的，glslang 却判它失败。

因此：

- 校验失败时**先怀疑工具，而不是 shader**。在真实浏览器里验证过再提修改，不要为了让校验器变绿去改正确的 shader。
- 画面偏暗 / 全黑只提示、不判失败。渐入型 shader 开头几秒本来就接近全黑，判失败会误伤。
- glslang 报的已知分歧同样只是警告，降级前会剔除该写法再编译一次，确认没别的问题才放行。
- GLSL 包装器有两份：`js/renderer.js`（运行时）与 `scripts/lib/glsl-wrap.js`（校验器），每次运行 sha1 比对，不一致就中止 —— 包装器漂移会让「通过」变成谎言。改一处就要同步另一处。模板字符串里的缩进属于 GLSL 文本，别顺手整理对齐。

浏览器后端依赖 `playwright`：

```bash
npm i -D playwright && npx playwright install chromium
# 容器里通常还缺系统库：npx playwright install-deps chromium
```

两个后端都没装时**跳过并退出 0**（它们是 devDependency，不该让没装的人红）。CI 里 `CI=true` 或
`--require` 会把「跳过」也判为失败，且**不允许静默降级到弱后端** —— 浏览器不可用时宁可红，逼人修
环境，而不是用弱结论假装绿。确实要放行就显式加 `--allow-fallback`。

## CI

```bash
npm run ci:setup                 # 装 npm 依赖 + Chromium + 系统库，最后跑环境自检
npm run ci:setup -- --no-npm     # 依赖已由 actions/setup-node 装好时
npm run ci:setup -- --no-deps    # 镜像已预装系统库时
npm run ci:setup -- --no-verify  # 只装不验
```

幂等，可重复执行。最后一步必跑 `--self-test`：**装完不等于能跑** —— 缺系统库时 Chromium 装得上但
启动即崩。自检正反都验（一个正确的 shader 必须通过，三个有问题的必须被抓到），避免「什么都返回
通过」的后端蒙混过关。

仓库已带 `.github/workflows/check.yml`（push/PR 触发），含 Playwright 浏览器缓存。

## 服务端写入防护校验

```bash
npm run api:check
```

验 `shared/shader-api.js` 的逻辑（体积 / ID / 存储内容校验、限流、ID 生成、内存配额），
并**真的调用两个 handler**（`api/shader.js` 与 `netlify/functions/shader.js`）打一遍：
超体积 → 400/413、连发第 21 次 → 429 且带 `Retry-After`、`../secret` 当 id → 400、坏数据 → 500。

只测纯函数是不够的 —— 防护写得再对，接线时漏掉一次调用就等于没有（忘了调 `validateCode`、
限流器建了没用）。所以断言打在 handler 的输出上。

Vercel 侧是 ESM（`api/shader.js` 用 `export default`），而 `package.json` 没有 `"type":"module"`，
Node 会把它当 CJS 解析。校验脚本把入口连同 `shared/` 一起复制到临时目录、改名为 `.mjs` 再
`import()` —— 顺便验证了「入口到共享模块的相对路径没写错」和「ESM 能默认导入 CJS」。

**这验不到打包环节。** 两个平台都会把相对依赖打进产物（Vercel 用 esbuild/ncc，
Netlify 用 zip-it-and-ship-it），这一步只有真机部署能证：`ntl dev` / `vercel dev` 各点一次「发布」。

## 总校验

```bash
npm run check
```

是 `add:check` 的超集，按顺序验五件事：

1. `manifest.js` 与 `shader/` 目录内容一致，且是新格式
2. 每个产物的 `path` / `label` 字段正确，且与 manifest 记录一致
3. 草稿与产物同步（见 [shader-workflow.md](shader-workflow.md)）
4. 服务端写入防护（`npm run api:check`，见下）
5. GLSL 运行校验（上面这一关）

任一项失败退出码 1。旧的 `npm run shaders:check` 保留为别名。

### 为什么「旧格式清单」要判失败

清单曾经是纯路径数组，那时页面全量加载，label 从产物里取。改成按需加载后，label 必须
写进清单 —— 启动时只有清单，产物还没下载。

旧格式的清单在运行时**仍然能读**（`normalizeManifest()` 兜底成文件名 Title Case），但
label 会退化：`Auroras` 显示成 `Aurora`。更麻烦的是校验侧：旧格式的 label 是拿产物现算
的，拿它跟产物比必然相等，于是「清单没刷新」这件事永远查不出来 —— CI 全绿，页面显示旧名字。

所以 `--check` 遇到旧格式直接判失败，要求跑一次 `npm run add:refresh`。
