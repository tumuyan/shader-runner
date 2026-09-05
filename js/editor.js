'use strict';
/**
 * 编辑器面板的按键行为（Ctrl+Enter 应用 / Tab 缩进）与分享链接解码。
 *
 * 依赖：config.js（INDENT）、ui.js、state.js、catalog.js（applyShader / clearFileSource）、
 *       codec.js（decodeShader）、share.js（syncUrlInput）
 */

// 优先走 execCommand('insertText')：它会进原生撤销栈，Ctrl+Z 仍可用；
// 不可用时退回 setRangeText（丢撤销栈，但功能不丢）。
function replaceRange(text, start, end, selStart, selEnd) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
    if (!ok) {
        // setRangeText 不会派发 input 事件，而「清除内置 shader 来源标记」依赖它，
        // 不补发的话：改过代码后点分享仍会生成 ?src= 短链，用户改动被静默丢弃。
        textarea.setRangeText(text, start, end, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    textarea.setSelectionRange(selStart, selEnd);
}

// 把选区扩展到整行范围
function lineBounds(selStart, selEnd) {
    const v = textarea.value;
    const start = v.lastIndexOf('\n', selStart - 1) + 1;
    let end = v.indexOf('\n', selEnd);
    if (end === -1) end = v.length;
    return [start, end];
}

// 整块缩进 / 反缩进，返回内容是否发生变化
function shiftBlock(outdent) {
    const v = textarea.value;
    const selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;
    const [ls, le] = lineBounds(selStart, selEnd);
    const block = v.slice(ls, le);
    let headDelta = 0, totalDelta = 0;
    const out = block.split('\n').map((line, i) => {
        let delta = 0, result = line;
        if (outdent) {
            const m = line.match(/^ {1,4}/);
            const n = m ? m[0].length : 0;
            if (n > 0) { delta = -n; result = line.slice(n); }
        } else if (line.length > 0) {
            // 空行不缩进，避免留下无意义的尾随空格
            delta = INDENT.length;
            result = INDENT + line;
        }
        if (i === 0) headDelta = delta;
        totalDelta += delta;
        return result;
    }).join('\n');
    if (out === block) return false;
    // 选区起点正好在行首时保持在行首，让新插入的缩进落在选区内（与主流编辑器一致）
    const newStart = (selStart === ls) ? ls : Math.max(ls, selStart + headDelta);
    replaceRange(out, ls, le, newStart, selEnd + totalDelta);
    return true;
}

textarea.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        applyShader(textarea.value);
        return;
    }
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;

    const hasSel = textarea.selectionStart !== textarea.selectionEnd;
    if (e.shiftKey) {
        // 反缩进。无选区或无缩进可去时不拦截 —— Shift+Tab 仍是「移出焦点」的逃生通道
        if (hasSel && shiftBlock(true)) e.preventDefault();
        return;
    }
    e.preventDefault();
    if (hasSel) {
        shiftBlock(false);
    } else {
        const at = textarea.selectionStart;
        replaceRange(INDENT, at, at, at + INDENT.length, at + INDENT.length);
    }
});

// ---- 解码：把分享链接还原回代码 ----
decodeBtn.addEventListener('click', () => {
    const raw = encodedUrlInput.value.trim();
    if (!raw) { showToast('ℹ 请先生成分享链接'); return; }

    let extracted = raw;

    // 如果输入的是完整 URL，提取 hash 或 query 中的 code 参数
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
        const hashMatch = raw.match(/#(?:code|id)=([^&]+)/);
        if (hashMatch) {
            extracted = hashMatch[1];
        } else {
            const queryMatch = raw.match(/[?&]code=([^&#]+)/);
            if (queryMatch) {
                extracted = queryMatch[1];
            }
        }
    }

    // 尝试解码
    const decoded = decodeShader(decodeURIComponent(extracted));
    if (decoded) {
        // currentSrc 与 currentJs 都要清：漏掉后者，解码出来的代码会被后面那次
        // syncUrlInput() 判成「仍来自外部 JS」，生成的还是 ?js= 短链 —— 用户刚
        // 解码出来的代码在分享时被静默丢掉。
        if (currentSrc || currentJs) clearFileSource();
        textarea.value = decoded;
        syncUrlInput();
        showToast('✓ 解码成功');
        applyShader(decoded);
    } else {
        showToast('✗ 解码失败：无法识别或数据已损坏');
    }
});
