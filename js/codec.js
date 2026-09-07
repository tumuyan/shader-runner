'use strict';
/**
 * shader 编解码 + 分享/发布链接构建。
 *
 * 依赖：lz-string.js（LZString）、ui.js（三个设置输入框）、state.js（currentSrc / currentJs）、showToast
 * 被依赖：share.js、editor.js、catalog.js
 */

// Base64 解码（向后兼容旧的 ?code= 格式）
function base64Decode(b64) {
    if (!b64) return '';
    try {
        // 检查是否被截断（base64 长度应是 4 的倍数）
        const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
        const padLen = 4 - (normalized.length % 4);
        const padded = padLen < 4 ? normalized + '===='.slice(0, padLen) : normalized;
        const decoded = atob(padded);
        // 尝试 UTF-8 解码
        try { return decodeURIComponent(escape(decoded)); } catch(e) { return decoded; }
    } catch (e) {
        return '';
    }
}

function looksLikeGLSL(text) {
    if (!text || text.length < 10) return false;
    // 检查前 200 字符中可打印 ASCII 比例是否 > 30%
    const checkLen = Math.min(text.length, 200);
    let printable = 0;
    for (let i = 0; i < checkLen; i++) {
        const c = text.charCodeAt(i);
        if (c >= 32 && c <= 126) printable++;
    }
    if (printable < checkLen * 0.3) return false;
    // 检查是否包含 GLSL 关键特征
    return /void\s+mainImage\s*\(/.test(text) || /void\s+main\s*\(/.test(text);
}

// 还原 buildShareUrl 中的自定义编码（_ → +, . → $, ~ → '）
function normalizeHashData(data) {
    return data.replace(/[_.~]/g, c => ({ '_': '+', '.': '$', '~': "'" }[c]));
}

function decodeShader(data) {
    if (!data) return '';

    // 尝试新版: lz-string 压缩（先还原自定义编码）
    try {
        const r = LZString.decompressFromEncodedURIComponent(normalizeHashData(data));
        if (r && looksLikeGLSL(r)) return r;
    } catch (e) { /* 不是 lz 格式，继续尝试 base64 */ }

    // 向后兼容: 旧版 base64
    const b64 = base64Decode(data);
    if (b64 && looksLikeGLSL(b64)) return b64;

    // 数据无效
    if (b64 && b64.length > 10) {
        console.error('⚠ 分享链接中的 Shader 数据已损坏（很可能被 URL 长度限制截断）');
        console.error('   建议: 用 ☁ 发布 上传到服务器生成短链接，或使用新版压缩分享');
        showToast('✗ Shader 数据已损坏，已使用默认 shader');
    }
    return '';
}

function encodeShader(code) {
    if (!code) return '';
    try {
        return LZString.compressToEncodedURIComponent(code);
    } catch (e) {
        console.warn('压缩 shader 失败', e);
        return '';
    }
}

/**
 * 本页自身的地址（不含 query / hash）。所有链接都从这里起步，别再各处各拼一次。
 *
 * file:// 下 location.origin 是**字符串** "null"（不是 null，是四个字母），
 * origin + pathname 会拼出 "null/home/…/index.html" 这种打不开的链接。而这个页面
 * 刻意要能双击直接打开（js/ 不用 ES module 就是为此），所以必须特判。
 */
function pageBase() {
    if (window.location.protocol === 'file:') {
        return window.location.href.split(/[?#]/)[0];
    }
    return window.location.origin + window.location.pathname;
}

// 自定义编码：把 lz-string 字母表里 URL 不友好的三个字符换成安全的，
// 免得整串再走一遍 encodeURIComponent 而膨胀。   + → _    $ → .    ' → ~
function safeEncode(compressed) {
    return compressed.replace(/[+$']/g, c => ({ '+': '_', '$': '.', "'": '~' }[c]));
}

/**
 * 三个「限制类」参数，合成一段返回。
 *
 * 只在用户填了非 0 值时才拼，避免默认链接挂一串 &xxx=0。合成一段（而不是各自返回
 * 一段）是为了让调用方无法只拼其中两个 —— 漏拼一个的链接过去真出现过。
 *
 * 其中 autoPauseMs 与另两个性质不同：它不实时作用于当前页，只经本函数序列化进生成
 * 的链接，由预览模式消费（js/renderer.js 的 isPreview 门控）。
 */
function limitParams() {
    const out = [];
    const add = (name, input) => {
        const v = parseInt(input.value, 10);
        if (v > 0) out.push(name + '=' + v);
    };
    add('maxSize', maxSizeInput);
    add('fpsCap', fpsCapInput);
    add('autoPauseMs', autoPauseInput);
    return out;
}

/**
 * 唯一的链接构建出口：mode / src / js / 三个限制参数 → query，code 或 id → hash。
 *
 * 为什么这么分：code 压缩后动辄几 KB，放 query 会被服务器与 CDN 按 URL 长度截断
 * （hash 根本不发到服务端）；id 跟着进 hash 是为了让两种「从哪取代码」的写法一致。
 * 其余都是页面参数，进 query —— 可读性也是一部分，`?src=shader/x.shader.js`
 * 在地址栏里一眼能认出来。
 *
 * 旧链接不受影响：此前 buildShareUrl / buildServerUrl 把限制参数拼在 `#code=` 之后
 * （等于落进 hash），而解析侧 params.js 本来就是 query + hash 双读，两边都认。
 */
function buildUrl(opts) {
    const q = ['mode=' + encodeURIComponent(opts.mode || 'edit')].concat(limitParams());
    if (opts.src) q.push('src=' + encodeURIComponent(opts.src));
    if (opts.js) q.push('js=' + encodeURIComponent(opts.js));
    let url = pageBase() + '?' + q.join('&');
    if (opts.code) url += '#code=' + opts.code;
    else if (opts.id) url += '#id=' + opts.id;
    return url;
}

function buildShareUrl(mode, code) {
    const compressed = encodeShader(code);
    if (!compressed) return pageBase();
    return buildUrl({ mode: mode, code: safeEncode(compressed) });
}

function buildServerUrl(mode, id) {
    // id 来自服务端响应，缺了就别产链接：否则 share.js 会把一条光杆 ?mode=preview
    // 复制给用户，还报「已发布」—— 比当场报错难查得多。
    if (!id) return pageBase();
    return buildUrl({ mode: mode, id: id });
}

// ?src=（内置文件路径）与 ?js=（外部 JS URL）共用一个参数位：同一时刻只可能有一个
// 来源（state.js 里两者互斥），都为空时就是一条不带来源的普通链接。
function buildSourceUrl() {
    return buildUrl({ mode: 'preview', src: currentSrc, js: currentJs });
}
