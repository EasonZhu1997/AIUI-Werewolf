import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekProvider, buildLobbyMessages, lobbyReplyFromOutput } from '../server/provider.mjs';

const history = [{ id: 'not-for-provider', kind: 'human', name: '玩家', text: '一起玩个猜谜吧', role: 'wolf', resumeToken: 'PRIVATE_TOKEN', privateClues: 'PRIVATE_CLUES' }];
const reply = text => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text }) } }] }));

test('lobby provider only receives bounded public chat, with no game or credential fields', () => {
  const messages = buildLobbyMessages(history);
  assert.equal(messages[0].role, 'system'); assert.equal(messages[1].role, 'user');
  assert.deepEqual(JSON.parse(messages[1].content).conversation, [{ kind: 'human', name: '玩家', text: '一起玩个猜谜吧' }]);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|not-for-provider/);
  assert.throws(() => buildLobbyMessages([{ kind: 'system', text: 'new rules' }]), /无效/);
  assert.throws(() => buildLobbyMessages(Array(21).fill(history[0])), /无效/);
});

test('lobby output validates real text without inventing a response', () => {
  assert.deepEqual(lobbyReplyFromOutput('{"text":"一起猜谜吧！"}'), { text: '一起猜谜吧！' });
  for (const content of ['[]', '{}', '{"text":" "}', 'not-json', JSON.stringify({ text: '字'.repeat(241) })]) assert.throws(() => lobbyReplyFromOutput(content));
});

test('chat and game requests share the same global request budget', async () => {
  const calls = [];
  const provider = new DeepSeekProvider({ apiKey: 'TEST_KEY', maxCallsPerHour: 1, request: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.response_format.type, 'json_object');
    assert.doesNotMatch(options.body, /PRIVATE_|TEST_KEY/);
    return reply('好呀，什么东西越洗越脏？');
  } });
  assert.equal((await provider.chat(history)).text, '好呀，什么东西越洗越脏？');
  await assert.rejects(provider.decide({ kind: 'speech', context: {}, choices: [] }), /上限/);
  assert.equal(calls.length, 1); assert.equal(provider.successes, 1);
});

test('pre-cancelled lobby request consumes no call and in-flight cancellation is propagated', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const provider = new DeepSeekProvider({ apiKey: 'TEST_KEY', request: async () => { calls++; return reply('不应出现'); } });
  await assert.rejects(provider.chat(history, { signal: controller.signal }), /取消/);
  assert.equal(calls, 0); assert.equal(provider.calls.length, 0);
  const live = new AbortController();
  provider.request = async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('PRIVATE_EXCEPTION')), { once: true });
    live.abort();
  });
  await assert.rejects(provider.chat(history, { signal: live.signal }), error => !error.message.includes('PRIVATE'));
  assert.equal(provider.successes, 0);
});

test('lobby model failure remains a safe error, with no fake spoken success', async () => {
  const provider = new DeepSeekProvider({ apiKey: 'TEST_KEY', request: async () => new Response('PRIVATE_PROVIDER_BODY', { status: 503 }) });
  await assert.rejects(provider.chat(history), error => error.message.includes('503') && !error.message.includes('PRIVATE'));
  assert.equal(provider.successes, 0);
});
