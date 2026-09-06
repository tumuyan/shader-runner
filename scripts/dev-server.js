#!/usr/bin/env node
/**
 * 零依赖的本地开发服务器（npm run dev）。
 *
 *   node scripts/dev-server.js [port]        # 默认 8080
 *   PORT=3000 npm run dev
 *
 * 为什么需要它：npx serve . 之类的纯静态服务器只发文件，没有 /api/shader，
 * 于是页面启动探测失败 → 「发布」按钮被置灰，「发布」这条路径在本地根本走不到。
 * 这个脚本补上一个 /api/shader —— 直接 import Vercel 那个 handler（同一个文件、
 * 同一份 shared/shader-api.js），所以本地验证的就是真要部署的代码，不是复制品。
 *
 * 不装 vercel CLI 也能跑：它只是个静态服务器 + 一次 import，没有平台依赖。
 * 反过来，它也不替代 vercel dev —— 平台侧的打包（esbuild/ncc 把相对依赖打进产物）
 * 只有真 CLI 能验（见 README「部署」节）。
 *
 * 存储是内存 Map，进程退出即丢 —— 与 Vercel 生产环境的行为一致。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HANDLER = path.join(ROOT, 'api', 'shader.js');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.glsl': 'text/plain; charset=utf-8',
    '.frag': 'text/plain; charset=utf-8',
};

/**
 * 加载 Vercel 的 ESM handler，包成 (req,res) 的 Node 回调。
 * 入口是 ESM（export default）而 package.json 没有 "type":"module"，
 * 复制到临时目录改名 .mjs 再 import —— 与 scripts/check-api.js 同一个套路。
 */
async function loadApiHandler() {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-dev-'));
    fs.mkdirSync(path.join(tmp, 'api'));
    fs.mkdirSync(path.join(tmp, 'shared'));
    fs.copyFileSync(HANDLER, path.join(tmp, 'api', 'shader.mjs'));
    fs.copyFileSync(path.join(ROOT, 'shared', 'shader-api.js'), path.join(tmp, 'shared', 'shader-api.js'));
    const mod = await import('file://' + path.join(tmp, 'api', 'shader.mjs'));
    fs.rmSync(tmp, { recursive: true, force: true });
    return mod.default;
}

/** Vercel 平台替 handler 做的事：解析 query、解析 JSON body、对象式 res.json() */
function callHandler(handler, req, res, url, bodyText) {
    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    let body;
    if (bodyText) {
        try { body = JSON.parse(bodyText); } catch { body = undefined; }
    }

    const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    );
    // Vercel 用 x-forwarded-for；本地直连没有，退回 socket 地址（::1 → 127.0.0.1，
    // 否则限流器会把每个请求当成不同 IP 之外的东西，共享同一个 bucket）
    if (!headers['x-forwarded-for']) {
        const ip = req.socket.remoteAddress || '';
        headers['x-forwarded-for'] = ip.startsWith('::ffff:') ? ip.slice(7) : (ip === '::1' ? '127.0.0.1' : ip);
    }

    const headersOut = {};
    const shim = {
        setHeader: (k, v) => { headersOut[k] = v; },
        status(code) { this._status = code; return this; },
        json(obj) { this._json = obj; return this; },
        end() { return this; },
    };

    return Promise.resolve(handler({ method: req.method, headers, body, query }, shim))
        .then(() => {
            const code = shim._status || 200;
            const payload = shim._json === undefined ? '' : JSON.stringify(shim._json);
            headersOut['Content-Type'] = 'application/json; charset=utf-8';
            res.writeHead(code, headersOut);
            res.end(payload);
        })
        .catch(err => {
            console.error('[api] handler 抛错:', err);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: err.message }));
        });
}

function sendFile(res, filePath) {
    fs.readFile(filePath, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found: ' + path.relative(ROOT, filePath));
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            // 本地开发永远别缓存：改完 shader 刷新看不到是最难查的一类问题
            'Cache-Control': 'no-store',
        });
        res.end(buf);
    });
}

async function main() {
    const port = Number(process.argv[2] || process.env.PORT || 8080);
    const handler = await loadApiHandler();

    http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/api/shader') {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => { callHandler(handler, req, res, url, Buffer.concat(chunks).toString('utf8')); });
            return;
        }

        // 目录穿越防护：解析后必须仍在 ROOT 内
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/index.html';
        const filePath = path.join(ROOT, rel);
        if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden');
            return;
        }

        fs.stat(filePath, (err, st) => {
            if (err || !st.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('404 Not Found: ' + rel);
                return;
            }
            sendFile(res, filePath);
        });
    }).on('error', err => {
        // 端口被占是最常见的一种失败，而 Node 默认只抛 EADDRINUSE，看不出该改哪里
        if (err.code === 'EADDRINUSE') {
            console.error('✗ 端口 ' + port + ' 已被占用。换一个：PORT=3001 npm run dev');
            process.exit(1);
        }
        throw err;
    }).listen(port, () => {
        console.log('\n  本地开发服务器已启动  →  http://localhost:' + port + '/');
        console.log('  /api/shader 由 api/shader.js 提供（内存存储，重启即丢）');
        console.log('  Ctrl+C 停止\n');
    });
}

main().catch(err => {
    console.error('✗ 启动失败:', err);
    process.exit(1);
});
