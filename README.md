# Shader Runner

一个纯前端的 GLSL 着色器本地运行器，支持编辑、预览、分享和服务器发布。

## 功能

- **编辑模式** — 粘贴 ShaderToy 的 `mainImage` GLSL 代码，实时编译运行
- **预览模式** — 全屏渲染，无任何 UI 干扰，通过 URL 参数控制
- **内置 shader 文件选择器** — 下拉列表切换内置 shader，切换即时生效
- **本地文件打开** — 从本地选择 `.glsl` / `.frag` 文件直接加载
- **本地压缩分享** — lz-string 压缩 shader 代码到 URL hash 中，无需服务器存储；来自内置文件的分享自动生成 `?src=` 短链接
- **服务端发布** — 使用 Netlify Blob Storage 存储，URL 只含 8 位短 ID
- **解码测试** — 将分享的 URL 或编码数据还原回编辑框
- **自动暂停** — 页面不可见时自动暂停，恢复后继续

## 快速开始

直接将 `shader.html`（或 `index.html`）拖到浏览器中打开即可使用，无需任何构建步骤。

```
# 本地打开
open shader.html

# 或通过 HTTP 服务
npx serve .
```

## URL 参数

| 参数 | 说明 | 示例 |
|---|---|---|
| `mode` | 页面模式：`edit`（默认）或 `preview` | `?mode=preview` |
| `code` | lz-string 压缩的 shader 代码（放在 hash 中） | `#code=L8RjIMoz...` |
| `id` | 服务端存储的 shader ID | `#id=Ab3xK9mQ` |
| `src` | 加载内置 shader 文件路径（如 `shader/xxx.glsl.css`） | `?src=shader/shader.glsl.css` |

### 生成分享链接

```
https://your-site.com/shader.html?mode=preview#code=L8RjIMoz...
https://your-site.com/shader.html?mode=edit#code=L8RjIMoz...
https://your-site.com/shader.html?mode=preview&src=shader/shader.glsl.css
```

## 部署

### 方式一：Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start)

```
git push  # 或手动上传项目到 Netlify
```

项目包含 `netlify/functions/shader.js`，Netlify 会自动部署 Serverless Function 和 Blob Storage，支持「发布」功能。

本地测试：

```bash
npm install
ntl dev
```

### 方式二：Vercel

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new)

支持「发布」功能。存储默认使用内存（重启后丢失），如需持久化可换用 [Vercel KV](https://vercel.com/docs/storage/vercel-kv) 或 [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)。

### 方式三：任意静态托管（GitHub Pages / cnb.run / Cloudflare Pages 等）

直接上传 `index.html` 即可。注意：此方式不支持「发布」功能（需要 Serverless 函数）。

## 项目结构

```
/
├── index.html                       # 主页面（含所有逻辑）
├── shader/
│   └── *.glsl.css              # 内置 shader 示例
├── README.md                        # 文档
├── vercel.json                      # Vercel 部署配置
├── api/
│   └── shader.js                    # Vercel Serverless Function
├── netlify.toml                     # Netlify 部署配置
├── package.json                     # 依赖声明（Netlify）
└── netlify/
    └── functions/
        └── shader.js                # Netlify Function
```

## 工作原理

### 分享流程

```
用户粘贴 GLSL 代码
        │
        ▼
   编辑模式 → 点击「分享链接」
        │
        ├──→ lz-string 压缩 → encodeURIComponent → #code=...
        │    （纯前端，数据在 URL 中，离线可用）
        │
        └──→ 点击「发布」
             └──→ POST /.netlify/functions/shader
                  └──→ Netlify Blob Storage
                       └──→ 返回 8 位短 ID → #id=...
```

### 解码流程

```
用户粘贴 URL 或编码数据到 URL 文本框
        │
        ▼
   点击「解码」按钮
        │
        ├──→ 从 URL 提取 hash 中的 code/id 参数
        ├──→ decodeURIComponent → lz-string 解压
        └──→ 还原到编辑框并自动编译运行
```

## 预设的 ShaderToy Uniforms

你的 shader 代码可以直接使用以下变量：

| 变量 | 类型 | 说明 |
|---|---|---|
| `iResolution` | `vec3` | 画布分辨率 (xy) |
| `iTime` | `float` | 运行时间（秒） |
| `iTimeDelta` | `float` | 帧间隔时间 |
| `iFrame` | `float` | 当前帧编号 |
| `iMouse` | `vec4` | 鼠标位置 (xy=当前位置, zw=按下位置) |
| `iDate` | `vec4` | 年/月/日/秒比例 |
| `iSampleRate` | `float` | 采样率 = 44100 |
| `iChannel0~3` | `sampler2D` | 纹理通道（默认白色纹理） |

函数签名须符合 ShaderToy 标准：

```glsl
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // 你的着色器代码
    fragColor = vec4(1.0);
}
```

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `E` | 打开/关闭编辑器 |
| `Space` | 暂停/恢复 |
| `Ctrl+Enter` | 编译并应用 shader |
| `Esc` | 关闭帮助/编辑器 |

## 技术栈

- **WebGL2** — 硬件加速渲染
- **lz-string** — 浏览器端 LZ 压缩，3~5x 压缩率
- **Netlify Blob Storage** — 服务端键值存储（可选）
- 纯 HTML/CSS/JS，无外部依赖
