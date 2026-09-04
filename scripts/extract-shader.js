#!/usr/bin/env node
'use strict';
/**
 * 反向导出：把 shader/*.shader.js 还原成 drafts/*.glsl 草稿。
 *
 *   node scripts/extract-shader.js shader/x.shader.js [--name 草稿名] [--force] [--dry-run]
 *
 * 存在的意义：草稿不提交进仓库，干净 clone 出来的仓库只有产物。没有这个命令，
 * 下次想改某个已发布 shader（大概率是 AI 来改）就无从下手。
 * 配合 release 形成闭环：extract → 改 → release。
 */
const fs = require('fs');
const L = require('./lib/shader-build');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const opts = {};
argv.forEach((a, i) => { if (a === '--name' && argv[i + 1]) opts.name = argv[i + 1]; });
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--name'));

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

function main() {
    if (!positional.length) {
        console.error('用法: npm run drafts:extract -- shader/x.shader.js [--name 草稿名] [--force]');
        process.exit(1);
    }
    const target = positional[0];
    if (!L.SHADER_RE.test(target)) fail(`不是 .shader.js 文件: ${target}`);
    if (!fs.existsSync(L.abs(target))) fail(`产物不存在: ${target}`);

    const parsed = L.parseShaderFile(fs.readFileSync(L.abs(target), 'utf8'));
    if (!parsed) fail(`${target} 不是本工具生成的格式，无法反向导出（手工维护的产物请直接编辑）`);

    const name = opts.name || (parsed.src ? parsed.src.replace(/^.*\//, '').replace(L.GLSL_RE, '') : null)
        || target.replace(/^.*\//, '').replace(L.SHADER_RE, '');
    const out = 'drafts/' + name + '.glsl';

    if (fs.existsSync(L.abs(out)) && !flags.has('--force')) {
        fail(`${out} 已存在，加 --force 覆盖（会丢失现有草稿内容）`);
    }

    // 头部补一行 frontmatter 保留显示名，去掉后 release 回来的产物字节完全一致
    const head = parsed.label ? `// @label: ${parsed.label}\n\n` : '';
    const content = head + L.normalizeGlsl(parsed.code);

    if (flags.has('--dry-run')) {
        console.log(`（--dry-run）将写出 ${out}，${content.split('\n').length} 行`);
        return;
    }
    fs.mkdirSync(L.DRAFTS_DIR, { recursive: true });
    fs.writeFileSync(L.abs(out), content, 'utf8');
    console.log(`✓ 已导出  ${out}  ← ${target}${parsed.label ? '  [' + parsed.label + ']' : ''}`);

    if (!parsed.hash) {
        // 手工维护的老产物，没有指纹可比。首次 release 需要 --force 接管，之后即纳入追踪。
        console.log('  注意: 该产物没有指纹（手工维护），首次 release 需加 --force 接管');
    } else {
        // 指纹是对「剥掉 frontmatter 后的正文」算的，这里必须同样剥离后再比
        const back = L.sha1(L.normalizeGlsl(L.parseFrontmatter(content).body));
        console.log(back === parsed.hash
            ? '✓ 往返校验通过（重新 release 不会产生内容变化）'
            : `⚠ 往返校验不一致（产物 sha1=${parsed.hash}，回导后=${back}），请人工确认`);
    }
}

main();
