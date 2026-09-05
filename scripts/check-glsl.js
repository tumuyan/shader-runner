#!/usr/bin/env node
/**
 * GLSL 运行校验 —— 判断 shader 能不能在浏览器里真的跑起来。
 *
 *   node scripts/check-glsl.js                    # 校验 manifest 引用的全部（默认）
 *   node scripts/check-glsl.js --manifest         # 同上，显式写出（npm run check 走这条）
 *   node scripts/check-glsl.js --all              # shader/ 下全部，含未被 manifest 引用的
 *   node scripts/check-glsl.js --drafts-only      # 只校验 drafts/*.glsl（npm run draft:check）
 *   node scripts/check-glsl.js rain aurora        # 指定若干，短名 / 路径都行（优先于上面三个）
 *   node scripts/check-glsl.js --backend glslang  # 指定后端（默认 browser，不可用时自动回退）
 *   node scripts/check-glsl.js --require          # 后端不可用时按失败处理（CI 用）
 *   node scripts/check-glsl.js --self-test        # 环境体检：后端是否真的可用（CI setup 用）
 *   node scripts/check-glsl.js --allow-fallback   # 允许在 CI 下回退到弱后端（默认不允许）
 *
 * --all / --manifest / --drafts-only 三个集合模式互斥；未知选项一律报错，不静默丢弃。
 *
 * 两个后端，优先级明确：
 *   browser（权威）真 WebGL2 上下文里编译 + 链接 + 渲染多帧，用的就是浏览器的 ANGLE
 *   glslang（回退）静态编译校验；它只是另一个实现，结论不等价于「能运行」，
 *             所以只把硬错误当失败，已证实与浏览器分歧的模式降级为警告
 *
 * 权威性是本工具的核心：早期版本直接把 glslang 的结论当结论，结果把浏览器里
 * 跑得好好的 shader 判成失败。现在有浏览器就用浏览器，没有才回退，且回退时
 * 如实标注结论强度较低。
 *
 * 只报为警告、不算失败：画面偏暗/全黑。渐入型 shader（the-universe-within 在
 * t<1 时接近全黑）、依赖 iChannel 的 shader 都可能合法地偏暗，判失败会误伤。
 *
 * 失败退出码 1。后端都不可用时默认跳过并退出 0（它们是 devDependency，不该让
 * 没装的人红）；CI=true 或 --require 会把「跳过」也判为失败。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib/shader-build');
const W = require('./lib/glsl-wrap');
const backendBrowser = require('./lib/glsl-backend-browser');
const backendGlslang = require('./lib/glsl-backend-glslang');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/**
 * 位置参数（文件名）必须排除「带值的选项」的取值 —— 否则
 * `--backend glslang` 里的 glslang 会被当成文件名去找 shader/glslang.shader.js。
 * 两者都支持：`--backend glslang` 和 `--backend=glslang`。
 */
const VALUED = new Set(['--backend']);

/**
 * 除带值的 --backend 外，全部已知选项。
 *
 * 未知选项一律拒绝，绝不静默丢弃：--manifestt 这种拼写错误如果当没看见，
 * 就会变成「按默认集跑完还全绿」—— 选项是幻觉，绿灯也是幻觉。
 */
const KNOWN_FLAGS = new Set([
    '--all', '--manifest', '--drafts-only', '--require', '--self-test', '--allow-fallback',
]);

const files = [];
let backendOpt = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) { if (argv[i + 1] !== undefined) backendOpt = argv[++i]; continue; }
    const eq = a.indexOf('=');
    if (eq > 0 && VALUED.has(a.slice(0, eq))) { backendOpt = a.slice(eq + 1); continue; }
    if (!a.startsWith('--')) { files.push(a); continue; }
    if (!KNOWN_FLAGS.has(a)) {
        process.stderr.write(`✗ 未知选项: ${a}\n`);
        process.stderr.write(`  可选: ${[...KNOWN_FLAGS].join('  ')}  --backend <browser|glslang>\n`);
        process.exit(1);
    }
}

const wantAll = has('--all');
const wantManifest = has('--manifest');
const wantDraftsOnly = has('--drafts-only');
const requireBackend = has('--require') || !!process.env.CI;
const allowFallback = has('--allow-fallback');

