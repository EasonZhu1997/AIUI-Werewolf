import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.mjs';
import { readDeepSeekKey, DeepSeekProvider } from './provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config = {};
try {
  const file = process.env.WEREWOLF_CONFIG || path.join(root, 'private-config.json');
  if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const apiKey = readDeepSeekKey(process.env.DEEPSEEK_ENV_FILE || config.deepseekEnvFile);
  const provider = new DeepSeekProvider({ apiKey, model: process.env.DEEPSEEK_MODEL || config.model || 'deepseek-v4-flash' });
  const service = createService({ root, provider, admin: config.admin || null, previewOrigins: (process.env.WEREWOLF_PREVIEW_ORIGINS || '').split(',').filter(Boolean) });
  const host = process.env.HOST || config.host || '127.0.0.1';
  const address = await service.listen(Number(process.env.PORT || config.port || 8790), host);
  console.log(`月下同桌 v0.1.2 · DeepSeek 已配置\n浏览器打开：http://${host}:${address.port}/werewolf/\n眼镜使用为此服务配置的 AIX。`);
  if (config.admin) console.log('管理后台已启用：/werewolf/admin/（需要管理口令）');
  const stop = async () => { await service.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  console.error(error instanceof SyntaxError ? '配置文件格式无效' : error.message);
  process.exitCode = 1;
}
