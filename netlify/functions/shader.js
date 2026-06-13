// netlify/functions/shader.js
// 服务端存储 Shader 代码 — 使用 Netlify Blob Storage
// API:
//   POST /    → body: { code }     → 返回 { id }
//   GET  /?id=xxx                  → 返回 { id, code }

const { getStore } = require('@netlify/blobs');

// 生成短 ID (8 位字母数字)
function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const store = getStore('shaders');

    if (event.httpMethod === 'POST') {
      // --- 存储 ---
      const { code } = JSON.parse(event.body || '{}');
      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 code 字段' }) };
      }

      const id = generateId();
      await store.set(id, JSON.stringify({ code }));
      return { statusCode: 200, headers, body: JSON.stringify({ id }) };

    } else if (event.httpMethod === 'GET') {
      // --- 读取 ---
      const id = event.queryStringParameters?.id;
      if (!id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 id 参数' }) };
      }

      const raw = await store.get(id, { type: 'text' });
      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: '未找到该 shader' }) };
      }

      return { statusCode: 200, headers, body: raw };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: '不支持的请求方法' }) };
  } catch (err) {
    console.error('Shader function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
