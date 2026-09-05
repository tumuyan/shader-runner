'use strict';
/**
 * shader 来源：内置清单、外部 ?js=、本地文件，以及「应用代码」这一步。
 *
 * 依赖：config.js、state.js、params.js、ui.js、codec.js、renderer.js（createProgram）
 * 被依赖：share.js（syncUrlInput 会读 currentSrc/currentJs）、editor.js、app.js（init 的 ?src= / ?js= 分支）
 *
 * 内置 shader 通过动态 <script> 加载 .shader.js 文件（不受 CORS 限制）。
 * 文件清单由 shader/manifest.js 提供，该文件由 `npm run add:refresh` 扫描
 * shader/*.shader.js 自动生成；新增 shader 只需丢文件 + 重跑命令，无需改这里。
 *
 * 按需加载：启动只读 manifest.js（一份 { path, label } 索引，约 1K），
 * shader 本体等用户选中或 URL 指定时才注入。静态托管下同样成立 ——
 * <script> 注入不走 fetch，没有 CORS 问题。
 */

const SHADER_MANIFEST = [];       // { path, label } —— 下拉列表的唯一来源
const BUILTIN_SHADERS = [];       // 已加载的产物 { path, label, code }，按需填充
const injectedPaths = new Set();  // 已注入过的路径/URL（无论成败），避免重复请求
// 外部来源的缓存。和 BUILTIN_SHADERS 分开：后者是 manifest 里的内置项，
// 重建下拉时会被整体重置，外部项不该跟着一起没。
const customShaders = new Map();

// 注入 <script>，返回 Promise<boolean>（onload / onerror 都 resolve，不卡住后续流程）
//
// corsFallback 只给跨域的 ?js= 用。普通 <script src> 是 no-cors 请求，会被资源方
// 的 Cross-Origin-Resource-Policy: same-origin 拦下（实测 ERR_BLOCKED_BY_RESPONSE
// .NotSameOrigin）；带上 crossorigin 属性就转成 CORS 请求，CORP 检查不再适用。
//
// 但它只能当兜底，绝不能当默认：没有 Access-Control-Allow-Origin 的资源，加了
// crossorigin 连原本能成功的也会失败（实测对照组的普通加载成功、crossorigin 失败）。
function injectScript(src, corsFallback) {
    return new Promise((resolve) => {
        function fail() { console.warn('⚠ 加载失败: ' + src); resolve(false); }
        var s = document.createElement('script');
        s.src = src;
        s.onload = function() { resolve(true); };
        s.onerror = function() {
            if (!corsFallback) return fail();
            // 换 CORS 模式再试一次，不行才认输
            var s2 = document.createElement('script');
            s2.crossOrigin = 'anonymous';
            s2.src = src;
            s2.onload = function() { resolve(true); };
            s2.onerror = fail;
            document.head.appendChild(s2);
        };
        document.head.appendChild(s);
    });
}

/**
 * 外部脚本加载失败时的归因。
 *
 * <script> 的 error 事件不带任何细节（既不说被 CORP 拦了，也不说 MIME 不对），
 * 光一句「加载失败」等于没说。于是额外发一个 CORS 模式的 fetch 来二分：
 *
 *   fetch 成功 → 资源可达且服务器愿意被跨域读取，那么 <script> 仍被拒就只剩
 *                一个解释：Content-Type 不是 JS 类型且启用了 nosniff，浏览器
 *                拒绝执行。换 CDN 即可。
 *   fetch 失败 → 跨域策略挡的（缺 ACAO 或 CORP: same-origin）。但注意这一类
 *                里也可能同时有 MIME 问题 —— 没有 ACAO 时无从分辨，只能两个
 *                可能一起说。
 *
 * 这里刻意不把 fetch 拿到的文本拿去 eval 执行：那样确实能救下 GitHub raw 之类
 * 「有 ACAO 但 MIME 不对」的源，代价是堆栈退化成匿名帧，出问题时更难查。
 */
