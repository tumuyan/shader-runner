'use strict';
/**
 * 分享（压缩进 URL）与发布（上传服务器换短链）。
 *
 * 依赖：config.js（API_PATH / API_PROBE_TIMEOUT_MS）、state.js（currentSrc / currentJs / apiAvailable）、ui.js、codec.js
 * 被依赖：catalog.js（syncUrlInput）、editor.js（解码后会同步输入框）
 */

// 把当前状态写成可复制的链接，同步到编辑器里的 URL 输入框
function syncUrlInput() {
    const code = textarea.value.trim();
    if (!code || code === DEFAULT_SHADER.trim()) {
        encodedUrlInput.value = '';
        return;
    }
    // 如果当前 shader 来自内置文件或外部 JS，生成 ?src= / ?js= 短链接
    if (currentSrc || currentJs) {
        encodedUrlInput.value = buildSourceUrl();
        return;
    }
    const url = buildShareUrl('preview', code) + maxSizeQuery() + fpsCapQuery() + autoPauseQuery();
    encodedUrlInput.value = url;
}

// ---- 分享：压缩到 URL hash ----
function doShare(mode) {
    // 与 syncUrlInput() 一样用 trim 后的值：否则首尾有空白时，「复制走的链接」
    // 和「框里显示的链接」不是同一份代码。
    const url = buildShareUrl(mode, textarea.value.trim()) + maxSizeQuery() + fpsCapQuery() + autoPauseQuery();
    return copyText(url, '✓ ' + (mode==='preview'?'预览':'编辑') + ' 链接已复制');
}

// 本地分享（不依赖服务器）：有内置/外部来源时分享 ?src= / ?js= 短链，否则把整份代码压进 URL。
// 也是「发布」不可用时的兜底路径 —— 与点「分享」完全同一份行为，别让用户拿到两种结果。
function localShare() {
    if (currentSrc || currentJs) {
        return copyText(buildSourceUrl(), '✓ 来源链接已复制');
    }
    return doShare('preview');
}

shareBtn.addEventListener('click', localShare);

shareUrlBtn.addEventListener('click', () => {
    syncUrlInput();
    if (currentSrc || currentJs) {
        copyText(buildSourceUrl(), '✓ 来源链接已复制');
    } else {
        doShare('edit');
    }
});

