'use strict';
/**
 * WebGL2 渲染：shader 编译 / program / GL 资源 / 渲染循环 / 计时 / 鼠标 / 暂停。
 *
 * 依赖：config.js（DEFAULT_SHADER）、state.js、params.js（isPreview）、ui.js（显示与播放控件）
 * 被依赖：catalog.js（createProgram / glResourcesReady）、app.js（resize / render / togglePause）
 *
 * ⚠ VERTEX_SHADER 与 buildFragmentShader 在 scripts/lib/glsl-wrap.js 里有一份逐字符副本，
 *   两者按 sha1 比对（npm run glsl:check 第一步）。改这里的 GLSL 必须同步那份副本，
 *   否则校验直接判「包装器漂移」并退出 —— 模板字符串里的缩进属于 GLSL 文本，别顺手对齐。
 */

const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: true,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
});
if (!gl) {
    document.body.innerHTML = '<h1 style="color:red;text-align:center;margin-top:40vh;">浏览器不支持 WebGL2</h1>';
    throw new Error('WebGL2 not supported');
}

function compileShader(src, type) {
    if (gl.isContextLost()) return null;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        console.error('Shader 编译错误:', log);
        // 尝试提取行号并显示对应源码行
        const match = log.match(/ERROR:\s*\d+:(\d+)/);
        if (match) {
            const lineNum = parseInt(match[1], 10);
            const lines = src.split('\n');
            const ctxStart = Math.max(0, lineNum - 3);
            const ctxEnd = Math.min(lines.length, lineNum + 2);
            console.error('--- 错误附近源码 (第 ' + lineNum + ' 行) ---');
            for (let i = ctxStart; i < ctxEnd; i++) {
                const marker = i === lineNum - 1 ? '>>> ' : '    ';
                console.error(marker + (i + 1) + ': ' + lines[i]);
            }
            console.error('---');
        }
        return null;
    }
    return shader;
}

// ↓↓ 与 scripts/lib/glsl-wrap.js 的 VERT_TEMPLATE 逐字符一致，勿改缩进 ↓↓
const VERTEX_SHADER = `#version 300 es
        precision highp float;
        in vec2 aPosition; out vec2 vUv;
        void main() {
            gl_Position = vec4(aPosition, 0.0, 1.0);
            vUv = aPosition * 0.5 + 0.5;
        }`;
// ↑↑ 与 scripts/lib/glsl-wrap.js 的 VERT_TEMPLATE 逐字符一致，勿改缩进 ↑↑

// ↓↓ 与 scripts/lib/glsl-wrap.js 的 FRAG_TEMPLATE 逐字符一致，勿改缩进 ↓↓
function buildFragmentShader(userCode) {
    return `#version 300 es
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
        ${userCode}
        `;
}
// ↑↑ 与 scripts/lib/glsl-wrap.js 的 FRAG_TEMPLATE 逐字符一致，勿改缩进 ↑↑

let program = null, uniforms = {};
function createProgram(userCode) {
    // 上下文丢失不是代码的错，此时不清 lastCompiledCode —— 否则会拿一个跟代码无关的
    // 环境问题去拦发布。
    if (gl.isContextLost()) return false;
    // 失败即黑屏是有意为之：失败时编辑器不关 + 红 toast，错误可见；
    // 不保留旧 program 到编译成功，否则关掉编辑器后会停在旧画面、让人误以为编辑成功。
    if (program) { gl.deleteProgram(program); program = null; }
    // 同时清空 location，避免失败时用失效 location 上传 uniform
    uniforms = {};
    // 走到这里就是要对这份代码重新下结论了：下面任一步失败都保持为空。
    lastCompiledCode = '';
    const vs = compileShader(VERTEX_SHADER, gl.VERTEX_SHADER);
    const fs = compileShader(buildFragmentShader(userCode), gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Program 链接失败:', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog); return false;
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    program = prog; gl.useProgram(program);
    const names = ['iResolution','iTime','iTimeDelta','iFrame','iMouse','iDate','iSampleRate','iChannel0','iChannel1','iChannel2','iChannel3'];
    names.forEach(n => uniforms[n] = gl.getUniformLocation(program, n));
    [0,1,2,3].forEach(i => gl.uniform1i(uniforms['iChannel'+i], i));
    lastCompiledCode = userCode;   // 编译 + 链接都过了：这份代码确实能跑
    return true;
}

function createDefaultTexture() {
    // 2x2 RGBA = 16 字节
    const data = new Uint8Array([
        255,255,255,255, 128,128,128,255,
        128,128,128,255, 255,255,255,255,
    ]);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
}

// ---- GL 资源（上下文丢失后需整体重建，故用 let 而非常量）----
let vao = null, vbo = null, dflTex = null;

function releaseGLResources() {
    // 上下文丢失后这些对象已失效，删除调用无意义且会静默失败，只需断开引用
    if (gl.isContextLost()) { vao = vbo = dflTex = null; return; }
    if (vao) { gl.deleteVertexArray(vao); vao = null; }
    if (vbo) { gl.deleteBuffer(vbo); vbo = null; }
    if (dflTex) { gl.deleteTexture(dflTex); dflTex = null; }
}

function initGLResources() {
    vao = gl.createVertexArray();
    vbo = gl.createBuffer();
    if (!vao || !vbo) { releaseGLResources(); return false; }
    gl.bindVertexArray(vao);
    const verts = new Float32Array([-1,-1,3,-1,-1,3]);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    dflTex = createDefaultTexture();
    if (!dflTex) { releaseGLResources(); return false; }
    for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D, dflTex); }
    return true;
}
// 初始化失败只置标记：此处早于 toast 的 const 声明，直接 showToast 会触发 TDZ 报错，
// 把脚本剩余部分（事件绑定、init()）全部打断。提示延后到 init() 末尾。
glResourcesReady = initGLResources();
if (!glResourcesReady) {
    glInitFailed = true;
    console.error('GL 资源初始化失败');
}

