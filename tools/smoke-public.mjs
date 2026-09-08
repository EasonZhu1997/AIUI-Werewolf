import fs from 'node:fs';
import path from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash('sha256').update(text).digest('hex');
const PHASES = new Set(['lobby', 'night', 'speech', 'playback', 'vote', 'result']);

class SmokeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function redactSpeech(text) {
  return text.replace(/\b(?:https?|wss?):\/\/\S+/gi, '[链接已隐藏]')
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{12,}\b/gi, '[凭据已隐藏]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[标识已隐藏]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}

function validateOptions({ url, humans, roomId, timeoutMs, maxRounds, connectTimeoutMs }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new SmokeFailure('INVALID_WSS_URL'); }
  if (endpoint.protocol !== 'wss:' || endpoint.pathname !== '/werewolf/ws' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new SmokeFailure('INVALID_WSS_URL');
  if (![1, 2].includes(humans)) throw new SmokeFailure('INVALID_HUMAN_COUNT');
  if (!/^\d{4}$/.test(roomId)) throw new SmokeFailure('INVALID_ROOM');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new SmokeFailure('INVALID_TIMEOUT');
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 50 || connectTimeoutMs > 20000) throw new SmokeFailure('INVALID_CONNECT_TIMEOUT');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 6) throw new SmokeFailure('INVALID_ROUND_LIMIT');
  return endpoint;
}

function checkView(state) {
  if (!state || !PHASES.has(state.phase) || !Array.isArray(state.players) || state.players.length > 6 || !Number.isInteger(state.revision) || !state.selfId) throw new SmokeFailure('INVALID_SERVER_VIEW');
  if (state.phase !== 'result' && state.players.some(player => player.id !== state.selfId && player.role)) throw new SmokeFailure('PRIVATE_ROLE_LEAK');
  if (state.phase === 'night' && /\d\s*号\s*AI/.test(state.aiStatus || '')) throw new SmokeFailure('NIGHT_ACTOR_LEAK');
}

function humanAction(state) {
  const prompt = state.prompt;
  if (prompt.kind === 'speech') return { kind: 'speech', text: `${state.selfSeat}号发言：我会比较大家给出的具体依据，请被怀疑的玩家解释自己的判断，再结合发言投票。` };
  if (!['night', 'vote'].includes(prompt.kind) || !Array.isArray(prompt.choices)) throw new SmokeFailure('INVALID_SERVER_PROMPT');
  const choice = prompt.choices.find(item => item.action === 'save') || [...prompt.choices].reverse().find(item => item.target !== null && item.action !== 'poison') || prompt.choices.find(item => item.action === 'skip');
  if (!choice) throw new SmokeFailure('NO_LEGAL_ACTION');
  return { kind: prompt.kind, action: choice.action, target: choice.target };
}

