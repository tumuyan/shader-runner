#!/usr/bin/env node
/**
 * /api/shader 写入防护的校验（npm run api:check，已并入 npm run check）。
 *
 *   node scripts/check-api.js
 *
 * 验三件事，任一项失败退出码 1：
 *   1. shared/shader-api.js 的纯逻辑：体积/ID/存储校验、限流、ID 生成、内存配额
 *   2. netlify/functions/shader.js 的 handler（直接 require，CJS）
 *   3. api/shader.js 的 handler（Vercel 侧是 ESM，复制到临时目录后 import）
 *
 * 为什么要跑 handler 而不只测纯函数：校验写成什么样都可能在接线时漏掉 —— 忘了
 * 调 validateCode、限流器建了没用、429 忘了带 Retry-After。只有把 handler 真的
 * 打一遍（超体积 → 400、连发 21 次 → 429、../ 当 id → 400）才算验过。
 *
 * 不参与 --check 时是静默的；CI 里由 gen-shader-manifest.js --check 调用。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = require(path.join(ROOT, 'shared/shader-api.js'));

let failed = 0;
function check(name, ok, extra) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  — ' + extra : ''));
    if (!ok) failed++;
}
function section(name) { console.log('\n' + name); }

// handler 会打印平台相关的 log/warn，测试期间静音，免得盖住断言输出。
// 必须 await 完再恢复：请求是异步的，同步恢复等于没静音。
async function muted(fn) {
    const { log, warn, error } = console;
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑
// ---------------------------------------------------------------------------
const KB = 1024;
const goodCode = 'void mainImage(out vec4 f, in vec2 p){ f = vec4(1.0); }';

/**
 * 造一份「形态合法、体积精确为 n 字节」的 shader。
 * 体积类用例必须用它而不是 'a'.repeat(n) —— 后者会先被 GLSL 形态校验拦下，
 * 于是「超体积」的断言其实是被形态规则挡住的，测的就不是体积了。
 * 填充放在行注释里，不引入额外的 GLSL 结构。
 */
function glslOfBytes(n) {
    const head = goodCode + '\n// ';
    const pad = n - api.byteLength(head) - 1;   // -1：末尾换行
    if (pad < 0) return goodCode;
    return head + 'x'.repeat(pad) + '\n';
}

section('体积校验');
check('接受正常 shader', api.validateCode(goodCode).ok === true);
check('按字节计量中文注释',
    api.validateCode('// ' + '中'.repeat(3) + '\n' + goodCode).bytes === api.byteLength('// ' + '中'.repeat(3) + '\n' + goodCode)
    && api.byteLength('中') === 3);
check('拒绝超过 512KB', api.validateCode(glslOfBytes(512 * KB + 1)).ok === false,
    api.validateCode(glslOfBytes(512 * KB + 1)).error);
check('接受恰好 512KB', api.validateCode(glslOfBytes(512 * KB)).ok === true);
check('拒绝非字符串', api.validateCode({ code: 1 }).ok === false && api.validateCode(null).ok === false);
check('拒绝全空白', api.validateCode('   \n\t ').ok === false);
// 体积必须排在形态之前：600 KB 的载荷报「缺少 mainImage」会把人带偏
check('超体积优先于形态报错',
    /超过上限/.test(api.validateCode('hello world '.repeat(50000)).error),
    api.validateCode('hello world '.repeat(50000)).error);
check('拒绝 NUL 字符', api.validateCode('void main(){' + String.fromCharCode(0) + '}').ok === false);