/**
 * 三个集合选择模式互斥，且必须都是「真选项」而不是「没传参数时恰好是的」默认值。
 * npm run check / draft:check 显式传了它们，若这里不认，就只是被静默丢弃，
 * 哪天默认值一改，CI 会毫无提示地换校验对象。
 */
const modes = [['--all', wantAll], ['--manifest', wantManifest], ['--drafts-only', wantDraftsOnly]]
    .filter(([, on]) => on).map(([n]) => n);
if (modes.length > 1) {
    process.stderr.write(`✗ ${modes.join(' 与 ')} 互斥（一次只能选一个集合）\n`);
    process.exit(1);
}

const MAX_ERRORS = 8;      // 每条 shader 最多打印这么多条
const DARK_RATIO = 0.02;   // 非黑像素占比低于此值提示「画面几乎全黑」
const wantSelfTest = has('--self-test');

/**
 * 环境体检用的样本：一个必然正确的 shader，和三个必然错误的 shader。
 * 用它们验证「后端真的可用」，而不是验证仓库里的 shader —— 后者失败可能
 * 只是代码有问题，不能用来判断环境装好没有。
 */
const SELF_TEST_SAMPLES = {
    good: 'void mainImage(out vec4 o, in vec2 c){ o = vec4(c / iResolution.xy, 0.5, 1.0); }',
    bad: [
        ['语法错', 'void mainImage(out vec4 o, in vec2 c){ float x = 1.0\n o = vec4(x); }'],
        ['未定义标识符', 'void mainImage(out vec4 o, in vec2 c){ o = vec4(definitelyNotDefined); }'],
        ['缺 mainImage', 'float helper(){ return 1.0; }'],
    ],
};

/** 命令行输入 → 校验目标：产物优先，其次草稿 */
function resolveTarget(input) {
    const name = L.normalizeInput(input);
    if (!name) return null;
    const shaderPath = 'shader/' + name + '.shader.js';
    if (fs.existsSync(L.abs(shaderPath))) return { kind: 'shader', file: shaderPath };
    const draftPath = 'drafts/' + name + '.glsl';
    if (fs.existsSync(L.abs(draftPath))) return { kind: 'draft', file: draftPath };
    return null;
}

function loadTarget(rel, kind) {
    const text = fs.readFileSync(L.abs(rel), 'utf8');
    if (kind === 'draft') {
        const d = L.readDraftFile(rel);
        return { label: rel, code: d.code };
    }
    const code = L.extractShaderCode(text);
    if (code === null) return { label: rel, error: '无法从产物中提取 code（模板字符串格式不符）' };
    const lm = text.match(/label\s*:\s*'((?:[^'\\]|\\.)*)'/);
    return {
        label: lm ? lm[1].replace(/\\'/g, "'") + '  (' + rel + ')' : rel,
        code
    };
}

function collectTargets() {
    const out = [], seen = new Set();
    const push = (rel, kind) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        out.push(loadTarget(rel, kind));
    };

    if (files.length) {
        for (const f of files) {
            const t = resolveTarget(f);
            if (!t) {
                out.push({
                    label: f,
                    error: `找不到目标（应为 shader/${L.normalizeInput(f)}.shader.js 或 drafts/${L.normalizeInput(f)}.glsl）`
                });
            } else {
                push(t.file, t.kind);
            }
        }
        return out;
    }

    // 只校验草稿（npm run draft:check）。这是独立模式而不是「额外加进来」的开关：
    // 后者跟位置参数撞在一起时谁生效说不清，实际实现里 --drafts 被位置参数分支
    // 静默吞掉了 —— 命令看起来生效，其实没跑。
    if (wantDraftsOnly) {
        L.listDrafts(false).forEach(d => push(d.file, 'draft'));
        return out;
    }

    let paths;
    if (wantAll) {
        paths = L.listShaders();
    } else {
        // --manifest 与「什么都不传」走同一条路：没被引用的产物页面根本不加载，
        // 让它把 CI 卡红没有意义。
        paths = L.readManifestPaths();
        if (paths === null) {
            process.stderr.write('✗ shader/manifest.js 不存在，无法按清单校验（先跑: npm run add:refresh）\n');
            process.exit(1);
        }
    }
    paths.forEach(p => push(p, 'shader'));
    return out;
}