async function diagnoseShaderUrl(url) {
    try {
        const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
        if (res.ok) {
            return '能下载但浏览器拒绝执行：服务器把 JS 当纯文本返回了'
                 + '（Content-Type 不是 JS 类型 + nosniff）。请改用会以 '
                 + 'application/javascript 返回的地址，如 jsDelivr / unpkg。';
        }
    } catch (e) { /* 落到下面的分支 */ }
    return '该地址不允许被第三方页面加载：缺少 Access-Control-Allow-Origin，'
         + '或设了 Cross-Origin-Resource-Policy: same-origin。'
         + '也可能同时把 Content-Type 标成了 text/plain。'
         + '用 curl -I 看这三个响应头即可确认 —— '
         + 'GitHub / CNB 的 raw 源码接口正是如此，需改用 JS CDN 或静态托管。';
}

/**
 * 校验 ?js= 的取值。这里只挡协议，不挡主机 —— 拿本页当跳板去加载第三方
 * 脚本是刻意允许的（URL 本来就是用户自己拼的，挡主机只是制造假安全感）。
 * 挡协议是为了给出可读的报错，而不是安全边界：`file://`、`data:`、
 * `javascript:` 这些塞进 <script src> 要么静默失败要么行为诡异，
 * 与其让页面黑屏，不如直接告诉用户参数写错了。
 */
function validateJsUrl(raw) {
    let u;
    try { u = new URL(raw, window.location.href); }
    catch (e) { return { error: 'URL 无法解析: ' + raw }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { error: '只支持 http(s) 地址，收到 ' + u.protocol };
    }
    return { url: u.href };
}

// 清单里的 label 偶尔会缺（旧格式只有路径）。退回到文件名的 Title Case，
// 与 scripts/lib/shader-build.js 里的 titleCase() 保持同一套规则。
function labelFromPath(p) {
    return String(p).replace(/^.*\//, '').replace(/\.shader\.js$/, '')
        .split(/[-_\s]+/).filter(Boolean)
        .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); })
        .join(' ');
}

// 清单是生成物，也可能被 CDN 缓存住旧版本，两种形状都得认
function normalizeManifest(raw) {
    return (raw || []).map(function(e) {
        if (typeof e === 'string') return { path: e, label: labelFromPath(e) };
        return { path: e.path, label: e.label || labelFromPath(e.path) };
    });
}

// 只加载清单：拿到 { path, label } 就够填下拉列表，shader 本体等选中再加载
async function loadShaderIndex() {
    if (!Array.isArray(window.__SHADER_MANIFEST__) && !(await injectScript(SHADER_MANIFEST_PATH))) {
        console.warn('⚠ ' + SHADER_MANIFEST_PATH + ' 缺失，未加载任何内置 shader');
        showToast('⚠ shader/manifest.js 缺失，请运行 npm run add:refresh');
        return;
    }
    var entries = normalizeManifest(window.__SHADER_MANIFEST__);
    SHADER_MANIFEST.length = 0;
    SHADER_MANIFEST.push.apply(SHADER_MANIFEST, entries);
}

// 取单个 shader，未加载过则先注入它的 .shader.js。
// 产物是往 __SHADER_REGISTRY__ 尾部 push 的，所以记下注入前的长度、只取
// 新增的这一段 —— 注册表里可能有别的来源塞进来的条目，按 path 全表兜底查
// 一次也只是保险，正常路径走不到。
async function ensureShader(path) {
    var hit = BUILTIN_SHADERS.find(function(s) { return s.path === path; });
    if (hit) return hit;
    if (injectedPaths.has(path)) return null;   // 注入过但没注册 → 文件坏了，别反复请求

    injectedPaths.add(path);
    var before = (window.__SHADER_REGISTRY__ || []).length;
    if (!(await injectScript(path))) {
        showToast('✗ 加载失败: ' + path);
        return null;
    }
    var reg = window.__SHADER_REGISTRY__ || [];
    var entry = reg.slice(before).find(function(s) { return s.path === path; })
             || reg.find(function(s) { return s.path === path; });
    if (!entry) {
        showToast('✗ ' + path + ' 未注册 shader');
        return null;
    }
    BUILTIN_SHADERS.push(entry);
    return entry;
}

