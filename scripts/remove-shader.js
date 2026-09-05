#!/usr/bin/env node
'use strict';
/**
 * 把 shader 从内置列表移除：删除 shader/x.shader.js 并刷新 manifest。
 *
 *   npm run remove underwater               # 短名 / underwater.glsl / shader/underwater.shader.js 都行
 *   npm run remove underwater --dry-run     # 只演练（记得加 --，见下）
 *   npm run remove -- underwater --force    # 无对应草稿 / 产物含手工改动时强制删
 *
 * 与 add 对称：remove 之后草稿回到「未发布」状态，npm run add underwater 能原样加回来。
 *
 * 默认保护三条（都需要 `--force` 才放行，且放行前会打印警告）：
 *   1. 产物不是本工具生成的（无法反向导出，删了就没了）
 *   2. 没有对应草稿（这是唯一一份可运行代码）
 *   3. 产物含手工改动（草稿里没有那份改动）
 *
 * 绝不动 drafts/：草稿是未提交的手工资产，删掉无法恢复。
 */
const fs = require('fs');
const L = require('./lib/shader-build');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const force = flags.has('--force');

/** 计算一次移除动作（不写盘）。返回 { input, draft, target, action, reason?, warn? } */
function planOne(input) {
    const r = L.resolveDraftInput(input, true);
    const name = r.name;

    // 产物名以草稿 frontmatter 的 @name 为准；没有草稿时退回短名推断
    let draft = null, target;
    const drafts = L.listDrafts(true);
    if (r.file) draft = drafts.find(d => d.file === r.file) || null;
    if (draft) {
        // 产物名以草稿 frontmatter 的 @name 为准，不能直接用文件名推
        target = 'shader/' + draft.name + '.shader.js';
    } else if (!r.file && r.suggestions.length) {
        // 没找到草稿，但输入本身可能是个错别字 —— 别拿猜测去删文件
        return { input, draft: null, target: null, action: 'blocked', reason: L.notFoundMessage(input, r) };
    } else {
        target = 'shader/' + name + '.shader.js';
    }

    const out = { input, draft: draft ? draft.file : null, target, action: 'remove' };

    if (!fs.existsSync(L.abs(target))) {
        out.action = 'absent';       // 幂等：本来就不在内置列表里
        return out;
    }

    const parsed = L.parseShaderFile(fs.readFileSync(L.abs(target), 'utf8'));

    if (!parsed) {
        if (!force) return blocked(out, `${target} 不是本工具生成的，删除后无法重建，加 --force 删除`);
        return force_(out, 'remove-foreign', `${target} 不是本工具生成的，删除后无法重建`);
    }
    if (!draft) {
        const why = parsed.src
            ? `没有对应草稿（产物记录的源草稿是 ${parsed.src}）`
            : `没有对应草稿 drafts/${name}.glsl`;
        if (!force) {
            return blocked(out, `${target} ${why}，加 --force 删除\n`
                + `  想保留可编辑副本: npm run drafts:extract -- ${target}   # 先导出草稿再删`);
        }
        return force_(out, 'remove-orphan', why);
    }
    if (parsed.src !== draft.file) {
        if (!force) return blocked(out, `${target} 由 ${parsed.src} 生成，不是 ${draft.file}，加 --force 删除`);
        return force_(out, 'remove-foreign', `产物记录源为 ${parsed.src}`);
    }

    const st = L.draftState(draft);
    if (st.state === 'product-edited' || st.state === 'conflict') {
        if (!force) {
            return blocked(out, `${target} 含手工改动（草稿里没有），删除会丢失:\n`
                + `  保留改动: npm run drafts:extract -- ${target} --force   # 导回草稿\n`
                + `  直接删除: npm run remove -- ${name} --force`);
        }
        return force_(out, 'remove-edited', '产物含手工改动，已随文件一起删除');
    }
    // synced / draft-stale：产物内容都能由草稿重建（草稿保留），直接删
    return out;
}

function blocked(out, reason) { return { ...out, action: 'blocked', reason }; }
function force_(out, action, warn) { return { ...out, action, warn }; }

const VERB = {
    'remove': '已移除', 'remove-foreign': '已移除(非本工具生成)',
    'remove-orphan': '已移除(无草稿)', 'remove-edited': '已移除(含手工改动)'
};

function main() {
    if (!positional.length) {
        console.log('用法: npm run remove <短名|drafts/x.glsl|shader/x.shader.js> [--dry-run] [--force]');
        console.log('      npm run remove -- underwater --force     # 带 flag 时必须加 --');
        console.log('（只删 shader/*.shader.js 并刷新清单，绝不删 drafts/ 里的草稿）');
        process.exit(1);
    }

    const plans = positional.map(planOne);

    for (const p of plans) {
        if (p.action === 'blocked') {
            console.error(`✗ 跳过  ${p.target || p.input}（原因见下）`);
            console.error('        ' + p.reason.split('\n')[0]);
            p.reason.split('\n').slice(1).forEach(l => console.error('        ' + l.trim()));
            continue;
        }
        if (p.action === 'absent') {
            console.log(`• 无变化  ${p.target}（本来就不在内置列表里）`);
            continue;
        }
        if (p.warn) console.log(`⚠ ${p.warn}`);
        if (!dryRun) fs.unlinkSync(L.abs(p.target));
        console.log(`${dryRun ? '· 将移除' : '✓ ' + VERB[p.action]}  ${p.target}`
            + (p.draft ? `  ← ${p.draft}` : '  （无草稿）'));
        if (p.draft) console.log(`        草稿保留，重新加入: npm run add ${L.normalizeInput(p.draft)}`);
    }

    const blocked_ = plans.filter(p => p.action === 'blocked');
    const removed = plans.filter(p => p.action !== 'absent' && p.action !== 'blocked');

    if (removed.length && !dryRun) {
        const paths = L.generateManifest();
        console.log(`✓ 已刷新 shader/manifest.js（${paths.length} 个内置 shader）`);
    } else if (dryRun) {
        console.log('（--dry-run，未写入）');
    }

    // 任何一项被拦下就整体失败：避免「部分成功」被误读成全部成功
    if (blocked_.length) process.exit(1);
}

main();