/** 挑后端：显式指定 > 浏览器可用 > glslang 可用。调用方保证 targets 都已成功加载。 */
async function runBackend(targets) {
    const order = [];
    if (backendOpt === 'glslang') order.push(['glslang', backendGlslang]);
    else if (backendOpt && backendOpt !== 'browser') {
        process.stderr.write(`✗ 未知后端: ${backendOpt}（可选 browser / glslang）\n`);
        process.exit(1);
    } else {
        order.push(['browser', backendBrowser], ['glslang', backendGlslang]);
    }

    for (const [name, backend] of order) {
        const r = await backend.check(targets);
        if (r.skip) {
            console.log(`· ${name} 后端不可用：${r.skip}`);
            continue;
        }
        if (r.fatal) {
            // fatal 与 skip 说的是同一件事：这个后端干不了这活。都继续试下一个 ——
            // browser 起不来时 glslang 往往还能给出结论，直接退出白白丢掉。
            // 该拦的地方有专门一道：下面「CI 不允许静默降级」照旧会判红。
            console.log(`· ${name} 后端启动失败：${r.fatal}`);
            continue;
        }
        return { name, ...r };
    }
    return null;
}

function report(backendName, out, targets) {
    const byId = new Map();
    if (out && out.results) out.results.forEach(r => byId.set(r.id, r));

    let failed = 0, warned = 0;
    for (const t of targets) {
        if (t.error) {
            console.log('✗ ' + t.label + '\n    ' + t.error);
            failed++;
            continue;
        }
        const r = byId.get(t.label);
        if (!r) { console.log('✗ ' + t.label + '\n    后端未返回结果'); failed++; continue; }

        if (backendName === 'browser') {
            if (r.stage !== 'ok') {
                console.log(`✗ ${t.label}  [${r.stage === 'compile' ? '编译失败' : '链接失败'}]`);
                String(r.log || '').trim().split('\n').slice(0, MAX_ERRORS)
                    .forEach(l => console.log('    ' + l.trim()));
                failed++;
                continue;
            }
            // 取最好（非黑占比最高）的一帧：多个采样时刻只要有一个亮就够了，
            // 渐入型 shader 在 t 很小时本就该是黑的。
            const best = r.means.reduce((a, b) => (b.nonBlack > a.nonBlack ? b : a));
            if (best.nonBlack < DARK_RATIO) {
                console.log(`⚠ ${t.label}  画面几乎全黑（最好一帧非黑像素 ${(best.nonBlack * 100).toFixed(1)}%，均值 ${best.mean}）`);
                warned++;
            } else {
                console.log(`✓ ${t.label}`);
            }
            continue;
        }

        // glslang
        if (r.hard.length) {
            console.log('✗ ' + t.label);
            r.hard.slice(0, MAX_ERRORS).forEach(e => console.log('    ' + e));
            if (r.hard.length > MAX_ERRORS) console.log(`    … 另有 ${r.hard.length - MAX_ERRORS} 条`);
            failed++;
        } else if (r.soft.length) {
            console.log(`⚠ ${t.label}  仅 glslang 过严类问题，浏览器不受影响`);
            r.soft.slice(0, MAX_ERRORS).forEach(e => console.log('    ' + e));
            warned++;
        } else {
            console.log('✓ ' + t.label);
        }
    }
    return { failed, warned };
}

/**
 * 环境体检：确认后端真的能干活，而不只是「装上了」。
 *
 * 光检查二进制存不存在是不够的 —— 缺系统库时 Chromium 能装上、启动即崩；
 * 缺执行位时 glslangValidator 就在那儿却跑不起来。真跑一次才算数。
 * 而且必须正反都验：只跑一个正确 shader，后端「无论什么都返回通过」也能蒙混过关。
 */
