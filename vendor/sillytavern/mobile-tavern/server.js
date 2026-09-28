import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const PORT = Number(process.env.MOBILE_TAVERN_PORT || 8787);

const MIME = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['.svg', 'image/svg+xml; charset=utf-8'],
]);

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

async function serveStatic(req, res) {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const requested = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
    const resolved = path.resolve(PUBLIC_DIR, requested);
    if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
        return sendJson(res, 403, { error: '访问被拒绝' });
    }

    try {
        const body = await readFile(resolved);
        res.writeHead(200, {
            'Content-Type': MIME.get(path.extname(resolved)) || 'application/octet-stream',
            'Cache-Control': requested === 'service-worker.js' ? 'no-cache' : 'public, max-age=300',
            'Content-Security-Policy': "default-src 'self'; connect-src https://api.deepseek.com; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
        });
        if (req.method === 'HEAD') return res.end();
        res.end(body);
    } catch {
        sendJson(res, 404, { error: '页面不存在' });
    }
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '方法不允许' });
    return serveStatic(req, res);
});

server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用。` : `预览服务启动失败：${error.message}`);
    process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('\n移动酒馆本地预览已启动');
    console.log(`地址：http://127.0.0.1:${PORT}`);
    console.log('提示：这个服务只用于电脑预览。发布到 HTTPS 后，iPhone 可完全独立运行。');
    console.log('使用 Ctrl+C 停止服务\n');
});