section('GLSL 形态校验（只拦必定编译不过的）');
{
    const S = api.validateGlslShape;
    check('接受正常 shader', S(goodCode).ok === true);
    check('拒绝缺少 mainImage', S('float f(){ return 1.0; }').ok === false,
        S('float f(){ return 1.0; }').error);
    check('拒绝 #version（与包装器冲突）', S('#version 300 es\n' + goodCode).ok === false);
    check('拒绝重复定义 main', S(goodCode + '\nvoid main(){ }').ok === false);
    check('拒绝 script 标签', S(goodCode + '\n</script>').ok === false);

    // 这些是「去注释」带来的收益：注释里出现同类写法不该被误杀
    check('注释里的 void main() 不误伤', S('// void main() 由包装器调用\n' + goodCode).ok === true);
    check('注释里的 #version 不误伤', S('/* #version 300 es */\n' + goodCode).ok === true);
    check('注释里的 /* 不会吃掉后面真代码',
        S('// a /* b\n' + goodCode).ok === true);

    // 这条是本组最重要的回归护栏：70s-melt-color 正是靠 precision 重声明活着的。
    // 它在真实 WebGL2/ANGLE 下编译 + 链接 + 渲染全过，只有 glslang 判它失败。
    // 哪天有人想「顺手把 precision 也拦了」，这条会立刻变红。
    check('precision 重声明不误伤（70s-melt-color 的命门）',
        S('#ifdef GL_ES\nprecision mediump float;\n#endif\n' + goodCode).ok === true);
    check('块注释里的 precision 也不误伤', S('/* precision mediump float; */\n' + goodCode).ok === true);

    // mainImage 必须真的存在，光在注释里不算
    check('注释里的 mainImage 不算数', S('// void mainImage(out vec4 o, in vec2 c)\nfloat f(){return 1.0;}').ok === false);
}

section('ID 校验');
check('接受 8 位字母数字', api.validateId('abcd1234').ok === true);
check('拒绝路径穿越', api.validateId('../secret').ok === false);
check('拒绝空 / 超长', api.validateId('').ok === false && api.validateId('a'.repeat(9)).ok === false);
check('拒绝非字符串', api.validateId(1234).ok === false);
check('拒绝斜杠与点', api.validateId('a/b').ok === false && api.validateId('a.b').ok === false);

/**
 * 往返测试：写入侧放行的，读取侧必须读得出来。
 *
 * 这是上一版漏掉的那类缝。当时写入按 code 的字节数判（512 KB），读取按序列化之后的
 * 字节数判（512 KB + 16 KB），于是「512 KB 且 17000 行换行」的记录能存进去却永远
 * 读不出来 —— GET 变 500，而且去重因读不出内容而误判成碰撞，每次重发都再存一份副本。
 * 只测「孤立地看 validateStored 会拒绝超长记录」是抓不到的，必须两边对着跑。
 */
function roundTripChecks() {
    section('写入 ↔ 读取 往返一致性');

    // 覆盖从 0 到 40000 个换行：换行在 JSON 里变成 2 字节，是膨胀的主因
    const head = goodCode + '\n';
    let worst = null, samples = 0, accepted = 0;
    for (const nl of [0, 1000, 8000, 16000, 17000, 20000, 40000, 100000]) {
        let code = head + '//\n'.repeat(nl);
        const need = api.LIMITS.MAX_CODE_BYTES - api.byteLength(code) - 2;
        if (need < 0) continue;                       // 这个换行数装不下 512KB，跳过
        code = code + '//' + 'x'.repeat(need);
        samples++;

        const w = api.validateCode(code);
        if (!w.ok) continue;
        accepted++;
        const stored = api.serialize(code);
        const r = api.validateStored(stored);
        if (!r.ok) {
            worst = { nl, stored: api.byteLength(stored), error: r.error };
        }
    }
    check('写入放行的，读取一律可读', worst === null,
        worst ? `换行 ${worst.nl}：存储 ${worst.stored}B → ${worst.error}` : `验了 ${accepted}/${samples} 个样本`);

    // 更强的形式：任何 code，只要写入接受，序列化后必在读取上限内
    const room = api.LIMITS.MAX_STORED_BYTES
        - api.byteLength(api.serialize('x'.repeat(api.LIMITS.MAX_CODE_BYTES)));
    check('最坏转义下仍有余量', room >= 0, '余量=' + room + ' 字节');

    // 去重不能因「读不出内容」而退化成碰撞 —— 那是每重发一次就多存一份副本
    let dedupeBroken = null;
    for (const nl of [0, 17000, 40000]) {
        let code = head + '//\n'.repeat(nl);
        const need = api.LIMITS.MAX_CODE_BYTES - api.byteLength(code) - 2;
        if (need < 0) continue;
        code = code + '//' + 'x'.repeat(need);
        if (!api.validateCode(code).ok) continue;
        const key = api.contentKey(code);
        const map = new Map([[key, api.serialize(code)]]);
        const io = { get: k => map.get(k) || null, has: k => map.has(k) };
        // 同步拿不到 assignId 的结果，这里只验它依赖的前置条件
        const readable = api.validateStored(map.get(key)).ok;
        if (!readable) dedupeBroken = nl;
    }
    check('去重的前置条件成立（已存内容始终可读）', dedupeBroken === null,
        dedupeBroken === null ? '' : '换行 ' + dedupeBroken + ' 时读不出');
}