// ---- WebGL 上下文丢失 / 恢复 ----
// GPU 切换、驱动重置、移动端切后台都可能丢上下文。丢失后所有 GL 调用静默失效，
// 表现为画面永久卡死；若不 preventDefault()，浏览器不会派发 restored 事件。
let contextLostTimer = null;

canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    contextLost = true;
    glResourcesReady = false;
    program = null; uniforms = {};
    releaseGLResources();
    console.warn('⚠ WebGL 上下文丢失，等待恢复…');
    clearTimeout(contextLostTimer);
    contextLostTimer = setTimeout(() => {
        if (contextLost) showToast('⚠ 渲染上下文未恢复，请刷新页面');
    }, 5000);
});

canvas.addEventListener('webglcontextrestored', () => {
    console.log('WebGL 上下文已恢复，正在重建资源…');
    clearTimeout(contextLostTimer);
    let ok = false;
    try {
        glResourcesReady = initGLResources();
        ok = glResourcesReady && createProgram(currentCode || DEFAULT_SHADER);
    } catch (err) {
        console.error('GL 资源重建异常:', err);
    }
    if (ok) {
        contextLost = false;
        resize(true);   // 恢复后需重设 viewport（canvas 尺寸未变时 resize 不会触发）
        showToast('✓ 渲染已恢复');
    } else {
        showToast('✗ 渲染恢复失败，请刷新页面');
    }
});

// ============================================================
// 运行时状态（ paused / autoPauseMs / autoPauseFired / frameCap 在 state.js ）
// ============================================================
let startTime = performance.now()/1000, frameCount = 0, pauseOffset = 0;
let frameAccum = 0;  // rAF 时间累加器，微秒级精度
let pendingDelta = 0;  // 自上次渲染以来累计的真实时长，用于 iTimeDelta
let fpsTimer = 0, fpsAccum = 0;
const MAX_DELTA = 1;  // 单帧最大计入时间（秒），超出部分视为冻结
// bx/by 初始为负：ShaderToy 用 iMouse.z > 0.0 判断是否按住，未点击过应处于「未按下」状态
const mouse = {x:0,y:0,bx:-1,by:-1,down:false};
let lastTime = 0;

function resize(force) {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const maxSize = parseInt(maxSizeInput.value, 10) || 0;
    let w, h;
    const dpr = Math.min(window.devicePixelRatio, 2);
    // 先按 DPR 计算原始物理分辨率
    let rawW = cw * dpr, rawH = ch * dpr;
    if (maxSize > 0) {
        // 限制较大边不超过 maxSize，否则维持 DPR 全分辨率
        const scale = Math.min(1, maxSize / Math.max(rawW, rawH));
        w = Math.floor(rawW * scale);
        h = Math.floor(rawH * scale);
    } else {
        w = Math.floor(rawW);
        h = Math.floor(rawH);
    }
    // 严格判 true：resize 直接被当作事件回调注册时，事件对象会作为 force 传入
    if (force === true || canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
        resDisplay.textContent = w + '×' + h;
    }
}

