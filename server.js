'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
require('./server/config').apply();
const {createNditorApi} = require('./server/nditor');
const NyaitterApiClient = require('./server/nditor/NyaitterApiClient');

const buildDir = path.resolve(process.env.NDITOR_WEB_ROOT || path.join(__dirname, 'build'));
const host = process.env.NDITOR_HOST || '127.0.0.1';
const port = Number(process.env.NDITOR_PORT || 3001);
const configuredApiBase = String(process.env.NDITOR_CLOUD_API_BASE || 'auto').trim().replace(/\/$/, '');
const upstream = new URL(process.env.NDITOR_UPSTREAM || 'http://127.0.0.1:3000');
const isDevelopment = process.env.NODE_ENV !== 'production';
const nyaitterAuthPath = '/api/nditor/nyaitter-auth';
const authCookieName = 'nditor_nyaitter_auth';
const authStateCookieName = 'nditor_nyaitter_auth_state';
const maxAuthBodyBytes = 32 * 1024;

const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.ejs': 'text/html; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function safePath(requestPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(requestPath.split('?')[0]);
    } catch (_) {
        return null;
    }
    const relativePath = decoded.replace(/^\/editor(?:\/|$)/, '').replace(/^\/+/, '');
    const absolutePath = path.resolve(buildDir, relativePath || 'editor.html');
    return absolutePath.startsWith(`${path.resolve(buildDir)}${path.sep}`) ? absolutePath : null;
}

function requestOrigin(request) {
    const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProtocol === 'https' ? 'https' : request.socket.encrypted ? 'https' : 'http';
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || 'localhost').split(',')[0].trim();
    return new URL(`${protocol}://${host}`);
}

function resolveApiBase(request) {
    if (configuredApiBase !== 'auto') return configuredApiBase;
    const origin = requestOrigin(request);
    origin.pathname = '/api/nditor/cloud-projects';
    return origin.href.replace(/\/$/, '');
}

function resolveCollaborationApiBase(request) {
    const origin = requestOrigin(request);
    origin.pathname = '/api/nditor/collaboration';
    return origin.href.replace(/\/$/, '');
}

function forwardedServerHost(request) {
    return requestOrigin(request).host;
}

function parseCookies(request) {
    const cookies = {};
    for (const part of String(request.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) continue;
        const name = part.slice(0, separator).trim();
        if (!name) continue;
        const rawValue = part.slice(separator + 1).trim();
        try {
            cookies[name] = decodeURIComponent(rawValue);
        } catch (_) {
            cookies[name] = rawValue;
        }
    }
    return cookies;
}

function publicCookies(request) {
    return String(request.headers.cookie || '')
        .split(';')
        .map(part => part.trim())
        .filter(part => {
            const name = part.slice(0, Math.max(part.indexOf('='), 0)).trim();
            return name && ![
                authCookieName,
                authStateCookieName,
                'nyaitter_session',
                'nyaitter_accounts',
                'session',
            ].includes(name);
        })
        .join('; ');
}

function proxyHeaders(request, {withNyaitterUserToken = false} = {}) {
    const publicHost = forwardedServerHost(request);
    const headers = {
        ...request.headers,
        host: publicHost,
        'x-forwarded-host': publicHost,
        'x-forwarded-proto': requestOrigin(request).protocol.replace(':', ''),
    };
    delete headers['x-nyaitter-extension-key'];
    delete headers.authorization;
    const cookie = publicCookies(request);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    if (withNyaitterUserToken) {
        const token = parseCookies(request)[authCookieName];
        if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
}

function proxyUpstream(request, response, targetPath, options = {}) {
    const transport = upstream.protocol === 'https:' ? https : http;
    const proxyRequest = transport.request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: targetPath,
        headers: proxyHeaders(request, options),
    }, proxyResponse => {
        response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
        proxyResponse.pipe(response);
    });
    proxyRequest.on('error', () => {
        if (!response.headersSent) response.writeHead(502, {'Content-Type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify({error: 'Nyaitter Serverへ接続できません。'}));
    });
    request.pipe(proxyRequest);
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        request.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > maxAuthBodyBytes) {
                chunks.length = 0;
                fail(Object.assign(new Error('要求が大きすぎます。'), {status: 413}));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (settled) return;
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                const body = text ? JSON.parse(text) : {};
                settled = true;
                resolve(body);
            } catch (_) {
                fail(Object.assign(new Error('JSON要求が正しくありません。'), {status: 400}));
            }
        });
        request.on('error', fail);
    });
}

const nyaitterApiClient = new NyaitterApiClient({upstream: upstream.href});
const nditorApi = createNditorApi({nyaitterApiClient});

