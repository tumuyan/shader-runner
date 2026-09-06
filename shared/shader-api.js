'use strict';
/**
 * /api/shader 的写入防护：体积上限、ID 校验、按 IP 限流、存储配额。
 *
 * 两个部署目标共用这一份：Vercel 的 api/shader.js 与 Netlify 的
 * netlify/functions/shader.js。
 *
 * 为什么是 CommonJS：Netlify 函数是 CJS，Vercel 侧是 ESM —— ESM 可以默认导入 CJS，
 * 反过来不行。所以这里是 module.exports，不是 export。
 *
 * ⚠ 关于限流的强度，别把下面的数字当成保证：
 *
 *   1. Serverless 每个实例有自己独立的内存，计数不跨实例共享。真正生效的上限约等于
 *      「limit × 同时存活的实例数」。它是减速带，不是墙。
 *   2. IP 取自平台头。Netlify 的 x-nf-client-connection-ip 由边缘写入，客户端伪造不了；
 *      Vercel 的 Node 运行时只有 x-forwarded-for，最左一段理论上客户端可伪造。
 *      要真正拦住 Abuse，请在平台层做（Vercel Firewall / Netlify 自带限速）。
 *   3. 存储配额只管得住内存回退那份（Vercel 全是内存存储）。Blob 存储的量由平台计费
 *      与平台配额管，这里拦不住 —— 能拦的只是「无限写入导致函数 OOM」这一类。
 *
 * 所以这里的定位是：挡掉脚本小子、挡掉手滑、挡掉 OOM。不是抗 DDoS。
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

const LIMITS = {
    // 单份 shader 的 UTF-8 字节上限。真实 shader 一般几 KB ~ 几十 KB，512 KB 留了
    // 一个数量级以上的余量；再大既不是手写的，也超出了「分享链接」这个场景。
    MAX_CODE_BYTES: 512 * 1024,

    // 落盘记录的体积上限 —— 这才是唯一的真相，因为读取侧量的是它。
    //
    // 为什么不是「code 上限 + 一点信封余量」：JSON 转义会让字节数膨胀，每个换行、
    // 引号、反斜杠各占 2 字节。所以「code 恰好 512 KB」的记录，序列化后最坏接近
    // 1 MB。上一版只留了 16 KB 余量，于是 17000 行换行的 512 KB shader 能写进去、
    // 却永远读不出来（GET → 500 存储已损坏），而且去重会把它判成碰撞、每次重发
    // 都再存一份完整副本。留 2×+16 KB 覆盖最坏情况，这类载荷不再出现。
    //
    // 写入侧因此必须对同样的字节做判定（见 validateCode），两侧才算对称。
    MAX_STORED_BYTES: 512 * 1024 * 2 + 16 * 1024,

    // 内存存储的条目上限（仅内存回退那份生效）。超出返回 503，而不是让函数 OOM。
    MAX_STORE_ENTRIES: 5000,

    // 内存存储的字节上限。只按条数算是不够的：5000 × 512KB = 2.44 GiB，
    // 远超函数内存的 ~1 GiB —— 满到 2000 份时就先被 OOM kill 了，根本走不到 503。
    // 常规 shader（2~5 KB）下由条目上限先触顶；这条只在对抗性输入时才生效，正是它的职责。
    MAX_STORE_BYTES: 64 * 1024 * 1024,

    // 请求体（JSON 字符串）的体积上限。比 MAX_STORED_BYTES 略宽：预检的目的是
    // 在 JSON.parse 之前挡掉过大的载荷（省掉解析几 MB 字符串），不是重新定义上限，
    // 所以这里宁可放宽一点，让超限请求落到 validateCode 给出精确字节数，而不是
    // 被 413 抢先报一个口径不同的数字。
    MAX_BODY_BYTES: 512 * 1024 * 2 + 16 * 1024 + 4096,

    ID_LENGTH: 8,
};

/** ID 只允许字母数字 —— GET 时先过这道，免得把 ../ 之类的东西拿去查存储 */
const ID_RE = /^[A-Za-z0-9]+$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 用字节而非 String.length 计量：GLSL 注释里可能有中文，.length 会严重低估 */
function byteLength(s) {
    return Buffer.byteLength(String(s), 'utf8');
}

