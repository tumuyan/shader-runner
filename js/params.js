'use strict';
/**
 * URL 参数（query + hash）。无依赖，最先执行——params / isPreview 后面到处都用。
 *
 * hash 必须手工解析：URLSearchParams 会把 '+' 解码成空格，而 lz-string 的
 * 输出字母表里就含 '+'，用它解析等于把压缩数据随机改写。
 */

function getURLParams() {
    const p = new URLSearchParams(window.location.search);

    const hashStr = window.location.hash.slice(1);
    const h = {};
    if (hashStr) {
        hashStr.split('&').forEach(pair => {
            const eq = pair.indexOf('=');
            if (eq > 0) {
                // decodeURIComponent 以确保特殊字符正确还原
                const key = pair.slice(0, eq);
                const val = pair.slice(eq + 1);
                try { h[key] = decodeURIComponent(val); } catch(e) { h[key] = val; }
            } else if (pair) {
                h[pair] = '';
            }
        });
    }

    return {
        mode: h.mode || p.get('mode') || 'edit',
        code: h.code || p.get('code') || '',
        id: h.id || p.get('id') || '',
        // src 与其它参数一样 query + hash 双读：生成器产出的确实是 query 形式，
        // 但手拼链接的人两种写法都会用，只认 query 会让 #src= 被静默忽略。
        src: p.get('src') || h.src || '',
        js: h.js || p.get('js') || '',
        maxSize: parseInt(p.get('maxSize') || h.maxSize, 10) || 0,
        fpsCap: parseInt(p.get('fpsCap') || h.fpsCap, 10) || 0,
        autoPauseMs: parseInt(p.get('autoPauseMs') || h.autoPauseMs, 10) || 0,
    };
}

const params = getURLParams();
const isPreview = params.mode === 'preview';
if (isPreview) document.body.classList.add('preview-mode');
