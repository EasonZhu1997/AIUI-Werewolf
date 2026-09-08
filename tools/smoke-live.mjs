import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createService } from '../server/service.mjs';
import { readDeepSeekKey, DeepSeekProvider } from '../server/provider.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.env.WEREWOLF_CONFIG || path.join(root, 'private-config.json');
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const humans = Number(process.argv[2] || 1);
if (![1, 2].includes(humans)) throw new Error('Live smoke supports one or two simulated human clients');
const provider = new DeepSeekProvider({ apiKey: readDeepSeekKey(process.env.DEEPSEEK_ENV_FILE || config.deepseekEnvFile), model: process.env.DEEPSEEK_MODEL || config.model });
const service = createService({ root, provider, random: () => 0.99 });
const address = await service.listen(0);
const clients = [];
const speeches = [];
let finalState;
const began = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < humans; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/werewolf/ws`);
    const client = { ws, state: null, seenSpeech: new Set(), acted: new Set(), errors: [] }; clients.push(client);
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.type === 'state') client.state = msg.state;
      if (msg.type === 'error') { client.errors.push(msg.message); client.acted.clear(); }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', roomId: '9001', name: `联调玩家${i + 1}` }));
    while (!client.state) await sleep(10);
  }
  clients[0].ws.send(JSON.stringify({ type: 'start' }));
  while (Date.now() - began < 180000) {
    for (const client of clients) {
      const state = client.state; if (!state) continue;
      if (state.phase === 'result') { finalState = state; break; }
      if (state.phase === 'playback' && state.speech && !client.seenSpeech.has(state.speech.id)) {
        client.seenSpeech.add(state.speech.id);
        if (client === clients[0]) speeches.push(state.speech);
        client.ws.send(JSON.stringify({ type: 'speech_done', speechId: state.speech.id }));
      }
      if (state.prompt && !client.acted.has(state.revision)) {
        client.acted.add(state.revision);
        let action;
        if (state.prompt.kind === 'speech') action = { kind: 'speech', text: `${state.selfSeat}号发言：先听大家给出的依据。我比较关注最后一个发言的玩家，请说明你的投票理由。` };
        else {
          const choices = state.prompt.choices;
          const chosen = choices.find(c => c.action === 'save') || [...choices].reverse().find(c => c.target !== null && c.action !== 'poison') || choices.find(c => c.action === 'skip') || choices[0];
          action = { kind: state.prompt.kind, action: chosen.action, target: chosen.target };
        }
        client.ws.send(JSON.stringify({ type: 'action', revision: state.revision, action }));
      }
    }
    if (finalState) break;
    await sleep(40);
  }
  if (!finalState) throw new Error('Live game did not reach a result within three minutes');
  const aiSpeech = speeches.filter(s => finalState.players.find(p => p.seat === s.seat)?.bot);
  if (!aiSpeech.length) throw new Error('Game ended without an AI speaking; voice dialogue path not covered');
  const report = { time: new Date().toISOString(), ok: true, humanClients: humans, model: provider.model, actualApiCalls: provider.calls.length,
    actualApiSuccesses: provider.successes, elapsedMs: Date.now() - began, rounds: finalState.round, result: finalState.result,
    aiSpeeches: aiSpeech, logs: finalState.logs, transport: 'actual WebSocket clients',
    limitations: ['Human speech/transcript inputs and playback acknowledgements are simulated in this test.', 'Actual audio rendering and glasses hardware need separate validation.'] };
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, `verification/live-game-${humans}human.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, humans, apiCalls: provider.successes, aiSpeeches: aiSpeech.length, rounds: finalState.round, result: finalState.result, elapsedMs: report.elapsedMs }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { for (const client of clients) client.ws.terminate(); await service.close(); }
