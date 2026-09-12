import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekProvider, buildLobbyMessages, lobbyReplyFromOutput, buildStoryMessages, storyReplyFromOutput } from '../server/provider.mjs';

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

test('story provider receives only public context and returns bounded城主 dialogue', () => {
  const messages = buildStoryMessages({
    history: [{ kind: 'host', name: '地下城城主', text: '风从门缝里进来。' }, { kind: 'human', name: '旅人', text: '我想看看窗边。', role: 'wolf', clues: ['PRIVATE'] }],
    context: { phase: 'night', round: 1, players: [{ seat: 1, name: '旅人', alive: true, role: 'wolf', clues: ['PRIVATE'] }], recentLogs: ['第 1 夜开始'] },
  });
  assert.equal(messages[0].role, 'system');
  const payload = JSON.parse(messages[1].content);
  assert.deepEqual(payload.conversation, [{ kind: 'host', name: '地下城城主', text: '风从门缝里进来。' }, { kind: 'human', name: '旅人', text: '我想看看窗边。' }]);
  assert.deepEqual(payload.context.players, [{ seat: 1, name: '旅人', alive: true, bot: false }]);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE/);
  assert.deepEqual(storyReplyFromOutput('{"text":"窗纸轻轻响了一下，城主没有替你回答，只问你要不要再靠近一步。"}'), { text: '窗纸轻轻响了一下，城主没有替你回答，只问你要不要再靠近一步。' });
  assert.throws(() => storyReplyFromOutput(JSON.stringify({ text: '字'.repeat(321) })), /长度/);
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

test('story chat shares the provider budget and uses JSON mode', async () => {
  const calls = [];
  const provider = new DeepSeekProvider({ apiKey: 'TEST_KEY', maxCallsPerHour: 1, request: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return reply('窗外的风停了，城主等你说下一句。');
  } });
  const result = await provider.storyChat([{ kind: 'host', name: '地下城城主', text: '故事开始。' }], { phase: 'night', round: 1, players: [] });
  assert.equal(result.text, '窗外的风停了，城主等你说下一句。');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  await assert.rejects(provider.storyChat([{ kind: 'host', text: '再来一句' }], {}), /上限/);
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