function formatBytes(n) {
    const mb = 1024 * 1024;
    if (n >= mb) return (n / mb).toFixed(n % mb === 0 ? 0 : 1) + ' MB';
    return Math.round(n / 1024) + ' KB';
}

// ---------------------------------------------------------------------------
// GLSL 形态校验：只拦「必定编译不过」的
// ---------------------------------------------------------------------------
/**
 * ⚠ 为什么服务端不做真编译：
 *
 *   1. Serverless 没有 GPU，跑不了 WebGL2。硬塞 Playwright + Chromium 进函数包是
 *      几百 MB、冷启动数秒、且只能 SwiftShader 软件渲染 —— 不能放在请求路径上。
 *   2. 唯一可行的 glslangValidator 二进制（6.7 MB）**会误杀合法 shader**。仓库自带
 *      的 70s-melt-color 在真实 WebGL2/ANGLE 里编译 + 链接 + 渲染全部通过，glslang
 *      却判它失败（'mediump' 重载精度）。scripts/lib/glsl-backend-glslang.js 里的
 *      BROWSER_DIVERGENT 就是为此存在的，而那张表是**实测攒出来的、必然不完整**：
 *      每一条都对应一次「用户的 shader 被错杀」。拿它当写入门槛，等于把尚未发现的
 *      分歧全部变成「用户无法发布且无处申诉」。
 *
 * 所以服务端只做一类判断：**无论哪个实现都必定失败**的特征。判据来自 GLSL 包装器
 * （scripts/lib/glsl-wrap.js 的 FRAG_TEMPLATE）—— 用户代码是塞进包装器一起编译的，
 * 与包装器抢名字、抢指令的写法不可能通过。这类判断是确定的，不会误伤。
 *
 * 真正的编译验证放在浏览器侧（js/share.js），那里用的就是最终渲染它的 ANGLE。
 */
