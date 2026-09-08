import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = data => createHash('sha256').update(data).digest('hex');
const allowlist = ['app.json', 'app.js', 'AGENTS.md', 'lib', 'pages', 'assets'];
let stage, reader;
try {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const config = (await import(pathToFileURL(path.join(root, 'lib/config.js')).href)).default;
  if (app.version !== '0.1.3' || config.version !== app.version) throw new Error('应用与配置版本不一致');
  const url = new URL(config.url);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.pathname !== '/werewolf/ws' || url.username || url.password || url.hash || url.search ||
      !(url.protocol === 'wss:' || local && url.protocol === 'ws:')) throw new Error('配置须为 /werewolf/ws 的 WSS 地址；仅环回地址可用 WS');
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });
  const name = `MoonTable-AIUI-v${app.version}${local ? '-LOCAL-ONLY' : ''}-cn.aix`;
  stage = fs.mkdtempSync(path.join(root, '.aix-stage-'));
  const sources = [];
  function copy(relative) {
    const source = path.join(root, relative); const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('不打包符号链接');
    if (stat.isDirectory()) {
      fs.mkdirSync(path.join(stage, relative), { recursive: true });
      for (const name of fs.readdirSync(source).sort()) {
        if (name.startsWith('.')) throw new Error('客户端文件中有隐藏项');
        copy(`${relative}/${name}`);
      }
    } else {
      const data = fs.readFileSync(source);
      if (/(?:DEEPSEEK_API_KEY\s*=|sk-[a-zA-Z0-9_-]{20,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(data.toString())) throw new Error('客户端文件可能含密钥，停止打包');
      fs.writeFileSync(path.join(stage, relative), data);
      sources.push({ path: relative, bytes: data.length, sha256: sha(data) });
    }
  }
  allowlist.forEach(copy);
  const cli = path.join(root, 'node_modules/@yodaos-pkg/aix-cli/dist/cli.js');
  const artifact = path.join(dist, name);
  const result = spawnSync(process.execPath, [cli, 'pack', stage, '-o', artifact, '--engine', app.engine], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`官方打包失败：${(result.stderr || result.stdout).slice(0, 1500)}`);
  const data = fs.readFileSync(artifact);
  if (data.length >= 2000000) throw new Error('AIX 超过 2 MB');
  const require = createRequire(import.meta.url);
  const { AixReaderWasm } = require(path.join(root, 'node_modules/@yodaos-pkg/aix-cli/dist/pkg/aix_web.js'));
  reader = new AixReaderWasm(new Uint8Array(data));
  const entries = reader.list().map(entry => entry.name).sort();
  const expected = [...sources.map(source => source.path), 'VERSION', 'META-INF/aix/manifest.json'].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error('Reader 文件白名单不匹配');
  const text = file => Buffer.from(reader.read_file(file)).toString('utf8');
  const manifest = JSON.parse(text('META-INF/aix/manifest.json'));
  const buildUuid = reader.get_version();
  if (manifest.version !== buildUuid || text('VERSION').trim() !== buildUuid || buildUuid === app.uuid || !/^[a-f0-9-]{36}$/.test(buildUuid)) throw new Error('构建 UUID 校验失败');
  if (!reader.supports_engine('0.17.0') || reader.supports_engine('0.18.0') || reader.supports_engine('0.16.99')) throw new Error('引擎兼容范围错误');
  const packed = JSON.parse(text('app.json'));
  if (packed.uuid !== app.uuid || packed.version !== app.version || !packed.permissions.includes('RECORD_AUDIO')) throw new Error('包内应用声明不一致');
  if (JSON.stringify(reader.get_pages().map(page => page.name)) !== JSON.stringify(app.pages)) throw new Error('路由验证失败');
  for (const entry of manifest.entries) {
    const value = Buffer.from(reader.read_file(entry.path));
    if (sha(value) !== entry.sha256 || value.length !== entry.size) throw new Error('包内摘要错误');
  }
  const report = { generatedAt: new Date().toISOString(), version: app.version, artifact: name, appUuid: app.uuid, buildUuid,
    bytes: data.length, sha256: sha(data), endpoint: config.url, localOnly: local,
    checks: { officialPacker: true, officialReader: true, allowlist: true, size: true, digests: true, routes: true, permissions: true, engine: true },
    deviceVerified: false, sources };
  fs.writeFileSync(path.join(dist, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ artifact, bytes: report.bytes, sha256: report.sha256, buildUuid, localOnly: local }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { reader?.free(); if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