// 外部 JS（?js=）载入的 shader。和内置产物一样是往 __SHADER_REGISTRY__
// 尾部 push，区别只是 path 不会出现在 manifest 里，所以靠「注入后新增的那段」
// 来认领，并按原样缓存 —— 同一个 URL 第二次遇到就不必再请求。
async function loadCustomShader(url) {
    var hit = customShaders.get(url);
    if (hit) return hit;
    if (injectedPaths.has(url)) return null;   // 注入过但没注册 → 不是 shader 产物

    injectedPaths.add(url);
    var before = (window.__SHADER_REGISTRY__ || []).length;
    if (!(await injectScript(url, true))) {
        // toast 地方太小装不下归因，指去控制台；地址一并打出来，方便对照 curl -I
        showToast('✗ 加载失败，原因见控制台');
        console.error('?js= 加载失败: ' + url + '\n' + await diagnoseShaderUrl(url));
        return null;
    }
    var reg = window.__SHADER_REGISTRY__ || [];
    var entry = reg.slice(before).find(function(s) { return s && typeof s.code === 'string'; });
    if (!entry) {
        showToast('✗ ' + url + ' 未注册 shader');
        return null;
    }
    customShaders.set(url, entry);
    return entry;
}

// ---- 下拉列表 ----

// 填充下拉列表（空选项在最前）。数据来自 manifest 而非已加载的产物 ——
// 按需加载下启动时一个 shader 都还没下载，label 只能从清单拿。
function populateShaderDropdown() {
    shaderSelector.innerHTML = '';
    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— 选择内置 shader —';
    shaderSelector.appendChild(emptyOpt);
    SHADER_MANIFEST.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.path;
        opt.textContent = s.label;
        shaderSelector.appendChild(opt);
    });
}

// 外部 shader 不在清单里，得单独加一项，否则下拉显示「未选择」而画面却在跑它
function addCustomOption(url, label) {
    var opt = document.createElement('option');
    opt.value = url;
    opt.textContent = (label || url) + '（外部）';
    opt.dataset.customJs = '1';
    shaderSelector.appendChild(opt);
    opt.selected = true;
}

function selectOptionByValue(value) {
    for (const opt of shaderSelector.options) opt.selected = opt.value === value;
}

// 清空来源标记（内置 / 外部都要清），并把下拉恢复到空选项
function clearFileSource() {
    const hadJs = !!currentJs;
    currentSrc = '';
    currentJs = '';
    // 外部项是动态追加的，重建一下就掉了；内置项无需重建
    if (hadJs) populateShaderDropdown();
    shaderSelector.selectedIndex = 0;
    syncUrlInput();
}

// 加载内置 shader 文件（首次选中时才注入它的 .shader.js，之后走缓存）
async function loadShaderFile(path) {
    if (!path) return;
    const entry = await ensureShader(path);
    if (!entry) { showToast('✗ 未找到: ' + path); return; }
    textarea.value = entry.code;
    currentSrc = path;
    currentJs = '';   // 来源只能有一个，否则再选回外部项会被判成「已选中」而跳过加载
    selectOptionByValue(path);
    syncUrlInput();
    applyShader(entry.code);
    showToast('✓ 已加载: ' + entry.label);
}

