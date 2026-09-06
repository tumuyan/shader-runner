'use strict';
/**
 * 启动编排 + 全局监听（快捷键、窗口尺寸、可见性、帮助弹窗）。最后加载，此时前面所有模块都已就位。
 *
 * 依赖：前面全部模块
 */

// ============================================================
// 启动：选择数据来源（优先级 code > id > src > js > 默认）
// ============================================================
async function init() {
    // 只读清单（通过 <script> 标签，不受 CORS 限制），shader 本体按需加载
    await loadShaderIndex();
    populateShaderDropdown();

    let shaderCode = '';

    if (params.code) {
        // 从 URL hash 解压
        shaderCode = decodeShader(params.code);
    } else if (params.id) {
        // 从服务器获取
        fetchLoader.classList.add('show');
        try {
            const res = await fetch(API_PATH + '?id=' + encodeURIComponent(params.id));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            shaderCode = data.code || '';
        } catch (err) {
            console.error('获取 shader 失败', err);
            showToast('✗ 获取失败，使用默认 shader');
        } finally {
            fetchLoader.classList.remove('show');
        }
    } else if (params.src) {
        // 先拿清单校验存在性：不在清单里就不发那个注定 404 的请求
        const known = SHADER_MANIFEST.find(s => s.path === params.src);
        if (!known) {
            console.error('未找到内置 shader:', params.src);
            showToast('✗ 未找到: ' + params.src);
        } else {
            // 只加载这一个（<script> 注入，无需 fetch，避免 CORS 问题）
            const entry = await ensureShader(params.src);
            if (entry) {
                shaderCode = entry.code;
                currentSrc = params.src;
                selectOptionByValue(params.src);
                console.log('📄 已加载 shader 文件:', params.src);
            } else {
                showToast('✗ 加载失败: ' + params.src);
            }
        }
    } else if (params.js) {
        // 外部 JS。先校验协议，省得把 file:// / data: 塞进 <script src> 的行为
        // 因浏览器而异，静默失败最难排查。
        const v = validateJsUrl(params.js);
        if (v.error) {
            console.error('?js= 参数无效:', v.error);
            showToast('✗ ' + v.error);
        } else {
            const entry = await loadCustomShader(v.url);
            if (entry) {
                shaderCode = entry.code;
                currentJs = v.url;
                addCustomOption(v.url, entry.label);
                console.log('🌐 已加载外部 shader:', v.url);
            }
            // 失败提示由 loadCustomShader 给出，这里不再叠一层
        }
    }

    if (!shaderCode) shaderCode = DEFAULT_SHADER;

    textarea.value = shaderCode;
    currentCode = shaderCode;
    createProgram(shaderCode);
    resize();
    playPauseBtn.textContent = paused ? '▶' : '⏸';
    requestAnimationFrame(render);

    // 延后到此处提示：glInitFailed 在 renderer.js 置位，那时 toast 还没初始化
    if (glInitFailed) showToast('✗ WebGL 资源初始化失败，请刷新页面');
}

init();

// ============================================================
// 全局快捷键
// ============================================================
window.addEventListener('keydown', e => {
    const el = e.target;
    const tn = (el && el.tagName) ? el.tagName.toUpperCase() : '';
    // 正在输入：不劫持单键快捷键（否则在编辑器里敲 vec3 / float 中的 e 会直接关掉面板）
    const typing = tn === 'TEXTAREA' || tn === 'INPUT' || (el && el.isContentEditable === true);
    // 焦点在原生控件上时，单键语义属于该控件本身（空格展开下拉 / 激活按钮、
    // 字母键在 select 里跳转 option），一律不劫持
    const interactive = tn === 'BUTTON' || tn === 'A' || tn === 'SELECT'
        || tn === 'OPTION' || tn === 'SUMMARY';

    // Esc 优先且始终生效 —— 在编辑器里打字时同样期望它能关闭面板
    if (e.key === 'Escape') {
        if (helpModal.classList.contains('open')) {
            closeHelp();
        } else {
            if (!isPreview) closeEditor();
        }
        return;
    }
    if (typing || interactive) return;

    if (e.key === ' ') {
        e.preventDefault();
        togglePause();
    }
    if (e.key === 'e' || e.key === 'E') { if (!isPreview) toggleEditor(); }
});

window.addEventListener('resize', () => resize());

// 可见性（仅编辑模式）
document.addEventListener('visibilitychange', () => {
    // 切后台期间 rAF 不跑，render 无法逐帧累加，故回前台时一次性补偿这段空白。
    // 用增量累加（而非赋值），才能和 render 里的冻结逻辑叠加而不是互相覆盖。
    if (!document.hidden) {
        const n = performance.now() / 1000;
        if (lastTime) pauseOffset += n - lastTime;
        lastTime = n;
    }
    if (isPreview) return;
    // 时间补偿统一由 render 每帧累加，此处只切换状态。
    // 回前台只解除「本函数自己造成的」那次暂停：用户手动按的暂停必须原样保留，
    // 否则切个标签页回来动画就自己跑起来了，等于把用户的操作静默撤掉。
    if (document.hidden) {
        if (!paused) { paused = true; autoPausedByVisibility = true; }
    } else if (autoPausedByVisibility) {
        autoPausedByVisibility = false;
        paused = false;
    }
    playPauseBtn.textContent = paused ? '▶' : '⏸';
});

// ---- 帮助弹窗 ----
helpCloseBtn.addEventListener('click', closeHelp);
helpModal.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeHelp();
});

// ---- 自检：验证 lz-string 压缩解压是否正常 ----
const _t = 'void mainImage(out vec4 f){f=vec4(1);}';
const _c = LZString.compressToEncodedURIComponent(_t);
const _d = LZString.decompressFromEncodedURIComponent(_c);
window.__LZ_OK = _d === _t;
console.log('✅ ShaderToy 运行器 | 模式:', isPreview ? '预览' : '编辑');
console.log('📎 数据来源:', params.code ? 'URL hash (压缩)' : params.id ? '服务器'
    : params.src ? '文件: ' + params.src : params.js ? '外部 JS: ' + params.js : '默认');
if (params.maxSize) console.log('🔒 渲染分辨率限制:', params.maxSize + 'px (最大边)');
if (params.fpsCap > 0) console.log('🎯 帧率上限:', params.fpsCap + ' FPS');
if (params.autoPauseMs > 0) console.log('⏸ 自动暂停（毫秒）:', params.autoPauseMs);
console.log('🔧 lz-string 自检:', window.__LZ_OK ? '通过' : '失败');