async function selfTest() {
    const targets = [
        { label: 'sample-good', code: SELF_TEST_SAMPLES.good },
        ...SELF_TEST_SAMPLES.bad.map(([name, code]) => ({ label: 'bad-' + name, code })),
    ];
    let bad = false, available = 0;

    for (const [name, backend] of [['browser', backendBrowser], ['glslang', backendGlslang]]) {
        const r = await backend.check(targets);
        if (r.skip) {
            console.log(`· ${name}：不可用 — ${r.skip}`);
            // browser 是权威后端，它不可用就意味着校验只能靠弱后端 —— 这必须是
            // setup 阶段的硬失败，否则 CI 会静默降级还自认为装好了。
            if (name === 'browser') { console.log('✗ browser 后端不可用，环境不完整'); bad = true; }
            continue;
        }
        if (r.fatal) { console.log(`✗ ${name}：启动失败 — ${r.fatal}`); bad = true; continue; }
        available++;

        const byId = new Map(r.results.map(x => [x.id, x]));
        const good = byId.get('sample-good');
        const problems = [];

        const goodOk = name === 'browser' ? good && good.stage === 'ok' : good && !good.hard.length;
        if (!goodOk) problems.push('正确的 shader 没被判通过');

        for (const [label] of SELF_TEST_SAMPLES.bad) {
            const x = byId.get('bad-' + label);
            const caught = name === 'browser' ? x && x.stage !== 'ok' : x && x.hard.length > 0;
            if (!caught) problems.push(`有问题的 shader 被漏掉: ${label}`);
        }

        if (problems.length) {
            console.log(`✗ ${name}：${problems.join('；')}`);
            bad = true;
        } else {
            const extra = r.renderer ? `  ${r.version} · ${r.renderer}` : '';
            console.log(`✓ ${name}：工作正常${extra}`);
        }
    }
    if (bad || available === 0) process.exit(1);
    console.log('✓ 环境自检通过');
}

async function main() {
    // 包装器漂移会让「通过」变成假阳性，先自查
    const drift = W.verifyAgainstRuntime();
    if (!drift.ok) {
        process.stderr.write('✗ GLSL 包装器已漂移，校验结果不可信：\n');
        drift.problems.forEach(p => process.stderr.write('  ' + p + '\n'));
        process.stderr.write('  请让 scripts/lib/glsl-wrap.js 与 js/renderer.js 重新一致。\n');
        process.exit(1);
    }

    if (wantSelfTest) { await selfTest(); return; }

    const targets = collectTargets();
    if (!targets.length) { console.log('· 没有需要校验的 shader'); return; }

    // 加载失败与后端可用性是两件事，必须在调后端之前就分开判定：
    //   读不出来源文件 → 硬失败，跟有没有后端无关（拼错文件名不能绿灯）
    //   读得出来但没后端 → 按 requireBackend 决定「跳过」还是「失败」
    // 混在一起判（上版就是这么写的）会把后者的 shader 也算进「无法加载」：
    // 报数虚高，还让非 CI 下本该跳过的场景变成失败。
    const unloadable = targets.filter(t => t.error);
    if (unloadable.length) {
        report(null, null, unloadable);
        console.log('');
        console.log(`✗ ${unloadable.length} / ${targets.length} 个目标无法加载，GLSL 校验中断`);
        process.exit(1);
    }

    const out = await runBackend(targets);
    if (!out) {
        console.log('⚠ GLSL 校验已跳过：没有可用的后端');
        if (requireBackend) process.exit(1);
        return;
    }

    // CI 下不允许静默降级。浏览器是权威后端，它不可用时退回 glslang 会让结论
    // 强度悄悄下降（对已知分歧只警告不失败）——绿是假的。宁可红，逼人修环境。
    if (requireBackend && out.name !== 'browser' && !allowFallback) {
        console.log('');
        console.log(`✗ 要求 browser 后端（权威），实际用的是 ${out.name}（结论强度较低）`);
        console.log('  先修环境：bash scripts/ci-setup.sh');
        console.log('  确认可接受弱后端，请显式加 --allow-fallback；非 CI 环境本条不生效。');
        process.exit(1);
    }

    if (out.renderer) console.log(`后端 ${out.name}  ${out.version} · ${out.renderer}`);
    console.log('');

    const { failed, warned } = report(out.name, out, targets);
    console.log('');
    if (failed) {
        console.log(`✗ ${failed} / ${targets.length} 个 shader 未通过 GLSL 校验` + (warned ? `（另有 ${warned} 条警告）` : ''));
        process.exit(1);
    }
    const label = out.name === 'browser' ? '真实 WebGL2 编译 + 链接 + 多帧渲染' : '静态编译 + 链接（非浏览器实现，结论强度较低）';
    console.log(`✓ GLSL 校验通过（${targets.length} 个 shader，${label}）` + (warned ? `，${warned} 条警告` : ''));
}

// 兜底：后端里的意外异常（Chromium 启动后崩、glslangValidator 没执行位等）
// 不该以一堆栈的形式抛出去 —— 那看不出是环境坏了还是 shader 坏了。
main().catch(e => {
    process.stderr.write('✗ GLSL 校验异常终止：' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
