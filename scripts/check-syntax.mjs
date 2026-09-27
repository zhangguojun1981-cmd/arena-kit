// Syntax-check every JS file that ships in the app (injected bundle + dock).
// Injected scripts are classic scripts (compiled through vm.Script, never
// executed); dock files are ES modules (checked with `node --check`).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [];
for (const f of fs.readdirSync(path.join(root, 'injected'))) if (f.endsWith('.js')) targets.push([path.join('injected', f), 'script']);
for (const dir of ['src', 'src/lib']) for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.js')) targets.push([path.join(dir, f), 'module']);
let failed = 0;
for (const [rel, kind] of targets) {
  let error = null;
  if (kind === 'script') {
    try { new vm.Script(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel }); } catch (e) { error = e.message; }
  } else {
    const r = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
    if (r.status !== 0) error = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
  }
  console.log(error ? `FAIL  ${rel} - ${error}` : `ok    ${rel}`);
  if (error) failed++;
}
if (failed) { console.error(`${failed} file(s) failed syntax check`); process.exit(1); }
