import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/* injected/links.js: the page-side half of the in-app link tab (reference
 * LinkPolicy + LinkTab). Loaded into a fake page; the transports (Android
 * bridge object / desktop `open_tab` command / plain window.open) are stubs. */
const root = resolve(new URL('..', import.meta.url).pathname);
const SRC = readFileSync(resolve(root, 'injected/links.js'), 'utf8');

function page({ android = false, tauri = false, href = 'https://arena.ai/agent/s1' } = {}) {
  const listeners = {};
  const calls = { native: [], invoke: [], opened: [], sent: [] };
  const ctx = {
    location: { href },
    URL,
    document: { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } },
    open: (u, t, f) => { calls.opened.push([u, t, f]); return { fake: true }; },
    console,
  };
  ctx.window = ctx;
  if (android) ctx.ArenaKitAndroid = { postMessage: (json) => calls.native.push(JSON.parse(json)) };
  if (tauri) ctx.__ARENAKIT__ = { invoke: (cmd, args) => { calls.invoke.push([cmd, args]); return Promise.resolve(true); }, send: (n, p) => calls.sent.push([n, p]) };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'links.js' });
  return { ctx, listeners, calls, links: ctx.__ARENAKIT_LINKS__ };
}

const click = (listeners, { href, target = null, button = 0, meta = false, download = false, inDock = false, trusted = true }) => {
  let prevented = false;
  const anchor = {
    getAttribute: (n) => (n === 'href' ? href : n === 'target' ? target : null),
    hasAttribute: (n) => (n === 'download' ? download : false),
    closest: (sel) => (sel === '#arenakit-embed' && inDock ? {} : null),
  };
  const ev = { button, metaKey: meta, ctrlKey: false, isTrusted: trusted, defaultPrevented: false, target: { closest: (sel) => (sel === 'a[href]' ? anchor : null) }, preventDefault: () => { prevented = true; } };
  for (const fn of listeners.click) fn(ev);
  return prevented;
};

test('routeMain mirrors the reference LinkPolicy (arena / auth flows in place, other sites → tab, schemes)', () => {
  const { links } = page();
  const r = links.routeMain;
  assert.equal(r('https://example.com/docs'), 'tab');
  assert.equal(r('http://github.com/owner/repo'), 'tab');
  assert.equal(r('https://arena.ai/agent/abc'), 'in-place');
  assert.equal(r('https://ARENA.AI/'), 'in-place');
  assert.equal(r('https://auth.arena.ai/x'), 'in-place');
  assert.equal(r('https://evilarena.ai/'), 'tab');
  assert.equal(r('https://arena.ai.evil.com/'), 'tab');
  // only real link taps are diverted
  assert.equal(r('https://example.com/', { linkClick: false }), 'in-place');
  assert.equal(r('https://example.com/', { gesture: false }), 'in-place');
  assert.equal(r('https://example.com/', { redirect: true }), 'in-place');
  // sign-in flows stay in the arena webview
  for (const u of ['https://accounts.google.com/o/oauth2/v2/auth', 'https://appleid.apple.com/auth/authorize', 'https://abcd.supabase.co/auth/v1/authorize', 'https://github.com/login/oauth/authorize', 'https://www.github.com/session', 'https://challenges.cloudflare.com/turnstile']) {
    assert.equal(r(u), 'in-place', u);
  }
  assert.equal(r('https://github.com/loginator/repo'), 'tab');
  assert.equal(r('https://www.google.com/search'), 'tab');
  // new-window requests always go to the tab, except sign-in pop-ups
  assert.equal(r('https://arena.ai/leaderboard', { newWindow: true }), 'tab');
  assert.equal(r('https://accounts.google.com/o/oauth2/auth', { newWindow: true }), 'in-place');
  // other apps only on a gesture; local / script schemes never
  assert.equal(r('mailto:someone@example.com'), 'external');
  assert.equal(r('tel:+85212345678'), 'external');
  assert.equal(r('intent://scan/#Intent;scheme=zxing;end'), 'external');
  assert.equal(r('market://details?id=x', { gesture: false }), 'block');
  assert.equal(r('file:///sdcard/secret.txt'), 'block');
  assert.equal(r('content://com.example.provider/x'), 'block');
  assert.equal(r('JavaScript:alert(1)'), 'block');
  assert.equal(r('about:blank'), 'in-place');
  assert.equal(r('blob:https://arena.ai/1234'), 'in-place');
  assert.equal(r(''), 'in-place');
  // helpers
  assert.ok(links.isWebUrl('https://example.com') && links.isWebUrl('HTTP://example.com/x'));
  assert.ok(!links.isWebUrl('https://') && !links.isWebUrl('blob:https://arena.ai/1') && !links.isWebUrl('javascript:alert(1)'));
});

