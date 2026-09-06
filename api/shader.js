// Vercel Serverless Function — 存储/读取 shader
// API:
//   POST /api/shader   body: { code }  → 返回 { id }
//   GET  /api/shader?id=xxx            → 返回 { id, code }
//
// 写入防护（体积上限 / ID 校验 / 按 IP 限流 / 存储配额）全部在 ../shared/shader-api.js，
// 与 Netlify 版 netlify/functions/shader.js 共用同一份，别在这里另写一套。

import api from '../shared/shader-api.js';

// 每个实例独立计数、跨实例不共享 —— 这是减速带而非强限制，理由与数字怎么来的
// 见 shared/shader-api.js 顶部。要真正拦 Abuse，请在平台层配 Vercel Firewall。
const postLimiter = api.createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
const getLimiter = api.createRateLimiter({ limit: 1200, windowMs: 10 * 60 * 1000 });

// 内存存储（重启后丢失，且有条目上限）。持久化请换 @vercel/kv / @vercel/blob。
const store = api.createMemoryStore();

function deny(res, retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `请求过于频繁，请 ${retryAfter} 秒后再试` });
}

export default async function handler(req, res) {
  Object.entries(api.CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = api.clientIp(req.headers);

  try {
    if (req.method === 'POST') {
      const gate = postLimiter.check(ip);
      if (!gate.ok) return deny(res, gate.retryAfter);

      const { code } = req.body || {};
      const v = api.validateCode(code);
      if (!v.ok) return res.status(400).json({ error: v.error });

      // 内容寻址：同一份代码复用同一个 ID，重复提交不再占第二份存储。
      // 响应形状不变，前端无需改动。
      const { id, deduped } = await api.assignId(code, {
        get: key => store.get(key),
        has: key => store.has(key),
      });
      if (!deduped && !store.set(id, api.serialize(code))) {
        return res.status(503).json({ error: '存储空间已满，请稍后再试' });
      }
      return res.status(200).json({ id });
    }

    if (req.method === 'GET') {
      const gate = getLimiter.check(ip);
      if (!gate.ok) return deny(res, gate.retryAfter);

      const id = req.query.id;
      const vid = api.validateId(id);
      if (!vid.ok) return res.status(400).json({ error: vid.error });

      const raw = store.get(id);
      if (!raw) return res.status(404).json({ error: '未找到该 shader' });

      // 存储里的内容不直接反射出去：坏了就说坏了，别把脏数据当 shader 吐给前端
      const parsed = api.validateStored(raw);
      if (!parsed.ok) {
        console.error('[shader] 存储内容非法:', parsed.error);
        return res.status(500).json({ error: '存储内容已损坏' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ id, code: parsed.code });
    }

    return res.status(405).json({ error: '不支持的请求方法' });
  } catch (err) {
    console.error('Shader API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
