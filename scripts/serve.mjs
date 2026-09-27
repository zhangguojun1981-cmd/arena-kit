#!/usr/bin/env node
/* Tiny static server for reviewing the UI in a browser without Tauri:
 *   npm run preview  →  http://localhost:4173/  (gallery)  /shell.html?tabs=1  /shell.html?mode=mobile
 * Zero dependencies on purpose (the project has no bundler). */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('../src', import.meta.url).pathname);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const s = await stat(file);
    const body = await readFile(s.isDirectory() ? join(file, 'index.html') : file);
    res.writeHead(200, {
      'content-type': types[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(e.code === 'ENOENT' ? 'not found' : String(e));
  }
}).listen(port, host, () => {
  console.log(`ArenaKit preview → http://localhost:${port}/`);
});