section('存储内容校验');
check('接受合法记录', api.validateStored(JSON.stringify({ code: goodCode })).ok === true);
check('拒绝非 JSON', api.validateStored('{oops').ok === false);
check('拒绝缺 code 字段', api.validateStored(JSON.stringify({ nope: 1 })).ok === false);
check('拒绝 code 非字符串', api.validateStored(JSON.stringify({ code: 42 })).ok === false);
// 越过上限来测，而不是写死一个字节数 —— 上限是「最坏 JSON 转义」推导出来的，
// 写死的话，调过一次上限之后这条就会变成「什么都没验」的假绿。
check('拒绝超长记录',
    api.validateStored(api.serialize('a'.repeat(api.LIMITS.MAX_STORED_BYTES + 1))).ok === false);
check('接受恰好到上限的记录',
    api.validateStored(api.serialize('a'.repeat(api.LIMITS.MAX_STORED_BYTES - 16))).ok === true);

section('ID 生成');
const ids = new Set();
for (let i = 0; i < 5000; i++) ids.add(api.generateId());
check('5000 次无碰撞', ids.size === 5000, 'unique=' + ids.size);
check('长度与字符集合法',
    [...ids].every(id => id.length === 8 && api.ID_RE.test(id)));
check('用 crypto（不同进程不会重复）', api.generateId() !== api.generateId());

// assignId 是 async，这段只能在 main() 里跑，所以它的输出排在同步各节之后 ——
// section() 必须写在函数内，否则标题会和断言分家（见上面的顺序）
async function contentAddressingChecks() {
    section('内容寻址');
    const k1 = api.contentKey(goodCode);
    check('同内容 → 同键（确定性）', k1 === api.contentKey(goodCode), k1);
    check('不同内容 → 不同键', k1 !== api.contentKey(goodCode + ' '));
    check('键长度与字符集合法', k1.length === 8 && api.ID_RE.test(k1), k1);
    check('空串等极端输入不炸',
        api.ID_RE.test(api.contentKey('')) && api.ID_RE.test(api.contentKey('中'.repeat(1e4))));

    const store = new Map();
    const io = { get: k => store.get(k) || null, has: k => store.has(k) };

    const r1 = await api.assignId(goodCode, io);
    check('首次写入用内容键', r1.id === k1 && r1.deduped === false, JSON.stringify(r1));
    store.set(r1.id, JSON.stringify({ code: goodCode }));

    const r2 = await api.assignId(goodCode, io);
    check('重复提交去重', r2.id === r1.id && r2.deduped === true, JSON.stringify(r2));
    check('去重后不再需要写入', r2.deduped === true && store.size === 1, 'size=' + store.size);

    // 真碰撞：键已被别的内容占着。强行占位来模拟 —— 8 位键的碰撞概率是 6e-8，
    // 等不到天然发生，但这段代码必须被验过，否则「去重」会变成「返回错的 shader」。
    store.set(k1, JSON.stringify({ code: '完全不同的一份代码' }));
    const r3 = await api.assignId(goodCode, io);
    check('碰撞时不当成去重', r3.deduped === false, JSON.stringify(r3));
    check('碰撞时改用别的 ID（不覆盖别人）', r3.id !== k1, 'id=' + r3.id + ' key=' + k1);
    check('退回的 ID 本身合法', api.ID_RE.test(r3.id) && r3.id.length === 8);
    check('退回的 ID 不与已占键冲突', !store.has(r3.id));
}