function internalNyaitterAuth(action, body) {
    return nyaitterApiClient.request(`internal/extensions/nyaitter-auth/${action}`, {
        method: 'POST',
        internal: true,
        body,
    });
}

function sameOriginRequest(request) {
    const origin = String(request.headers.origin || '').trim();
    if (!origin) return true;
    try {
        return new URL(origin).origin === requestOrigin(request).origin;
    } catch (_) {
        return false;
    }
}

function jsonResponse(response, status, payload, headers = {}) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
    });
    response.end(JSON.stringify(payload));
}

function cookie(name, value, request, {maxAge = null, cookiePath = '/api/nditor'} = {}) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        `Path=${cookiePath}`,
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (requestOrigin(request).protocol === 'https:') parts.push('Secure');
    if (maxAge !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
    return parts.join('; ');
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleNyaitterAuth(request, response, requestUrl) {
    if (!sameOriginRequest(request)) {
        jsonResponse(response, 403, {error: 'Cross-origin requests are not allowed'});
        return;
    }
    try {
        if (request.method === 'POST' && requestUrl.pathname === `${nyaitterAuthPath}/start`) {
            const body = await readJsonBody(request);
            let returnUrl;
            try {
                returnUrl = new URL(String(body.return_url || ''));
            } catch (_) {
                jsonResponse(response, 400, {error: 'Nditorの戻り先が正しくありません。'});
                return;
            }
            const isEditorPath = returnUrl.pathname === '/editor' || returnUrl.pathname.startsWith('/editor/');
            if (returnUrl.origin !== requestOrigin(request).origin || !isEditorPath) {
                jsonResponse(response, 400, {error: 'Nditorの戻り先が正しくありません。'});
                return;
            }
            returnUrl.searchParams.set('nyaitter_auth_callback', '1');
            const state = crypto.randomBytes(24).toString('base64url');
            const result = await internalNyaitterAuth('initiate', {
                redirect_uri: returnUrl.toString(),
                state,
                scopes: [
                    {scope: 'profile:read', required: true},
                    {scope: 'storage:access', required: true},
                    {scope: 'continuous_access', required: true},
                ],
            });
            jsonResponse(response, 200, {auth_url: result.auth_url, state}, {
                'Set-Cookie': cookie(authStateCookieName, state, request, {
                    maxAge: 15 * 60,
                    cookiePath: nyaitterAuthPath,
                }),
            });
            return;
        }

        if (request.method === 'POST' && requestUrl.pathname === `${nyaitterAuthPath}/token`) {
            const body = await readJsonBody(request);
            const expectedState = parseCookies(request)[authStateCookieName];
            if (!expectedState || !safeEqual(expectedState, body.state)) {
                jsonResponse(response, 400, {error: 'ログイン状態を確認できません。最初からやり直してください。'});
                return;
            }
            const result = await internalNyaitterAuth('token', {code: body.code});
            if (!String(result.access_token || '').startsWith('nyauth_') || !result.user) {
                throw Object.assign(new Error('NyaitterAuthトークンを受け取れませんでした。'), {status: 502});
            }
            const clearedState = cookie(authStateCookieName, '', request, {
                maxAge: 0,
                cookiePath: nyaitterAuthPath,
            });
            const authCookie = cookie(authCookieName, result.access_token, request, {maxAge: 30 * 24 * 60 * 60});
            jsonResponse(response, 200, {
                user: result.user,
                granted_scopes: result.granted_scopes || [],
            }, {'Set-Cookie': [authCookie, clearedState]});
            return;
        }

        if (request.method === 'GET' && requestUrl.pathname === `${nyaitterAuthPath}/me`) {
            const token = parseCookies(request)[authCookieName];
            if (!token) {
                jsonResponse(response, 401, {error: 'ログインしていません。'});
                return;
            }
            const result = await nyaitterApiClient.introspectUserToken(token);
            jsonResponse(response, 200, {
                user: result.user,
                tokenType: result.token_type || 'app',
                granted_scopes: result.granted_scopes || [],
            });
            return;
        }

        if (request.method === 'POST' && requestUrl.pathname === `${nyaitterAuthPath}/logout`) {
            jsonResponse(response, 200, {success: true}, {
                'Set-Cookie': [
                    cookie(authCookieName, '', request, {maxAge: 0}),
                    cookie(authStateCookieName, '', request, {
                        maxAge: 0,
                        cookiePath: nyaitterAuthPath,
                    }),
                ],
            });
            return;
        }

        jsonResponse(response, 404, {error: 'APIエンドポイントが見つかりません。'});
    } catch (error) {
        jsonResponse(response, Number(error.statusCode || error.status) || 500, {
            error: error.message || 'NyaitterAuthの処理に失敗しました。',
            ...(error.code ? {code: error.code} : {}),
        });
    }
}

function inlineScriptSources(filePath) {
    if (path.extname(filePath).toLowerCase() !== '.html') return [];
    let html;
    try {
        html = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return [];
    }
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
}

const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
        response.writeHead(308, {Location: `/editor${requestUrl.search}`});
        response.end();
        return;
    }

    if (requestUrl.pathname === nyaitterAuthPath || requestUrl.pathname.startsWith(`${nyaitterAuthPath}/`)) {
        void handleNyaitterAuth(request, response, requestUrl);
        return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
        if (
            requestUrl.pathname === '/api/nditor/cloud-projects' ||
            requestUrl.pathname.startsWith('/api/nditor/cloud-projects/') ||
            requestUrl.pathname === '/api/nditor/collaboration' ||
            requestUrl.pathname.startsWith('/api/nditor/collaboration/')
        ) {
            const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(request.method || 'GET');
            if (stateChanging && !sameOriginRequest(request)) {
                jsonResponse(response, 403, {error: 'Cross-origin requests are not allowed'});
                return;
            }
            nditorApi.app(request, response);
            return;
        }
        if (!requestUrl.pathname.startsWith('/api/nditor/')) {
            jsonResponse(response, 404, {error: 'APIエンドポイントが見つかりません。'});
            return;
        }
        jsonResponse(response, 404, {error: 'APIエンドポイントが見つかりません。'});
        return;
    }
    if (requestUrl.pathname === '/health' || requestUrl.pathname === '/ready') {
        proxyUpstream(request, response, `/server${requestUrl.pathname}${requestUrl.search}`);
        return;
    }
    if (
        requestUrl.pathname.startsWith('/editor-api/') ||
        requestUrl.pathname === '/hub' ||
        requestUrl.pathname.startsWith('/hub/') ||
        requestUrl.pathname.startsWith('/hub-api/')
    ) {
        response.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({error: 'APIエンドポイントが見つかりません。'}));
        return;
    }
    if (requestUrl.pathname === '/editor/editor.html' || requestUrl.pathname === '/editor.html') {
        response.writeHead(308, {Location: `/editor${requestUrl.search}`});
        response.end();
        return;
    }

    if (requestUrl.pathname === '/editor/runtime-config.js' || requestUrl.pathname === '/runtime-config.js') {
        const apiBase = resolveApiBase(request);
        const collaborationApiBase = resolveCollaborationApiBase(request);
        const nyaitterAuthBase = new URL(nyaitterAuthPath, requestOrigin(request)).href.replace(/\/$/, '');
        response.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        response.end(`globalThis.NditorConfig=${JSON.stringify({cloudApiBase: apiBase, nyaitterAuthBase, collaborationApiBase})};`);
        return;
    }

    if (!fs.existsSync(buildDir)) {
        response.writeHead(503, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('専用エディタをビルドしてください。');
        return;
    }

    let filePath = safePath(requestUrl.pathname);
    if (!filePath) {
        response.writeHead(400);
        response.end();
        return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = path.join(buildDir, 'editor.html');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(503, {'Content-Type': 'text/plain; charset=utf-8'});
        response.end('専用エディタをビルド中です。');
        return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const apiUrl = new URL(resolveApiBase(request));
    const websocketOrigin = `${apiUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiUrl.host}`;
    const scriptHashes = inlineScriptSources(filePath).join(' ');
    if (isDevelopment) {
        // Development builds are rebuilt in place. Disable browser and edge
        // caching so a rebuild is visible on the next regular page reload.
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
    }
    response.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-eval' ${scriptHashes} https://cdn.jsdelivr.net https://challenges.cloudflare.com https://extensions.turbowarp.org; frame-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ${apiUrl.origin} ${websocketOrigin} https: wss:; worker-src 'self' blob:; manifest-src 'self'`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Type', contentTypes[extension] || 'application/octet-stream');
    fs.createReadStream(filePath).on('error', () => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
    }).pipe(response);
});

async function shutdown() {
    server.close();
    try {
        await nditorApi.stop();
    } catch (error) {
        console.warn('[editor] Shutdown cleanup failed:', error.message);
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('upgrade', (request, socket, head) => {
    void nditorApi.handleUpgrade(request, socket, head);
});

nditorApi.initialize().then(() => {
    server.listen(port, host, () => {
        console.log(`[editor] Nditor running at http://${host}:${port}/editor/`);
    });
}).catch((error) => {
    console.error('[editor] Failed to initialize Nditor services:', error);
    process.exitCode = 1;
});
