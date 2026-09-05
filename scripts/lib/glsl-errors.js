'use strict';
/**
 * GLSL 编译日志的解析与归类，两个后端共用。
 *
 * glslangValidator 与 ANGLE 的错误格式略有差异，但都是 `ERROR: <位置>: 消息`，
 * 位置可能是 `0:21`（列:行）也可能是 `路径.frag:21`。统一吃进来，行号一律
 * 映射回用户源码 —— 报包装后的行号等于没报。
 */

/** 匹配 `ERROR: 0:21:` 与 `ERROR: /tmp/x.frag:21:` 两种前缀 */
const LOC_RE = /^((?:ERROR|WARNING):\s*)(?:\d+|\S*\.(?:frag|vert)):(\d+):/;

/**
 * 原始日志 → 结构化错误列表，行号映射回源码。
 *
 * 注意：这里只做「格式化」，不做「哪些能降级」的判断。降级是 glslang 后端
 * 独有的概念 —— 浏览器是权威，它报的每一条都是真问题，一条都不能降级。
 */
function parseErrors(stdout, offset) {
    const raw = String(stdout || '').split('\n')
        .map(l => l.trim())
        .filter(l => l && !/compilation errors/.test(l) && !/^\S*\.(?:frag|vert)$/.test(l))
        .map(l => l.replace(LOC_RE, (_, head, line) => {
            const src = parseInt(line, 10) - offset;
            return src > 0 ? `${head}源码第 ${src} 行:` : `${head}第 ${line} 行:`;
        }));

    // 链接错误会折行（"…found:" 换行后跟符号签名），合并回一条
    const items = [];
    for (const l of raw) {
        const prev = items[items.length - 1];
        if (prev !== undefined && !/^(ERROR|WARNING):/.test(l) && /:$/.test(prev)) items[items.length - 1] = prev + ' ' + l;
        else items.push(l);
    }
    return items;
}

module.exports = { LOC_RE, parseErrors };
