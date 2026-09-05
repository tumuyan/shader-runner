'use strict';
/**
 * 草稿（drafts/*.glsl） ↔ 产物（shader/*.shader.js）的共享逻辑。
 *
 * 被 scripts/release-shader.js、scripts/extract-shader.js、
 * scripts/gen-shader-manifest.js 共用，保证三处对格式的理解完全一致。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DRAFTS_DIR = path.join(ROOT, 'drafts');
const SHADER_DIR = path.join(ROOT, 'shader');
const MANIFEST_FILE = path.join(SHADER_DIR, 'manifest.js');

const GLSL_RE = /\.glsl$/;
const SHADER_RE = /\.shader\.js$/;

// 产物指纹行。兼容两种写法：
//   本工具:       // 源草稿: drafts/aero-waves.glsl @ sha1:3f2a...
//   早期/其它工具: // @source: drafts/aero-waves.glsl
//                 // @fingerprint: sha1:3f2a...
const FINGERPRINT_RE = /^\/\/ 源草稿: (.+?) @ sha1:([0-9a-f]{40})\s*$/m;
const SOURCE_RE = /^\/\/ @source: (.+?)\s*$/m;
const FINGERPRINT_ALT_RE = /^\/\/ @fingerprint: sha1:([0-9a-f]{40})\s*$/m;

// 产物里 code 模板字符串的边界。锚定到结尾的 ` }); `，避免被 GLSL 中
// 被转义的反引号（`\`）干扰 —— 普通正则 `[\s\S]*?\`` 会错误地停在那里。
const CODE_BLOCK_RE = /code: `([\s\S]*)`\n\s*\}\);/;

// 路径统一用「/」且相对仓库根，和浏览器里的 URL 保持一致
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function abs(p) { return path.isAbsolute(p) ? p : path.join(ROOT, p); }

function sha1(text) { return crypto.createHash('sha1').update(text, 'utf8').digest('hex'); }

/** 归一化：去 BOM、CRLF → LF、尾部空白收敛为一个换行。保证跨平台产物字节一致。 */
function normalizeGlsl(src) {
    return src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\s*$/, '\n');
}

/**
 * 解析文件开头的 frontmatter，形如：
 *   // @label: Aero Waves
 *   // @name:  aero-waves
 *
 * 只认白名单里的 key（避免把 shader 里恰好以 `// @xxx:` 开头的注释误当元数据剥掉），
 * 遇到第一个非 frontmatter 行即停止（允许开头有空行）。
 * 返回 { meta, body } —— body 是剥掉 frontmatter 后的正文，才是真正的 shader 代码。
 */
const FRONTMATTER_KEYS = /^(label|name)$/;
function parseFrontmatter(text) {
    const meta = {};
    const lines = text.split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const m = line.match(/^\s*\/\/\s*@(\w+)\s*:\s*(.*?)\s*$/);
        if (!m || !FRONTMATTER_KEYS.test(m[1])) break;
        meta[m[1]] = m[2];
    }
    return { meta, body: lines.slice(i).join('\n') };
}

/** 文件名 → 显示名：aero-waves → Aero Waves；70s-melt-color → 70s Melt Color */
function titleCase(name) {
    return name.split(/[-_\s]+/).filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * 转义进 JS 模板字符串。顺序不能变 —— 先处理反斜杠。
 * 反斜杠必须转义：GLSL 宏常用 `\` 续行，`\` + 换行在模板字符串里会被
 * 当成 line continuation 把换行吃掉，直接破坏代码。
 */
function escapeTemplate(s) {
    return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** 反转义：每个 `\X` 还原为 X */
function unescapeTemplate(s) {
    return s.replace(/\\([\s\S])/g, (_, c) => c);
}

/** 渲染产物文件。格式固定，extract 依赖它反解。 */
function renderShaderFile(opts) {
    const short = String(opts.src).replace(/^.*\//, '').replace(GLSL_RE, '');
    return `// 自动生成，请勿手工编辑。
// 源草稿: ${opts.src} @ sha1:${opts.hash}
// 重新生成: npm run add ${short}
// 移除内置: npm run remove ${short}
(function(w){
    var d = (w.__SHADER_REGISTRY__ = w.__SHADER_REGISTRY__ || []);
    d.push({
        path: '${opts.path}',
        label: '${String(opts.label).replace(/'/g, "\\'")}',
        code: \`
${escapeTemplate(opts.code)}\`
    });
})(window);
`;
}

/**
 * 只取 code 的宽松提取，给 GLSL 校验用。
 *
 * 与 CODE_BLOCK_RE 的区别：允许反引号后面跟尾随空格和行注释。手工编辑过的产物
 * 常写成  `<code>\n` + 注释（` 后面直接跟 // xxx），严格正则会失配返回 null。
 *
 * 刻意不改 parseShaderFile —— 那里解析不出来要判成 foreign，好让 add / remove
 * 拒绝动手；GLSL 校验只是想读代码，能读就读，不该改变产物的状态判定。
 */
const CODE_BLOCK_LOOSE_RE = /code:\s*`\n?([\s\S]*)`[^\n]*\n\s*\}\);/;
function extractShaderCode(text) {
    const m = String(text).match(CODE_BLOCK_LOOSE_RE);
    return m ? unescapeTemplate(m[1]).replace(/^\n/, '') : null;
}

