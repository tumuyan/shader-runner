# `?js=` 加载外部 shader

`?js=<url>` 让页面从任意一个 http(s) 地址加载 shader，而不必把它放进本仓库。

```
https://your.site/?js=https%3A%2F%2Fcdn.jsdelivr.net%2Fnpm%2Fmy-shader%2Fdist%2Fmy.js
```

目标 JS 只要往 `window.__SHADER_REGISTRY__` 里 push 一条即可（与 `shader/*.shader.js` 同形）：

```js
(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: 'https://cdn.example.com/my.js',
        label: 'My Shader',
        code: `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    fragColor = vec4(1.0);
}
`
    });
})(window);
```

- 协议必须是 `http:` / `https:`（`data:` / `javascript:` / `file:` 会被拒），**不限制主机**。
- URL 里含 `?`、`&` 时必须 `encodeURIComponent`，否则会被当成新的参数分隔符。
- 加载后出现在下拉列表里，标注「（外部）」；分享按钮生成 `?js=` 短链。

## 目标地址必须满足三个响应头

`<script src>` 是 no-cors 请求：**绕得开 CORS，绕不开 CORP**。

| 响应头 | 要求 |
|---|---|
| `Content-Type` | 必须是 JS 类型。`text/plain` + `nosniff` 会被浏览器拒绝执行，**客户端无任何绕法** |
| `Cross-Origin-Resource-Policy` | 不存在，或为 `cross-origin`。`same-origin` 拦下所有跨域嵌入 |
| `Access-Control-Allow-Origin` | 上一条不满足时，可凭 `*` 走 CORS 模式绕过 —— 页面会自动带 `crossorigin` 重试一次 |

### 实测矩阵

页面与资源不同源，四种服务端配置 × 三种加载方式：

| 服务端配置 | 普通 `<script>` | `crossorigin` | `fetch(cors)` |
|---|---|---|---|
| 干净（对照） | **loaded** | error | fail |
| `CORP: same-origin` | error | error | fail |
| `CORP: same-origin` + `ACAO: *` | error | **loaded** | **ok** |
| `text/plain` + `nosniff` | error | error | fail |

两点结论：

- `crossorigin` 能绕过 CORP，但**前提是对方给了 ACAO**。所以页面把它当**失败后的兜底**，不能当默认 —— 对照行可见，没有 ACAO 时它会把原本能成功的加载搞失败。
- MIME 那一栏三种方式全灭，无解。

### 常见源能不能用

| 源 | Content-Type | ACAO | CORP | 可用 |
|---|---|---|---|---|
| jsDelivr / unpkg / esm.sh | `application/javascript` | `*` | `cross-origin` | ✅ |
| GitHub raw | `text/plain` | `*` | `cross-origin` | ❌ MIME |
| CNB raw | `text/plain` | 仅自家文档站 | `same-origin` | ❌ 三头全不满足 |

**源码托管站的 raw 接口基本都不可用** —— 它们普遍把文件当 `text/plain` 返回并加 `nosniff`。要发布单个 shader，把它传到 jsDelivr / unpkg，或用 Pages / 静态托管（那种情况通常与页面同源，直接用 `?src=` 更好）。

快速自查：

```bash
curl -I <url> | grep -i 'content-type\|cross-origin-resource\|access-control-allow-origin'
```

## 失败时怎么看原因

页面只提示「原因见控制台」—— toast 装不下归因。控制台会给出具体判断：

- `diagnoseShaderUrl()` 会补发一次 CORS 模式的 fetch 来二分：fetch 成功 → 只剩 MIME 一种解释；fetch 失败 → 跨域策略问题（也可能叠加 MIME，没有 ACAO 时无从分辨）。
- 它**刻意不 eval** 拿到的文本。那样能救下 GitHub raw 这类「有 ACAO 但 MIME 不对」的源，代价是堆栈退化成匿名帧 —— 而加载失败的排查恰恰最依赖堆栈。

一个固有噪音：CORP+ACAO 场景下，浏览器会为**被拦的那次普通请求**自己打一条红错误，即使最终靠重试成功了也会留一条。无法避免 —— 必须先试一次才知道被拦。
