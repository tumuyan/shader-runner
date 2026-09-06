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
- **预览模式** — 全屏渲染，无控件干扰（只有点击屏幕底部暂停/继续）
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
| `autoPauseMs` | 仅预览模式：链接打开后按毫秒自动暂停，手动暂停后失效 | `?autoPauseMs=3000` |

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
| **任意静态托管**（GitHub Pages / Cloudflare Pages 等） | 上传 `index.html`、`css/`、`js/` 与 `shader/` 即可。没有 `/api/shader`，启动时探测不到接口会自动把「发布」按钮置灰并说明原因；「分享」不受影响 |

**发布接口探测**：启动时发一次 `GET /api/shader`（不带 `id`，两个后端都返回 400 + JSON，零副作用），
响应是 JSON 才认为后端存在 —— 只看状态码会被带 SPA fallback 的托管骗过（未知路径被重写成 `index.html` 返回 200 HTML）。

### 服务端的写入限制

两个后端共用 `shared/shader-api.js`，规则一致：

| 项 | 值 | 说明 |
|---|---|---|
| 单份 code | 512 KB（UTF-8 字节） | 真实 shader 一般几 KB ~ 几十 KB；按字节计量，中文注释不会「偷渡」 |
| ID / 存储键 | `sha256(code)` 的 base62 前 8 位 | **内容寻址**：同一份代码复用同一个 ID，重复提交不占第二份存储 |
| 请求体 | ~1 MB | Netlify 侧在 `JSON.parse` **之前**按体积拒（413）；Vercel 的 body 由平台预解析，由 code 校验兜住（400） |
| 写入频率 | 20 次 / 10 分钟 / IP | 超了返回 429 + `Retry-After`，前端自动改用本地分享 |
| 读取频率 | 1200 次 / 10 分钟 / IP | 只挡爬取，正常浏览与分享不受影响 |
| ID | 8 位，`crypto` 生成 | 不用 `Math.random`（可预测＝可枚举）；写入前重试避让碰撞 |
| 存储条目 | 5000（内存存储） | 满了返回 503，而不是让函数 OOM |
| 存储字节 | 64 MB（内存存储） | 只按条数算不够：5000 × 512 KB = 2.44 GiB，远超函数内存，会先 OOM 再谈 503 |
| 记录体积 | 1 MB（序列化后） | **写入与读取量的是同一个字节数**。量法不一致会出现「存得进去、读不出来」的记录 |

读取侧同样不信任存储：ID 先过 `^[A-Za-z0-9]{1,8}$`（挡路径穿越），内容再过 JSON + 字段 + 体积校验，
坏数据报 500「存储内容已损坏」，而不是把脏数据当 shader 反射给前端。

### 编译验证：为什么放在浏览器侧

写入前要求 shader 真的能编译，这件事**只能由浏览器做**，分两层：

| 层 | 手段 | 拦什么 |
|---|---|---|
| 浏览器（发布前） | 本机 WebGL2/ANGLE 编译 + 链接成功（`lastCompiledCode`） | 语法错、未定义标识符、链接失败 —— 零误判 |
| 服务端（写入前） | `validateGlslShape()`：只在「必定编译不过」时拒 | 非 GLSL 载荷、与包装器抢名字/抢指令的写法 |

**服务端不做真编译，原因有两条，第二条是决定性的：**

1. Serverless 没有 GPU，跑不了 WebGL2。硬塞 Playwright + Chromium 进函数包是几百 MB、冷启动数秒、
   且只有 SwiftShader 软件渲染 —— 不能放在请求路径上。
2. 唯一可行的 glslangValidator 二进制（6.7 MB）**会误杀合法 shader**。仓库自带的 `70s-melt-color`
   在真实 WebGL2/ANGLE 下编译 + 链接 + 渲染全部通过，glslang 却判它失败（`'mediump'` 重载精度）。
   `scripts/lib/glsl-backend-glslang.js` 里的 `BROWSER_DIVERGENT` 就是为此存在的，而那张表是
   **实测攒出来的、必然不完整** —— 每一条都对应一次「某个 shader 被错杀」。拿它当写入门槛，
   等于把尚未发现的分歧全部变成「用户无法发布且无处申诉」。CI 里误报很便宜（维护者看一眼，
   浏览器里验证，加一条）；用户侧误报很贵（他只会觉得这个站坏了）。