section('按 IP 限流');
{
    const rl = api.createRateLimiter({ limit: 3, windowMs: 1000 });
    const now = 1_000_000;
    check('放行到上限', ['1', '1', '1'].every((_, i) => rl.check('1.1.1.1', now + i).ok));
    const blocked = rl.check('1.1.1.1', now + 3);
    check('超上限即拒绝', blocked.ok === false, JSON.stringify(blocked));
    check('retryAfter 合理（秒）', blocked.retryAfter >= 1 && blocked.retryAfter <= 1,
        'retryAfter=' + blocked.retryAfter);
    check('别的 IP 不受影响', rl.check('2.2.2.2', now + 3).ok === true);
    check('窗口过后恢复', rl.check('1.1.1.1', now + 1001).ok === true);
}
{
    // 限流器自己不能变成内存 DoS 入口
    const rl = api.createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 5000; i++) rl.check('ip-' + i, 1_000_000 + i);
    check('条目数封顶（内存自防护）', rl.size <= 100, 'size=' + rl.size);
}

section('clientIp');
check('优先 Netlify 边缘头',
    api.clientIp({ 'x-forwarded-for': '9.9.9.9', 'x-nf-client-connection-ip': '1.2.3.4' }) === '1.2.3.4');
check('XFF 取最左一段', api.clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }) === '1.2.3.4');
check('回退 x-real-ip', api.clientIp({ 'x-real-ip': '8.8.8.8' }) === '8.8.8.8');
check('取不到时 unknown（而非放行）', api.clientIp({}) === 'unknown' && api.clientIp(undefined) === 'unknown');

section('内存存储配额');
{
    const ms = api.createMemoryStore(3);
    check('放到上限', ms.set('a', '1') && ms.set('b', '1') && ms.set('c', '1'));
    check('满后拒绝新条目', ms.set('d', '1') === false, 'size=' + ms.size);
    check('已存在的 key 可覆盖', ms.set('a', '2') === true);
}
{
    // 只按条数算会被「少量超大题」绕过 —— 这正是上一版 5000 × 512KB = 2.44 GiB 的漏洞
    const ms = api.createMemoryStore(1000, 1000);
    check('byte 预算拦下超大题', ms.set('big', 'x'.repeat(2000)) === false, 'bytes=' + ms.bytes);
    check('byte 预算放行小题', ms.set('small', 'x'.repeat(100)) === true, 'bytes=' + ms.bytes);
    check('覆盖已有 key 不重复计费', ms.set('small', 'x'.repeat(900)) === true && ms.bytes === 900,
        'bytes=' + ms.bytes);
    check('逼近上限时拒掉会超的那个', ms.set('more', 'x'.repeat(200)) === false, 'bytes=' + ms.bytes);
}

// ---------------------------------------------------------------------------
// 2 & 3. 两个 handler 的行为
// ---------------------------------------------------------------------------

/** Vercel 风格的 mock req/res */
function vercelHandlerCall(handler, { method, headers = {}, body, query = {} }) {
    let status = 0, payload = undefined;
    const resHeaders = {};
    const res = {
        setHeader: (k, v) => { resHeaders[k] = v; },
        status(n) { status = n; return res; },
        json(o) { payload = o; return res; },
        end() { return res; },
    };
    return Promise.resolve(handler({ method, headers, body, query }, res))
        .then(() => ({ status, payload, headers: resHeaders }));
}

