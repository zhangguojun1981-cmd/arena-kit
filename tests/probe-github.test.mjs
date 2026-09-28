import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected, fakePage, plain } from './helpers.mjs';

/* Mini DOM for the composer controls: every node lists the simple selectors it
 * matches (`sel`); querySelectorAll('a,b') returns nodes matching any part. */
function node({ sel = [], text = '', attrs = {}, parent = null, visible = true, onClick } = {}) {
  const n = {
    tagName: 'BUTTON', id: '', sel, attrs: { ...attrs }, isConnected: true, parentElement: parent, _visible: visible,
    get textContent() { return typeof text === 'function' ? text() : text; },
    getClientRects() { return n._visible ? [{}] : []; },
    getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
    hasAttribute: (k) => k in n.attrs,
    closest: () => null,
    click() { n.clicks = (n.clicks || 0) + 1; if (onClick) onClick(n); },
    focus() {},
  };
  return n;
}
function load(nodes, pathname = '/agent') {
  const p = fakePage({ pathname });
  p.sandbox.__ARENAKIT__ = { send: () => {} };
  p.document.querySelectorAll = (sel) => {
    const parts = sel.split(',').map((s) => s.trim());
    return nodes().filter((n) => n.sel.some((s) => parts.includes(s)));
  };
  runInjected('injected/probe.js', p.sandbox);
  return async (action, args = {}) => plain(await p.sandbox.ArenaProbe.call(action, JSON.stringify(args), 'r'));
}

const MODE = () => node({ sel: ['button[role="combobox"]'], text: 'Agent Mode', attrs: { role: 'combobox' } });

test('ensureProject: GitHub switch flipped on, repo chosen from the picker, verified', async () => {
  const row = { textContent: 'GitHub', parentElement: null };
  const sw = node({ sel: ['[role="switch"]'], attrs: { role: 'switch', 'aria-checked': 'false' }, parent: row, onClick: (n) => { n.attrs['aria-checked'] = 'true'; } });
  let repoLabel = 'Select repository';
  let open = false;
  const picker = node({ sel: ['button[aria-haspopup]'], text: () => repoLabel, attrs: { 'aria-haspopup': 'listbox' }, onClick: () => { open = true; } });
  const optA = node({ sel: ['[role="option"]'], text: 'someone/arena-kit-old', attrs: { role: 'option' }, onClick: () => { repoLabel = 'someone/arena-kit-old'; open = false; } });
  const optB = node({ sel: ['[role="option"]'], text: 'zhangguojun1981-cmd/arena-kit', attrs: { role: 'option' }, onClick: () => { repoLabel = 'zhangguojun1981-cmd/arena-kit'; open = false; } });
  const mode = MODE();
  const call = load(() => [mode, sw, picker, ...(open ? [optA, optB] : [])]);
  const r = await call('ensureProject', { repo: 'https://github.com/zhangguojun1981-cmd/arena-kit.git' });
  assert.equal(r.ok, true, r.error);
  assert.equal(sw.clicks, 1);
  assert.equal(optB.clicks, 1, 'full owner/name beats a look-alike');
  assert.equal(optA.clicks, undefined);
  assert.deepEqual(r.data, { github: true, repo: 'zhangguojun1981-cmd/arena-kit', branch: null, changed: true });
  // second run: nothing to do, no clicks
  const again = await call('ensureProject', { repo: 'zhangguojun1981-cmd/arena-kit' });
  assert.equal(again.ok, true);
  assert.equal(again.data.changed, false);
  assert.equal(sw.clicks, 1);
  assert.equal(picker.clicks, 1);
});

test('ensureGithub: already on → untouched; data-state toggles are understood', async () => {
  const row = { textContent: 'GitHub connector', parentElement: null };
  const sw = node({ sel: ['button[data-state="checked"]'], attrs: { 'data-state': 'checked' }, parent: row });
  const call = load(() => [MODE(), sw]);
  const r = await call('ensureGithub');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { github: true, changed: false });
  assert.equal(sw.clicks, undefined);
});

test('ensureGithub: "Connect your GitHub" banner → clear error, no OAuth click', async () => {
  const banner = { textContent: 'Connect your GitHub NEW Connect', parentElement: null };
  const wrap = { textContent: 'Connect', parentElement: banner };
  const connect = node({ sel: ['button'], text: 'Connect', parent: wrap });
  const call = load(() => [MODE(), connect]);
  const r = await call('ensureGithub');
  assert.equal(r.ok, false);
  assert.match(r.error, /GitHub 尚未连接/);
  assert.equal(connect.clicks, undefined);
});

test('applyDefaults: never runs inside an existing conversation; reports parts separately', async () => {
  const call = load(() => [MODE()], '/agent/abc-123');
  const r = await call('applyDefaults', { github: true });
  assert.deepEqual(r.data, { skipped: 'conversation' });
});

test('ensureProject refuses without a repo', async () => {
  const call = load(() => [MODE()]);
  const r = await call('ensureProject', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /未指定项目/);
});