所以服务端的形态校验**只收「无论哪个实现都必定失败」的特征**：缺 `mainImage`、自带 `#version`、
重复定义 `void main()`、含 `script` 标签。判定前会先剥掉注释，避免注释里写一句 `void main()` 就被误杀。

需要说清楚：浏览器那道是**体验护栏，不是安全控制** —— 直接 POST 一下就绕过去了。服务端形态校验
才是兜底。两边各管各的，都不能省。

**这些限制是减速带，不是墙。** Serverless 每个实例独立计数、跨实例不共享，真正生效的上限约等于
「阈值 × 同时存活的实例数」；Vercel 侧 IP 取自 `x-forwarded-for`，理论上可伪造。要真正拦 Abuse，
请在平台层配（Vercel Firewall / Netlify 自带限速）。详见 [docs/checking.md](docs/checking.md)。

### 为什么存储键用内容哈希

内容寻址真正的价值不是省空间，而是**改变存储耗尽攻击的成本模型**：

| 攻击 | 现状（随机 ID） | 内容寻址后 |
|---|---|---|
| 10000 个 IP 各发同一份 512 KB | 存 10000 份 = 4.9 GB | **存 1 份** |
| 10000 个 IP 各发不同 512 KB | 存 4.9 GB | 存 4.9 GB，但攻击者得真上传 5 GB |

洪水从「按请求数计费」变成「按不同内容的字节数计费」。这是把 O(便宜) 的攻击改成 O(昂贵)，
比任何配额都有效 —— 所以字节预算仍然保留，两者正交：内容寻址让攻击变贵，字节预算让它有界。

两个必须小心的地方：

- **8 位键只取了哈希的低 47.5 bit**，5000 条时碰撞概率约 6e-8。随机 ID 碰撞能被检出并重试，
  内容哈希碰撞却会被误判成「同一份内容」—— 用户会拿到播放错误 shader 的链接。所以每次写入
  都要**取出内容比对**：相同才去重，不同则判定碰撞、退回随机 ID（`assignId()` 已处理）。
- **ID 由内容派生后，未授权读取反而更难**：攻击者要猜的是完整 shader 源码，熵远高于 47.5 bit。
  代价是多了一个「确认某份已知内容是否存在」的 oracle —— 考虑到 ID 本来就是为了分享出去的，
  这个代价可忽略。

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
│   ├── share.js            # 分享（压进 URL）与发布（上传换短链 + 接口探测）
│   ├── editor.js           # 编辑器按键（Ctrl+Enter / Tab）与链接解码
│   └── app.js              # 启动编排 + 全局监听
├── drafts/                 # 开发中的 GLSL（不提交，且勿写进 .gitignore）
│   └── _temple.glsl        # 模板（_ 开头，不参与扫描）
├── shader/                 # 产物 + 清单（自动生成，提交）
├── scripts/                # 加入 / 移除 / 导出 / 清单 / 校验工具（Node 侧，零运行时依赖）
├── docs/                   # 分主题文档
├── shared/shader-api.js    # 服务端写入防护：体积 / ID / 限流 / 配额（两个后端共用）
├── api/shader.js           # Vercel Function
└── netlify/functions/shader.js  # Netlify Function
```

技术栈：WebGL2 + lz-string，纯 HTML/CSS/JS 无外部依赖；服务端发布可选 Netlify Blob / Vercel Functions。

`js/` 里的脚本是有意不用 ES module 的：`file://` 下模块请求会被 CORS 拦掉，而这个页面必须能双击直接打开。
代价是没有 import/export，模块之间靠**加载顺序 + 共享全局词法作用域**通信 —— 所以顺序即依赖顺序
（`index.html` 底部的 `<script>` 列表就是依赖图，不要随意调换），跨模块共享的状态统一放在 `js/state.js`、
常量放在 `js/config.js`。每个文件顶部都写明了「依赖 / 被依赖」。
