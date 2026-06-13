// netlify/functions/shader.js
// 服务端存储 Shader 代码 — 首选 Netlify Blob Storage, 回退到内存存储
// API:
//   POST /    → body: { code }     → 返回 { id }
//   GET  /?id=xxx                  → 返回 { id, code }

let store = null;
let memoryStore = null; // in-memory 回退

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
    memoryStore = new Map();
    return null;
  }
}

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
    const blobStore = await getStoreInstance();

    if (event.httpMethod === 'POST') {
      // --- 存储 ---
      const { code } = JSON.parse(event.body || '{}');
      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 code 字段' }) };
      }

      const id = generateId();
      if (blobStore) {
        await blobStore.set(id, JSON.stringify({ code }));
      } else {
        memoryStore.set(id, JSON.stringify({ code }));
      }
      return { statusCode: 200, headers, body: JSON.stringify({ id }) };

    } else if (event.httpMethod === 'GET') {
      // --- 读取 ---
      const id = event.queryStringParameters?.id;
      if (!id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 id 参数' }) };
      }

      let raw;
      if (blobStore) {
        raw = await blobStore.get(id, { type: 'text' });
      } else {
        raw = memoryStore.get(id) || null;
      }
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
