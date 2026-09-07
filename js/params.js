'use strict';
/**
 * URL 参数（query + hash）。无依赖，最先执行——params / isPreview 后面到处都用。
 *
 * 一个参数可能出现在 query 或 hash 里（手拼链接的人两种写法都会用），所以两边都读、
 * 按同一套优先级合并 —— 由 pick() 统一做，不要在各处自己写 `h.x || p.get('x')`：
 * 那种写法每加一个参数就要决定一次方向，src 就曾经和另外几个反着来。
 *
 * hash 必须手工解析：URLSearchParams 会把 '+' 解码成空格，而 lz-string 的
 * 输出字母表里就含 '+'，用它解析等于把压缩数据随机改写。
 */

function parseHash() {
    const h = {};
    const hashStr = window.location.hash.slice(1);
    if (!hashStr) return h;
    hashStr.split('&').forEach(pair => {
        const eq = pair.indexOf('=');
        if (eq > 0) {
            const key = pair.slice(0, eq);
            const val = pair.slice(eq + 1);
            // decodeURIComponent 以确保特殊字符正确还原；非法 % 序列（abc%zz）会抛
            // URIError，不能让它打断整个解析 —— 原样保留，由使用方给出可读的报错。
            try { h[key] = decodeURIComponent(val); } catch (e) { h[key] = val; }
        } else if (pair) {
            h[pair] = '';
        }
    });
    return h;
}

function getURLParams() {
    const p = new URLSearchParams(window.location.search);
    const h = parseHash();

    // 同名参数以 hash 为准：hash 是「后写上去的那一份」。分享链接把整份状态压进 hash，
    // 若 query 里还留着同名的旧值，该生效的是 hash 这份。（src 以前是反的，与其余五个
    // 参数不一致，纯笔误，已统一。）
    //
    // 判「胜出」用真值而不是 `!== undefined`：hash 里显式留空（`#mode=`）是没写，
    // 不是「要覆盖成空」，此时该回退到 query —— 用 undefined 判断会把 `?code=X#code=`
    // 里的真值吃掉。
    const pick = key => {
        if (h[key]) return h[key];
        const q = p.get(key);
        return q === null ? '' : q;
    };

    return {
        mode: pick('mode') || 'edit',
        code: pick('code'),
        id: pick('id'),
        src: pick('src'),
        js: pick('js'),
        maxSize: parseInt(pick('maxSize'), 10) || 0,
        fpsCap: parseInt(pick('fpsCap'), 10) || 0,
        autoPauseMs: parseInt(pick('autoPauseMs'), 10) || 0,
    };
}

const params = getURLParams();
const isPreview = params.mode === 'preview';
if (isPreview) document.body.classList.add('preview-mode');
