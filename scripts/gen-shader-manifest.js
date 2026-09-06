#!/usr/bin/env node
/**
 * 扫描 shader/ 目录下的 *.shader.js，生成 shader/manifest.js。
 *
 *   node scripts/gen-shader-manifest.js           # 生成 / 刷新清单
 *   node scripts/gen-shader-manifest.js --check   # 校验（CI 用，过期退出码 1）
 *
 * --check 会同时校验四件事：
 *   1. manifest.js 与 shader/ 目录内容一致，且是新格式（旧格式的 label 是现算的，
 *      比什么都能过 —— 放过去就是假绿）
 *   2. 每个 shader 文件的 path / label 写对了，且与 manifest 记录一致
 *   3. 已发布草稿没有「改了但忘了重新 release」（委托给 release-shader.js --check）
 *   4. 服务端写入防护（委托给 check-api.js）
 *   5. GLSL 运行校验（委托给 check-glsl.js）
 *
 * 零依赖，任何 Node 版本都能跑。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib/shader-build');

const checkOnly = process.argv.includes('--check');

/** 检查每个 shader 文件是否写对了 path / label / 是否注册到 __SHADER_REGISTRY__ */
function lint(paths) {
    const problems = [];
    for (const rel of paths) {
        const abs = L.abs(rel);
        if (!fs.existsSync(abs)) { problems.push(`${rel}: 文件不存在`); continue; }
        const src = fs.readFileSync(abs, 'utf8');
        if (!src.includes('__SHADER_REGISTRY__')) {
            problems.push(`${rel}: 没有注册到 window.__SHADER_REGISTRY__`);
        }
        const pm = src.match(/path\s*:\s*'([^']+)'/);
        if (!pm) {
            problems.push(`${rel}: 缺少 path 字段`);
        } else if (pm[1] !== rel) {
            problems.push(`${rel}: 内部 path 写的是 '${pm[1]}'，应为 '${rel}'`);
        }
        if (!/label\s*:\s*'((?:[^'\\]|\\.)*)'/.test(src)) problems.push(`${rel}: 缺少 label 字段`);
    }

    // label 已从产物搬进清单，于是多出一种新的过期方式：手工改了 .shader.js 的
    // label 却没重跑 add:refresh → 下拉列表显示旧名字。改动产物本身是人类的合法
    // 操作，所以这里只报错提醒，绝不自动改写任何一边。
    // 只有在清单本身就是新格式时这条比对才有意义：旧格式的 label 是拿产物现算的，
    // 跟产物比必然相等，比了也是白比（那种情况由 main() 单独报错）。
    const manifest = L.readManifest();
    if (manifest.format === 'entries') {
        const byPath = new Map(manifest.entries.map(e => [e.path, e.label]));
        for (const rel of paths) {
            if (!byPath.has(rel)) continue;          // 整条缺失由 --check 分支单独报
            const want = L.manifestEntry(rel).label;
            if (byPath.get(rel) !== want) {
                problems.push(`shader/manifest.js: '${rel}' 的 label 记的是 '${byPath.get(rel)}'，现应为 '${want}' —— 请运行 npm run add:refresh`);
            }
        }
    }
    return problems;
}

function main() {
    const paths = L.listShaders();

    if (checkOnly) {
        let bad = false;
        const manifest = L.readManifest();
        const current = manifest.format === 'missing' ? null : manifest.entries.map(e => e.path);
        if (manifest.format === 'paths') {
            // 旧格式（纯路径数组）的 label 是拿产物现算的，所以上面每条校验都会
            // 恰好通过 —— 不在这里拦一道，一个没刷新的清单能让 CI 全绿，
            // 而页面上的下拉却显示退化后的文件名。
            console.error('✗ shader/manifest.js 是旧格式（纯路径数组）：label 会退化成文件名，'
                + '且「清单未刷新」无法被检出。请运行: npm run add:refresh');
            bad = true;
        } else if (manifest.format === 'empty') {
            console.error('✗ shader/manifest.js 解析不出任何条目，请运行: npm run add:refresh');
            bad = true;
        }
        if (current === null) {
            console.error('✗ shader/manifest.js 不存在，请运行: npm run add:refresh');
            bad = true;
        } else if (current.join('\n') !== paths.join('\n')) {
            console.error('✗ shader/manifest.js 已过期，请运行: npm run add:refresh\n');
            const cur = new Set(current), want = new Set(paths);
            paths.filter(p => !cur.has(p)).forEach(p => console.error('  缺少: ' + p));
            current.filter(p => !want.has(p)).forEach(p => console.error('  多余: ' + p));
            bad = true;
        }

        const problems = lint(paths);
        if (problems.length) {
            problems.forEach(p => console.error('✗ ' + p));
            bad = true;
        }

        // 草稿与产物的同步状态（产物没有对应草稿是干净 clone 的常态，不算错）
        if (fs.existsSync(L.DRAFTS_DIR)) {
            const r = spawnSync(process.execPath, [path.join(__dirname, 'release-shader.js'), '--check'], { stdio: 'inherit' });
            if (r.status !== 0) bad = true;
        }

        // /api/shader 的写入防护：体积上限 / ID 校验 / 限流 / 存储配额，两个后端都验。
        // 放在 GLSL 校验前：它不需要浏览器，先跑可以先拿到一个便宜的红。
        const a = spawnSync(process.execPath, [path.join(__dirname, 'check-api.js')], { stdio: 'inherit' });
        if (a.status !== 0) bad = true;

        // 最后一关：GLSL 编译 + 链接校验。只校验 manifest 引用的 —— 没被引用的
        // 产物页面根本不会加载，让它把 CI 卡红没有意义。
        const g = spawnSync(process.execPath, [path.join(__dirname, 'check-glsl.js'), '--manifest'], { stdio: 'inherit' });
        if (g.status !== 0) bad = true;

        if (bad) process.exit(1);
        console.log(`✓ 校验通过（${paths.length} 个内置 shader）`);
        return;
    }

    const written = L.generateManifest();
    console.log(`✓ 已生成 shader/manifest.js（${written.length} 个内置 shader）`);
    written.forEach(p => console.log('  ' + p));
    const problems = lint(written);
    if (problems.length) {
        console.log('');
        problems.forEach(p => console.log('⚠ ' + p));
    }
}

main();
