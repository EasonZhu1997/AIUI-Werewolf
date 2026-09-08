import test from 'node:test';
import assert from 'node:assert/strict';
import { speechText } from '../lib/speech-text.js';

test('spoken seat labels are clear and do not repeat the AI introduction', () => {
  const speech = { seat: 2, text: '2号发言：我想先听3号的解释；再考虑投票。' };
  assert.equal(speechText(speech), '二号发言。我想先听三号的解释。再考虑投票。');
  assert.equal(speech.text, '2号发言：我想先听3号的解释；再考虑投票。');
});

test('formatting gets pauses without losing claims, seat numbers, or punctuation', () => {
  assert.equal(speechText({ seat: 2, text: '**2号是好人**。\n我怀疑６号，不是16号。' }), '二号发言。二号是好人。我怀疑六号，不是16号。');
  assert.equal(speechText({ seat: 1, text: '三号发言：请解释你的选择。' }), '一号发言。三号发言：请解释你的选择。');
});

test('host cues and voice samples do not pretend to occupy player seats', () => {
  assert.equal(speechText({ seat: 1, narration: true, text: '请听普通话试听' }), '请听普通话试听。');
  assert.equal(speechText({ text: '现在开始投票。' }, { narration: true }), '现在开始投票。');
  assert.equal(speechText({ text: '' }), '');
});
