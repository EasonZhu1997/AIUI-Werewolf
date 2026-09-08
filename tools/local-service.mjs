import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'server/index.mjs');
const records = path.join(root, 'verification');
const statePath = path.join(records, 'local-service.json');
const logPath = path.join(records, 'local-service.log');
const url = 'http://127.0.0.1:8790/werewolf/';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function health() {
  try {
    const response = await fetch(url + 'health', { signal: AbortSignal.timeout(800) });
    const value = await response.json();
    return response.ok && value.app === 'aiui-werewolf' && value.ok ? value : null;
  } catch (_) { return null; }
}
function savedState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return null; }
}
function ownedProcess(state) {
  if (!state || state.root !== root || !Number.isInteger(state.pid) || state.pid < 2) return false;
  try {
    const command = execFileSync('/bin/ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return command.endsWith(' ' + entry) && command.startsWith(state.node + ' ');
  } catch (_) { return false; }
}
async function start() {
  const existing = await health();
  if (existing) { console.log(`月下同桌已在运行：${url}`); return; }
  const state = savedState();
  if (ownedProcess(state)) throw new Error('已存在本项目服务进程，但健康检查未通过；请先运行 npm run stop:local 后重试。');
  fs.mkdirSync(records, { recursive: true });
  const log = fs.openSync(logPath, 'a', 0o600); fs.chmodSync(logPath, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry], { cwd: root, detached: true,
      stdio: ['ignore', log, log], env: { ...process.env, HOST: '127.0.0.1', PORT: '8790', WEREWOLF_PREVIEW_ORIGINS: '' } });
  } finally { fs.closeSync(log); }
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  child.unref();
  const record = { app: 'aiui-werewolf', root, node: process.execPath, pid: child.pid, startedAt: new Date().toISOString(), url };
  for (let attempt = 0; attempt < 30; attempt++) {
    if (spawnFailed) break;
    if (await health()) {
      if (!ownedProcess(record)) throw new Error('端口已由另一进程启动；未接管或停止该进程。');
      fs.writeFileSync(statePath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      console.log(`月下同桌已在后台启动：${url}\n可以关闭本终端窗口。停止服务：npm run stop:local`); return;
    }
    if (child.exitCode !== null) break;
    await delay(200);
  }
  if (ownedProcess(record)) process.kill(record.pid, 'SIGTERM');
  throw new Error(`服务启动失败，请查看 ${logPath}。`);
}
async function stop() {
  const state = savedState();
  if (!ownedProcess(state)) {
    if (await health()) throw new Error('当前服务不是此后台启动器创建的进程；请在原启动终端停止。');
    console.log('本机后台服务未运行。'); return;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) {
    if (!ownedProcess(state)) { fs.rmSync(statePath, { force: true }); console.log('本机后台服务已停止。'); return; }
    await delay(250);
  }
  throw new Error('服务未能及时停止，已保留进程记录；不会强制结束其他进程。');
}
try {
  const command = process.argv[2] || 'start';
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'status') console.log(JSON.stringify({ running: Boolean(await health()), managed: ownedProcess(savedState()), url }));
  else throw new Error('命令必须为 start、stop 或 status');
} catch (error) { console.error(error.message); process.exitCode = 1; }
