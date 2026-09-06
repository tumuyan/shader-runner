// netlify/functions/shader.js
// 服务端存储 Shader 代码 — 首选 Netlify Blob Storage, 回退到内存存储
// API:
//   POST /    → body: { code }     → 返回 { id }
//   GET  /?id=xxx                  → 返回 { id, code }
//
// 写入防护（体积上限 / ID 校验 / 按 IP 限流 / 存储配额）全部在 ../../shared/shader-api.js，
// 与 Vercel 版 api/shader.js 共用同一份，别在这里另写一套。

const api = require('../../shared/shader-api.js');

// 每个实例独立计数、跨实例不共享 —— 这是减速带而非强限制，理由与数字怎么来的
// 见 shared/shader-api.js 顶部。要真正拦 Abuse，请用 Netlify 平台自带的限速。
const postLimiter = api.createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
const getLimiter = api.createRateLimiter({ limit: 1200, windowMs: 10 * 60 * 1000 });

let store = null;
let memoryStore = null; // in-memory 回退（带条目上限）

async function getStoreInstance() {
  if (store) return store;
  try {
    const { getStore } = require('@netlify/blobs');
    store = getStore('shaders');
    // 快速探测 Blob Storage 是否可用
    try { await store.get('__probe__', { type: 'text' }); } catch (e) { /* 可忽略 */ }
    console.log('[shader] 使用 Netlify Blob Storage');
    return store;
  } catch (e) {
    console.warn('[shader] Blob Storage 不可用，回退到内存存储:', e.message);
    memoryStore = memoryStore || api.createMemoryStore();
    return null;
  }
}

function deny(retryAfter) {
  return {
    statusCode: 429,
    headers: { ...api.CORS_HEADERS, 'Retry-After': String(retryAfter) },
    body: JSON.stringify({ error: `请求过于频繁，请 ${retryAfter} 秒后再试` }),
  };
}

exports.handler = async (event, context) => {
  const headers = { ...api.CORS_HEADERS };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // 405 必须在初始化存储之前返回：PATCH / DELETE 本来就不该碰存储，尤其 Blob 不可用
  // 时每次 getStoreInstance() 都要重跑一遍 require + getStore + __probe__。
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '不支持的请求方法' }) };
  }

  const ip = api.clientIp(event.headers);

  try {
    // 限流同样在 getStoreInstance() 之前，理由同上：被限流的请求不该各触发一次探测。
    const gate = event.httpMethod === 'POST' ? postLimiter.check(ip) : getLimiter.check(ip);
    if (!gate.ok) return deny(gate.retryAfter);

    const blobStore = await getStoreInstance();

    if (event.httpMethod === 'POST') {
      // 先看体积再 JSON.parse：省掉解析一个几 MB 字符串（平台 body 上限是 6MB）
      const bodyBytes = api.byteLength(event.body || '');
      if (bodyBytes > api.LIMITS.MAX_BODY_BYTES) {
        return {
          statusCode: 413, headers,
          // 精确字节：超一点点时四舍五入会让上下限看起来一样
          body: JSON.stringify({
            error: '请求体 ' + bodyBytes + ' 字节，超过上限 '
                 + api.LIMITS.MAX_BODY_BYTES + ' 字节（'
                 + api.formatBytes(api.LIMITS.MAX_BODY_BYTES) + '）',
          }),
        };
      }

      let parsed;
      try {
        parsed = JSON.parse(event.body || '{}');
      } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '请求体不是合法 JSON' }) };
      }

      const code = parsed.code;
      const v = api.validateCode(code);
      if (!v.ok) return { statusCode: 400, headers, body: JSON.stringify({ error: v.error }) };

      // 内容寻址：同一份代码复用同一个 ID，重复提交不再占第二份存储。
      // 两种存储共用这段去重逻辑（io 由上面注入），响应形状不变，前端无需改动。
      const io = blobStore
        ? {
            get: key => blobStore.get(key, { type: 'text' }),
            has: async key => (await blobStore.get(key, { type: 'text' })) !== null,
          }
        : {
            get: key => memoryStore.get(key),
            has: key => memoryStore.has(key),
          };
      const { id, deduped } = await api.assignId(code, io);

      const payload = api.serialize(code);
      if (deduped) {
        return { statusCode: 200, headers, body: JSON.stringify({ id }) };
      } else if (blobStore) {
        await blobStore.set(id, payload);
      } else if (!memoryStore.set(id, payload)) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: '存储空间已满，请稍后再试' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ id }) };

    } else if (event.httpMethod === 'GET') {
      const id = (event.queryStringParameters || {}).id;
      const vid = api.validateId(id);
      if (!vid.ok) return { statusCode: 400, headers, body: JSON.stringify({ error: vid.error }) };

      let raw;
      if (blobStore) {
        raw = await blobStore.get(id, { type: 'text' });
      } else {
        raw = memoryStore.get(id) || null;
      }
      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: '未找到该 shader' }) };
      }

      // 存储里的内容不直接反射出去：坏了就说坏了，别把脏数据当 shader 吐给前端
      const parsed = api.validateStored(raw);
      if (!parsed.ok) {
        console.error('[shader] 存储内容非法:', parsed.error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: '存储内容已损坏' }) };
      }
      headers['Cache-Control'] = 'no-store';
      return { statusCode: 200, headers, body: JSON.stringify({ id, code: parsed.code }) };
    }
  } catch (err) {
    console.error('Shader function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