function netlifyHandlerCall(handler, { method, headers = {}, body, query = {} }) {
    const queryStringParameters = Object.keys(query).length ? query : null;
    return Promise.resolve(handler({ httpMethod: method, headers, body, queryStringParameters }, {}))
        .then(r => ({
            status: r.statusCode,
            payload: r.body ? JSON.parse(r.body) : undefined,
            headers: r.headers || {},
        }));
}

/**
 * 对某个 handler 跑同一套断言。
 * 注意顺序：POST 限流是模块级状态，跑满 21 次后该 IP 就被限住了，
 * 所以「限流」这组必须放最后，其余用例用不同 IP。
 */
async function exerciseHandler(label, rawCall, opts) {
    // 只静音 handler 自己那几行平台日志；断言输出必须在静音之外，否则全被吃掉
    const call = o => muted(() => rawCall(o));
    // Netlify 拿得到原始 body 字符串，能在 JSON.parse 之前按体积拒（413）；
    // Vercel 的 req.body 是平台预解析好的对象，只能靠 code 校验兜住（400）。
    // 两者都是「超大请求被挡下」，只是挡在哪一层。
    const bodyGuard = Boolean(opts && opts.bodyGuard);
    const H = ip => ({ 'x-nf-client-connection-ip': ip });
    const SHADER = 'void mainImage(out vec4 f, in vec2 p){ f = vec4(1.0); }';

    section(label);

    const opt = await call({ method: 'OPTIONS', headers: H('10.0.0.1') });
    check('OPTIONS → 204', opt.status === 204, 'status=' + opt.status);

    const ok = await call({
        method: 'POST', headers: H('10.0.0.2'), body: { code: SHADER },
    });
    check('POST 正常 → 200 + id', ok.status === 200 && typeof (ok.payload || {}).id === 'string',
        JSON.stringify(ok.payload));
    const id = (ok.payload || {}).id;

    const bad = await call({ method: 'POST', headers: H('10.0.0.3'), body: {} });
    check('POST 缺 code → 400', bad.status === 400, JSON.stringify(bad.payload));

    const huge = glslOfBytes(512 * KB + 1);
    const big = await call({ method: 'POST', headers: H('10.0.0.4'), body: { code: huge } });
    check('POST 超 512KB → 400', big.status === 400, JSON.stringify(big.payload));

    // 形态拦截：不是 GLSL 的东西不该进存储
    const notGlsl = await call({ method: 'POST', headers: H('10.0.0.14'), body: { code: 'hello world' } });
    check('POST 非 GLSL → 400', notGlsl.status === 400, JSON.stringify(notGlsl.payload));
    const withVersion = await call({
        method: 'POST', headers: H('10.0.0.15'),
        body: { code: '#version 300 es\n' + SHADER },
    });
    check('POST 带 #version → 400', withVersion.status === 400, JSON.stringify(withVersion.payload));

    const wrongType = await call({ method: 'POST', headers: H('10.0.0.5'), body: { code: { a: 1 } } });
    check('POST code 非字符串 → 400', wrongType.status === 400, JSON.stringify(wrongType.payload));

    const hugeBody = await call({ method: 'POST', headers: H('10.0.0.10'), body: { code: glslOfBytes(1100 * KB) } });
    check('POST 超大请求体 → ' + (bodyGuard ? '413（解析前拦下）' : '400（由 code 校验兜住）'),
        hugeBody.status === (bodyGuard ? 413 : 400), 'status=' + hugeBody.status);

    const got = await call({ method: 'GET', headers: H('10.0.0.6'), query: { id } });
    check('GET 已存 → 200 + code', got.status === 200 && got.payload.code === SHADER, JSON.stringify(got.payload));

    // 去重（换 IP 以避开限流）。这条同时是接线验证：assignId 写对了但 handler 忘了调用它，
    // 这里就会拿到一个不同的随机 ID —— 只测纯函数是抓不到的。
    const again = await call({ method: 'POST', headers: H('10.0.0.11'), body: { code: SHADER } });
    check('重复 POST → 同一个 id', again.status === 200 && again.payload.id === id,
        JSON.stringify(again.payload) + ' vs ' + id);
    // 内容不同则必须给新 ID —— 去重绝不能变成「不同内容共用 ID」
    const other = await call({ method: 'POST', headers: H('10.0.0.12'), body: { code: SHADER + ' ' } });
    check('不同内容 → 不同 id', other.status === 200 && other.payload.id !== id,
        JSON.stringify(other.payload) + ' vs ' + id);
    const otherGot = await call({ method: 'GET', headers: H('10.0.0.13'), query: { id: other.payload.id } });
    check('去重没把内容搞串', otherGot.payload.code === SHADER + ' ', JSON.stringify(otherGot.payload));
    check('GET 响应 no-store', /no-store/.test(got.headers['Cache-Control'] || ''),
        got.headers['Cache-Control']);

    const traversal = await call({ method: 'GET', headers: H('10.0.0.7'), query: { id: '../secret' } });
    check('GET 路径穿越 → 400', traversal.status === 400, JSON.stringify(traversal.payload));

    const missing = await call({ method: 'GET', headers: H('10.0.0.8'), query: { id: 'zzzzzzzz' } });
    check('GET 不存在 → 404', missing.status === 404, JSON.stringify(missing.payload));

    const patch = await call({ method: 'PATCH', headers: H('10.0.0.9') });
    check('不支持的方法 → 405', patch.status === 405, 'status=' + patch.status);

    // 限流放最后：这个 IP 之后就被限住了
    let last = null, limitedAt = -1;
    for (let i = 0; i < 25; i++) {
        last = await call({ method: 'POST', headers: H('10.9.9.9'), body: { code: SHADER } });
        if (last.status === 429 && limitedAt < 0) limitedAt = i;
    }
    check('连发超过 20 次 → 429', last.status === 429, 'status=' + last.status);
    check('恰好第 21 次被拦', limitedAt === 20, 'limitedAt=' + limitedAt);
    check('429 带 Retry-After', Number(last.headers['Retry-After']) > 0, last.headers['Retry-After']);

    const still = await call({ method: 'GET', headers: H('10.9.9.9'), query: { id } });
    check('GET 不受 POST 限流影响', still.status === 200, 'status=' + still.status);
}