const GLSL_SHAPE = {
    // 必须有 mainImage：包装器声明并调用了它，缺了就是链接期
    // "No function definition (body) found: mainImage"
    mainImage: /\bvoid\s+mainImage\s*\(/,
    // 包装器首行已是 `#version 300 es`，而 #version 必须是首行指令，用户再写一份必定失败
    version: /^[ \t]*#[ \t]*version\b/m,
    // 包装器定义了 `void main()` 来调用 mainImage，用户再定义一次是重定义
    redefMain: /\bvoid\s+main\s*\(/,
    // 与 GLSL 无关，是「把这个接口当网盘用」的强信号
    scriptTag: /<\/?script/i,
};

/**
 * 去掉注释后再判定，否则注释里写一句 `void main()` 就会被误杀。
 * GLSL 没有字符串字面量，所以 `//` 与 `/*` 一律是注释起点，这个判定是确定的。
 *
 * 顺序要紧：先除行注释。否则行注释里的块注释起始符会一路配到后面某个真的块注释
 * 结束符，把中间的真代码整段吃掉。
 */
function stripComments(code) {
    return code
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function validateGlslShape(code) {
    const src = stripComments(code);
    if (!GLSL_SHAPE.mainImage.test(src)) {
        return { ok: false, error: '缺少 void mainImage(out vec4, in vec2) 函数' };
    }
    if (GLSL_SHAPE.version.test(src)) {
        return { ok: false, error: '不能包含 #version（页面包装器已指定 #version 300 es）' };
    }
    if (GLSL_SHAPE.redefMain.test(src)) {
        return { ok: false, error: '不能重复定义 void main()（页面包装器已定义）' };
    }
    if (GLSL_SHAPE.scriptTag.test(src)) {
        return { ok: false, error: '内容不是 GLSL（含 script 标签）' };
    }
    return { ok: true };
}

/**
 * 写入前的 code 校验。
 *
 * 顺序是有讲究的：**体积一律排在形态之前**。理由有二：
 *   1. 报错要指向真正的限制。600 KB 的载荷报「缺少 mainImage」会把人带偏 ——
 *      它确实缺，但真正的问题是太大。
 *   2. 形态校验要跑 stripComments（全量正则），先按体积拒掉能省下这趟开销。
 */
function validateCode(code) {
    if (typeof code !== 'string') return { ok: false, error: 'code 必须是字符串' };
    if (!code.trim()) return { ok: false, error: 'code 不能为空' };
    if (code.indexOf('\u0000') !== -1) return { ok: false, error: 'code 不能包含 NUL 字符' };

    const bytes = byteLength(code);
    if (bytes > LIMITS.MAX_CODE_BYTES) {
        // 报精确字节数：512KB+1 四舍五入还是「512 KB」，写成「512 KB 超过 512 KB」
        // 等于什么都没说
        return {
            ok: false,
            error: 'code 体积 ' + bytes + ' 字节，超过上限 '
                 + LIMITS.MAX_CODE_BYTES + ' 字节（' + formatBytes(LIMITS.MAX_CODE_BYTES) + '）',
        };
    }

    // 按「序列化之后」的体积再判一次。读取侧量的是这个（validateStored），
    // 所以写入侧必须量同一个东西，否则就会出现「存得进去、读不出来」——
    // 那条记录会成为永久的 500，且去重会因它读不出内容而误判成碰撞。
    const stored = byteLength(serialize(code));
    if (stored > LIMITS.MAX_STORED_BYTES) {
        return {
            ok: false,
            error: 'code 序列化后 ' + stored + ' 字节，超过上限 '
                 + LIMITS.MAX_STORED_BYTES + ' 字节（'
                 + formatBytes(LIMITS.MAX_STORED_BYTES) + '）',
        };
    }

    const shape = validateGlslShape(code);
    if (!shape.ok) return shape;
    return { ok: true, bytes: bytes, stored: stored };
}

/** 落盘格式。两处必须用同一个函数，否则写入侧与读取侧量到的不是同一样东西。 */
function serialize(code) {
    return JSON.stringify({ code: code });
}

/** ID 校验（GET 侧）。非法格式直接 400，不去查存储 —— 路径穿越之类的输入到此为止 */
function validateId(id) {
    if (typeof id !== 'string' || !id) return { ok: false, error: '缺少 id 参数' };
    if (id.length > LIMITS.ID_LENGTH) return { ok: false, error: 'id 格式非法' };
    if (!ID_RE.test(id)) return { ok: false, error: 'id 格式非法（只允许字母数字）' };
    return { ok: true };
}

/**
 * 读存储时的校验：存储里的东西不能直接反射出去。
 *
 * 这里只管「结构」—— 是不是合法 JSON、有没有 code 字段、体积是否正常。**不套用
 * 写入侧的 GLSL 形态规则**：那套规则会随认知演进（见 validateGlslShape），若读路径
 * 也跟着收紧，历史上合规写进去的记录会在某次部署后集体变成「存储内容已损坏」，
 * 而读路径恰恰是唯一的数据恢复通道 —— 让它变严是有害的。
 */
function validateStored(raw) {
    if (typeof raw !== 'string' || !raw) return { ok: false, error: '存储内容为空' };
    if (byteLength(raw) > LIMITS.MAX_STORED_BYTES) return { ok: false, error: '存储内容超长' };
    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        return { ok: false, error: '存储内容不是合法 JSON' };
    }
    if (!data || typeof data !== 'object') return { ok: false, error: '存储内容不是对象' };
    if (typeof data.code !== 'string' || !data.code.trim()) return { ok: false, error: '存储内容缺少 code 字段' };
    return { ok: true, code: data.code };
}

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

/**
 * 8 位 ID。用 crypto 而不是 Math.random：后者不是密码学安全的，拿到足够多的连续输出
 * 就能反推 V8 xorshift128+ 的内部状态，进而预测后续 ID —— ID 就是这里唯一的访问凭证。
 *
 * 取模前剔除 >= 248 的字节（248 = 62 × 4），消除取模偏倚。
 */
function generateId() {
    const out = [];
    while (out.length < LIMITS.ID_LENGTH) {
        const buf = crypto.randomBytes(LIMITS.ID_LENGTH * 2);
        for (const b of buf) {
            if (b >= 248) continue;
            out.push(ID_ALPHABET[b % 62]);
            if (out.length === LIMITS.ID_LENGTH) break;
        }
    }
    return out.join('');
}

/**
 * 内容寻址键：sha256(code) 的 base62 前 8 位。
 *
 * 同一份 code 永远得到同一个键，于是重复提交自动去重 —— 这不仅省空间，更是存储耗尽
 * 攻击的正解：洪水从「请求数」变成「不同内容的字节数」，攻击者必须真的上传那么多数据。
 *
 * 保留 8 位是为了不破坏「固定 8 位 ID」这个对外承诺，代价是只取了哈希的低 47.5 bit。
 * 5000 条时碰撞概率约 6e-8，与随机 ID 同量级，但**后果不同**：随机 ID 碰撞能被
 * isTaken 检出并重试，内容哈希碰撞若被误判成「同一份内容」，用户会拿到播放错误
 * shader 的链接。所以 assignId() 必须取出内容比对，而不是只看键存不存在。
 */
function contentKey(code) {
    const hex = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
    let n = BigInt('0x' + hex);
    let out = '';
    for (let i = 0; i < LIMITS.ID_LENGTH; i++) {
        out = ID_ALPHABET[Number(n % 62n)] + out;
        n = n / 62n;
    }
    return out;
}

/**
 * 为一份 code 定 ID，并在内容相同时复用已有 ID。
 *
 *   io = { get(id), has(id) } —— 由调用方注入，两种存储（Blob / 内存）共用这段逻辑，
 *   免得去重在 Vercel 与 Netlify 两个文件里各写一遍然后漂移。
 *
 * 三种结果：
 *   1. 键为空                      → id = 内容键（常规路径）
 *   2. 键存在且内容相同            → id = 内容键，deduped = true（调用方不必再写）
 *   3. 键存在但内容不同（真碰撞）  → 退回随机 ID 并用 has() 避让，绝不当成去重
 */
async function assignId(code, io) {
    const key = contentKey(code);
    const existing = await io.get(key);
    if (existing) {
        // 直接比对 code 本身：这是「是不是同一份内容」的唯一权威判据。
        // 不比对哈希字段 —— 那会要求存储里额外存一份 hash，而 code 就在手边。
        const p = validateStored(existing);
        if (p.ok && p.code === code) return { id: key, deduped: true };
        // 极罕见的真碰撞：这份 code 必须拿到自己的 ID，不能覆盖别人的
        return { id: await createId(io.has), deduped: false, collided: true };
    }
    return { id: key, deduped: false };
}

/**
 * 生成一个不冲突的 ID。碰撞概率极低（62^8 ≈ 2.2e14，条目上限 5000 时约 6e-8），
 * 但仍重试几次 —— 撞上了就是静默覆盖别人的 shader，代价太高。
 * isTaken 传 null 表示调用方查一次太贵，跳过。
 */
async function createId(isTaken, tries = 5) {
    if (!isTaken) return generateId();
    for (let i = 0; i < tries; i++) {
        const id = generateId();
        if (!(await isTaken(id))) return id;
    }
    throw new Error('ID 生成连续冲突，请重试');
}

// ---------------------------------------------------------------------------
// 按 IP 限流（滑动窗口）
// ---------------------------------------------------------------------------

/**
 * 滑动窗口计数。返回 { ok, retryAfter } / { ok, remaining }。
 *
 * 内存自我防护：限流器自己也是一张按 IP 增长的 Map，不管住它，「加限流」就变成了
 * 一个新的内存 DoS 入口 —— 大量不同 IP 能把函数撑爆。做法是只在超过 maxKeys 时
 * 才做一次全表清理（O(n log n)），平时每条路径只碰自己那一个 key。
 */
function createRateLimiter(opts) {
    const limit = opts.limit;
    const windowMs = opts.windowMs;
    const maxKeys = opts.maxKeys || 10000;
    const hits = new Map();   // key -> number[]（窗口内的时间戳，升序）

    function check(key, now = Date.now()) {
        const cutoff = now - windowMs;
        let list = hits.get(key);
        if (list) {
            while (list.length && list[0] <= cutoff) list.shift();
        } else {
            list = [];
        }
        if (list.length >= limit) {
            return {
                ok: false,
                limit: limit,
                retryAfter: Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000)),
            };
        }
        list.push(now);
        hits.set(key, list);
        if (hits.size > maxKeys) sweep(hits, cutoff, maxKeys);
        return { ok: true, limit: limit, remaining: limit - list.length };
    }

    return {
        limit: limit,
        windowMs: windowMs,
        check: check,
        get size() { return hits.size; },
        reset() { hits.clear(); },
    };
}

