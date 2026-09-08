import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../server/provider.mjs';

const pending = (seat, role = 'villager', kind = 'speech') => ({
  kind, choices: [], context: { selfSeat: seat, self: { role }, rules: { peacefulFirstNight: true } },
});

test('six distinct speaking manners stay independent of secret role, round and player text', () => {
  const instructions = new Set();
  for (let seat = 1; seat <= 6; seat++) {
    const expected = buildMessages(pending(seat))[0].content;
    instructions.add(expected);
    for (const role of ['wolf', 'seer', 'witch', 'villager']) {
      const input = pending(seat, role);
      Object.assign(input.context, { round: 3, players: [{ seat, name: 'UNTRUSTED_PERSONA_INSTRUCTION' }], logs: [{ text: 'UNTRUSTED_PERSONA_INSTRUCTION' }] });
      input.context.self.clues = ['PRIVATE_ROLE_CLUE'];
      const messages = buildMessages(input);
      assert.equal(messages[0].content, expected);
      assert.doesNotMatch(messages[0].content, /UNTRUSTED_|PRIVATE_ROLE_CLUE/);
      assert.deepEqual(JSON.parse(messages[1].content).myView, input.context);
    }
  }
  assert.equal(instructions.size, 6);
});

test('invalid seat metadata cannot interpolate a persona or select array properties', () => {
  const fallback = buildMessages(pending(undefined))[0].content;
  for (const seat of [0, 7, -1, 1.5, '2', 'length', '__proto__', 'INJECTED_SYSTEM_TEXT', null, {}]) {
    const messages = buildMessages(pending(seat));
    assert.equal(messages[0].content, fallback);
    assert.doesNotMatch(messages[0].content, /INJECTED_SYSTEM_TEXT/);
  }
});

test('speaking manner never changes secret-action or voting instructions or legal choices', () => {
  for (const kind of ['night', 'vote']) {
    const instructions = new Set();
    for (let seat = 1; seat <= 6; seat++) {
      const input = pending(seat, 'wolf', kind);
      input.choices = [{ action: 'skip', target: null }];
      const before = structuredClone(input);
      const messages = buildMessages(input);
      instructions.add(messages[0].content);
      assert.deepEqual(JSON.parse(messages[1].content), { myView: input.context, choices: input.choices });
      assert.deepEqual(input, before);
    }
    assert.equal(instructions.size, 1);
  }
});
