#!/usr/bin/env node
'use strict';
/**
 * 把草稿 GLSL 组装成 shader/*.shader.js 并刷新 manifest。
 *
 *   npm run add underwater            # 短名 / underwater.glsl / drafts/underwater.glsl 都行
 *   npm run add -- x --label "名"     # 覆盖显示名
 *   npm run add:all                   # 仅重组装「已发布过」的草稿，绝不新增发布
 *   npm run status                    # 只读：列出草稿六态
 *   npm run add:check                 # 有「草稿已改但未重新 add」则退出码 1（npm run check 的一步）
 *   npm run add:refresh               # 只重建 manifest
 *
 * 面向 AI 调用：零交互、幂等（内容不变则产物字节不变）、失败给一句可操作原因。
 * 绝不会在未经显式调用时发布任何东西 —— 没有任何 hook 会自动跑这个脚本。
 */
const fs = require('fs');
const L = require('./lib/shader-build');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--') && !a.includes('=')));
const opts = {};
argv.forEach((a, i) => {
    if (/^--(label|name)$/.test(a) && argv[i + 1]) opts[a.slice(2)] = argv[i + 1];
});
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(label|name)$/.test(argv[i - 1])));

/** 读取草稿：接受短名 / 完整路径 / 产物路径，统一经 resolveDraftInput 归一 */
function readDraft(input) {
    const r = L.resolveDraftInput(input, true);   // 显式指定时允许 `_` 模板
    if (!r.file) fail(L.notFoundMessage(input, r));
    return L.readDraftFile(r.file);
}

function fail(msg) {
    if (flags.has('--json')) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
        console.error('✗ ' + msg);
    }
    process.exit(1);
}

/** 组装单个草稿 → 写产物。返回描述结果的对象。 */
function releaseOne(draft, o) {
    const name = o.name || draft.name;
    const label = o.label || draft.label;
    const target = 'shader/' + name + '.shader.js';
    const hash = L.sha1(draft.code);
    const result = { draft: draft.file, target, label, hash, action: 'create' };

    if (fs.existsSync(L.abs(target))) {
        const parsed = L.parseShaderFile(fs.readFileSync(L.abs(target), 'utf8'));
        if (!parsed) {
            if (!o.force) return { ...result, action: 'blocked', reason: `${target} 不是本工具生成的，加 --force 覆盖（会丢失原有内容）` };
            result.action = 'overwrite-foreign';
        } else if (parsed.src !== draft.file) {
            if (!o.force) return { ...result, action: 'blocked', reason: `${target} 由 ${parsed.src} 生成，加 --force 改为由 ${draft.file} 生成` };
            result.action = 'overwrite-foreign';
        } else if (parsed.hash === null) {
            if (!o.force) return { ...result, action: 'blocked', reason: `${target} 没有指纹（手工维护），加 --force 接管` };
            result.action = 'overwrite-foreign';
        } else {
            const actual = L.sha1(L.normalizeGlsl(parsed.code));
            if (actual === hash) {
                // 草稿与产物内容已一致，只是头部指纹是旧的（典型：刚 extract 导回过）。
                // 刷新指纹没有任何数据丢失风险，直接放行，不必 --force。
                result.action = parsed.hash === hash ? 'unchanged' : 'refresh';
            } else if (actual !== parsed.hash && !o.force) {
                // 产物被人手工改过，且与草稿内容不同 —— 绝不静默覆盖，那是数据丢失
                return {
                    ...result, action: 'blocked',
                    reason: `${target} 含手工改动（产物已不是生成的样子）\n`
                        + `  保留手工改动: npm run drafts:extract -- ${target} --force   # 导回草稿，然后 release\n`
                        + `  丢弃手工改动: npm run add -- ${draft.file} --force          # 用草稿覆盖`
                };
            } else {
                result.action = 'update';   // 草稿是权威（产物没被改过，或已 --force）
            }
        }
    }

    if (!o.dryRun && result.action !== 'unchanged') {
        fs.writeFileSync(L.abs(target), L.renderShaderFile({
            src: draft.file, hash, path: target, label, code: draft.code
        }), 'utf8');
    }
    return result;
}

const VERB = {
    create: '新增', update: '更新', unchanged: '无变化', refresh: '刷新指纹',
    'overwrite-foreign': '覆盖', blocked: '跳过'
};

function showStatus(json) {
    const st = L.collectStatus();
    if (json) { console.log(JSON.stringify(st, null, 2)); return; }
    if (!st.drafts.length && !st.orphans.length) { console.log('（drafts/ 为空）'); return; }
    for (const d of st.drafts) {
        const tag = {
            unreleased: '未发布    ', synced: '已同步    ', foreign: '未追踪    ',
            'draft-stale': '草稿有更新', 'product-edited': '产物手工改', conflict: '冲突      '
        }[d.state];
        let note = '';
        if (d.state === 'unreleased') note = `→ 将新增 ${d.target}`;
        if (d.state === 'foreign') note = `→ ${d.target} 非本工具生成，add 需 --force`;
        if (d.state === 'draft-stale') note = `→ ${d.target}（运行 npm run add ${d.name} 更新）`;
        if (d.state === 'product-edited') note = `→ ${d.target} 含手工改动，extract 导回或 --force 覆盖`;
        if (d.state === 'conflict') note = `→ 草稿与产物都改过，需人工合并`;
        console.log(`${tag}  ${d.file.padEnd(34)}${note}`);
    }
    if (st.orphans.length) {
        console.log(`\n另有 ${st.orphans.length} 个已发布 shader 没有对应草稿`
            + (flags.has('--orphans') ? '：' : '（加 --orphans 列出；可用 drafts:extract 导出）'));
        if (flags.has('--orphans')) st.orphans.forEach(p => console.log('  ' + p));
    }
}

