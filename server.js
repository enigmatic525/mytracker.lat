const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const foodHandler = require('./api/food');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3001;
const ROOT = __dirname;
const PUBLIC_FILES = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/style.css', 'style.css'],
    ['/script.js', 'script.js'],
    ['/manifest.json', 'manifest.json'],
    ['/sw.js', 'sw.js'],
    ['/myicon.png', 'myicon.png']
]);
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png'
};

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function runApiHandler(req, res) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10_000) {
            sendJson(res, 413, { error: 'Request too large' });
            req.destroy();
        }
    });
    req.on('end', async () => {
        if (res.writableEnded) return;
        req.body = body;
        res.status = function status(code) {
            this.statusCode = code;
            return this;
        };
        res.json = function json(payload) {
            if (!this.headersSent) this.setHeader('Content-Type', 'application/json; charset=utf-8');
            this.end(JSON.stringify(payload));
            return this;
        };
        try {
            await foodHandler(req, res);
        } catch (error) {
            console.error('API request failed:', error);
            if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
            else if (!res.writableEnded) res.end();
        }
    });
}

function servePublicFile(urlPath, res, headOnly) {
    const relativePath = PUBLIC_FILES.get(urlPath);
    if (!relativePath) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    const filePath = path.join(ROOT, relativePath);
    fs.readFile(filePath, (error, data) => {
        if (error) {
            sendJson(res, error.code === 'ENOENT' ? 404 : 500, { error: 'Could not load file' });
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(headOnly ? undefined : data);
    });
}

const server = http.createServer((req, res) => {
    let urlPath;
    try {
        urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
    } catch (error) {
        sendJson(res, 400, { error: 'Invalid URL' });
        return;
    }

    if (urlPath === '/api/food') {
        runApiHandler(req, res);
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
    }
    servePublicFile(urlPath, res, req.method === 'HEAD');
});

server.listen(PORT, HOST, () => {
    console.log(`MyTracker running at http://${HOST}:${PORT}`);
});

