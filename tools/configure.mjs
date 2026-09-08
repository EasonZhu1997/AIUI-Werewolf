import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const value = process.argv[2]; const url = new URL(value);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.pathname !== '/werewolf/ws' || url.search || url.hash || url.username || url.password || !(url.protocol === 'wss:' || local && url.protocol === 'ws:')) throw new Error('请使用 wss://域名/werewolf/ws，或本机环回 WS 地址');
  fs.writeFileSync(path.join(root, 'lib/config.js'), `export default ${JSON.stringify({ version: '0.1.2', url: url.href })};\n`, { mode: 0o600 });
  console.log('眼镜服务地址已配置；请重新打包。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