/** A public transport smoke test. This module never imports a server or AI provider. */
export async function runPublicSmoke({ url, humans = 1, roomId = String(randomInt(10000)).padStart(4, '0'), timeoutMs = 180000, maxRounds = 4, connectTimeoutMs = 10000, WebSocketImpl = WebSocket, signal } = {}) {
  const endpoint = validateOptions({ url, humans, roomId, timeoutMs, maxRounds, connectTimeoutMs });
  const began = performance.now();
  const clients = [];
  const speeches = new Map();
  const phases = new Set();
  let failed = null;
  let finished = null;
  let latestRound = 0;
  let totalActions = 0;
  let serverErrors = 0;
  let cleanupComplete = false;
  const checkBudget = () => {
    if (signal?.aborted) throw new SmokeFailure('INTERRUPTED');
    if (performance.now() - began >= timeoutMs) throw new SmokeFailure('GAME_TIMEOUT');
    if (latestRound > maxRounds) throw new SmokeFailure('ROUND_LIMIT');
    if (totalActions > 150 || serverErrors > 30) throw new SmokeFailure('MESSAGE_LIMIT');
    const bad = clients.find(client => client.failure);
    if (bad) throw new SmokeFailure(bad.failure);
  };
  const send = (client, message) => {
    if (client.ws.readyState !== WebSocket.OPEN) throw new SmokeFailure('CONNECTION_LOST');
    client.ws.send(JSON.stringify(message));
  };
  const waitFor = async (condition, duration, timeoutCode) => {
    const start = performance.now();
    while (!condition()) {
      checkBudget();
      if (performance.now() - start >= duration) throw new SmokeFailure(timeoutCode);
      await delay(10);
    }
  };
  try {
    for (let index = 0; index < humans; index++) {
      const ws = new WebSocketImpl(endpoint.href, { handshakeTimeout: connectTimeoutMs, maxPayload: 262144, rejectUnauthorized: true });
      const client = { ws, state: null, playerId: null, seenSpeech: new Set(), acted: new Set(), failure: null, intentionalClose: false };
      clients.push(client);
      ws.on('error', () => { if (!client.intentionalClose) client.failure = 'CONNECTION_ERROR'; });
      ws.on('close', () => { if (!client.intentionalClose) client.failure = 'CONNECTION_LOST'; });
      ws.on('message', (raw, binary) => {
        try {
          if (binary) throw new SmokeFailure('INVALID_SERVER_MESSAGE');
          const message = JSON.parse(raw.toString());
          if (message.type === 'welcome') {
            client.playerId = message.playerId;
            // Resume credentials are deliberately not copied into state or reports.
          } else if (message.type === 'error') {
            serverErrors++;
            if (message.code === 'RESUME_EXPIRED') client.failure = 'UNEXPECTED_RESUME_ERROR';
            else if (!client.state || client.state.phase === 'lobby') client.failure = 'JOIN_OR_START_REJECTED';
            client.acted.clear();
          } else if (message.type === 'state') {
            checkView(message.state);
            if (message.state.roomId !== roomId || client.playerId && message.state.selfId !== client.playerId) throw new SmokeFailure('ROOM_OR_PLAYER_MISMATCH');
            client.state = message.state;
            latestRound = Math.max(latestRound, message.state.round || 0);
            phases.add(message.state.phase);
            if (message.state.phase === 'playback' && message.state.speech) {
              const speech = message.state.speech;
              if (typeof speech.id !== 'string' || typeof speech.text !== 'string' || !speech.text.trim() || Array.from(speech.text).length > 240) throw new SmokeFailure('INVALID_PUBLIC_SPEECH');
              const speaker = message.state.players.find(player => player.seat === speech.seat);
              if (!speaker) throw new SmokeFailure('UNKNOWN_SPEAKER');
              const prior = speeches.get(speech.id);
              if (prior && (prior.text !== speech.text || prior.seat !== speech.seat || prior.bot !== speaker.bot)) throw new SmokeFailure('BROADCAST_MISMATCH');
              const entry = prior || { text: speech.text, seat: speech.seat, bot: speaker.bot, clients: new Set() };
              entry.clients.add(index);
              speeches.set(speech.id, entry);
            }
          }
        } catch (error) { client.failure = error instanceof SmokeFailure ? error.code : 'INVALID_SERVER_MESSAGE'; }
      });
      await waitFor(() => ws.readyState === WebSocket.OPEN, connectTimeoutMs, 'CONNECT_TIMEOUT');
      send(client, { type: 'join', roomId, name: `公网联调${index + 1}` });
      await waitFor(() => client.state && client.playerId, connectTimeoutMs, 'JOIN_TIMEOUT');
      const ownIds = new Set(clients.map(peer => peer.playerId));
      if (client.state.phase !== 'lobby' || client.state.players.length !== index + 1 || client.state.players.some(player => player.bot || !ownIds.has(player.id))) throw new SmokeFailure('ROOM_ALREADY_IN_USE');
    }
    await waitFor(() => clients.every(client => client.state.players.length === humans), connectTimeoutMs, 'JOIN_SYNC_TIMEOUT');
    if (!clients[0].state.canStart || clients[0].state.hostId !== clients[0].playerId) throw new SmokeFailure('NOT_ROOM_HOST');
    send(clients[0], { type: 'start' });
    while (true) {
      checkBudget();
      if (clients.every(client => client.state?.phase === 'result')) {
        finished = clients[0].state;
        if (!['wolves', 'villagers'].includes(finished.result?.winner) || finished.players.length !== 6 || finished.players.filter(player => player.bot).length !== 6 - humans) throw new SmokeFailure('INVALID_FINAL_RESULT');
        if (clients.some(client => client.state.result?.winner !== finished.result.winner || client.state.round !== finished.round)) throw new SmokeFailure('RESULT_MISMATCH');
        break;
      }
      for (const client of clients) {
        const state = client.state;
        if (state.phase === 'playback' && state.speech && !client.seenSpeech.has(state.speech.id)) {
          client.seenSpeech.add(state.speech.id);
          send(client, { type: 'speech_done', speechId: state.speech.id });
        }
        if (state.prompt && !client.acted.has(state.revision)) {
          client.acted.add(state.revision);
          totalActions++;
          send(client, { type: 'action', revision: state.revision, action: humanAction(state) });
          // Wait for the shared revision before letting a second human act.
          break;
        }
      }
      await delay(25);
    }
    const ai = [...speeches.values()].filter(speech => speech.bot);
    if (!ai.length) throw new SmokeFailure('AI_SPEECH_NOT_COVERED');
    if ([...speeches.values()].some(speech => speech.clients.size !== humans)) throw new SmokeFailure('PLAYBACK_NOT_SEEN_BY_ALL_CLIENTS');
  } catch (error) {
    failed = error instanceof SmokeFailure ? error.code : 'SMOKE_OPERATION_FAILED';
  } finally {
    for (const client of clients) {
      client.intentionalClose = true;
      if (client.ws.readyState === WebSocket.OPEN) {
        try { client.ws.send(JSON.stringify({ type: 'leave' })); client.ws.close(1000, 'Smoke finished'); } catch {}
      } else if (client.ws.readyState !== WebSocket.CLOSED) {
        try { client.ws.terminate(); } catch {}
      }
    }
    const closingAt = performance.now();
    while (clients.some(client => client.ws.readyState !== WebSocket.CLOSED) && performance.now() - closingAt < 2000) await delay(10);
    for (const client of clients) if (client.ws.readyState !== WebSocket.CLOSED) { try { client.ws.terminate(); } catch {} }
    if (clients.some(client => client.ws.readyState !== WebSocket.CLOSED)) await delay(50);
    cleanupComplete = clients.every(client => client.ws.readyState === WebSocket.CLOSED);
    if (!cleanupComplete && !failed) failed = 'CLEANUP_INCOMPLETE';
  }
  const ai = [...speeches.values()].filter(speech => speech.bot);
  return {
    time: new Date().toISOString(), ok: !failed, errorCode: failed,
    transport: 'External WSS; real WebSocket clients; certificate verification enabled',
    endpointSha256: hash(endpoint.href), humanClients: humans, elapsedMs: Math.round(performance.now() - began),
    budget: { timeoutMs, maxRounds }, rounds: latestRound, phases: [...phases],
    result: finished ? { winner: finished.result.winner, round: finished.round } : null,
    publicSpeechCount: speeches.size, aiSpeechCount: ai.length,
    aiSpeechSamples: ai.slice(0, 6).map(speech => ({ seat: speech.seat, text: redactSpeech(speech.text), receivedByClients: speech.clients.size })),
    allPublicSpeechSeenByAllClients: speeches.size > 0 && [...speeches.values()].every(speech => speech.clients.size === humans),
    submittedHumanActions: totalActions, recoverableServerErrors: serverErrors,
    cleanup: { clientsOpened: clients.length, allClientsClosed: cleanupComplete, leaveSentForOpenClients: true },
    limitations: [
      'Human transcripts and playback acknowledgements are simulated; this test does not render or measure audio.',
      'AI evidence is public speech from server-assigned bot seats. Provider identity and API billing are not observable through this WebSocket protocol.',
      'No keys, resume tokens, player IDs, room number, private role views, or raw server errors are stored in this report.',
    ],
  };
}

async function main(argv) {
  const options = {};
  const usage = 'node tools/smoke-public.mjs --url wss://HOST/werewolf/ws [--humans 1|2] [--room 0037] [--timeout-ms 180000] [--output verification/public-game.json]';
  if (argv.includes('--help')) { console.log(usage); return; }
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--url', '--humans', '--room', '--timeout-ms', '--output'].includes(argv[index]) || !argv[index + 1]) throw new SmokeFailure('INVALID_CLI_ARGUMENTS');
    options[argv[index].slice(2)] = argv[index + 1];
  }
  const humans = Number(options.humans || 1);
  const output = path.resolve(options.output || `verification/public-game-${humans}human.json`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const report = await runPublicSmoke({ url: options.url, humans, roomId: options.room, timeoutMs: Number(options['timeout-ms'] || 180000), signal: controller.signal });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: report.ok, errorCode: report.errorCode, humanClients: humans, aiSpeechCount: report.aiSpeechCount, rounds: report.rounds, result: report.result, elapsedMs: report.elapsedMs, allClientsClosed: report.cleanup.allClientsClosed }));
    if (!report.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, errorCode: error instanceof SmokeFailure ? error.code : 'SMOKE_OPERATION_FAILED' })); process.exitCode = 1; });
}
