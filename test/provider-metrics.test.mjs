import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DeepSeekProvider } from '../server/provider.mjs';

const history = [{ kind: 'human', name: '玩家', text: 'PRIVATE_CHAT_SENTINEL' }];
const pending = { kind: 'speech', context: { hidden: 'PRIVATE_CONTEXT_SENTINEL' }, choices: [] };
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"一起玩吧！"}' } }] }));
const make = options => new DeepSeekProvider({ apiKey: 'PRIVATE_KEY_SENTINEL', ...options });

test('metrics expose only safe scalar fields and start with no samples', () => {
  const provider = make({ request: async () => reply() });
  const metrics = provider.getMetrics();
  assert.deepEqual(metrics, {
    configured: true, model: 'deepseek-v4-flash', callsLastHour: 0, maxCallsPerHour: 600,
    successes: 0, failures: 0, cancellations: 0, inFlight: 0,
    averageLatencyMs: 0, lastSuccessAt: null, lastFailureAt: null,
  });
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_|apiKey|messages|response|history/);
  metrics.successes = 999;
  assert.equal(provider.getMetrics().successes, 0, 'a snapshot cannot mutate counters');
});

test('chat and decisions share counters, in-flight tracking, and lifetime latency average', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const resolvers = [];
  const provider = make({ request: async () => new Promise(resolve => resolvers.push(resolve)) });
  const first = provider.chat(history);
  assert.equal(provider.getMetrics().inFlight, 1);
  now = 1100;
  const second = provider.decide(pending);
  assert.equal(provider.getMetrics().inFlight, 2);
  assert.equal(provider.getMetrics().callsLastHour, 2);
  now = 1500; resolvers[0](reply()); await first;
  assert.equal(provider.getMetrics().inFlight, 1);
  assert.equal(provider.getMetrics().averageLatencyMs, 500);
  now = 2100; resolvers[1](reply()); await second;
  const metrics = provider.getMetrics();
  assert.equal(metrics.inFlight, 0); assert.equal(metrics.successes, 2);
  assert.equal(provider.successes, 2); assert.deepEqual(provider.calls, [1000, 1100]);
  assert.equal(metrics.averageLatencyMs, 750); assert.equal(metrics.lastSuccessAt, 2100);
  assert.equal(metrics.lastFailureAt, null);
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_/);
});

test('network, HTTP, body decoding, and game/chat parsing failures are all counted once', async () => {
  const provider = make();
  const cases = [
    { request: async () => { throw new Error('PRIVATE_NETWORK_SENTINEL'); }, error: /网络请求失败或超时/ },
    { request: async () => new Response('PRIVATE_RESPONSE_SENTINEL', { status: 503 }), error: /HTTP 503/ },
    { request: async () => new Response('PRIVATE_INVALID_JSON_SENTINEL'), error: /服务响应无效/ },
    { request: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_MODEL_OUTPUT_SENTINEL' } }] })), error: /聊天回复格式无效/ },
    { request: async () => new Response('{}'), error: /AI 返回格式无效/, decision: true },
  ];
  for (const [index, item] of cases.entries()) {
    provider.request = item.request;
    await assert.rejects(item.decision ? provider.decide(pending) : provider.chat(history), error => {
      assert.match(error.message, item.error); assert.doesNotMatch(error.message, /PRIVATE_/); return true;
    });
    const metrics = provider.getMetrics();
    assert.equal(metrics.failures, index + 1); assert.equal(metrics.inFlight, 0);
    assert.equal(metrics.successes, 0); assert.equal(metrics.cancellations, 0);
    assert.equal(typeof metrics.lastFailureAt, 'number');
    assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_/);
  }
});

test('pre-abort and quota rejection do not create requests, failures, or latency samples', async () => {
  let calls = 0;
  const provider = make({ maxCallsPerHour: 1, request: async () => { calls++; return reply(); } });
  const controller = new AbortController(); controller.abort();
  const before = provider.getMetrics();
  await assert.rejects(provider.chat(history, { signal: controller.signal }), /请求已取消/);
  assert.deepEqual(provider.getMetrics(), before);
  await provider.chat(history);
  const after = provider.getMetrics();
  await assert.rejects(provider.chat(history), /本小时上限/);
  assert.deepEqual(provider.getMetrics(), after);
  assert.equal(calls, 1); assert.equal(provider.completedRequests, 1);
});

