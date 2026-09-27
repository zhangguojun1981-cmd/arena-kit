import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, plain, runScript } from './helpers/fake-window.mjs';

const BOOT = '../../injected/bootstrap.js';

function boot(opts = {}) {
  const calls = [];
  const w = makeWindow({
    ...opts,
    invoke: opts.noRuntime ? undefined : (cmd, args) => (calls.push({ cmd, args }), Promise.resolve(null)),
  });
  runScript(w, BOOT);
  return { w, ak: w.__ARENAKIT__, calls };
}

test('defaults: desktop modules on, eni off, hud off', () => {
  const { ak } = boot({ env: { platform: 'macos', version: '0.1.0', mobile: false } });
  assert.deepEqual(plain(ak.modules()), { manager: true, unlock: true, plus: true, leaderboard: true, eni: false });
  assert.equal(ak.moduleOn('manager'), true);
  assert.equal(ak.moduleOn('eni'), false);
  assert.equal(ak.moduleOn('snoop'), true, 'unknown modules always run');
  assert.equal(ak.moduleOn('hud'), true, 'hud.js always loads; visibility is a separate flag');
  assert.equal(ak.snapshot().hud, false);
});

test('mobile default enables hud', () => {
  const { ak } = boot({ env: { platform: 'android', version: '0.1.0', mobile: true } });
  assert.equal(ak.snapshot().hud, true);
  assert.equal(ak.moduleOn('hud'), true);
});

test('saved switches override defaults', () => {
  const { ak } = boot({ storage: { ak_modules: JSON.stringify({ plus: false, eni: true }) } });
  assert.equal(ak.moduleOn('plus'), false);
  assert.equal(ak.moduleOn('eni'), true);
  assert.equal(ak.moduleOn('manager'), true);
});

test('reportState sends a page_event with the snapshot', async () => {
  const { ak, calls } = boot({ env: { platform: 'macos', version: '0.1.0' } });
  calls.length = 0;
  assert.equal(await ak.reportState(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'page_event');
  assert.equal(calls[0].args.kind, 'state');
  const p = calls[0].args.payload;
  assert.deepEqual(Object.keys(p).sort(), ['eni', 'hud', 'modules', 'unlock', 'url', 'version']);
  assert.deepEqual(plain(p.unlock), { opus: true, hidden: false });
  assert.deepEqual(plain(p.eni), { on: false, text: '' });
});

test('reportState is a no-op without a runtime', async () => {
  const { ak } = boot({ noRuntime: true });
  assert.equal(await ak.reportState(), false);
});

test('announces state on DOMContentLoaded when loading', () => {
  const { w, calls } = boot({ readyState: 'loading' });
  assert.equal(calls.length, 0);
  w.document.fire('DOMContentLoaded');
  assert.equal(calls.length, 1);
});

test('setModule persists and reloads', () => {
  const { w, ak } = boot();
  ak.setModule('plus', false);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ak_modules')), { plus: false });
  assert.equal(w.__reloads, 1);
  assert.equal(ak.moduleOn('plus'), false);
});

test('setUnlock updates _at and the chrome.sync shim store', () => {
  const { w, ak } = boot();
  ak.setUnlock('hidden', true);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('_at')), { e: true, o: true, h: true });
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ak_chrome_sync')), { o: true, h: true, e: true });
  ak.setUnlock('opus', false);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('_at')), { e: true, o: false, h: true });
  assert.equal(w.__reloads, 2);
  assert.deepEqual(plain(ak.snapshot().unlock), { opus: false, hidden: true });
  ak.setUnlock('bogus', true);
  assert.equal(w.__reloads, 2, 'unknown keys are ignored');
});

test('setEni writes the GM prompt key and toggles the module', () => {
  const { w, ak } = boot();
  ak.setEni(true, 'be terse');
  assert.equal(w.localStorage.getItem('ak_gm_arena_eni_system_prompt_v1'), 'be terse');
  assert.equal(ak.moduleOn('eni'), true);
  assert.equal(w.__reloads, 1, 'reload when eni.js is not loaded yet');
  assert.deepEqual(plain(ak.snapshot().eni), { on: true, text: 'be terse' });

  // simulate eni.js loaded: live update, no reload
  w.__arenaENIPrompt = 'be terse';
  ak.setEni(false, 'be terse');
  assert.equal(w.__arenaENIPrompt, '');
  assert.equal(ak.moduleOn('eni'), false);
  assert.equal(w.__reloads, 1);
  ak.setEni(true, 'new prompt');
  assert.equal(w.__arenaENIPrompt, 'new prompt');
  assert.equal(w.__reloads, 1);
});

test('setHud persists and drives the HUD if present', () => {
  const { w, ak } = boot();
  let visible = null;
  w.__AK_HUD__ = { setVisible: (v) => (visible = v) };
  ak.setHud(true);
  assert.equal(w.localStorage.getItem('ak_hud'), '1');
  assert.equal(visible, true);
  assert.equal(ak.snapshot().hud, true);
  ak.setHud(false);
  assert.equal(ak.snapshot().hud, false);
});

test('toggleManager reports whether the manager is present', () => {
  const { w, ak } = boot();
  assert.equal(ak.toggleManager(), false);
  let hits = 0;
  w.__AK_MANAGER_TOGGLE__ = () => hits++;
  assert.equal(ak.toggleManager(), true);
  assert.equal(hits, 1);
});

test('onToken forwards to fetch_trace with camelCase args', async () => {
  const { ak, calls } = boot();
  calls.length = 0;
  await ak.onToken({ token: 'a.b.c', sessionId: 's1' });
  assert.deepEqual(plain(calls[0]), { cmd: 'fetch_trace', args: { token: 'a.b.c', sessionId: 's1' } });
});

test('re-running the bootstrap is idempotent', () => {
  const { w, ak } = boot();
  runScript(w, BOOT);
  assert.equal(w.__ARENAKIT__, ak);
});
