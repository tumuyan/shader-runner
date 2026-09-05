# Shader Runner

一个纯前端的 GLSL 着色器运行器，支持编辑、预览、分享与服务端发布。

- **可静态托管** — 不依赖 Node / Python / Java / PHP 等运行环境
- **单文件特效** — 一个特效有且只有一个文件，便于 AI 辅助开发与复制分享
- **可移植性强** — 大量（并非全部）ShaderToy shader 可直接复制进来用；本环境能跑的 shader 100% 能放回 ShaderToy

![截图](img/screenshot.jpg)

## 快速开始

浏览器直接打开即可；走 HTTP 能解锁全部功能（`file://` 属于非安全上下文，剪贴板 API 不可用，分享按钮会静默失败）。

```bash
open index.html    # 直接打开
npx serve .        # 或走 HTTP
```

## 功能

- **编辑模式** — 粘贴 ShaderToy 的 `mainImage` GLSL 代码，实时编译运行
- **预览模式** — 全屏渲染，无 UI 干扰
- **内置 shader 选择器** — 下拉切换，即时生效（按需加载，首屏不下载任何 shader）
- **本地文件打开** — 直接加载 `.glsl` / `.frag` 等文件
- **本地压缩分享** — lz-string 把代码压进 URL hash，无需服务器存储
- **短链接分享** — 内置 shader 生成 `?src=`，外部 JS 生成 `?js=`
- **服务端发布** — Netlify Blob 存储，URL 只含 8 位短 ID
- **性能控制** — 帧率上限、分辨率上限（自动缩放填满）、页面不可见自动暂停、实时显示分辨率与帧率

## URL 参数

| 参数 | 说明 | 示例 |
|---|---|---|
| `mode` | 页面模式: `edit`（默认）或 `preview` | `?mode=preview` |
| `code` | lz-string 压缩的 shader（放在 hash 中） | `#code=L8RjIMoz...` |
| `id` | 服务端存储的 shader ID | `#id=Ab3xK9mQ` |
| `src` | 内置 shader 文件路径 | `?src=shader/synthwave.shader.js` |
| `js` | 外部 JS 里的 shader | `?js=https%3A%2F%2Fcdn.example.com%2Fmy.js` |
| `maxSize` | 渲染分辨率最大边长（px），0=不限 | `?maxSize=720` |
| `fpsCap` | 帧率上限，0=不限 | `?fpsCap=30` |
| `autoPauseMs` | 仅预览模式：加载后按毫秒自动暂停 | `?autoPauseMs=3000` |

优先级：`code` > `id` > `src` > `js` > 默认 shader。

`?js=` 能指向任意 http(s) 地址，但目标服务器必须满足三个响应头（源码托管站的 raw 接口基本都不满足）—— 详见 [docs/external-js.md](docs/external-js.md)。

## 用 AI 开发 shader

1. 选模型。个人经验：gemini > qwen >> glm ≈ DeepSeek > hy
2. 新建 `.glsl`，提示词：「参考附图，写一个能直接在 shadertoy 上运行的 shader，远景是……」
3. 调试。把 GLSL 粘进页面文本框运行；报错就复制控制台信息给 AI，外观不对就描述或截图
4. 发布。`npm run add xxx` 生成产物并刷新清单

```bash
cp drafts/_temple.glsl drafts/xxx.glsl   # 建草稿
npm run add xxx                          # 加入内置：生成产物 + 刷新清单
git add shader/ && git commit            # 只提交产物，drafts/ 留在本机
```

完整的命令、状态机与注意事项见 [docs/shader-workflow.md](docs/shader-workflow.md)。

## 校验

`npm run check` 是总校验：清单同步 + 字段检查 + 草稿同步 + **GLSL 运行校验**（真实 WebGL2 上下文里编译、
链接、渲染多帧，而不是只做静态语法检查）。细节与 CI 配置见 [docs/checking.md](docs/checking.md)。

## 部署

| 平台 | 说明 |
|---|---|
| **Netlify** | push 即部署，自动配置 Serverless Function 与 Blob Storage，支持「发布」。本地测试：`npm install && ntl dev` |
| **Vercel** | 支持「发布」，存储默认在内存（重启丢失），可换 Vercel KV / Blob |
| **任意静态托管**（GitHub Pages / cnb.run / Cloudflare Pages） | 上传 `index.html`、`css/`、`js/` 与 `shader/` 即可，但不支持「发布」 |

## ShaderToy Uniforms

| 变量 | 类型 | 说明 |
|---|---|---|
| `iResolution` | `vec3` | 画布分辨率 (xy)，z 恒为 1 |
| `iTime` | `float` | 运行时间（秒） |
| `iTimeDelta` | `float` | 帧间隔 |
| `iFrame` | `float` | 帧编号 |
| `iMouse` | `vec4` | 鼠标 (xy=当前, zw=按下；未交互时为负) |
| `iDate` | `vec4` | 年/月/日/秒比例 |
| `iSampleRate` | `float` | 采样率 = 44100 |
| `iChannel0~3` | `sampler2D` | 纹理通道（默认白色） |

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = vec4(1.0);
}
```

另提供 `texture2D()` 兼容别名，可直接粘贴 ShaderToy 代码。

## 项目结构

```
/
├── index.html              # 页面骨架：只放 DOM 与按顺序引入的 <script>/<link>
├── css/app.css             # 全部样式
├── js/                     # 浏览器运行时（普通 <script>，非 ES module）
│   ├── vendor/lz-string.js # 第三方库，原样搬运，禁止改动
│   ├── config.js           # 常量（默认 shader、默认值、接口路径、缩进）
│   ├── state.js            # 跨模块共享的可变状态
│   ├── params.js           # URL 参数（query + hash）
│   ├── ui.js               # DOM 引用 + toast + 剪贴板 + 面板开合
│   ├── codec.js            # lz 编解码 + 分享/发布链接构建
│   ├── renderer.js         # WebGL2：编译 / program / 资源 / 渲染循环 / 鼠标 / 暂停
│   ├── catalog.js          # 内置清单、?js= 外部源、本地文件、应用 shader
│   ├── share.js            # 分享（压进 URL）与发布（上传换短链）
│   ├── editor.js           # 编辑器按键（Ctrl+Enter / Tab）与链接解码
│   └── app.js              # 启动编排 + 全局监听
├── drafts/                 # 开发中的 GLSL（不提交，且勿写进 .gitignore）
│   └── _temple.glsl        # 模板（_ 开头，不参与扫描）
├── shader/                 # 产物 + 清单（自动生成，提交）
├── scripts/                # 加入 / 移除 / 导出 / 清单 / 校验工具（Node 侧，零运行时依赖）
├── docs/                   # 分主题文档
├── api/shader.js           # Vercel Function
└── netlify/functions/shader.js  # Netlify Function
```

技术栈：WebGL2 + lz-string，纯 HTML/CSS/JS 无外部依赖；服务端发布可选 Netlify Blob / Vercel Functions。

`js/` 里的脚本是有意不用 ES module 的：`file://` 下模块请求会被 CORS 拦掉，而这个页面必须能双击直接打开。
代价是没有 import/export，模块之间靠**加载顺序 + 共享全局词法作用域**通信 —— 所以顺序即依赖顺序
（`index.html` 底部的 `<script>` 列表就是依赖图，不要随意调换），跨模块共享的状态统一放在 `js/state.js`、
常量放在 `js/config.js`。每个文件顶部都写明了「依赖 / 被依赖」。
