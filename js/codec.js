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

function buildShareUrl(mode, code) {
    const base = window.location.origin + window.location.pathname;
    const compressed = encodeShader(code);
    if (!compressed) return base;
    // 自定义编码：用不在 lz-string 字母表 ([A-Za-z0-9+-$']) 中的字符替换 +=$'，避免 encodeURIComponent 膨胀
    //   + → _    $ → .    ' → ~
    const safe = compressed.replace(/[+$']/g, c => ({
        '+': '_',
        '$': '.',
        "'": '~'
    }[c]));
    return base + '?mode=' + mode + '#code=' + safe;
}

// 三个「限制类」参数：只在用户填了非 0 值时才拼进 URL，避免默认链接挂一串 &xxx=0
function maxSizeQuery() {
    const v = parseInt(maxSizeInput.value, 10);
    return v > 0 ? '&maxSize=' + v : '';
}
function fpsCapQuery() {
    const v = parseInt(fpsCapInput.value, 10);
    return v > 0 ? '&fpsCap=' + v : '';
}
function autoPauseQuery() {
    const v = parseInt(autoPauseInput.value, 10);
    return v > 0 ? '&autoPauseMs=' + v : '';
}

function buildServerUrl(mode, id) {
    const base = window.location.origin + window.location.pathname;
    return base + '?mode=' + mode + '#id=' + id + maxSizeQuery() + fpsCapQuery() + autoPauseQuery();
}

// ?src=（内置文件路径）与 ?js=（外部 JS URL）共用一个参数位：同一时刻
// 只可能有一个来源，两个都空时返回不带来源参数的链接（仅模式/限制参数）。
function buildSourceUrl() {
    const base = window.location.origin + window.location.pathname;
    const from = currentSrc ? '&src=' + encodeURIComponent(currentSrc)
               : currentJs ? '&js=' + encodeURIComponent(currentJs)
               : '';
    return base + '?mode=preview' + maxSizeQuery() + fpsCapQuery() + autoPauseQuery() + from;
}
