'use strict';
/**
 * 分享（压缩进 URL）与发布（上传服务器换短链）。
 *
 * 依赖：config.js（API_PATH）、state.js（currentSrc / currentJs）、ui.js、codec.js
 * 被依赖：catalog.js（syncUrlInput）、editor.js（解码后会同步输入框）
 */

// 把当前状态写成可复制的链接，同步到编辑器里的 URL 输入框
function syncUrlInput() {
    const code = textarea.value.trim();
    if (!code || code === DEFAULT_SHADER.trim()) {
        encodedUrlInput.value = '';
        return;
    }
    // 如果当前 shader 来自内置文件或外部 JS，生成 ?src= / ?js= 短链接
    if (currentSrc || currentJs) {
        encodedUrlInput.value = buildSourceUrl();
        return;
    }
    const url = buildShareUrl('preview', code) + maxSizeQuery() + fpsCapQuery() + autoPauseQuery();
    encodedUrlInput.value = url;
}

// ---- 分享：压缩到 URL hash ----
function doShare(mode) {
    // 与 syncUrlInput() 一样用 trim 后的值：否则首尾有空白时，「复制走的链接」
    // 和「框里显示的链接」不是同一份代码。
    const url = buildShareUrl(mode, textarea.value.trim()) + maxSizeQuery() + fpsCapQuery() + autoPauseQuery();
    return copyText(url, '✓ ' + (mode==='preview'?'预览':'编辑') + ' 链接已复制');
}

// 有内置/外部来源时分享的是 ?src= / ?js= 短链，否则才把整份代码压进 URL
shareBtn.addEventListener('click', () => {
    if (currentSrc || currentJs) {
        copyText(buildSourceUrl(), '✓ 来源链接已复制');
    } else {
        doShare('preview');
    }
});

shareUrlBtn.addEventListener('click', () => {
    syncUrlInput();
    if (currentSrc || currentJs) {
        copyText(buildSourceUrl(), '✓ 来源链接已复制');
    } else {
        doShare('edit');
    }
});

// ---- 发布：上传到服务器换固定短链 ----
// 统一 API 路径（Netlify 通过重写规则映射到 /.netlify/functions/shader）
async function uploadShader(code) {
    const label = '上传中...';
    uploadBtn.textContent = label;
    uploadBtn.disabled = true;
    try {
        const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code }),
        });
        const bodyText = await res.text();
        if (!res.ok) {
            let detail = '';
            try { const e = JSON.parse(bodyText); detail = e.error || ''; } catch (e2) {}
            throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
        }
        const data = JSON.parse(bodyText);
        const url = buildServerUrl('preview', data.id);
        // 服务端已发布成功，复制失败绝不能报成「发布失败」
        const copied = await copyTextAsync(url);
        if (copied) {
            showToast('已发布，预览链接已复制');
        } else {
            encodedUrlInput.value = url;   // 兜底：让用户能手动复制
            showToast('已发布，但复制失败；链接已填入编辑器输入框，请手动复制');
        }
    } catch (err) {
        console.error('发布失败:', err);
        showToast('☁ 发布失败 (' + err.message + ')，已改用本地分享（URL 会较长）');
        doShare('preview');
    } finally {
        uploadBtn.textContent = '发布';
        uploadBtn.disabled = false;
    }
}
uploadBtn.addEventListener('click', () => uploadShader(textarea.value));
shareServerBtn.addEventListener('click', () => uploadShader(textarea.value));