function main() {
    // ---- --status：只读 ----
    if (flags.has('--status')) return showStatus(flags.has('--json'));

    // ---- --check：CI 用 ----
    // 只有「草稿改了却没重新 release」算硬失败：那是有明确补救动作的遗漏。
    // 「产物被手工改过」是人类合法操作，只警告不失败，否则手工编辑会被 CI 一直报警。
    if (flags.has('--check')) {
        const st = L.collectStatus();
        const stale = st.drafts.filter(d => d.state === 'draft-stale');
        const edited = st.drafts.filter(d => d.state === 'product-edited');
        const conflict = st.drafts.filter(d => d.state === 'conflict');

        if (stale.length) {
            console.error(`✗ 有 ${stale.length} 个草稿改动后未重新 add：`);
            stale.forEach(d => console.error(`  ${d.file} → ${d.target}`));
            console.error('\n运行: npm run add:all   或   npm run add -- <草稿>');
            process.exit(1);
        }
        if (conflict.length) {
            console.error(`✗ 有 ${conflict.length} 个草稿与产物都改过，需人工合并：`);
            conflict.forEach(d => console.error(`  ${d.file} ↔ ${d.target}`));
            process.exit(1);
        }
        edited.forEach(d => console.warn(`⚠ ${d.target} 含手工改动（未同步回草稿）`));
        console.log('✓ 草稿与产物无待处理变更');
        return;
    }

    // ---- --refresh：只重建清单，不动任何产物 ----
    // 场景：手工增删/重命名了 shader/*.shader.js 之后，让清单跟上目录。
    if (flags.has('--refresh')) {
        if (flags.has('--dry-run')) { console.log('（--dry-run，未写入）'); return; }
        const paths = L.generateManifest();
        console.log(`✓ 已重建 shader/manifest.js（${paths.length} 个内置 shader）`);
        return;
    }

    // ---- --all：只重组装已发布过的 ----
    if (flags.has('--all')) {
        const targets = L.collectStatus().drafts.filter(d => d.state === 'synced' || d.state === 'draft-stale');
        if (targets.length) {
            const results = targets.map(d => releaseOne(readDraft(d.file), { dryRun: flags.has('--dry-run') }));
            results.forEach(r => {
                console.log(`${VERB[r.action].padEnd(8)}${r.target}  ← ${r.draft}`);
                if (r.action === 'blocked') console.log('        ' + r.reason.split('\n')[0]);
            });
        } else {
            console.log('（没有已发布的草稿）');
        }
        // 清单必须无条件刷新：即使没有要重组装的草稿，也可能有被手工删除的产物
        // 需要从清单里清掉（早期版本在这里提前 return，导致清单漂移无法修复）。
        if (!flags.has('--dry-run')) L.generateManifest();
        return;
    }

    // ---- 无参数：默认显示状态。必须是只读的默认动作 —— 绝不是写操作，
    // 否则 npm 吞掉 flag 时（npm run add:all 写成 npm run add --all）就会意外改动文件。
    if (!positional.length) {
        showStatus(flags.has('--json'));
        if (!flags.has('--json')) {
            console.log('\n用法: npm run add <短名|drafts/x.glsl> [--label "名称"] [--name 产物名]');
            console.log('      npm run add:all | add:check | add:refresh | status | check | remove');
            console.log('（出现 flag 时必须加 -- 分隔符：npm run add -- x --label "名称"）');
        }
        return;
    }

    // ---- 一个或多个草稿 ----
    // --label / --name 是单值选项，多草稿时使用会让人以为逐个生效，直接拒绝。
    if (positional.length > 1 && (opts.label || opts.name)) {
        fail(`--label / --name 只能用于单个草稿（这次传了 ${positional.length} 个）。把名称写进草稿的 frontmatter 更稳妥。`);
    }

    const results = positional.map(f => releaseOne(readDraft(f), {
        label: opts.label, name: opts.name,
        dryRun: flags.has('--dry-run'), force: flags.has('--force')
    }));

    const blocked = results.filter(r => r.action === 'blocked');
    if (flags.has('--json')) {
        console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    } else {
        results.forEach(r => {
            if (r.action === 'blocked') {
                console.error(`✗ 跳过  ${r.target}  ← ${r.draft}（原因见下）`);
            } else {
                console.log(`${r.action === 'unchanged' ? '✓ 无变化' : '✓ ' + VERB[r.action]}  ${r.target}  ← ${r.draft}  [${r.label}]`);
            }
        });
    }

    // 有任何一个被拦下就整体失败，避免「部分成功」被误当成全部成功。
    // 但成功的那部分已经写盘了，manifest 必须跟上再退出，否则清单与目录不一致。
    if (blocked.length) {
        if (!flags.has('--dry-run')) L.generateManifest();
        fail(blocked.map(b => b.reason).join('\n'));
    }

    if (flags.has('--dry-run')) {
        if (!flags.has('--json')) console.log('（--dry-run，未写入）');
        return;
    }
    const paths = L.generateManifest();
    if (!flags.has('--json')) console.log(`✓ 已刷新 shader/manifest.js（${paths.length} 个内置 shader）`);
}

main();