// ---- 发布可用性探测 ----
// 静态托管（GitHub Pages / cnb.run / Cloudflare Pages）根本没有 /api/shader，点「发布」
// 必然掉进 uploadShader 的 catch 再 fallback 到本地分享 —— 用户点了才知道，还说不清原因。
// 所以启动时探测一次，不可用就把两个「发布」按钮置灰并写明原因。
//
// 探测用 GET /api/shader（不带 id）：两个后端都对缺 id 返回 400 + JSON，零副作用、
// 不碰存储。URL 不带查询串，正好命中 netlify.toml 里 /api/shader 的精确重写规则。
//
// 判定必须状态码 + 响应体两边都看，只看一边都会判错：
//   - 只看状态码：SPA fallback 把未知路径重写成 index.html 回 200 HTML，误判为有后端。
//   - 只看「是不是 JSON」：网关（实测 cnb.run 开发域）对未知路径回 404 + JSON，同样误判。
// 真后端对这个探测（GET 不带 id）一律 400 + {error}，故 404 = 没人接这条路由。
async function probeApiAvailability() {
    if (location.protocol === 'file:') {
        return { ok: false, reason: '本地文件打开（file://），没有发布接口' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(API_PATH, {
            method: 'GET',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' },
            signal: ctrl.signal,
        });
        const text = await res.text();
        const isHtml = /^<(?:!doctype|html)/i.test(text.trim());
        if (res.status === 404) {
            return {
                ok: false,
                reason: isHtml
                    ? '当前站点是静态托管，未部署 /api/shader 发布接口'
                    : '当前站点未部署 /api/shader 发布接口（探测请求返回 404）',
            };
        }
        let payload = null;
        try { payload = JSON.parse(text); } catch (e) { /* 不是 JSON */ }
        if (payload && typeof payload === 'object') return { ok: true };
        return {
            ok: false,
            reason: isHtml
                ? '当前站点是静态托管，未部署 /api/shader 发布接口'
                : '发布接口返回了非 JSON 响应（HTTP ' + res.status + '）',
        };
    } catch (err) {
        if (err && err.name === 'AbortError') {
            return { ok: false, reason: '发布接口探测超时（' + API_PROBE_TIMEOUT_MS + 'ms 无响应）' };
        }
        return { ok: false, reason: '无法连接发布接口（' + ((err && err.message) || err) + '）' };
    } finally {
        clearTimeout(timer);
    }
}

// 探测只发一次：启动探测、按钮点击、?id= 分支可能同时想要结论，共用同一个 promise。
let apiProbePromise = null;
function ensureApiProbe() {
    if (!apiProbePromise) apiProbePromise = refreshPublishAvailability();
    return apiProbePromise;
}

async function refreshPublishAvailability() {
    const r = await probeApiAvailability();
    apiAvailable = r.ok;
    apiUnavailableReason = r.ok ? '' : r.reason;
    applyPublishAvailability();
    console.log(r.ok ? '☁ 发布接口：可用' : '☁ 发布接口：不可用 —— ' + apiUnavailableReason);
    return r.ok;
}

// 置灰用 aria-disabled + class，而不是 disabled 属性：disabled 的按钮既不派发 click
// 也不显示 title，点下去「毫无反应」—— 那正是要治的病。保持可点，点了讲清原因。
function applyPublishAvailability() {
    const off = apiAvailable === false;
    for (const btn of [uploadBtn, shareServerBtn]) {
        btn.classList.toggle('is-disabled', off);
        if (off) {
            btn.setAttribute('aria-disabled', 'true');
            btn.title = '☁ 发布不可用：' + apiUnavailableReason + '。请改用「分享」（代码压缩进 URL，无需服务器）';
        } else {
            btn.removeAttribute('aria-disabled');
            btn.title = '上传代码至服务器，生成固定短链接';
        }
    }
}

// 两个「发布」按钮共用：探测没回来就等它（不发第二次请求），不可用只提示，可用才上传
async function requestPublish() {
    if (apiAvailable === null) await ensureApiProbe();
    if (apiAvailable === false) {
        showToast('☁ 发布不可用：' + apiUnavailableReason + '；已改用「分享」');
        localShare();
        return;
    }
    uploadShader(textarea.value);
}

/**
 * 发布前要求「这份代码在本机真的编译 + 链接成功过」。
 *
 * 用的是浏览器自己的 ANGLE —— 也就是最终渲染它的那个编译器，所以零误判。没有任何
 * 第二个 GLSL 实现能做到这点：服务端跑不了 WebGL2，glslang 又会误杀合法 shader
 * （仓库自带的 70s-melt-color 在 ANGLE 下编译链接全过，glslang 却判它失败）。
 *
 * 明确地说：这是**体验护栏，不是安全控制** —— 直接 POST 一下就绕过去了。所以服务端
 * 还有一道形态校验（validateGlslShape）兜底，两边各管各的，都不能省。
 */
function compiledLocally(code) {
    return lastCompiledCode.trim() === code.trim();
}

// 按 UTF-8 字节计量：GLSL 注释里可能有中文，String.length 会严重低估
function codeByteLength(text) {
    try {
        return new TextEncoder().encode(text).length;
    } catch (err) {
        return unescape(encodeURIComponent(text)).length;   // 老浏览器兜底，同样按字节
    }
}

// 发请求前的体积预检。服务端有同样的上限（见 shared/shader-api.js），这里是省掉一次
// 注定被拒的上传，并把「多大 / 上限多少」讲清楚 —— 传完几百 KB 才收到一句 400 太晚。
function tooBigToUpload(code) {
    const bytes = codeByteLength(code);
    if (bytes <= MAX_UPLOAD_BYTES) return false;
    // 用精确字节：超一点点时两边四舍五入成同一个「512 KB」，看着像 bug
    showToast('☁ 代码 ' + bytes + ' 字节，超过发布上限 ' + MAX_UPLOAD_BYTES + ' 字节，已改用「分享」');
    return true;
}

// ---- 发布：上传到服务器换固定短链 ----
// 统一 API 路径（Netlify 通过重写规则映射到 /.netlify/functions/shader）

// 两个「发布」入口（顶栏 / 编辑器）是同一个动作，反馈要两侧同步：只改 uploadBtn 的话，
// 从顶栏点发布改的是此刻看不见的那个按钮。一并置灰还挡住重入 —— 限流按次计数
// （10 分钟 20 次），重复点击会把自己额度点完。
let publishPending = false;
// 空闲文案快照：上传中会改写 textContent，恢复时还原（两个按钮都叫「发布」是巧合）
const publishIdleLabel = new Map([uploadBtn, shareServerBtn].map(b => [b, b.textContent]));
function setPublishBusy(busy) {
    publishPending = busy;
    for (const btn of [uploadBtn, shareServerBtn]) {
        if (busy) {
            // 与「发布不可用」同用 aria-disabled + .is-disabled：disabled 属性既不派发
            // click 也不显示 title。重入由 publishPending 挡，不靠 disabled。
            btn.classList.add('is-disabled');
            btn.setAttribute('aria-disabled', 'true');
            btn.textContent = '上传中...';
        } else {
            btn.textContent = publishIdleLabel.get(btn);
        }
    }
    if (!busy) applyPublishAvailability();   // 别把「发布不可用」状态一并抹掉
}

async function uploadShader(rawCode) {
    if (publishPending) return;   // 上一个请求还没回来，忽略重复点击
    // 与分享路径统一用 trim 后的值：否则「发布上去的代码」和「分享出去的代码」不是一份，
    // 而内容寻址会让它们拿到不同的 ID。
    const code = rawCode.trim();
    if (tooBigToUpload(code)) {
        localShare();
        return;
    }
    if (!compiledLocally(code)) {
        showToast('☁ 代码未通过本地编译，请先「应用」确认能正常运行再发布');
        return;
    }
    setPublishBusy(true);
    try {
        const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code }),
        });
        const bodyText = await res.text();
        if (!res.ok) {
            let detail = '';
            try { const e = JSON.parse(bodyText); detail = e.error || ''; } catch (e2) {}
            const err = new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
            err.status = res.status;   // 429 / 413 值得单独措辞，见下面 catch
            throw err;
        }
        const data = JSON.parse(bodyText);
        const url = buildServerUrl('preview', data.id);
        // 服务端已发布成功，复制失败绝不能报成「发布失败」
        const copied = await copyTextAsync(url);
        if (copied) {
            showToast('已发布，预览链接已复制');
        } else {
            encodedUrlInput.value = url;   // 兜底：让用户能手动复制
            showToast('已发布，但复制失败；链接已填入编辑器输入框，请手动复制');
        }
    } catch (err) {
        console.error('发布失败:', err);
        // 429（限流）/ 413（超体积）是服务端有意拒绝，措辞别混进「发布失败」里 ——
        // 前者等一会儿能成，后者这份代码永远发不出去，用户该知道是哪一种。
        const prefix = err.status === 429 ? '☁ 发布被限流'
                     : err.status === 413 ? '☁ 代码超体积'
                     : '☁ 发布失败';
        showToast(prefix + ' (' + err.message + ')，已改用本地分享（URL 会较长）');
        localShare();
    } finally {
        setPublishBusy(false);
    }
}
uploadBtn.addEventListener('click', requestPublish);
shareServerBtn.addEventListener('click', requestPublish);
