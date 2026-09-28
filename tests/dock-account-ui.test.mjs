import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/dock.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../src/dock.js', import.meta.url), 'utf8');

test('账号页: the automatic-login progress group is hidden until a login runs; 取消 only while running', () => {
  assert.match(html, /<div class="ak-group" id="ak-acct-helper" hidden>/);
  assert.match(html, /自动登录进度/);
  assert.match(html, /id="ak-acct-stop"[^>]*>取消自动登录</);
  const acct = html.slice(html.indexOf('data-page="account"'), html.indexOf('data-page="more"'));
  assert.ok(acct.length > 100);
  assert.doesNotMatch(acct, />停止</, 'no bare 停止 button on the account page');
  assert.doesNotMatch(html, /自动重新登录<\/span>/);
  assert.match(js, /box\.hidden = !t/);
  assert.match(js, /stop\.hidden = !running/);
});

test('账号页 notes describe the real flows (dead session cleared first; add = Google "使用其他账号")', () => {
  assert.match(html, /清除失效的登录状态 → 打开 Google 登录/);
  assert.match(html, /「添加另一个账号」会直接打开 Google 登录并点「使用其他账号」/);
});
