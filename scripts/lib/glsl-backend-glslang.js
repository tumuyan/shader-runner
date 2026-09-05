'use strict';
/**
 * 回退后端：用 glslangValidator 做静态编译 + 链接校验（ESSL 3.00）。
 *
 * 只在没有浏览器时启用 —— glslang 是另一个实现，与浏览器的 ANGLE 行为并不一致，
 * 它的结论不能代表「能不能运行」。所以它必须做错误分层：只把任何实现都会拒绝的
 * 硬错误当失败，已知分歧降级为警告。
 *
 * 注意这与「豁免」的区别：
 *   豁免某个文件  → 该文件以后出任何错都被放行，会藏住真 bug
 *   降级某个模式  → 只有这一条已证实的工具缺陷被降级；同一文件里若另有语法错、
 *                   类型错、缺失定义，依然照常报错
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./glsl-wrap');
const E = require('./glsl-errors');

/**
 * 已证实 glslang 与浏览器(ANGLE)分歧的模式。
 *
 * 判定依据：Chromium 153 / ANGLE / SwiftShader 实测，仓库内 12 个内置 shader
 * 全部编译 + 链接 + 渲染成功；其中 70s-melt-color 被 glslang 判为失败。
 * 即：浏览器能跑、glslang 报错 → 是 glslang 过严，不是 shader 有问题。
 * 往这里加条目必须附上同样的实测证据，不能凭猜测。
 *
 * 每条必须自带 sanitize —— 剔除触发该分歧的代码，用于二次编译。
 * 为什么必须二次编译：glslang 遇到这类错误会当场 compilation terminated，
 * 后面的代码不再解析。也就是说一旦判它是「已知过严」，本次输出里就看不到
 * 后面可能存在的真错误了，直接放行等于把真 bug 藏起来。剔除后重新编译，
 * 才能让「确实只有这一个已知问题」成为被验证过的结论，而不是猜测。
 *
 * sanitize 必须保持行数不变（把内容涂成空行，而不是删行），否则二次编译
 * 报的行号会和源码对不上。
 */
const BROWSER_DIVERGENT = [
    {
        re: /overloaded functions must have the same parameter precision qualifiers/i,
        why: '精度限定符不参与函数签名匹配，ANGLE 接受重声明时参数精度不同，glslang 拒绝',
        // ESSL 1.00 遗留：#ifdef GL_ES / precision mediump float; / #endif
        sanitize: (code) => code.replace(
            /^[ \t]*#ifdef[ \t]+GL_ES[ \t]*\n[ \t]*precision[ \t]+\w+[ \t]+float;[ \t]*\n[ \t]*#endif[ \t]*\n?/gmi,
            m => m.replace(/[^\n]/g, '')
        ),
    },
];

/**
 * 无独立信息的衍生消息：前面出了错，编译/链接就必然报这些，本身不代表额外问题。
 * 归类必须跟随本次的根因，否则降级根因毫无意义 —— 光把 mediump 降级，它引发的
 * 「compilation terminated」和「No function definition found」照样判失败。
 */
const DERIVED = [
    /compilation terminated/i,
    /No code generated/i,
    /No function definition \(body\) found/i,
];

/** 定位 glslangValidator。返回 { bin } 或 { skip } */
function locate() {
    let bin;
    try {
        bin = require('glslang-validator-prebuilt-predownloaded').getPath();
    } catch (e) {
        if (String(e.message || e).includes('Cannot find module')) {
            return { skip: '未安装 glslangValidator（npm i -D glslang-validator-prebuilt-predownloaded）' };
        }
        return { skip: String(e.message || e) + '（该包只有 win32/darwin/linux 的 x64 二进制）' };
    }
    if (!fs.existsSync(bin)) return { skip: '找不到二进制: ' + bin };
    try { fs.chmodSync(bin, 0o755); } catch (e) { /* 只读介质，忽略 */ }
    return { bin };
}

/**
 * @returns {{ok:boolean, skip?:string, results:Array}}
 *          每条 result: { id, hard: string[], soft: string[] }
 */