/** 解析产物文件；非本工具生成的返回 null */
function parseShaderFile(text) {
    const code = text.match(CODE_BLOCK_RE);
    if (!code) return null;
    const pm = text.match(/path\s*:\s*'([^']+)'/);
    const lm = text.match(/label\s*:\s*'((?:[^'\\]|\\.)*)'/);
    let src = null, hash = null;
    const fp = text.match(FINGERPRINT_RE);
    if (fp) {
        src = fp[1]; hash = fp[2];
    } else {
        const s = text.match(SOURCE_RE), h = text.match(FINGERPRINT_ALT_RE);
        if (s) src = s[1];
        if (h) hash = h[1];
    }
    return {
        src, hash,
        path: pm ? pm[1] : null,
        label: lm ? lm[1].replace(/\\'/g, "'") : null,
        code: unescapeTemplate(code[1]).replace(/^\n/, '')
    };
}

/** 读单个草稿文件（含 `_` 开头的模板 —— 显式指定时允许） */
function readDraftFile(file) {
    const raw = fs.readFileSync(abs(file), 'utf8');
    const fm = parseFrontmatter(raw);
    const base = file.replace(/^.*\//, '').replace(GLSL_RE, '');
    return {
        file,
        name: fm.meta.name || base,
        label: fm.meta.label || titleCase(base),
        code: normalizeGlsl(fm.body),   // frontmatter 是元数据，不计入 shader 代码
        meta: fm.meta
    };
}

/** 列出草稿（以 `_` 开头的是模板，不参与自动处理） */
function listDrafts(includeTemplates) {
    if (!fs.existsSync(DRAFTS_DIR)) return [];
    return fs.readdirSync(DRAFTS_DIR)
        .filter(n => GLSL_RE.test(n) && (includeTemplates || !n.startsWith('_')))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map(n => readDraftFile('drafts/' + n));
}

/**
 * 命令行输入 → 短名。以下写法全部等价：
 *   underwater | underwater.glsl | drafts/underwater.glsl | ./drafts/underwater.glsl
 *   underwater.shader.js | shader/underwater.shader.js
 * 只剥「目录前缀 + 扩展名」，不做任何模糊匹配。
 */
const INPUT_EXT_RE = /\.(glsl|frag|vert|txt|shader\.js|js)$/;
function normalizeInput(input) {
    return String(input).trim().replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^(?:drafts|shader)\//, '')
        .replace(INPUT_EXT_RE, '');
}

/**
 * 短名 → 草稿文件。
 *
 * 只做精确匹配，绝不做前缀补全：`shattered-space` 与 `shattered-space-v11`
 * 必须靠用户多敲几个字符来区分 —— 猜错一次的代价（发错 shader）远高于多敲几个字符。
 * 找不到时给出 suggestions，让报错能直接指导下一步。
 *
 * 返回 { name, file, via } | { name, file: null, suggestions, ambiguous? }
 */
function resolveDraftInput(input, includeTemplates) {
    const name = normalizeInput(input);
    const base = name.replace(/^.*\//, '');
    if (!base) return { name, file: null, suggestions: [] };

    const candidates = name.includes('/')
        ? [name + '.glsl', 'drafts/' + name + '.glsl']
        : ['drafts/' + name + '.glsl'];
    for (const c of candidates) {
        if (fs.existsSync(abs(c))) return { name: base, file: c, via: 'path' };
    }

    // 草稿文件名可以和产物名不同（frontmatter @name: xxx），再按解析出的 name 找一遍
    const drafts = listDrafts(!!includeTemplates);
    const byName = drafts.filter(d => d.name === base);
    if (byName.length === 1) return { name: base, file: byName[0].file, via: 'name' };
    if (byName.length > 1) {
        return { name: base, file: null, suggestions: byName.map(d => d.file), ambiguous: true };
    }

    const pool = new Set([
        ...drafts.map(d => d.name),
        ...drafts.map(d => d.file.replace(/^.*\//, '').replace(GLSL_RE, '')),
        ...listShaders().map(p => p.replace(/^.*\//, '').replace(SHADER_RE, ''))
    ]);
    pool.delete(base);
    const suggestions = [...pool]
        .filter(n => n.toLowerCase().includes(base.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return { name: base, file: null, suggestions };
}

/** 找不到草稿时的一句可操作报错 */
function notFoundMessage(input, r) {
    if (r.ambiguous) return `短名 ${r.name} 对应多个草稿，请写完整路径：\n  ` + r.suggestions.join('\n  ');
    const hint = r.suggestions.length ? `\n  是不是想找: ${r.suggestions.join(', ')}` : '';
    return `找不到草稿: ${input}（应有 drafts/${r.name}.glsl）${hint}`;
}

/** 列出已发布产物（manifest.js 除外） */
function listShaders() {
    if (!fs.existsSync(SHADER_DIR)) return [];
    return fs.readdirSync(SHADER_DIR)
        .filter(n => SHADER_RE.test(n))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map(n => 'shader/' + n);
}

/**
 * 判断单个草稿与产物的关系。
 *
 * 三个哈希，缺一不可：
 *   draftHash    草稿正文当前的 sha1
 *   recordedHash 产物头部记录的 sha1（上次 release 时草稿的样子）
 *   actualHash   产物里 code 实际的 sha1
 *
 * 用 recordedHash 做基准就能分清「哪边动过」——手工编辑 *.shader.js 是人类的合法
 * 操作，绝不能被当成「草稿改了忘了 release」，更不能让 release 静默覆盖掉它。
 *
 *   unreleased      产物不存在
 *   foreign         产物不是本工具生成的 / 由别的草稿生成 → 不追踪，不敢动
 *   synced          两边都没动
 *   draft-stale     只有草稿动了        → release 即可（草稿是权威）
 *   product-edited  只有产物被手工改了  → 需人工决定去向，release 会拒绝
 *   conflict        两边都动了          → 必须人工介入
 */
function draftState(draft) {
    const target = 'shader/' + draft.name + '.shader.js';
    const draftHash = sha1(draft.code);
    const out = {
        file: draft.file, name: draft.name, label: draft.label, target,
        state: 'unreleased', draftHash, recordedHash: null, actualHash: null
    };
    if (!fs.existsSync(abs(target))) return out;

    const parsed = parseShaderFile(fs.readFileSync(abs(target), 'utf8'));
    if (!parsed) { out.state = 'foreign'; return out; }   // 结构不认识，不敢动
    out.recordedHash = parsed.hash;
    out.actualHash = sha1(normalizeGlsl(parsed.code));
    out.productSrc = parsed.src;

    if (parsed.src !== draft.file) { out.state = 'foreign'; return out; }
    if (parsed.hash === null) { out.state = 'foreign'; return out; }   // 无指纹，不敢动

    const draftMoved = draftHash !== parsed.hash;
    const productMoved = out.actualHash !== parsed.hash;
    out.state = !draftMoved && !productMoved ? 'synced'
              : draftMoved && !productMoved ? 'draft-stale'
              : !draftMoved && productMoved ? 'product-edited'
              : 'conflict';
    return out;
}

/** 汇总全部草稿状态，外加「没有任何草稿指向它」的产物 */
function collectStatus() {
    const drafts = listDrafts(false).map(draftState);
    const claimed = new Set(drafts.map(d => d.target));
    const orphans = listShaders().filter(p => !claimed.has(p));
    return { drafts, orphans };
}

/**
 * 清单里的单条记录 { path, label }。
 *
 * label 必须写进清单：页面改成按需加载后，启动时只加载清单，shader 本体
 * （label 原本住在里面）还没执行，下拉列表就只能靠清单里的这份来渲染。
 *
 * 读 label 刻意分两步。先用 parseShaderFile（权威，认得出的产物走它）；它返回
 * null 时不代表 label 坏了 —— 手工编辑过的产物常被判 foreign，那是有意的，好让
 * add / remove 拒绝动手。而清单只是索引，读个 label 不必依赖整块 code 的结构，
 * 所以再单独抠一次 label 字段。真读不出来才退回文件名 Title Case，绝不因某条
 * label 有问题就让整个清单生成失败。
 */
function manifestEntry(rel) {
    let label = null;
    try {
        const src = fs.readFileSync(abs(rel), 'utf8');
        const parsed = parseShaderFile(src);
        if (parsed && parsed.label) label = parsed.label;
        if (label === null) {
            const lm = src.match(/label\s*:\s*'((?:[^'\\]|\\.)*)'/);
            if (lm) label = lm[1].replace(/\\'/g, "'");
        }
    } catch (e) { /* 读不到就退回文件名 */ }
    if (label === null) {
        label = titleCase(rel.replace(/^.*\//, '').replace(SHADER_RE, ''));
    }
    return { path: rel, label };
}

/** 把任意字符串写成单引号 JS 字面量的内容部分（反斜杠与单引号都要转义） */
function escapeSingleQuoted(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 上一步的逆运算。只认 \\ 与 \' 两种转义，其余反斜杠按原样保留。 */
function unescapeSingleQuoted(s) {
    return String(s).replace(/\\(['\\])/g, '$1');
}

function renderManifest(paths) {
    const lines = paths.map(p => {
        const e = manifestEntry(p);
        // 先转义反斜杠再转义引号：只转义引号的话，label 里的 \ 会与原样字符拼成
        // 转义序列（'a\b' 在浏览器里是退格符），清单说的一个样、页面拿到另一个样。
        return "        { path: '" + e.path + "', label: '" + escapeSingleQuoted(e.label) + "' }";
    }).join(',\n');
    return `// 自动生成，请勿手工编辑。
// 由 \`npm run release -- --refresh\` 扫描 shader/*.shader.js 生成；改动后请重新运行并一起提交。
// 新增内置 shader：把 xxx.glsl 放进 drafts/ 目录 → npm run release -- drafts/xxx.glsl。
// label 随 path 一并给出：页面按需加载 shader.js，启动时只读这份清单填下拉列表。
(function (w) {
    w.__SHADER_MANIFEST__ = [
${lines}
    ];
})(window);
`;
}

function generateManifest() {
    const paths = listShaders();
    fs.writeFileSync(MANIFEST_FILE, renderManifest(paths), 'utf8');
    return paths;
}

/**
 * 读清单。返回 { format, entries }，format 有四种：
 *
 *   'entries' —— 新格式（{ path, label }），label 就是清单里写的那个
 *   'paths'   —— 旧格式（纯路径数组），label 由产物现算
 *   'empty'   —— 文件在，但一条都没解析出来
 *   'missing' —— 文件不存在（entries 为 null）
 *
 * 区分 'entries' 与 'paths' 是给校验用的：'paths' 的 label 是现算的，拿它跟产物
 * 比必然相等 —— 「清单没刷新」这件事在旧格式下永远查不出来，是假绿。运行时能读
 * 旧格式（normalizeManifest 兜底成文件名 Title Case），但 label 会退化（Auroras
 * → Aurora），所以 --check 要求清单必须是新格式。
 */
function readManifest() {
    if (!fs.existsSync(MANIFEST_FILE)) return { format: 'missing', entries: null };
    const src = fs.readFileSync(MANIFEST_FILE, 'utf8');

    const entries = [];
    const re = /\{\s*path\s*:\s*'([^']+)'\s*,\s*label\s*:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        if (!SHADER_RE.test(m[1])) continue;
        entries.push({ path: m[1], label: unescapeSingleQuoted(m[2]) });
    }
    if (entries.length) return { format: 'entries', entries };

    // 旧格式：纯路径数组（那时页面全量加载，label 从产物里取）。label 现算。
    const paths = [];
    const old = /^\s*'([^']+)',?\s*$/gm;
    let o;
    while ((o = old.exec(src)) !== null) {
        if (SHADER_RE.test(o[1])) paths.push(o[1]);
    }
    if (paths.length) return { format: 'paths', entries: paths.map(manifestEntry) };
    return { format: 'empty', entries: [] };
}

/** 读清单的 { path, label } 列表；文件不存在返回 null。 */
function readManifestEntries() {
    const r = readManifest();
    return r.format === 'missing' ? null : r.entries;
}

/** 只要路径。清单缺失时返回 null，和旧行为一致。 */
function readManifestPaths() {
    const entries = readManifestEntries();
    return entries === null ? null : entries.map(e => e.path);
}

module.exports = {
    ROOT, DRAFTS_DIR, SHADER_DIR, MANIFEST_FILE, GLSL_RE, SHADER_RE,
    rel, abs, sha1, normalizeGlsl, parseFrontmatter, titleCase,
    escapeTemplate, unescapeTemplate, renderShaderFile, parseShaderFile,
    extractShaderCode,
    listDrafts, readDraftFile, listShaders, draftState, collectStatus,
    normalizeInput, resolveDraftInput, notFoundMessage,
    manifestEntry, renderManifest, generateManifest,
    escapeSingleQuoted, unescapeSingleQuoted,
    readManifest, readManifestEntries, readManifestPaths
};
