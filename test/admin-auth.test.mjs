import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAdmin } from '../server/admin.mjs';

const BASE = '/werewolf/admin/';
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'werewolf-admin-'));
  await fs.mkdir(path.join(root, 'admin'));
  for (const name of ['index.html', 'main.js', 'view.js', 'style.css']) await fs.writeFile(path.join(root, 'admin', name), 'public-' + name);
  await fs.writeFile(path.join(root, 'admin', 'private.json'), '{"secret":"never-public"}');
  await fs.writeFile(path.join(root, 'private-config.json'), '{"secret":"never-public"}');
  let admin; let calls = 0; let time = 1000000;
  const events = [];
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (await admin.handle(req, res, pathname)) return;
      res.writeHead(418); res.end('Outside admin');
    } catch (_) { res.writeHead(500); res.end('Unexpected test error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); const origin = options.origin || `http://127.0.0.1:${address.port}`;
  admin = createAdmin({ root, config: options.disabled ? null : { origin, tokenHash }, now: () => time,
    snapshot: () => { calls++; if (options.snapshotError) throw new Error('PRIVATE_PROVIDER_SECRET'); return { status: 'ok', rooms: [{ roomId: '4826' }] }; },
    onEvent: value => { events.push(value); if (options.eventError) throw new Error('private event failure'); },
  });
  t.after(async () => { admin.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const request = ({ pathname = BASE, method = 'GET', headers = {}, body, chunked, leaveOpen = false, onRequest } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname, method,
      headers: { Host: new URL(origin).host, ...headers }, agent: false,
    }, res => {
      const chunks = []; res.on('data', value => chunks.push(value));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch (_) { /* Static asset. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error('Test request timed out')));
    if (chunked) { for (const chunk of chunked) req.write(chunk); }
    else if (body !== undefined) req.write(body);
    if (!leaveOpen) req.end();
    onRequest?.(req);
  });
  const login = (value = token, headers = {}) => request({ pathname: BASE + 'api/login', method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ token: value }) });
  return { root, admin, request, login, origin, events, get calls() { return calls; }, advance: ms => { time += ms; } };
}
const cookieOf = response => response.headers['set-cookie']?.[0]?.split(';')[0];

test('admin is absent without configuration and never calls the snapshot before authentication', async t => {
  const f = await fixture(t, { disabled: true });
  for (const pathname of [BASE, BASE + 'main.js', BASE + 'api/state']) assert.equal((await f.request({ pathname })).status, 404);
  assert.equal(f.calls, 0);
  assert.equal((await f.request({ pathname: '/werewolf/administer' })).status, 418);
});

test('admin origin configuration accepts HTTPS and loopback HTTP only', () => {
  for (const origin of ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?x=1', 'null']) {
    assert.throws(() => createAdmin({ config: { origin, tokenHash } }), /后台/);
  }
  assert.throws(() => createAdmin({ config: { origin: 'https://example.com', tokenHash: 'bad' } }), /后台/);
  assert.throws(() => createAdmin({ config: { origin: 'https://example.com', tokenHash: [tokenHash] } }), /后台/);
  for (const origin of ['https://example.com', 'http://localhost:8790', 'http://127.0.0.1:8790', 'http://[::1]:8790']) {
    createAdmin({ config: { origin, tokenHash }, snapshot: () => ({}) }).close();
  }
});

test('only the four fixed shell assets are public; private paths and symlinks are denied', async t => {
  const f = await fixture(t);
  for (const name of ['', 'index.html', 'main.js', 'view.js', 'style.css']) {
    const response = await f.request({ pathname: BASE + name }); assert.equal(response.status, 200); assert.match(response.text, /^public-/);
  }
  assert.equal((await f.request({ pathname: BASE + 'main.js', method: 'HEAD' })).text, '');
  assert.equal((await f.request({ pathname: BASE.slice(0, -1) })).headers.location, BASE);
  for (const name of ['private.json', 'config.json', 'token', 'server/admin.mjs', '%2e%2e/private-config.json', 'api/state/']) {
    const response = await f.request({ pathname: BASE + name }); assert.notEqual(response.status, 200); assert.doesNotMatch(response.text, /never-public/);
  }
  await fs.rm(path.join(f.root, 'admin', 'main.js'));
  await fs.symlink(path.join(f.root, 'private-config.json'), path.join(f.root, 'admin', 'main.js'));
  assert.equal((await f.request({ pathname: BASE + 'main.js' })).status, 404);
  assert.equal(f.calls, 0);
});

test('all admin responses disable caching, framing, inline scripts and sensitive device permissions', async t => {
  const f = await fixture(t);
  for (const pathname of [BASE, BASE + 'api/state', BASE + 'unknown']) {
    const response = await f.request({ pathname });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['content-security-policy'], /script-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline/);
    assert.match(response.headers['permissions-policy'], /microphone=\(\)/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

test('valid login issues a scoped session and authenticated state; failed login reveals no data', async t => {
  const f = await fixture(t);
  const denied = await f.request({ pathname: BASE + 'api/state' });
  assert.equal(denied.status, 401); assert.equal(f.calls, 0); assert.doesNotMatch(denied.text, /4826|tokenHash/);
  assert.equal((await f.login('not-the-token')).status, 401);
  const login = await f.login(); assert.equal(login.status, 200); assert.deepEqual(login.data, { authenticated: true });
  const cookie = cookieOf(login); assert.match(cookie, /^ww_admin_session=[a-f0-9]{64}$/);
  assert.doesNotMatch(login.text + cookie, new RegExp(token));
  assert.match(login.headers['set-cookie'][0], /Path=\/werewolf\/admin\//);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.match(login.headers['set-cookie'][0], /Max-Age=28800/);
  const session = await f.request({ pathname: BASE + 'api/session', headers: { Cookie: cookie } });
  assert.equal(session.status, 200); assert.equal(f.calls, 0);
  const state = await f.request({ pathname: BASE + 'api/state', headers: { Cookie: cookie } });
  assert.deepEqual(state.data, { status: 'ok', rooms: [{ roomId: '4826' }] }); assert.equal(f.calls, 1);
  assert.deepEqual(f.events.map(event => event.kind), ['admin_login_failed', 'admin_login']);
  assert.doesNotMatch(JSON.stringify(f.events), new RegExp(token + '|127\\.0\\.0\\.1|not-the-token'));
});

test('cookie security comes from configured origin and ignores forwarded protocol headers', async t => {
  const local = await fixture(t);
  assert.doesNotMatch((await local.login(token, { 'X-Forwarded-Proto': 'https' })).headers['set-cookie'][0], /Secure/);
  const secure = await fixture(t, { origin: 'https://admin.example.test' });
  assert.match((await secure.login(token, { 'X-Forwarded-Proto': 'http' })).headers['set-cookie'][0], /; Secure$/);
});

test('Origin, Host, URL tokens and cross-site requests cannot authenticate or use an existing session', async t => {
  const f = await fixture(t); const cookie = cookieOf(await f.login());
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.login(token, headers)).status, 403);
    assert.equal((await f.request({ pathname: BASE + 'api/state', headers: { Cookie: cookie, ...headers } })).status, 403);
  }
  assert.equal((await f.request({ pathname: BASE + 'api/login', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status, 403);
  assert.equal((await f.request({ pathname: BASE + 'api/state?token=' + token, headers: { Cookie: cookie } })).status, 403);
  assert.equal((await f.request({ pathname: BASE + 'api/logout', method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await f.request({ pathname: BASE + 'api/state', headers: { Cookie: cookie } })).status, 200);
});

test('a cross-site top-level link may open the public shell while APIs remain protected', async t => {
  const f = await fixture(t);
  for (const pathname of [BASE, BASE.slice(0, -1), BASE + 'main.js']) {
    const response = await f.request({ pathname, headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://external.example' } });
    assert.ok([200, 308].includes(response.status));
  }
  assert.equal(f.calls, 0);
  assert.equal((await f.request({ pathname: BASE + 'api/state', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('malformed, repeated and forged session cookies are rejected without reading state', async t => {
  const f = await fixture(t); const cookie = cookieOf(await f.login());
  for (const value of ['ww_admin_session=%ZZ', 'ww_admin_session=' + '0'.repeat(64), cookie + '; ' + cookie, 'other=' + cookie, cookie.replace('=', '= ')]) {
    assert.equal((await f.request({ pathname: BASE + 'api/state', headers: { Cookie: value } })).status, 401);
  }
  assert.equal(f.calls, 0);
});

test('only documented read-only state/session methods and login/logout POST routes exist', async t => {
  const f = await fixture(t); const cookie = cookieOf(await f.login());
  for (const [pathname, method] of [['api/state', 'POST'], ['api/session', 'DELETE'], ['api/login', 'GET'], ['api/logout', 'GET'], ['main.js', 'POST']]) {
    assert.equal((await f.request({ pathname: BASE + pathname, method, headers: { Cookie: cookie, Origin: f.origin } })).status, 405);
  }
  for (const pathname of ['api/rooms/delete', 'api/restart', 'api/config', 'api/token']) {
    assert.equal((await f.request({ pathname: BASE + pathname, method: 'POST', headers: { Cookie: cookie, Origin: f.origin } })).status, 404);
  }
  assert.equal(f.calls, 0);
});

test('login requires bounded JSON and never authenticates extra fields or malformed payloads', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await f.login(token, headers)).status, 415);
  }
  const send = body => f.request({ pathname: BASE + 'api/login', method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body });
  assert.equal((await send('{bad json')).status, 400);
  assert.equal((await send(JSON.stringify({ token, admin: true }))).status, 401);
  assert.equal((await send(JSON.stringify([token]))).status, 401);
  assert.equal((await send(JSON.stringify({ token: 123 }))).status, 401);
  assert.equal((await send('x'.repeat(1025))).status, 413);
  assert.equal((await f.request({ pathname: BASE + 'api/login', method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': '99999' }, body: '{' })).status, 413);
  assert.equal(f.calls, 0);
});

test('chunked oversize bodies and slow login bodies are cut off with bounded responses', async t => {
  const f = await fixture(t);
  const headers = { Origin: f.origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' };
  assert.equal((await f.request({ pathname: BASE + 'api/login', method: 'POST', headers, chunked: ['a'.repeat(700), 'b'.repeat(700)] })).status, 413);
  const started = Date.now();
  assert.equal((await f.request({ pathname: BASE + 'api/login', method: 'POST', headers, body: '{', leaveOpen: true })).status, 408);
  assert.ok(Date.now() - started < 5000); assert.equal(f.calls, 0);
});

test('login attempts are bounded using the real socket address, unaffected by forged forwarded IPs', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) assert.equal((await f.login('bad', { 'X-Forwarded-For': `203.0.113.${index}` })).status, 401);
  const denied = await f.login(); assert.equal(denied.status, 429); assert.equal(denied.headers['retry-after'], '60');
  f.advance(60000); assert.equal((await f.login()).status, 200);
});

test('sessions expire after 30 idle minutes and after eight absolute hours despite activity', async t => {
  const f = await fixture(t); const cookie = cookieOf(await f.login());
  f.advance(30 * 60000);
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: cookie } })).status, 401);
  const active = cookieOf(await f.login());
  for (let index = 0; index < 16; index++) {
    f.advance(29 * 60000); assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: active } })).status, 200);
  }
  f.advance(16 * 60000);
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: active } })).status, 401);
});

test('session rotation, sixteen-session limit, logout and shutdown revoke old sessions', async t => {
  const f = await fixture(t); const first = cookieOf(await f.login());
  const rotated = cookieOf(await f.login(token, { Cookie: first }));
  assert.notEqual(first, rotated);
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: first } })).status, 401);
  const cookies = [rotated];
  for (let index = 0; index < 16; index++) { f.advance(60000); cookies.push(cookieOf(await f.login())); }
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: rotated } })).status, 401);
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: cookies[1] } })).status, 200);
  const last = cookies.at(-1);
  const logout = await f.request({ pathname: BASE + 'api/logout', method: 'POST', headers: { Cookie: last, Origin: f.origin } });
  assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: last } })).status, 401);
  assert.equal(f.events.at(-1).kind, 'admin_logout');
  f.admin.close(); assert.equal((await f.request({ pathname: BASE + 'api/session', headers: { Cookie: cookies[1] } })).status, 404);
});

test('snapshot and monitoring failures never expose server errors or break authentication', async t => {
  const f = await fixture(t, { snapshotError: true, eventError: true });
  const login = await f.login(); assert.equal(login.status, 200);
  const response = await f.request({ pathname: BASE + 'api/state', headers: { Cookie: cookieOf(login) } });
  assert.equal(response.status, 503); assert.doesNotMatch(response.text, /PRIVATE|provider|stack|secret/i);
});

test('token comparison does not accept a prefix or a token from another deployment', async t => {
  const f = await fixture(t);
  for (const value of [token.slice(0, -1), token + 'a', hash(token), randomBytes(32).toString('base64url')]) {
    assert.equal((await f.login(value)).status, 401);
  }
  assert.equal((await f.login()).status, 200);
});

test('closing the router while a login body arrives cannot create a late session', async t => {
  const f = await fixture(t);
  let request;
  const response = f.request({ pathname: BASE + 'api/login', method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    body: '{"token":"', leaveOpen: true, onRequest: req => { request = req; },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  f.admin.close(); request.end(token + '"}');
  const result = await response;
  assert.equal(result.status, 404); assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(f.events.length, 0); assert.equal(f.calls, 0);
});
