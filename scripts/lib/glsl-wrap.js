'use strict';
/**
 * GLSL 包装器 —— 与 index.html 里的 VERTEX_SHADER / buildFragmentShader 保持同源。
 *
 * 浏览器真正编译的是「包装器 + 用户代码」，不是 *.glsl 原文。只校验原文会漏掉
 * 两类只有包装后才暴露的错误：
 *   1. 与包装器冲突：重复 #version、precision 重声明、重复定义 fragColor 等
 *   2. 链接期错误：mainImage 未定义 / 签名不符（编译能过、链接失败 → 页面黑屏）
 *
 * index.html 是零构建的单文件应用，不能 require 本模块，所以这里存一份副本，
 * 并用 verifyAgainstIndexHtml() 比对 sha1 —— 改了 index.html 忘了同步这里会直接报错，
 * 避免出现「校验通过但线上炸」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML = path.join(ROOT, 'index.html');

/** 与 index.html 中 buildFragmentShader 的模板逐字符一致 */
const FRAG_TEMPLATE = `#version 300 es
        precision highp float;
        uniform vec3  iResolution;
        uniform float iTime;
        uniform float iTimeDelta;
        uniform float iFrame;
        uniform vec4  iMouse;
        uniform vec4  iDate;
        uniform float iSampleRate;
        uniform sampler2D iChannel0, iChannel1, iChannel2, iChannel3;
        in vec2 vUv; out vec4 fragColor;
        vec4 texture2D(sampler2D s, vec2 uv) { return texture(s, uv); }
        vec4 texture2D(sampler2D s, vec2 uv, float b) { return texture(s, uv, b); }
        void mainImage(out vec4, in vec2);
        void main() {
            vec2 fragCoord = vUv * iResolution.xy;
            mainImage(fragColor, fragCoord);
            fragColor = clamp(fragColor, 0.0, 1.0);
        }
        \${userCode}
        `;

/** 与 index.html 中 VERTEX_SHADER 逐字符一致 */
const VERT_TEMPLATE = `#version 300 es
        precision highp float;
        in vec2 aPosition; out vec2 vUv;
        void main() {
            gl_Position = vec4(aPosition, 0.0, 1.0);
            vUv = aPosition * 0.5 + 0.5;
        }`;

const FRAG_RE = /function\s+buildFragmentShader\s*\([^)]*\)\s*\{\s*return\s*`([\s\S]*?)`\s*;/;
const VERT_RE = /const\s+VERTEX_SHADER\s*=\s*`([\s\S]*?)`/;

function sha1(text) { return crypto.createHash('sha1').update(text, 'utf8').digest('hex'); }

function wrapFragment(userCode) {
    return FRAG_TEMPLATE.replace('${userCode}', userCode);
}

/**
 * 用户代码首行在包装后 shader 中的行号偏移。
 * glslangValidator 报的是包装后的行号，减掉它才能定位回源码。
 */
function fragmentLineOffset() {
    const i = FRAG_TEMPLATE.split('\n').findIndex(l => l.includes('${userCode}'));
    return i < 0 ? 0 : i;   // 该行索引 i → 包装后行号 i+1，用户第 1 行正好落在这里
}

/** 从 index.html 现场提取两份模板；提取不到返回 null */
function readIndexTemplates() {
    if (!fs.existsSync(INDEX_HTML)) return null;
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const f = html.match(FRAG_RE), v = html.match(VERT_RE);
    if (!f || !v) return null;
    return { frag: f[1], vert: v[1] };
}

/**
 * 校验本模块与 index.html 是否漂移。返回 { ok, problems[] }。
 * index.html 缺失或提取失败时不算漂移 —— 单文件应用被拆开时不要误报。
 */
function verifyAgainstIndexHtml() {
    const live = readIndexTemplates();
    if (!live) return { ok: true, problems: [] };
    const problems = [];
    if (sha1(live.frag) !== sha1(FRAG_TEMPLATE)) {
        problems.push('index.html 的 buildFragmentShader 与 scripts/lib/glsl-wrap.js 的 FRAG_TEMPLATE 不一致');
    }
    if (sha1(live.vert) !== sha1(VERT_TEMPLATE)) {
        problems.push('index.html 的 VERTEX_SHADER 与 scripts/lib/glsl-wrap.js 的 VERT_TEMPLATE 不一致');
    }
    return { ok: problems.length === 0, problems };
}

/**
 * 运行时环境 —— 与 index.html 渲染循环保持同源。
 *
 * 校验「能不能跑」时，喂给 shader 的 uniform 必须和页面一致，否则结论不可信：
 * rain 依赖 iChannel0 的背景图，不绑纹理就会渲染成纯黑，被误判成坏 shader。
 * iResolution.z 同理：页面恒传 1（ShaderToy 约定），传 0 会让某些写法除零变 NaN。
 */
const DEFAULT_TEXTURE = {
    width: 2, height: 2,
    // index.html createDefaultTexture()：2x2 棋盘格，白/灰
    data: [
        255, 255, 255, 255, 128, 128, 128, 255,
        128, 128, 128, 255, 255, 255, 255, 255,
    ]
};

const UNIFORM_DEFAULTS = {
    // iResolution.z 恒为 1：ShaderToy 约定的像素宽高比，不是画布宽高比。
    // 传 0 会让 (fragCoord - 0.5*iResolution.xy)/iResolution.z 这类写法除零变 inf/NaN。
    resolutionZ: 1,
    timeDelta: 1 / 60,
    sampleRate: 44100,
    // iMouse / iDate 页面里随交互变化，校验时给一组中性值。
    // iMouse.zw 必须是 -1，与 index.html 的 mouse = {x:0,y:0,bx:-1,by:-1} 同源：
    // ShaderToy 用 iMouse.z > 0.0 判断「是否按住」，页面未点击过传的就是负值。
    // 校验器若传 0，那些用 iMouse.z < 0.0 判「从未交互」的 shader 会走错分支。
    mouse: [0, 0, -1, -1],
    date: [2025, 1, 1, 0.5],
};

module.exports = {
    INDEX_HTML, FRAG_TEMPLATE, VERT_TEMPLATE,
    DEFAULT_TEXTURE, UNIFORM_DEFAULTS,
    wrapFragment, fragmentLineOffset,
    readIndexTemplates, verifyAgainstIndexHtml, sha1
};