function render(time) {
    resize();
    const now = time / 1000;
    // 切后台回来时 rAF 会停摆，首帧 delta 可能是几百秒。截断并把超出部分计入冻结时间，
    // 否则 iTime / iTimeDelta 会出现巨大跳变（shader 里常见的一闪而过或画面突变）。
    const rawDelta = lastTime ? now - lastTime : 0.016;
    const delta = Math.min(rawDelta, MAX_DELTA);
    pauseOffset += rawDelta - delta;
    lastTime = now;
    // 画面未推进的时间（暂停 / 上下文丢失 / 无可用 program）统一在此累加到 pauseOffset。
    // 必须每帧增量累加，不能在各处赋值覆盖 —— 否则后面的补偿会抹掉前面已冻结的时间。
    if (paused || contextLost || !program) {
        pauseOffset += delta;
        // 这段时间 iTime 不推进（已计入 pauseOffset），对应的步长也要丢弃，
        // 否则恢复后首帧的 iTimeDelta 会带上暂停前的残留
        pendingDelta = 0;
        requestAnimationFrame(render);
        return;
    }

    // 帧率控制—高精度累加器（rAF time 为 DOMHighResTimeStamp，微秒级精度）
    // 被跳过的帧同样要把真实时长累加进 pendingDelta：否则上传的 iTimeDelta
    // 只等于最后一个真实帧间隔，与 iTime 每渲染帧推进的 1/frameCap 不符，
    // shader 里用 iTimeDelta 做积分/阻尼会整体偏慢（30FPS 上限下慢一半）。
    pendingDelta += delta;
    if (frameCap > 0) {
        frameAccum = Math.min(frameAccum + delta, 1);  // 防 catch-up 爆帧
        if (frameAccum < 1 / frameCap) {
            requestAnimationFrame(render);
            return;
        }
        frameAccum -= 1 / frameCap;
    }
    const total = (now - startTime) - pauseOffset;
    frameCount++;
    // 到达指定毫秒后自动暂停（仅预览模式，手动操作后永久失效）。
    // 带 isPreview 是刻意的：该参数服务于分享出去的预览链接，编辑模式要能无限时调代码。
    if (isPreview && autoPauseMs > 0 && !autoPauseFired) {
        const elapsed = (performance.now() / 1000 - startTime) * 1000;
        if (elapsed >= autoPauseMs) {
            paused = true;
            autoPauseFired = true;
            playPauseBtn.textContent = '▶';
        }
    }
    fpsAccum++;
    if (now - fpsTimer >= 1) {
        fpsDisplay.textContent = Math.round(fpsAccum / (now - fpsTimer)) + ' FPS';
        fpsAccum = 0;
        fpsTimer = now;
    }
    gl.useProgram(program);
    const w = canvas.width, h = canvas.height;
    // iResolution.z 是像素宽高比（ShaderToy 约定，方形像素恒为 1.0），不是画布宽高比。
    // 传 0 会让 (fragCoord - 0.5*iResolution.xy)/iResolution.z 这类写法除零变 inf/NaN。
    gl.uniform3f(uniforms.iResolution, w, h, 1);
    gl.uniform1f(uniforms.iTime, total);
    gl.uniform1f(uniforms.iTimeDelta, pendingDelta);
    gl.uniform1f(uniforms.iFrame, frameCount);
    gl.uniform1f(uniforms.iSampleRate, 44100);
    gl.uniform4f(uniforms.iMouse, mouse.x, mouse.y, mouse.bx, mouse.by);
    const d = new Date();
    gl.uniform4f(uniforms.iDate, d.getFullYear(), d.getMonth()+1, d.getDate(),
        (d.getHours()*3600+d.getMinutes()*60+d.getSeconds())/86400);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pendingDelta = 0;
    requestAnimationFrame(render);
}

// ============================================================
// 鼠标：iMouse 语义见 updateMousePos 上方注释
// ============================================================
function updateMousePos(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    mouse.x = (clientX-r.left)/r.width*canvas.width;
    mouse.y = canvas.height - (clientY-r.top)/r.height*canvas.height;
}
function pressMouse(clientX, clientY) {
    // 先按事件坐标刷新 xy：进入画布后未移动就按下时，mouse.xy 还是上一次的陈旧值
    updateMousePos(clientX, clientY);
    mouse.bx = mouse.x; mouse.by = mouse.y;
    mouse.down = true;
}
function releaseMouse() {
    mouse.down = false;
    // 取负，且 0 的情况（-0 是 falsy）兜底为 -1，保证 z 严格 < 0
    mouse.bx = -Math.abs(mouse.bx) || -1;
    mouse.by = -Math.abs(mouse.by) || -1;
}
canvas.addEventListener('mousemove', e => updateMousePos(e.clientX, e.clientY));
canvas.addEventListener('mousedown', e => pressMouse(e.clientX, e.clientY));
canvas.addEventListener('mouseup', releaseMouse);
canvas.addEventListener('mouseleave', releaseMouse);
canvas.addEventListener('touchstart', e => {
    pressMouse(e.touches[0].clientX, e.touches[0].clientY);
}, {passive:true});
canvas.addEventListener('touchmove', e => {
    updateMousePos(e.touches[0].clientX, e.touches[0].clientY);
}, {passive:true});
canvas.addEventListener('touchend', releaseMouse, {passive:true});

function togglePause() {
    autoPauseFired = true;  // 手动操作后自动暂停永久失效
    // 用户亲手按过之后，暂停状态的归属就是他自己的：清掉可见性自动暂停的标记，
    // 免得后面一次 visibilitychange 又把手动结果覆盖掉
    autoPausedByVisibility = false;
    paused = !paused;
    // 时间补偿统一由 render 每帧累加，此处不再手工改写 pauseOffset
    playPauseBtn.textContent = paused ? '▶' : '⏸';
}
