// Vercel Serverless Function — 存储/读取 shader
// API:
//   POST /api/shader   body: { code }  → 返回 { id }
//   GET  /api/shader?id=xxx            → 返回 { id, code }

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

// 简易内存存储（重启后丢失）
// 如需持久化，可换用 @vercel/kv 或 @vercel/blob
const store = new Map();

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') {
      const { code } = req.body || {};
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: '缺少 code 字段' });
      }
      const id = generateId();
      store.set(id, { code });
      return res.status(200).json({ id });

    } else if (req.method === 'GET') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: '缺少 id 参数' });

      const data = store.get(id);
      if (!data) return res.status(404).json({ error: '未找到该 shader' });

      return res.status(200).json(data);
    }

    return res.status(405).json({ error: '不支持的请求方法' });
  } catch (err) {
    console.error('Shader API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
