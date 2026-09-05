'use strict';
/**
 * 权威后端：在真实 WebGL2 上下文里编译 + 链接 + 渲染。
 *
 * 这是唯一能回答「这个 shader 能不能正常运行」的判据 —— 浏览器用的就是
 * ANGLE，而 glslang 只是另一个实现，两者对规范的解读并不一致（见
 * glsl-backend-glslang.js 里的 BROWSER_DIVERGENT）。
 *
 * 环境必须复刻 js/renderer.js 的运行时：默认纹理、iResolution.z=1、各 uniform 初值。
 * 少一样就会误判 —— rain 依赖 iChannel0，不绑纹理就渲染成纯黑。
 */
const W = require('./glsl-wrap');
const E = require('./glsl-errors');

/** 采样时刻。单帧判断「全黑」会误伤渐入型 shader（the-universe-within 在 t<1 时接近全黑）。 */
const SAMPLE_TIMES = [0.1, 1, 5, 20, 60];
const CANVAS_SIZE = 128;

/** 页面里执行：建上下文、按序校验每个 shader */
function pageFn(args) {
    const { targets, vert, tex, defaults, times, size, wrap } = args;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return { fatal: '无法创建 WebGL2 上下文' };

    function compile(src, type) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            return { ok: false, log };
        }
        return { ok: true, shader: s };
    }

    // 复刻 js/renderer.js initGLResources()：默认纹理绑到 iChannel0-3
    const dfl = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dfl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(tex.data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    const v = compile(vert, gl.VERTEX_SHADER);
    if (!v.ok) return { fatal: '顶点着色器编译失败: ' + v.log };

    // 复刻 js/renderer.js：全屏三角形
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const results = targets.map(t => {
        const fragSrc = wrap.replace('${userCode}', t.code);
        const f = compile(fragSrc, gl.FRAGMENT_SHADER);
        if (!f.ok) return { id: t.id, stage: 'compile', log: f.log };

        const p = gl.createProgram();
        gl.attachShader(p, v.shader);
        gl.attachShader(p, f.shader);
        gl.bindAttribLocation(p, 0, 'aPosition');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(p);
            gl.deleteProgram(p); gl.deleteShader(f.shader);
            return { id: t.id, stage: 'link', log };
        }

        gl.useProgram(p);
        const loc = gl.getAttribLocation(p, 'aPosition');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, size, size);
        for (let i = 0; i < 4; i++) {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, dfl);
            const u = gl.getUniformLocation(p, 'iChannel' + i);
            if (u) gl.uniform1i(u, i);
        }

        const u = (n) => gl.getUniformLocation(p, n);
        gl.uniform3f(u('iResolution'), size, size, defaults.resolutionZ);
        gl.uniform1f(u('iTimeDelta'), defaults.timeDelta);
        gl.uniform1f(u('iSampleRate'), defaults.sampleRate);
        gl.uniform4f(u('iMouse'), ...defaults.mouse);
        gl.uniform4f(u('iDate'), ...defaults.date);

        const px = new Uint8Array(size * size * 4);
        const means = [];
        for (const tm of times) {
            gl.uniform1f(u('iTime'), tm);
            gl.uniform1f(u('iFrame'), Math.round(tm * 60));
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let sum = 0, nonBlack = 0;
            for (let i = 0; i < px.length; i += 4) {
                const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
                sum += lum;
                if (lum > 2) nonBlack++;
            }
            const n = px.length / 4;
            means.push({ t: tm, mean: +(sum / n).toFixed(1), nonBlack: +(nonBlack / n).toFixed(3) });
        }
        gl.deleteProgram(p); gl.deleteShader(f.shader);
        return { id: t.id, stage: 'ok', means };
    });

    return {
        renderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        results
    };
}

/**
 * 在真实浏览器里跑一遍。
 * @returns {Promise<{ok:boolean, skip?:string, renderer?:string, version?:string, results:Array}>}
 */
async function check(targets) {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        return { ok: true, skip: '未安装 playwright（npm i -D playwright && npx playwright install chromium）' };
    }

    let browser;
    try {
        browser = await chromium.launch({
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
        });
    } catch (e) {
        const msg = String(e.message || e);
        // 缺系统库是最常见的失败，给出可操作的提示
        const hint = /shared libraries|Host system is missing/i.test(msg)
            ? '（缺系统依赖，试试 npx playwright install-deps chromium）'
            : '';
        return { ok: true, skip: '无法启动 Chromium: ' + msg.split('\n')[0] + hint };
    }

    try {
        const page = await browser.newPage();
        const out = await page.evaluate(pageFn, {
            targets: targets.map(t => ({ id: t.label, code: t.code })),
            vert: W.VERT_TEMPLATE,
            wrap: W.FRAG_TEMPLATE,
            tex: W.DEFAULT_TEXTURE,
            defaults: W.UNIFORM_DEFAULTS,
            times: SAMPLE_TIMES,
            size: CANVAS_SIZE
        });
        if (out.fatal) return { ok: false, fatal: out.fatal, results: [] };

        // 行号映射回源码（浏览器报的是包装后的行号）；浏览器是权威，不做任何降级
        const offset = W.fragmentLineOffset();
        const results = out.results.map(r => (r.log
            ? { ...r, log: E.parseErrors(r.log, offset).join('\n') }
            : r));
        return { ok: true, renderer: out.renderer, version: out.version, results };
    } finally {
        await browser.close();
    }
}

module.exports = { check, SAMPLE_TIMES, CANVAS_SIZE };
