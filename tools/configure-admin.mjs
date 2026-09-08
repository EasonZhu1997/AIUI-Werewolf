import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

// Creates a high-entropy access token; never prints the token or adds it to public files.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'private-config.json');
const accessFile = path.join(root, 'private-admin-access.txt');
try {
  const origin = new URL(process.argv[2] || 'http://127.0.0.1:8790');
  if (origin.origin !== (process.argv[2] || 'http://127.0.0.1:8790') || origin.username || origin.password ||
      !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw Error('管理入口须为 HTTPS Origin；仅本机环回允许 HTTP');
  if (!fs.existsSync(configFile)) throw Error('请先准备服务的 private-config.json');
  if (fs.existsSync(accessFile)) throw Error('管理口令文件已存在，保留当前凭证；轮换请按 docs/ADMIN.md 操作');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.admin) throw Error('管理后台已配置，停止覆盖现有凭证');
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const credentials = '月下同桌 · 管理后台\n\n管理入口：' + origin.origin + '/werewolf/admin/\n管理口令：' + token + '\n\n无需用户名。此文件只供管理者保管，请勿发到玩家群或放入公开仓库。\n';
  fs.writeFileSync(accessFile, credentials, { mode: 0o600, flag: 'wx' });
  const temporary = configFile + '.admin-' + randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...config, admin: { origin: origin.origin, tokenHash } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, configFile);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log('管理后台配置已创建。口令保存在：' + accessFile + '\n重启游戏服务后生效。');
} catch (error) { console.error(error instanceof SyntaxError ? '配置格式无效' : error.message); process.exitCode = 1; }