function sweep(hits, cutoff, maxKeys) {
    for (const [k, list] of hits) {
        while (list.length && list[0] <= cutoff) list.shift();
        if (!list.length) hits.delete(k);
    }
    // 裁到 90% 而不是恰好 maxKeys：裁到正好会让之后每个新 IP 都再触发一次全表排序，
    // 轮换 IP 就能把每个请求都变成一次 O(n log n)。留 10% 余量把这次开销摊薄。
    const target = Math.floor(maxKeys * 0.9);
    if (hits.size <= target) return;
    // 仍超限：按「最近一次访问最旧」淘汰。删除正在遍历的 Map 是安全的，先收集再删。
    const victims = [...hits.entries()]
        .sort((a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1])
        .slice(0, hits.size - target);
    for (const [k] of victims) hits.delete(k);
}

/**
 * 取客户端 IP。优先用平台写入、客户端伪造不了的头。
 * 取不到时返回 'unknown' —— 那意味着所有匿名请求共用一个桶，宁可一起被限，
 * 也好过拿不到 IP 就放行（那是把限流整个关掉）。
 */
function clientIp(headers) {
    const h = headers || {};
    const get = name => {
        const v = h[name] !== undefined ? h[name] : h[name.toLowerCase()];
        if (typeof v === 'string') return v;
        if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
        return '';
    };
    const nf = get('x-nf-client-connection-ip');   // Netlify 边缘写入，最可信
    if (nf) return nf.trim();
    const xff = get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    const real = get('x-real-ip');
    if (real) return real.trim();
    return 'unknown';
}

