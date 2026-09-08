import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(fs.readFileSync(path.join(root, 'dist/validation.json'), 'utf8'));
const child = spawn(process.execPath, [path.join(root, 'node_modules/@yodaos-pkg/aix-cli/dist/cli.js'), 'preview', path.join(root, 'dist', path.basename(report.artifact))], { cwd: root, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