// 加载外部 shader（?js= 指向的第三方 .js，格式同内置产物）
async function loadCustomUrl(url) {
    const v = validateJsUrl(url);
    if (v.error) { showToast('✗ ' + v.error); return; }
    const entry = await loadCustomShader(v.url);
    if (!entry) return;
    textarea.value = entry.code;
    currentSrc = '';
    currentJs = v.url;
    if (![...shaderSelector.options].some(o => o.value === v.url)) {
        addCustomOption(v.url, entry.label);
    } else {
        selectOptionByValue(v.url);
    }
    syncUrlInput();
    applyShader(entry.code);
    showToast('✓ 已加载: ' + (entry.label || v.url));
}

// 编译并应用一份 shader 源码。所有来源（编辑、下拉、文件、URL 参数）最终都走这里。
function applyShader(code) {
    currentCode = code;
    if (contextLost) {
        showToast('✗ WebGL 上下文已丢失，不是你的代码问题，请等待恢复或刷新页面');
        return;
    }
    // GL 资源缺失 = 启动期初始化失败。此时 program 依然建得出来，但画面全黑，
    // 必须拦在编译之前，否则会误报「编译成功」，让用户以为是自己代码写错了。
    if (!glResourcesReady) {
        showToast('✗ 渲染资源不可用，请刷新页面');
        return;
    }
    if (createProgram(code)) {
        showToast('✓ Shader 编译成功');
        closeEditor();
    } else {
        showToast('✗ Shader 编译失败，请检查控制台');
    }
}

// ============================================================
// 设置输入框与事件绑定
// ============================================================
maxSizeInput.value = params.maxSize || MAX_SIZE_DEFAULT;
fpsCapInput.value = params.fpsCap || FPS_CAP_DEFAULT;
autoPauseInput.value = params.autoPauseMs;
autoPauseMs = parseInt(autoPauseInput.value, 10) || 0;
frameCap = parseInt(fpsCapInput.value, 10) || 0;

autoPauseInput.addEventListener('input', () => {
    autoPauseMs = parseInt(autoPauseInput.value, 10) || 0;
});
maxSizeInput.addEventListener('input', resize);
fpsCapInput.addEventListener('input', () => {
    frameCap = parseInt(fpsCapInput.value, 10) || 0;
});

// 用户手动编辑 → 清除来源标记
textarea.addEventListener('input', () => {
    if (currentSrc || currentJs) clearFileSource();
});

// 下拉列表切换。外部项的值是 URL，内置项是 manifest 里的路径 ——
// 用 dataset 标记区分，比猜「是不是 http 开头」可靠。
shaderSelector.addEventListener('change', () => {
    const value = shaderSelector.value;
    const picked = shaderSelector.selectedOptions[0];
    if (picked && picked.dataset.customJs) {
        if (value !== currentJs) loadCustomUrl(value);
        return;
    }
    if (value) {
        loadShaderFile(value);
    } else if (currentSrc || currentJs) {
        // 切到空选项 → 清除来源，恢复默认 shader
        clearFileSource();
        textarea.value = DEFAULT_SHADER;
        syncUrlInput();
        applyShader(DEFAULT_SHADER);
    }
});

// "打开文件" 按钮 → 触发本地文件选择
openFileBtn.addEventListener('click', () => fileInput.click());

// 本地文件选择后读取内容
fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
        const code = await file.text();
        textarea.value = code;
        clearFileSource();
        applyShader(code);
        showToast('✓ 已打开: ' + file.name);
    } catch (err) {
        console.error('读取文件失败', err);
        showToast('✗ 读取文件失败');
    }
    fileInput.value = '';
});

editBtn.addEventListener('click', toggleEditor);
playPauseBtn.addEventListener('click', togglePause);
editHintBtn.addEventListener('click', openHelp);
applyBtn.addEventListener('click', () => {
    if (currentSrc || currentJs) clearFileSource();
    applyShader(textarea.value);
});
closeBtn.addEventListener('click', closeEditor);
defaultBtn.addEventListener('click', () => {
    textarea.value = DEFAULT_SHADER;
    if (currentSrc || currentJs) clearFileSource();
});
