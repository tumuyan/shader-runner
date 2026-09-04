#!/usr/bin/env node
/**
 * 扫描 shader/ 目录下的 *.shader.js，生成 shader/manifest.js。
 *
 *   node scripts/gen-shader-manifest.js           # 生成 / 刷新清单
 *   node scripts/gen-shader-manifest.js --check   # 校验（CI 用，过期退出码 1）
 *
 * --check 会同时校验三件事：
 *   1. manifest.js 与 shader/ 目录内容一致
 *   2. 每个 shader 文件的 path / label 写对了
 *   3. 已发布草稿没有「改了但忘了重新 release」（委托给 release-shader.js --check）
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
    return problems;
}

function main() {
    const paths = L.listShaders();

    if (checkOnly) {
        let bad = false;
        const current = L.readManifestPaths();
        if (current === null) {
            console.error('✗ shader/manifest.js 不存在，请运行: npm run release -- --refresh');
            bad = true;
        } else if (current.join('\n') !== paths.join('\n')) {
            console.error('✗ shader/manifest.js 已过期，请运行: npm run release -- --refresh\n');
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
