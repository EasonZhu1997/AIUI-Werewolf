// Spoken presentation only; never modify the transcript stored by the game.
const seats = ['', '一', '二', '三', '四', '五', '六'];

function clean(text) {
  return String(text || '')
    .replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\r?\n+/g, '。')
    .replace(/[\t ]+/g, ' ')
    .replace(/([0-9０-９]+)\s*号/g, (match, digit) => {
      if (digit.length !== 1) return match;
      const number = digit.charCodeAt(0) > 127 ? digit.charCodeAt(0) - 0xff10 : Number(digit);
      return seats[number] ? seats[number] + '号' : match;
    })
    .replace(/[;；]/g, '。')
    .replace(/([。！？!?])[。]+/g, '$1')
    .replace(/\s+([，。！？：、])/g, '$1')
    .trim();
}

function sentence(text) {
  return !text || /[。！？!?…][”」』"']?$/.test(text) ? text : text + '。';
}

export function speechText(speech, { narration = false } = {}) {
  if (!speech || typeof speech.text !== 'string') return '';
  let text = clean(speech.text);
  if (!text) return '';
  const seat = Number(speech.seat);
  if (!narration && speech.narration !== true && Number.isInteger(seat) && seat >= 1 && seat <= 6) {
    const label = seats[seat] + '号';
    // Remove only the same speaker's introductory label, never a claim about a seat.
    text = text.replace(new RegExp('^' + label + '(?:玩家)?(?:发言)?\\s*[：:，,。．.]\\s*'), '');
    return label + '发言。' + sentence(text);
  }
  return sentence(text);
}