function check(targets) {
    const loc = locate();
    if (loc.skip) return { ok: true, skip: loc.skip, results: [] };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glsl-check-'));
    const vertFile = path.join(tmp, 'v.vert');
    fs.writeFileSync(vertFile, W.VERT_TEMPLATE);
    const offset = W.fragmentLineOffset();

    let seq = 0;
    /**
     * 编译一次。返回 { ok:true } 或 { ok:false, errors:string[] }。
     *
     * 两条防线，防的都是「明明失败了却被判通过」：
     *   1. stdout 和 stderr 都收。只看 stdout 的话，换个把诊断写到 stderr 的版本
     *      就会解析出 0 条错误，而 0 条错误在下面会被当成通过 —— 假阳性。
     *   2. 退出码非 0 却解析不出任何诊断时，补一条带退出码的合成错误。
     *      这是最后一道兜底：宁可报错让人来修工具，也不能静默放行。
     */
    const compile = (code) => {
        const fragFile = path.join(tmp, 'f' + (seq++) + '.frag');
        fs.writeFileSync(fragFile, W.wrapFragment(code));
        let r;
        try {
            r = spawnSync(loc.bin, ['-l', vertFile, fragFile], { encoding: 'utf8' });
        } catch (e) {
            // 典型：二进制丢了执行位（locate() 里的 chmod 在只读介质上会失败），
            // 或平台/架构不支持该预编译包。这是环境问题，不是 shader 的问题。
            throw new Error(`无法执行 glslangValidator（${loc.bin}）：${e.message}`
                + '（可能是缺少执行位或平台不受支持）');
        }
        if (r.status === 0) return { ok: true };

        const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
        const errors = E.parseErrors(raw, offset);
        if (!errors.length) {
            const head = raw.trim().split('\n')[0] || '（无输出）';
            errors.push(`glslangValidator 以 ${r.status === null ? '信号 ' + r.signal : '退出码 ' + r.status}`
                + ` 结束，但未能解析出诊断信息；原始输出首行：${head}`);
        }
        return { ok: false, errors };
    };

    try {
        const results = targets.map(t => {
            const first = compile(t.code);
            if (first.ok) return { id: t.label, hard: [], soft: [] };

            const hard = [], soft = [], derived = [], matched = [];
            for (const msg of first.errors) {
                const hit = BROWSER_DIVERGENT.find(d => d.re.test(msg));
                if (hit) {
                    soft.push(`${msg}  （已知 glslang 过严：${hit.why}）`);
                    if (!matched.includes(hit)) matched.push(hit);
                } else if (DERIVED.some(re => re.test(msg))) {
                    derived.push(msg);
                } else {
                    hard.push(msg);
                }
            }

            // 有独立硬错误 → 直接失败，无需再验
            if (hard.length) return { id: t.label, hard: [...hard, ...derived], soft };

            // 没有已知分歧可解释（例如「缺 mainImage」只有一条链接错误）——
            // 这类衍生消息本身就是问题所在，不能因为它长得像衍生消息就放过
            if (!soft.length) return { id: t.label, hard: derived, soft: [] };

            // 走到这里说明非衍生错误全是已知分歧。但 glslang 已经 compilation
            // terminated，后面的代码它根本没看，所以必须二次编译才能下结论。
            const sanitized = matched.reduce((code, d) => d.sanitize(code), t.code);
            const second = compile(sanitized);
            if (second.ok) {
                return { id: t.label, hard: [], soft: [...soft, ...derived] };
            }
            // 剔除已知问题后仍有错 → 这些是真错误，行号因保持行数而依然准确
            let hard2 = second.errors.filter(m => !DERIVED.some(re => re.test(m)));
            if (!hard2.length) {
                // 二次编译只吐出衍生消息、没留任何根因 —— 说明剔除已知分歧之后
                // 它还是没编译成功，而原因我们读不出来。空 hard 会被当成「通过」，
                // 那就是本工具最不该有的假阳性，补一条再说。
                hard2 = [`剔除已知 glslang 分歧后仍编译失败，但未能定位根因；`
                    + `原始输出：${second.errors.join(' | ') || '（无）'}`];
            }
            return {
                id: t.label,
                hard: hard2,
                soft: [...soft, ...derived],
            };
        });
        return { ok: true, results };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

module.exports = { check, BROWSER_DIVERGENT, DERIVED };