async function main() {
    await contentAddressingChecks();
    roundTripChecks();

    // --- Netlify（CJS，直接 require）---
    const netlify = require(path.join(ROOT, 'netlify/functions/shader.js'));
    await exerciseHandler('netlify/functions/shader.js',
        o => netlifyHandlerCall(netlify.handler, {
            ...o,
            body: o.body === undefined ? undefined : JSON.stringify(o.body),
        }),
        { bodyGuard: true });

    // --- Vercel（ESM）：复制到临时目录再 import，相对路径 ../shared/ 才能解析 ---
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-api-check-'));
    try {
        fs.mkdirSync(path.join(tmp, 'api'));
        fs.mkdirSync(path.join(tmp, 'shared'));
        // .mjs：package.json 没有 "type":"module"，直接用 .js 会被 Node 当 CJS 解析
        fs.copyFileSync(path.join(ROOT, 'api/shader.js'), path.join(tmp, 'api/shader.mjs'));
        fs.copyFileSync(path.join(ROOT, 'shared/shader-api.js'), path.join(tmp, 'shared/shader-api.js'));
        const mod = await import('file://' + path.join(tmp, 'api/shader.mjs'));
        check('Vercel 入口能加载共享模块', typeof mod.default === 'function');
        await exerciseHandler('api/shader.js', o => vercelHandlerCall(mod.default, o));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 服务端写入防护校验通过');
    if (failed) process.exit(1);
}

main().catch(err => {
    console.error('✗ 校验脚本自身出错:', err);
    process.exit(1);
});
