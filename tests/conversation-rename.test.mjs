import test from 'node:test';
import assert from 'node:assert/strict';
import { runInjected, fakePage } from './helpers.mjs';

function load() {
  const page = fakePage({ pathname: '/agent/session-a' });
  runInjected('injected/conversation-rename.js', page.sandbox);
  return page.sandbox.ArenaConversationRename;
}

test('rename accepts only a valid conversation ID and an exact nonempty title', () => {
  const R = load();
  assert.equal(R.validate('session-a', 'deepseek-flash'), 'deepseek-flash');
  assert.equal(R.validate('session-a', '  model-name  '), 'model-name');
  for (const session of [null, '../other', 'a?b', 'x'.repeat(129)]) assert.throws(() => R.validate(session, 'model'));
  for (const name of ['', null, 'a\nb', 'a\u0000b', 'x'.repeat(101)]) assert.throws(() => R.validate('session-a', name));
  assert.equal(R.validate('session-a', 'x'.repeat(100)).length, 100);
});

test('rename scope matches exact conversation routes only', () => {
  const R = load();
  assert.equal(R.sessionFromPath('/agent/session-a'), 'session-a');
  assert.equal(R.sessionFromPath('/agent/session-a/'), 'session-a');
  for (const path of ['/agent', '/agent/session-a/settings', '/other/session-a', '/agent/a%2Fb']) assert.equal(R.sessionFromPath(path), null);
  assert.equal(typeof R.rename, 'function');
  assert.equal(typeof R.archive, 'function');
  assert.equal(R.isBusy(), false);
});
