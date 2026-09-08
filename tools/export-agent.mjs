import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'agent');
const sha = data => createHash('sha256').update(data).digest('hex');
function files(directory, prefix = '') {
  const result = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '.export.json') continue;
    const file = path.join(directory, name); const relative = prefix + name; const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('导出目录内有符号链接');
    if (stat.isDirectory()) Object.assign(result, files(file, relative + '/'));
    else result[relative] = sha(fs.readFileSync(file));
  }
  return result;
}
try {
  if (fs.existsSync(target)) {
    const previous = JSON.parse(fs.readFileSync(path.join(target, '.export.json'), 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(files(target))) throw new Error('agent 已在导出后修改，请先保留修改再重新导出');
    fs.rmSync(target, { recursive: true });
  }
  fs.mkdirSync(target);
  for (const name of ['AGENTS.md', 'app.json', 'app.js', 'pages', 'lib', 'assets']) fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true, dereference: false });
  fs.writeFileSync(path.join(target, '.export.json'), JSON.stringify(files(target)));
  console.log(`Studio 导入根目录：${target}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