test('lifetime latency includes failed and cancelled requests without replacing prior outcome times', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const provider = make({ request: async () => { now = 1100; return reply(); } });
  await provider.chat(history);
  now = 2000;
  provider.request = async () => { now = 2300; throw new Error('PRIVATE_NETWORK_SENTINEL'); };
  await assert.rejects(provider.chat(history), /网络请求失败或超时/);
  now = 3000;
  const controller = new AbortController();
  provider.request = async () => { now = 3500; controller.abort(); throw new Error('PRIVATE_ABORT_SENTINEL'); };
  await assert.rejects(provider.chat(history, { signal: controller.signal }), /网络请求失败或超时/);
  const metrics = provider.getMetrics();
  assert.equal(metrics.averageLatencyMs, 300);
  assert.equal(metrics.successes, 1); assert.equal(metrics.failures, 1); assert.equal(metrics.cancellations, 1);
  assert.equal(metrics.lastSuccessAt, 1100); assert.equal(metrics.lastFailureAt, 2300);
  assert.equal(metrics.inFlight, 0);
});

test('parent cancellation is separate from failure and always releases the in-flight slot', async () => {
  const controller = new AbortController();
  const provider = make({ request: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT_REASON')), { once: true });
  }) });
  const result = assert.rejects(provider.chat(history, { signal: controller.signal }), /网络请求失败或超时/);
  assert.equal(provider.getMetrics().inFlight, 1);
  controller.abort(new Error('PRIVATE_PARENT_REASON')); await result;
  const metrics = provider.getMetrics();
  assert.equal(metrics.cancellations, 1); assert.equal(metrics.failures, 0);
  assert.equal(metrics.callsLastHour, 1); assert.equal(metrics.inFlight, 0);
  assert.equal(metrics.lastFailureAt, null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_/);
});

test('an earlier provider timeout stays a failure even when the parent cancels before rejection', async () => {
  const controller = new AbortController(); let rejectRequest; let requestSignal;
  const provider = make({ timeoutMs: 1, request: async (_, { signal }) => {
    requestSignal = signal;
    return new Promise((resolve, reject) => { rejectRequest = reject; });
  } });
  const result = assert.rejects(provider.chat(history, { signal: controller.signal }), /网络请求失败或超时/);
  await delay(20);
  assert.equal(requestSignal.aborted, true); assert.equal(controller.signal.aborted, false);
  controller.abort(); rejectRequest(new Error('PRIVATE_DELAYED_TIMEOUT')); await result;
  assert.equal(provider.getMetrics().failures, 1);
  assert.equal(provider.getMetrics().cancellations, 0);
  assert.equal(provider.getMetrics().inFlight, 0);
  assert.equal(typeof provider.getMetrics().lastFailureAt, 'number');
});

test('an earlier parent cancellation remains cancellation after the timeout also expires', async () => {
  const controller = new AbortController(); let rejectRequest;
  const provider = make({ timeoutMs: 1, request: async () => new Promise((resolve, reject) => { rejectRequest = reject; }) });
  const result = assert.rejects(provider.chat(history, { signal: controller.signal }), /网络请求失败或超时/);
  controller.abort(); await delay(20); rejectRequest(new Error('PRIVATE_DELAYED_ABORT')); await result;
  assert.equal(provider.getMetrics().cancellations, 1);
  assert.equal(provider.getMetrics().failures, 0);
  assert.equal(provider.getMetrics().inFlight, 0);
});

test('body-read cancellation is counted separately without changing the safe response error', async () => {
  const controller = new AbortController(); let rejectBody;
  const provider = make({ request: async () => ({ ok: true, json: () => new Promise((resolve, reject) => { rejectBody = reject; }) }) });
  const result = assert.rejects(provider.chat(history, { signal: controller.signal }), /服务响应无效/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(typeof rejectBody, 'function');
  controller.abort(); rejectBody(new Error('PRIVATE_BODY_ABORT')); await result;
  assert.equal(provider.getMetrics().cancellations, 1);
  assert.equal(provider.getMetrics().failures, 0);
  assert.equal(provider.getMetrics().inFlight, 0);
});

test('hourly counts expire at the boundary while lifetime counters remain intact', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const provider = make({ maxCallsPerHour: 1, request: async () => reply() });
  await provider.chat(history);
  assert.equal(provider.getMetrics(3600999).callsLastHour, 1);
  assert.equal(provider.getMetrics(3601000).callsLastHour, 0);
  assert.equal(provider.getMetrics(3601000).successes, 1);
  assert.deepEqual(provider.calls, [1000], 'reading metrics does not alter rate-limit state');
  now = 3601000; await provider.chat(history);
  assert.deepEqual(provider.calls, [3601000]); assert.equal(provider.getMetrics().successes, 2);
});

test('clock rollback cannot create negative request latency', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const provider = make({ request: async () => { now = 900; return reply(); } });
  await provider.chat(history);
  assert.equal(provider.getMetrics().averageLatencyMs, 0);
  assert.equal(provider.getMetrics().successes, 1);
  assert.equal(provider.getMetrics().inFlight, 0);
});
