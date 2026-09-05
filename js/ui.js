'use strict';
/**
 * DOM 引用与纯 UI 原子操作。
 *
 * 元素 id 的权威清单在 index.html，这里集中取一次：其它模块直接用这些常量，
 * 不要再各写一遍 getElementById。
 *
 * 依赖：无（排在最前）。
 * 被依赖：几乎所有模块都用 showToast / toggleEditor / copyText。
 */

const overlay = document.getElementById('inputOverlay');
const textarea = document.getElementById('shaderCode');
const applyBtn = document.getElementById('applyBtn');
const closeBtn = document.getElementById('closeBtn');
const defaultBtn = document.getElementById('defaultBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const editBtn = document.getElementById('editBtn');
const editHintBtn = document.getElementById('editHintBtn');
const shareBtn = document.getElementById('shareBtn');
const shareServerBtn = document.getElementById('shareServerBtn');
const shareUrlBtn = document.getElementById('shareUrlBtn');
const uploadBtn = document.getElementById('uploadBtn');
const decodeBtn = document.getElementById('decodeBtn');
const maxSizeInput = document.getElementById('maxSizeInput');
const fpsCapInput = document.getElementById('fpsCapInput');
const autoPauseInput = document.getElementById('autoPauseInput');
const resDisplay = document.getElementById('resDisplay');
const fpsDisplay = document.getElementById('fpsDisplay');
const encodedUrlInput = document.getElementById('encodedUrlInput');
const shaderSelector = document.getElementById('shaderSelector');
const openFileBtn = document.getElementById('openFileBtn');
const fileInput = document.getElementById('fileInput');
const toast = document.getElementById('toast');
const fetchLoader = document.getElementById('fetchLoader');
const helpModal = document.getElementById('helpModal');
const helpCloseBtn = document.getElementById('helpCloseBtn');

// ---- Toast ----
let toastTimer = null;
function showToast(msg) {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ---- 统一剪贴板写入 ----
// navigator.clipboard 在非安全上下文（http:// 局域网、file://）下可能整个不存在，
// 此时 writeText 会同步抛 TypeError 而非返回 rejected promise —— 只写 .catch() 是接不住的，
// 必须用 try/catch 包住调用再落到 execCommand 兜底。
function copyTextAsync(text) {
    const fallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (err) {
            return false;
        }
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true, () => fallback());
        }
    } catch (err) { /* 同步抛错，落到兜底 */ }
    return Promise.resolve(fallback());
}

function copyText(text, okMsg) {
    return copyTextAsync(text).then(ok => {
        showToast(ok ? okMsg : '✗ 复制失败，请手动选中复制');
        return ok;
    });
}

// ---- 编辑器面板 ----
function toggleEditor() {
    overlay.classList.toggle('open');
    if (overlay.classList.contains('open')) textarea.focus();
}
function closeEditor() { overlay.classList.remove('open'); }

// ---- 帮助弹窗 ----
function openHelp() { helpModal.classList.add('open'); }
function closeHelp() { helpModal.classList.remove('open'); }
