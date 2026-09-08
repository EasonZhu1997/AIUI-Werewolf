import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE = '/werewolf/admin/';
const COOKIE = 'ww_admin_session';
const BODY_LIMIT = 1024;
const BODY_TIMEOUT_MS = 3000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const STATIC = new Map([
  [BASE, ['index.html', 'text/html; charset=utf-8']],
  [BASE + 'index.html', ['index.html', 'text/html; charset=utf-8']],
  [BASE + 'main.js', ['main.js', 'text/javascript; charset=utf-8']],
  [BASE + 'view.js', ['view.js', 'text/javascript; charset=utf-8']],
  [BASE + 'style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const sha256 = value => createHash('sha256').update(value).digest();

function validateConfig(config) {
  if (config == null) return null;
  if (typeof config !== 'object' || Array.isArray(config) || typeof config.tokenHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(config.tokenHash)) throw new Error('后台访问配置无效');
  let origin;
  try { origin = new URL(config.origin); } catch (_) { throw new Error('后台来源配置无效'); }
  if (origin.origin !== config.origin || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('后台来源须为 HTTPS 或本机 HTTP Origin');
  }
  return { origin: origin.origin, host: origin.host, secure: origin.protocol === 'https:', hash: Buffer.from(config.tokenHash, 'hex') };
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; worker-src 'none'");
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function failure(res, status, code, error) {
  // Rejected requests never retain an unfinished upload on a keep-alive connection.
  if (res.req && !res.req.complete) {
    res.setHeader('Connection', 'close');
    res.once('finish', () => res.req.destroy());
  }
  json(res, status, { code, error });
}

function sessionCookie(req) {
  if (typeof req.headers.cookie !== 'string') return null;
  const values = req.headers.cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? sha256(value).toString('hex') : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const length = req.headers['content-length'];
    const error = (status, code) => Object.assign(new Error(code), { status, code });
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
      req.pause(); reject(error(413, 'BODY_TOO_LARGE')); return;
    }
    let bytes = 0; const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort);
    };
    const fail = err => { cleanup(); req.pause(); reject(err); };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { fail(error(413, 'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onAbort = () => fail(error(400, 'REQUEST_ABORTED'));
    const timer = setTimeout(() => fail(error(408, 'BODY_TIMEOUT')), BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onAbort);
  });
}

/** Read-only admin surface. Configuration and session state never enter a response. */
export function createAdmin({ root, config, snapshot, now = Date.now, onEvent } = {}) {
  const settings = validateConfig(config);
  const sessions = new Map();
  const rates = new Map();
  let globalRate = { since: now(), count: 0 };
  let closed = false;
  const event = kind => {
    const values = {
      admin_login: ['info', '管理员已登录'],
      admin_login_failed: ['warning', '管理员登录失败'],
      admin_logout: ['info', '管理员已退出'],
    };
    try { onEvent?.({ kind, level: values[kind][0], message: values[kind][1] }); } catch (_) { /* Monitoring must not affect authentication. */ }
  };
  const prune = time => {
    for (const [key, value] of sessions) if (time - value.created >= ABSOLUTE_MS || time - value.lastUsed >= IDLE_MS) sessions.delete(key);
    for (const [key, value] of rates) if (time - value.since >= RATE_WINDOW_MS) rates.delete(key);
    if (time - globalRate.since >= RATE_WINDOW_MS) globalRate = { since: time, count: 0 };
  };
  const cookie = (res, value, age) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=${BASE}; Max-Age=${age}; HttpOnly; SameSite=Strict${settings.secure ? '; Secure' : ''}`);
  };
  const authenticate = (req, res) => {
    const key = sessionCookie(req); const value = key ? sessions.get(key) : null;
    if (!value) {
      cookie(res, '', 0); failure(res, 401, 'AUTH_REQUIRED', '请先登录管理后台'); return false;
    }
    value.lastUsed = now(); return true;
  };
  const rateAllowed = req => {
    // Direct socket address only: an arbitrary forwarded header must not reset limits.
    const address = req.socket.remoteAddress || 'unknown';
    let rate = rates.get(address);
    if (!rate) {
      if (rates.size >= 128) return false;
      rate = { since: now(), count: 0 }; rates.set(address, rate);
    }
    if (rate.count >= 10 || globalRate.count >= 60) return false;
    rate.count++; globalRate.count++; return true;
  };
  const rejectBody = (req, res, err) => {
    // IncomingMessage may already be destroyed after a fully read invalid JSON body,
    // while its response socket is still writable.
    if (res.destroyed) return;
    res.setHeader('Connection', 'close');
    res.once('finish', () => req.destroy());
    failure(res, err.status || 400, err.code || 'INVALID_REQUEST', '请求内容无效或过大，请重试');
  };

  async function handle(req, res, pathname) {
    if (pathname !== BASE.slice(0, -1) && !pathname.startsWith(BASE)) return false;
    securityHeaders(res);
    if (!settings || closed) { failure(res, 404, 'NOT_FOUND', 'Not found'); return true; }
    prune(now());
    let url;
    try { url = new URL(req.url, settings.origin); } catch (_) { failure(res, 400, 'INVALID_REQUEST', '请求无效'); return true; }
    if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== settings.host.toLowerCase() ||
        req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length !== 1) {
      failure(res, 403, 'INVALID_HOST', '请求来源无效'); return true;
    }
    const isAPI = pathname.startsWith(BASE + 'api/');
    // The shell contains no private data, so an external top-level link may open it.
    // API access still requires the configured origin and rejects cross-site fetches.
    if (url.search || (isAPI && ((req.headers.origin !== undefined && req.headers.origin !== settings.origin) || req.headers['sec-fetch-site'] === 'cross-site'))) {
      failure(res, 403, 'INVALID_ORIGIN', '请求来源无效'); return true;
    }
    if (pathname === BASE.slice(0, -1)) {
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); failure(res, 405, 'METHOD_NOT_ALLOWED', '请求方法无效'); return true; }
      res.writeHead(308, { Location: BASE }); res.end(); return true;
    }
    if (STATIC.has(pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); failure(res, 405, 'METHOD_NOT_ALLOWED', '请求方法无效'); return true; }
      try {
        const [name, mime] = STATIC.get(pathname);
        const directory = path.resolve(root, 'admin'); const filename = path.join(directory, name);
        const [realRoot, realDirectory, realFile, stat] = await Promise.all([fs.realpath(root), fs.realpath(directory), fs.realpath(filename), fs.lstat(filename)]);
        if (!realDirectory.startsWith(realRoot + path.sep) || path.dirname(realFile) !== realDirectory || stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024) throw new Error('Invalid asset');
        const data = await fs.readFile(filename);
        res.writeHead(200, { 'Content-Type': mime }); res.end(req.method === 'HEAD' ? undefined : data);
      } catch (_) { failure(res, 404, 'NOT_FOUND', 'Not found'); }
      return true;
    }
    if (!['api/login', 'api/logout', 'api/session', 'api/state'].some(value => pathname === BASE + value)) {
      failure(res, 404, 'NOT_FOUND', 'Not found'); return true;
    }
    const action = pathname.slice(BASE.length + 4);
    const method = ['login', 'logout'].includes(action) ? 'POST' : 'GET';
    if (req.method !== method) { res.setHeader('Allow', method); failure(res, 405, 'METHOD_NOT_ALLOWED', '请求方法无效'); return true; }
    if (method === 'POST' && req.headers.origin !== settings.origin) { failure(res, 403, 'INVALID_ORIGIN', '请求来源无效'); return true; }
    if (action === 'login') {
      if (!rateAllowed(req)) { res.setHeader('Retry-After', '60'); failure(res, 429, 'RATE_LIMITED', '登录尝试过于频繁，请一分钟后重试'); return true; }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) {
        failure(res, 415, 'INVALID_CONTENT_TYPE', '请使用 JSON 格式登录'); return true;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (err) { rejectBody(req, res, err); return true; }
      if (closed) { failure(res, 404, 'NOT_FOUND', 'Not found'); return true; }
      const token = typeof body?.token === 'string' ? body.token : '';
      const matches = timingSafeEqual(sha256(token), settings.hash);
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token) || !matches || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'token')) {
        event('admin_login_failed'); failure(res, 401, 'AUTH_FAILED', '访问口令无效'); return true;
      }
      // A successful re-login rotates the existing browser session; values stored in memory are hashes only.
      const oldKey = sessionCookie(req); if (oldKey) sessions.delete(oldKey);
      while (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
      const value = randomBytes(32).toString('hex');
      sessions.set(sha256(value).toString('hex'), { created: now(), lastUsed: now() });
      cookie(res, value, ABSOLUTE_MS / 1000); event('admin_login');
      json(res, 200, { authenticated: true }); return true;
    }
    if (!authenticate(req, res)) return true;
    if (action === 'logout') {
      try { await readBody(req); } catch (err) { rejectBody(req, res, err); return true; }
      if (closed) { failure(res, 404, 'NOT_FOUND', 'Not found'); return true; }
      sessions.delete(sessionCookie(req)); cookie(res, '', 0); event('admin_logout');
      json(res, 200, { authenticated: false }); return true;
    }
    if (action === 'session') { json(res, 200, { authenticated: true }); return true; }
    try {
      const body = JSON.stringify(snapshot());
      if (body === undefined) throw new Error('No snapshot');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body);
    } catch (_) { failure(res, 503, 'STATE_UNAVAILABLE', '暂时无法读取状态，请稍后重试'); }
    return true;
  }
  return { handle, close() { closed = true; sessions.clear(); rates.clear(); } };
}
