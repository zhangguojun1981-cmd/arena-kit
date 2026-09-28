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
const REPOS = [
  { id: 1, name: 'arena-kit-old', fullName: 'someone/arena-kit-old', ownerLogin: 'someone', defaultBranch: 'main' },
  { id: 2, name: 'arena-kit', fullName: 'zhangguojun1981-cmd/arena-kit', ownerLogin: 'zhangguojun1981-cmd', defaultBranch: 'main' },
  { id: 3, name: 'notes', fullName: 'zhangguojun1981-cmd/notes', ownerLogin: 'zhangguojun1981-cmd', defaultBranch: 'main' },
];
function load(nodes, pathname = '/agent', { connection = 'connected', repos = REPOS, fetches = [] } = {}) {
  const p = fakePage({ pathname });
  p.sandbox.__ARENAKIT__ = { send: () => {} };
  p.sandbox.fetch = async (url) => {
    fetches.push(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (url.startsWith('/api/coding/github/connection')) return connection === null ? json({}, 404) : json({ status: connection });
    if (url.startsWith('/api/coding/github/repos')) return repos === null ? json({}, 401) : json({ repos, nextCursor: null, hasNextPage: false });
    return json({}, 404);
  };
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
  assert.deepEqual(r.data, { github: true, repo: 'zhangguojun1981-cmd/arena-kit', name: 'arena-kit', branch: null, changed: true });
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
  const call = load(() => [MODE(), connect], '/agent', { connection: null });
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

test('fuzzy project names: exact > squashed > prefix > contains > subsequence', async () => {
  const p = fakePage({ pathname: '/agent' });
  p.sandbox.__ARENAKIT__ = { send: () => {} };
  runInjected('injected/probe.js', p.sandbox);
  const { pickRepo, fuzzyScore } = p.sandbox.ArenaProbe;
  const name = (q) => pickRepo(q, REPOS)?.repo.fullName || null;
  assert.equal(name('arena-kit'), 'zhangguojun1981-cmd/arena-kit', 'exact name beats the longer look-alike');
  assert.equal(name('ARENAKIT'), 'zhangguojun1981-cmd/arena-kit', 'case / punctuation insensitive');
  assert.equal(name('arena'), 'zhangguojun1981-cmd/arena-kit', 'prefix: the shorter name wins the tie');
  assert.equal(name('kit-old'), 'someone/arena-kit-old');
  assert.equal(name('note'), 'zhangguojun1981-cmd/notes');
  assert.equal(name('ank'), 'zhangguojun1981-cmd/arena-kit', 'subsequence as last resort');
  assert.equal(name('someone/arena-kit-old'), 'someone/arena-kit-old', 'owner/name still works');
  assert.equal(name('xyz'), null);
  assert.equal(fuzzyScore('', REPOS[0]), 0);
});

test('ensureProject with a short fuzzy name: resolved via the repo list, picked by exact name in the dropdown', async () => {
  let label = 'Select a repository';
  let open = false;
  const picker = node({ sel: ['button[aria-haspopup]'], text: () => label, attrs: { 'aria-haspopup': 'listbox' }, onClick: () => { open = true; } });
  const opt1 = node({ sel: ['[role="option"]'], text: 'someone/arena-kit-old', onClick: () => { label = 'arena-kit-old'; open = false; } });
  const opt2 = node({ sel: ['[role="option"]'], text: 'zhangguojun1981-cmd/arena-kit', onClick: () => { label = 'arena-kit'; open = false; } });
  const mode = MODE();
  const fetches = [];
  const call = load(() => [mode, picker, ...(open ? [opt1, opt2] : [])], '/agent', { fetches });
  const r = await call('ensureProject', { repo: 'arenakit' });
  assert.equal(r.ok, true, r.error);
  assert.equal(opt2.clicks, 1);
  assert.equal(opt1.clicks, undefined);
  assert.equal(r.data.repo, 'zhangguojun1981-cmd/arena-kit');
  assert.ok(fetches.some((u) => u.startsWith('/api/coding/github/connection')));
  const again = await call('ensureProject', { repo: 'arena-kit' });
  assert.equal(again.data.changed, false, 'already selected → no clicks');
  assert.equal(picker.clicks, 1);
});

test('ensureProject: unknown project name lists what exists; GitHub disconnected is reported', async () => {
  let call = load(() => [MODE()]);
  let r = await call('ensureProject', { repo: 'zzz' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有与「zzz」匹配的仓库（共 3 个：arena-kit-old、arena-kit、notes）/);
  call = load(() => [MODE()], '/agent', { connection: 'disconnected' });
  r = await call('ensureProject', { repo: 'arena-kit' });
  assert.match(r.error, /GitHub 尚未连接（状态 disconnected）/);
});