test('Android: a tapped link to another site goes to the native tab; arena links are left alone', () => {
  const { listeners, calls } = page({ android: true });
  assert.equal(click(listeners, { href: 'https://example.com/a' }), true, 'default prevented');
  assert.deepEqual(calls.native, [{ cmd: 'openTab', url: 'https://example.com/a' }]);
  assert.equal(click(listeners, { href: '/agent/other' }), false, 'relative arena link navigates in place');
  assert.equal(click(listeners, { href: 'https://arena.ai/leaderboard' }), false);
  assert.equal(click(listeners, { href: 'https://arena.ai/leaderboard', target: '_blank' }), true, 'target=_blank → tab even for arena');
  assert.equal(click(listeners, { href: 'https://example.com/b', button: 1 }), false, 'right/middle button on click event ignored');
  assert.equal(click(listeners, { href: 'https://example.com/c', download: true }), false, 'downloads are not tabs');
  assert.equal(click(listeners, { href: 'https://example.com/d', inDock: true }), false, "the dock's own links");
  assert.equal(click(listeners, { href: 'mailto:x@y.z' }), false, 'mailto is left to the navigation (links.rs → external)');
  assert.equal(click(listeners, { href: 'javascript:alert(1)' }), true, 'script URLs are swallowed');
  assert.equal(calls.native.length, 2);
});

test('window.open goes to the tab (returns null) except sign-in pop-ups, which keep their opener', () => {
  const { ctx, calls } = page({ android: true });
  assert.equal(ctx.open('https://example.com/x'), null);
  assert.deepEqual(calls.native.at(-1), { cmd: 'openTab', url: 'https://example.com/x' });
  assert.deepEqual(ctx.open('https://accounts.google.com/o/oauth2/auth', 'popup', 'width=500'), { fake: true });
  assert.deepEqual(calls.opened.at(-1), ['https://accounts.google.com/o/oauth2/auth', 'popup', 'width=500']);
  assert.deepEqual(ctx.open(), { fake: true }, 'window.open() with no URL is untouched');
  assert.equal(calls.native.length, 1);
});

test('desktop: the tab is the open_tab command; without any runtime it is a real new tab', () => {
  const d = page({ tauri: true });
  assert.equal(click(d.listeners, { href: 'https://example.com/a' }), true);
  assert.equal(JSON.stringify(d.calls.invoke), JSON.stringify([['open_tab', { url: 'https://example.com/a' }]]));
  assert.equal(d.calls.opened.length, 0);
  const plain = page();
  assert.equal(click(plain.listeners, { href: 'https://example.com/a' }), true);
  assert.deepEqual(plain.calls.opened, [['https://example.com/a', '_blank', 'noopener']]);
});

test('native tab state is mirrored for the dock; external() only forwards non-web, non-forbidden URLs', () => {
  const { links, calls } = page({ android: true, tauri: true });
  assert.equal(links.isOpen(), false);
  links.setOpen(true);
  assert.equal(links.isOpen(), true);
  assert.equal(JSON.stringify(calls.sent.at(-1)), JSON.stringify(['link-tab', { open: true }]));
  links.setOpen(false);
  assert.equal(links.isOpen(), false);
  assert.equal(links.external('mailto:a@b.c'), true);
  assert.deepEqual(calls.native.at(-1), { cmd: 'external', url: 'mailto:a@b.c' });
  assert.equal(links.external('https://example.com'), false);
  assert.equal(links.external('file:///etc/passwd'), false);
  assert.equal(links.open('javascript:alert(1)'), false);
  assert.equal(links.open('https://example.com/from-rust'), true, 'links.rs → open(url) on Android');
  assert.deepEqual(calls.native.at(-1), { cmd: 'openTab', url: 'https://example.com/from-rust' });
  assert.ok(links.hasNativeTab());
});

test('re-injection is a no-op (version guard) and keeps the first window.open patch', () => {
  const { ctx } = page({ android: true });
  const patched = ctx.open;
  vm.runInContext(SRC, ctx, { filename: 'links.js' });
  assert.equal(ctx.open, patched);
});