// ---------------------------------------------------------------------------
// 内存存储（带配额）
// ---------------------------------------------------------------------------

/**
 * 带双重预算（条数 + 字节）的内存 KV。set 返回 false 表示满了 —— 由调用方转成 503。
 *
 * 两个预算都要：只管条数挡不住「少量超大题」，只管字节挡不住「海量小题」。
 */
function createMemoryStore(maxEntries = LIMITS.MAX_STORE_ENTRIES, maxBytes = LIMITS.MAX_STORE_BYTES) {
    const map = new Map();
    let totalBytes = 0;
    return {
        has(id) { return map.has(id); },
        get(id) { return map.has(id) ? map.get(id) : null; },
        set(id, value) {
            const bytes = byteLength(value);
            if (map.has(id)) {                       // 覆盖：只补差额
                totalBytes += bytes - byteLength(map.get(id));
                map.set(id, value);
                return true;
            }
            if (map.size >= maxEntries) return false;
            if (totalBytes + bytes > maxBytes) return false;
            map.set(id, value);
            totalBytes += bytes;
            return true;
        },
        get size() { return map.size; },
        get bytes() { return totalBytes; },
    };
}

module.exports = {
    LIMITS, ID_RE, CORS_HEADERS,
    byteLength, formatBytes,
    validateCode, validateId, validateStored, serialize,
    validateGlslShape, stripComments, GLSL_SHAPE,
    generateId, contentKey, createId, assignId,
    createRateLimiter, clientIp,
    createMemoryStore,
};
