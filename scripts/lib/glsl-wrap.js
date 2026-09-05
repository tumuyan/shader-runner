'use strict';
/**
 * GLSL 包装器 —— 与 js/renderer.js 里的 VERTEX_SHADER / buildFragmentShader 保持同源。
 *
 * 浏览器真正编译的是「包装器 + 用户代码」，不是 *.glsl 原文。只校验原文会漏掉
 * 两类只有包装后才暴露的错误：
 *   1. 与包装器冲突：重复 #version、precision 重声明、重复定义 fragColor 等
 *   2. 链接期错误：mainImage 未定义 / 签名不符（编译能过、链接失败 → 页面黑屏）
 *
 * 页面是零构建的普通 <script> 应用，不能 require 本模块，所以这里存一份副本，
 * 并用 verifyAgainstRuntime() 比对 sha1 —— 改了运行时忘了同步这里会直接报错，
 * 避免出现「校验通过但线上炸」。
 *
 * 模板字符串里的缩进属于 GLSL 文本的一部分，别因为「看起来没对齐」去整理它，
 * 那会立刻触发漂移。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
/** 包装器的真身在运行时脚本里（index.html 只负责按序加载它们） */
const RUNTIME_SRC = path.join(ROOT, 'js', 'renderer.js');

/** 与 js/renderer.js 中 buildFragmentShader 的模板逐字符一致 */
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

/** 与 js/renderer.js 中 VERTEX_SHADER 逐字符一致 */
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

/** 从 js/renderer.js 现场提取两份模板；提取不到返回 null */
function readRuntimeTemplates() {
    if (!fs.existsSync(RUNTIME_SRC)) return null;
    const src = fs.readFileSync(RUNTIME_SRC, 'utf8');
    const f = src.match(FRAG_RE), v = src.match(VERT_RE);
    if (!f || !v) return null;
    return { frag: f[1], vert: v[1] };
}

/**
 * 校验本模块与运行时脚本是否漂移。返回 { ok, problems[] }。
 * 文件缺失或提取失败时算漂移 —— 那意味着包装器被搬走了或改名了，
 * 这时候「通过」只是因为没比对上任何东西，是假绿。
 */
function verifyAgainstRuntime() {
    const live = readRuntimeTemplates();
    if (!live) {
        return { ok: false, problems: ['无法从 ' + path.relative(ROOT, RUNTIME_SRC)
            + ' 提取 GLSL 包装器（VERTEX_SHADER / buildFragmentShader）—— 文件被移动或改名了？'] };
    }
    const problems = [];
    if (sha1(live.frag) !== sha1(FRAG_TEMPLATE)) {
        problems.push('js/renderer.js 的 buildFragmentShader 与 scripts/lib/glsl-wrap.js 的 FRAG_TEMPLATE 不一致');
    }
    if (sha1(live.vert) !== sha1(VERT_TEMPLATE)) {
        problems.push('js/renderer.js 的 VERTEX_SHADER 与 scripts/lib/glsl-wrap.js 的 VERT_TEMPLATE 不一致');
    }
    return { ok: problems.length === 0, problems };
}

/**
 * 运行时环境 —— 与 js/renderer.js 的渲染循环保持同源。
 *
 * 校验「能不能跑」时，喂给 shader 的 uniform 必须和页面一致，否则结论不可信：
 * rain 依赖 iChannel0 的背景图，不绑纹理就会渲染成纯黑，被误判成坏 shader。
 * iResolution.z 同理：页面恒传 1（ShaderToy 约定），传 0 会让某些写法除零变 NaN。
 */
const DEFAULT_TEXTURE = {
    width: 2, height: 2,
    // js/renderer.js createDefaultTexture()：2x2 棋盘格，白/灰
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
    // iMouse.zw 必须是 -1，与 js/renderer.js 的 mouse = {x:0,y:0,bx:-1,by:-1} 同源：
    // ShaderToy 用 iMouse.z > 0.0 判断「是否按住」，页面未点击过传的就是负值。
    // 校验器若传 0，那些用 iMouse.z < 0.0 判「从未交互」的 shader 会走错分支。
    mouse: [0, 0, -1, -1],
    date: [2025, 1, 1, 0.5],
};

module.exports = {
    RUNTIME_SRC, FRAG_TEMPLATE, VERT_TEMPLATE,
    DEFAULT_TEXTURE, UNIFORM_DEFAULTS,
    wrapFragment, fragmentLineOffset,
    readRuntimeTemplates, verifyAgainstRuntime, sha1
};
